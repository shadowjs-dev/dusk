import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiRoute, createHandler, json, text } from "../src/server/index";
import { outputFileFor, PrerenderError, prerender } from "../src/static/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function out(): string {
  const dir = mkdtempSync(join(tmpdir(), "start-prerender-"));
  dirs.push(dir);
  return dir;
}

async function handler(extra: Partial<Parameters<typeof createHandler>[0]> = {}) {
  const app = await loadApp();
  return createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      apiRoutes: [
        {
          id: "feed",
          path: "/feed.xml",
          load: async () =>
            apiRoute({
              GET: () => text("<rss/>", { headers: { "content-type": "application/xml" } }),
            }),
        },
        {
          id: "data",
          path: "/data.json",
          load: async () => apiRoute({ GET: () => json({ ok: true }) }),
        },
      ],
    }),
    dev: true,
    onError: errorLog().onError,
    ...extra,
  });
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? listFiles(full, base) : [full.slice(base.length + 1)];
    })
    .sort();
}

describe("prerender", () => {
  it("[SPRE-01] renders pages with the production handler to directory-style files, plus the SPA shell and 404.html", async () => {
    const dir = out();
    const result = await prerender({
      handler: await handler(),
      outDir: dir,
      paths: ["/", "/posts/1", "/posts/2", "/nested/child"],
    });
    expect(listFiles(dir)).toEqual([
      "200.html",
      "404.html",
      "index.html",
      "nested/child/index.html",
      "posts/1/index.html",
      "posts/2/index.html",
    ]);
    expect(readFileSync(join(dir, "posts/1/index.html"), "utf8")).toContain("Post 1");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain('class="home"');
    const shell = readFileSync(join(dir, "200.html"), "utf8");
    expect(shell).toContain('<div id="app"></div>');
    expect(shell).not.toContain("__shadow_router");
    // The 404 page is the app's own: the root layout with its notFound inside.
    const notFound = readFileSync(join(dir, "404.html"), "utf8");
    expect(notFound).toContain('class="layout"');
    expect(notFound).toContain("page not found");
    expect(result.pages.map((page) => page.path)).toEqual([
      "/",
      "/nested/child",
      "/posts/1",
      "/posts/2",
    ]);
    expect(result.shell).toBe(join(dir, "200.html"));
  });

  it("[SPRE-02] the file layout can be html files; non-HTML endpoints keep their names", async () => {
    const dir = out();
    await prerender({
      handler: await handler(),
      outDir: dir,
      paths: ["/posts/1", "/feed.xml", "/data.json"],
      format: "file",
      shell: false,
      notFoundPath: false,
    });
    expect(listFiles(dir)).toEqual(["data.json", "feed.xml", "posts/1.html"]);
    expect(readFileSync(join(dir, "feed.xml"), "utf8")).toBe("<rss/>");
  });

  it("[SPRE-03] a path that is not OK fails the run and names the path; allowStatus admits it", async () => {
    const dir = out();
    await expect(
      prerender({
        handler: await handler(),
        outDir: dir,
        paths: ["/gone"],
        shell: false,
        notFoundPath: false,
      }),
    ).rejects.toMatchObject({
      code: "PRERENDER_NON_OK",
      message: expect.stringContaining("/gone"),
    });
    await prerender({
      handler: await handler(),
      outDir: dir,
      paths: ["/gone"],
      allowStatus: [200, 404],
      shell: false,
      notFoundPath: false,
    });
    expect(existsSync(join(dir, "gone/index.html"))).toBe(true);
  });

  it("[SPRE-04] redirects fail by default; onRedirect: 'html' writes a meta-refresh page for a local target", async () => {
    const dir = out();
    await expect(
      prerender({
        handler: await handler(),
        outDir: dir,
        paths: ["/old"],
        shell: false,
        notFoundPath: false,
      }),
    ).rejects.toMatchObject({ code: "PRERENDER_REDIRECT" });
    await prerender({
      handler: await handler(),
      outDir: dir,
      paths: ["/old"],
      onRedirect: "html",
      shell: false,
      notFoundPath: false,
    });
    const page = readFileSync(join(dir, "old/index.html"), "utf8");
    expect(page).toContain('http-equiv="refresh" content="0;url=/posts/1"');
  });

  it("[SPRE-05] hostile paths are rejected before anything is written (traversal, NUL, backslash, query, relative)", async () => {
    const dir = out();
    const run = handler();
    for (const path of [
      "/../x",
      "/a/%2e%2e/x",
      "/a%00b",
      "/a\\b",
      "/a?x=1",
      "/a#h",
      "relative",
      "/%2e%2e%2fetc",
      `/${"a".repeat(300)}`,
      `/${"a/".repeat(600)}`,
    ]) {
      await expect(
        prerender({
          handler: await run,
          outDir: dir,
          paths: ["/", path],
          shell: false,
          notFoundPath: false,
        }),
        path,
      ).rejects.toBeInstanceOf(PrerenderError);
    }
    expect(listFiles(dir)).toEqual([]);
  });

  it("[SPRE-06] two paths that write one file are a conflict", async () => {
    const dir = out();
    await expect(
      prerender({
        handler: await handler(),
        outDir: dir,
        paths: ["/nested/child", "/nested/child/index.html"],
        shell: false,
        notFoundPath: false,
      }),
    ).rejects.toMatchObject({ code: "PRERENDER_PATH_CONFLICT" });
  });

  it("[DSK-W-08] routes whose files differ only by case are a conflict on every platform, and the error names both", async () => {
    // macOS and Windows file systems ignore case, so `/About` and `/about` would overwrite each other there.
    // The check is case-blind everywhere, so the same project fails the same way on Linux too.
    const dir = out();
    const run = async (): Promise<unknown> =>
      prerender({
        handler: await handler(),
        outDir: dir,
        paths: ["/About", "/about"],
        shell: false,
        notFoundPath: false,
      });
    await expect(run()).rejects.toMatchObject({ code: "PRERENDER_PATH_CONFLICT" });
    await expect(run()).rejects.toThrow(/\/about and \/About both write/);
    expect(listFiles(dir)).toEqual([]);
  });

  it("[SPRE-07] bound: more pages than maxPages is an error before rendering; duplicates count once", async () => {
    const dir = out();
    await expect(
      prerender({
        handler: await handler(),
        outDir: dir,
        paths: ["/", "/posts/1", "/posts/2"],
        maxPages: 2,
      }),
    ).rejects.toMatchObject({ code: "PRERENDER_MAX_PAGES" });
    expect(listFiles(dir)).toEqual([]);
    const result = await prerender({
      handler: await handler(),
      outDir: dir,
      paths: ["/posts/1", "/posts/1"],
      maxPages: 1,
      shell: false,
      notFoundPath: false,
    });
    expect(result.pages).toHaveLength(1);
  });

  it("[SPRE-08] bound: a page larger than maxPageBytes fails", async () => {
    const dir = out();
    await expect(
      prerender({
        handler: await handler(),
        outDir: dir,
        paths: ["/posts/1"],
        maxPageBytes: 200,
        shell: false,
        notFoundPath: false,
      }),
    ).rejects.toMatchObject({ code: "PRERENDER_PAGE_TOO_LARGE" });
  });

  it("[SPRE-09] paths can come from a function; concurrency does not change the result", async () => {
    const dir = out();
    const paths = Array.from({ length: 12 }, (_unused, n) => `/posts/${String(n)}`);
    const result = await prerender({
      handler: await handler(),
      outDir: dir,
      paths: async () => paths,
      concurrency: 5,
      shell: false,
      notFoundPath: false,
    });
    expect(result.pages).toHaveLength(12);
    for (const n of [0, 7, 11])
      expect(readFileSync(join(dir, `posts/${String(n)}/index.html`), "utf8")).toContain(
        `Post ${String(n)}`,
      );
  });

  it("[SPRE-10] outputFileFor maps paths predictably", () => {
    expect(outputFileFor("/", "directory", "text/html")).toBe("index.html");
    expect(outputFileFor("/a/b", "directory", "text/html")).toBe("a/b/index.html");
    expect(outputFileFor("/a/b", "file", "text/html")).toBe("a/b.html");
    expect(outputFileFor("/page.html", "directory", "text/html")).toBe("page.html");
    expect(outputFileFor("/robots.txt", "directory", "text/plain")).toBe("robots.txt");
    expect(outputFileFor("/v1.2/about", "directory", "text/html")).toBe("v1.2/about/index.html");
    expect(outputFileFor("/a%20b", "directory", "text/html")).toBe("a b/index.html");
  });

  it("[SPRE-11] the shell comes from the handler, so it has the same head defaults and entry as the pages", async () => {
    const response = await (await handler()).renderShell();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<script type="module" src="/assets/entry-abc123.js">');
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('<link rel="stylesheet" href="/assets/app-def456.css">');
  });
});

describe("prerender and the host check", () => {
  it("[SPRH-01] with allowedHosts that lack localhost, the first listed host is used automatically", async () => {
    const dir = out();
    const seen: string[] = [];
    const real = await handler({
      security: { allowedHosts: ["*.cdn.example", "www.example.com", "other.test"] },
    });
    const result = await prerender({
      handler: {
        allowedHosts: real.allowedHosts,
        renderShell: real.renderShell,
        env: real.env,
        fetch: (request, platform) => {
          seen.push(new URL(request.url).host);
          return real.fetch(request, platform);
        },
      } as typeof real,
      outDir: dir,
      paths: ["/", "/posts/1"],
    });
    expect(result.pages.map((page) => page.path)).toEqual(["/", "/posts/1"]);
    expect(new Set(seen)).toEqual(new Set(["www.example.com"]));
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain('class="home"');
  });

  it("[SPRH-02] a port in the first listed host is kept", async () => {
    const dir = out();
    const real = await handler({ security: { allowedHosts: ["app.test:8443"] } });
    const result = await prerender({ handler: real, outDir: dir, paths: ["/"] });
    expect(result.pages).toHaveLength(1);
  });

  it("[SPRH-03] localhost stays the default when the list allows it, or when there is no list", async () => {
    const hosts: string[] = [];
    for (const extra of [{ security: { allowedHosts: ["localhost"] } }, {}]) {
      const real = await handler(extra);
      await prerender({
        handler: {
          allowedHosts: real.allowedHosts,
          renderShell: real.renderShell,
          env: real.env,
          fetch: (request, platform) => {
            hosts.push(new URL(request.url).host);
            return real.fetch(request, platform);
          },
        } as typeof real,
        outDir: out(),
        paths: ["/"],
      });
    }
    expect(new Set(hosts)).toEqual(new Set(["localhost"]));
  });

  it("[SPRH-04] a list of wildcards only has no host to choose: PRERENDER_HOST names allowedHosts", async () => {
    const real = await handler({ security: { allowedHosts: ["*.example.com"] } });
    const error = await prerender({ handler: real, outDir: out(), paths: ["/"] }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PrerenderError);
    expect((error as PrerenderError).code).toBe("PRERENDER_HOST");
    expect((error as PrerenderError).message).toContain("security.allowedHosts");
    expect((error as PrerenderError).message).toContain("*.example.com");
  });

  it("[SPRH-05] an explicit origin the handler refuses fails naming allowedHosts and the host used", async () => {
    const real = await handler({ security: { allowedHosts: ["www.example.com"] } });
    const error = await prerender({
      handler: real,
      outDir: out(),
      paths: ["/x"],
      origin: "http://staging.test",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrerenderError);
    const message = (error as PrerenderError).message;
    expect(message).toContain("PRERENDER_NON_OK");
    expect(message).toContain("/x answered 400");
    expect(message).toContain("staging.test");
    expect(message).toContain("security.allowedHosts");
    expect(message).toContain("www.example.com");
  });

  it("[SPRH-06] a 400 for another reason keeps the plain message", async () => {
    const real = await handler({ security: { allowedHosts: ["www.example.com"] } });
    const error = await prerender({
      handler: real,
      outDir: out(),
      paths: ["/%zz"],
      allowStatus: [200],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("allowedHosts");
  });

  it("[SPRH-07] the SPA shell is not written when the host check refused it", async () => {
    const dir = out();
    const real = await handler({ security: { allowedHosts: ["www.example.com"] } });
    const error = await prerender({
      handler: real,
      outDir: dir,
      paths: [],
      origin: "http://staging.test",
      notFoundPath: false,
    }).catch((caught: unknown) => caught);
    expect((error as PrerenderError).message).toContain("the SPA shell answered 400");
    expect((error as PrerenderError).message).toContain("security.allowedHosts");
    expect(existsSync(join(dir, "200.html"))).toBe(false);
  });

  it("[SPRH-08] onRedirect: 'html' only follows redirects to the same origin; another origin is PRERENDER_REDIRECT", async () => {
    const trusting = await handler({ trustedOrigins: ["https://evil.example"] });
    await expect(
      prerender({
        handler: trusting,
        outDir: out(),
        paths: ["/external"],
        onRedirect: "html",
        shell: false,
        notFoundPath: false,
      }),
    ).rejects.toMatchObject({ code: "PRERENDER_REDIRECT", message: /another origin/ });
  });

  it("[SPRE-16] the meta-refresh page of a redirect keeps its query and its fragment", async () => {
    const dir = out();
    const redirecting = {
      fetch: async () =>
        new Response(null, { status: 308, headers: { location: "/?ref=mail#download" } }),
    };
    await prerender({
      handler: redirecting,
      outDir: dir,
      paths: ["/old-download"],
      onRedirect: "html",
      shell: false,
      notFoundPath: false,
    });
    const page = readFileSync(join(dir, "old-download/index.html"), "utf8");
    expect(page).toContain('http-equiv="refresh" content="0;url=/?ref=mail#download"');
    expect(page).toContain('<link rel="canonical" href="/?ref=mail#download">');
  });

  it("[SPRE-17] a redirect of dusk.config.ts to a path with a fragment becomes a page that goes there, query and fragment included", async () => {
    const dir = out();
    const real = await handler({
      routing: { redirects: [{ source: "/old-download", destination: "/#download" }] },
    });
    await prerender({
      handler: real,
      outDir: dir,
      paths: ["/old-download"],
      onRedirect: "html",
      shell: false,
      notFoundPath: false,
    });
    const page = readFileSync(join(dir, "old-download/index.html"), "utf8");
    expect(page).toContain('http-equiv="refresh" content="0;url=/#download"');
  });

  it("[SPRH-09] the meta-refresh page escapes the target", async () => {
    const dir = out();
    const hostile = {
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: '/a"><script>x</script>' } }),
    };
    await prerender({
      handler: hostile,
      outDir: dir,
      paths: ["/old"],
      onRedirect: "html",
      shell: false,
      notFoundPath: false,
    });
    const page = readFileSync(join(dir, "old/index.html"), "utf8");
    expect(page).not.toContain("<script>");
    // The target is parsed as a URL first, so the quote and the angle brackets are percent-encoded.
    expect(page).toContain("url=/a%22%3E%3Cscript%3Ex%3C/script%3E");
  });
});

describe("prerender: crawling, filter and hooks (A3)", () => {
  /** A handler that links `/` to `/a` and `/z`, and `/a` to `/b`; `/gone` is a 404. */
  const site: Parameters<typeof prerender>[0]["handler"] = {
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/gone")) return new Response("nope", { status: 404 });
      const body =
        path === "/"
          ? '<a href="/a">a</a><a href="/z">z</a>'
          : path === "/a"
            ? '<a href="/b">b</a>'
            : "<p>end</p>";
      return new Response(`<html>${body}</html>`, { headers: { "content-type": "text/html" } });
    },
  };

  it("[A3-P3] crawlLinks writes the pages the rendered pages link to, within the depth", async () => {
    const dir = out();
    const result = await prerender({
      handler: site,
      outDir: dir,
      paths: ["/"],
      crawlLinks: { depth: 2 },
    });
    expect(result.pages.map((page) => page.path)).toEqual(["/", "/a", "/b", "/z"]);
    expect(existsSync(join(dir, "b", "index.html"))).toBe(true);
  });

  it("[A3-P4] filter drops paths before they are rendered; onSuccess and onError observe the run", async () => {
    const dir = out();
    const ok: string[] = [];
    const failed: string[] = [];
    const result = await prerender({
      handler: site,
      outDir: dir,
      paths: ["/", "/a", "/z"],
      filter: (path) => path !== "/z",
      onSuccess: (page) => void ok.push(page.path),
      onError: (failure) => void failed.push(failure.path),
    });
    expect(result.pages.map((page) => page.path)).toEqual(["/", "/a"]);
    expect(ok.sort()).toEqual(["/", "/a"]);
    expect(failed).toEqual([]);
  });

  it("[A3-P6] a failed run lists every failing path in one error", async () => {
    const dir = out();
    const error: unknown = await prerender({
      handler: site,
      outDir: dir,
      paths: ["/gone2", "/gone"],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrerenderError);
    expect(error instanceof Error ? error.message : "").toMatch(/\/gone[\s\S]*\/gone2/);
  });
});
