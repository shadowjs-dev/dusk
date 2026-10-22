import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeFetch } from "../../src/adapter/native";
import {
  inlineSourcesOf,
  type StaticPageInput,
  staticCspValue,
  staticPagesOf,
} from "../../src/adapter/static-pages";
import type { CspOptions } from "../../src/server/csp";
import type { Handler, SecureHeadersOptions } from "../../src/server/types";
import { validateRouting } from "../../src/shared/routing-config";
import { pageKeyOf, type StaticPage } from "../../src/shared/static-page";

/**
 * The rule that decides how a prerendered page is answered (B2): the pure policy of `adapter/static-pages.ts`, the page
 * key of a request, the CSP of a static page, and the Bun/Deno static path that reads the same table.
 */

const PAGE = "<!doctype html><html><head></head><body><p>about</p></body></html>";
const ROOT_HTML = PAGE;

function policy(
  pages: StaticPageInput[],
  input: {
    routing?: Parameters<typeof validateRouting>[0];
    headers?: false | SecureHeadersOptions;
    csp?: false | CspOptions;
  } = {},
): StaticPage[] {
  return staticPagesOf({
    routing: validateRouting(input.routing ?? {}, { ignoreCase: true }),
    headers: input.headers,
    csp: input.csp,
    pages,
  });
}

const headerOf = (page: StaticPage | undefined, name: string): string | undefined =>
  page?.headers.find(([key]) => key === name)?.[1];

describe("the static policy of a prerendered page", () => {
  it("[SPOL-01] a page no rule applies to is static, with the secure defaults and a CSP that has no nonce", () => {
    const [page] = policy([{ path: "/about", html: PAGE, routeMiddleware: false }], {
      headers: {},
      csp: {},
    });
    expect(page?.mode).toBe("static");
    expect(page?.reason).toBeUndefined();
    expect(headerOf(page, "x-content-type-options")).toBe("nosniff");
    expect(headerOf(page, "x-frame-options")).toBe("SAMEORIGIN");
    const csp = headerOf(page, "content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/nonce/);
  });

  it("[SPOL-02] a redirect or a rewrite that matches the path makes it handler-rendered; a rule for another path does not", () => {
    const pages: StaticPageInput[] = [
      { path: "/old", html: PAGE, routeMiddleware: false },
      { path: "/about", html: PAGE, routeMiddleware: false },
    ];
    const routing = {
      redirects: [{ source: "/old", destination: "/new" }],
      rewrites: { beforeFiles: [{ source: "/elsewhere", destination: "/x" }] },
    };
    const [old, about] = policy(pages, { routing });
    expect(old?.mode).toBe("handler");
    expect(old?.reason).toMatch(/redirect/);
    expect(about?.mode).toBe("static");
  });

  it("[SPOL-03] a host-conditioned rewrite of a path makes that page handler-rendered (the host decides per request)", () => {
    const routing = {
      rewrites: {
        beforeFiles: [
          {
            source: "/",
            destination: "/posts/1",
            has: [{ type: "host" as const, value: "sites.test" }],
          },
        ],
      },
    };
    const [home] = policy([{ path: "/", html: ROOT_HTML, routeMiddleware: false }], { routing });
    expect(home?.mode).toBe("handler");
    expect(home?.reason).toMatch(/rewrite/);
  });

  it("[SPOL-04] a middleware of the page or its folder makes it handler-rendered", () => {
    const [page] = policy([{ path: "/private", html: PAGE, routeMiddleware: true }]);
    expect(page?.mode).toBe("handler");
    expect(page?.reason).toMatch(/middleware/);
  });

  it("[SPOL-05] a header rule with a condition is request-dependent; an unconditioned one is written into the page's headers", () => {
    const conditioned = policy([{ path: "/x", html: PAGE, routeMiddleware: false }], {
      routing: {
        headers: [{ source: "/x", headers: { "x-a": "1" }, has: [{ type: "cookie", key: "k" }] }],
      },
    });
    expect(conditioned[0]?.mode).toBe("handler");
    const plain = policy([{ path: "/x", html: PAGE, routeMiddleware: false }], {
      routing: { headers: [{ source: "/x", headers: { "x-a": "1", "x-frame-options": "DENY" } }] },
    });
    expect(plain[0]?.mode).toBe("static");
    expect(headerOf(plain[0], "x-a")).toBe("1");
    // A rule does not override a header the defaults set, unless it says so.
    expect(headerOf(plain[0], "x-frame-options")).toBe("SAMEORIGIN");
    const override = policy([{ path: "/x", html: PAGE, routeMiddleware: false }], {
      routing: {
        headers: [{ source: "/x", headers: { "x-frame-options": "DENY" }, override: true }],
      },
    });
    expect(headerOf(override[0], "x-frame-options")).toBe("DENY");
  });

  it("[SPOL-06] inline scripts and styles are allowed by their hashes; the nonce is never written", () => {
    const html = `${PAGE.replace("</body>", "<script>window.a = 1;</script><style>p{color:red}</style></body>")}`;
    const inline = inlineSourcesOf(html);
    expect(inline.script).toHaveLength(1);
    expect(inline.style).toHaveLength(1);
    const [page] = policy([{ path: "/a", html, routeMiddleware: false }], { csp: {} });
    const csp = headerOf(page, "content-security-policy") ?? "";
    for (const source of [...inline.script, ...inline.style]) expect(csp).toContain(source);
    expect(csp).not.toMatch(/nonce/);
  });

  it("[SPOL-07] a data script and an external module script add no hash; a non-HTML page gets no CSP", () => {
    const html =
      '<script type="application/json" id="x">{}</script><script type="module" src="/a.js"></script>';
    expect(inlineSourcesOf(html)).toEqual({ script: [], style: [] });
    const [feed] = policy(
      [{ path: "/feed.xml", html: undefined as unknown as string, routeMiddleware: false }],
      {
        csp: {},
      },
    );
    expect(headerOf(feed, "content-security-policy")).toBeUndefined();
  });

  it("[SPOL-08] HSTS is listed apart: only a request over https may carry it", () => {
    const [page] = policy([{ path: "/a", html: PAGE, routeMiddleware: false }], {
      headers: { hsts: { maxAge: 31536000 } },
    });
    expect(headerOf(page, "strict-transport-security")).toBeUndefined();
    expect(page?.httpsHeaders).toEqual([["strict-transport-security", "max-age=31536000"]]);
  });

  it("[SPOL-09] a nonce-only directive keeps 'self' (no fallback to a looser default), and a removed directive stays removed", () => {
    const value = staticCspValue({
      directives: { "script-src": ["{nonce}"], "img-src": [] },
      useDefaults: false,
    });
    expect(value).toContain("script-src 'self'");
    expect(value).not.toContain("img-src");
    expect(value).not.toMatch(/nonce/);
  });

  it("[SPOL-10] a page key maps the file forms of one page to one key", () => {
    expect(pageKeyOf("/about/")).toBe("/about");
    expect(pageKeyOf("/about/index.html")).toBe("/about");
    expect(pageKeyOf("/about.html")).toBe("/about");
    expect(pageKeyOf("/index.html")).toBe("/");
    expect(pageKeyOf("/")).toBe("/");
  });
});

describe("the native (Bun, Deno) static path reads the same table", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("[SPOL-11] a static page is served with its headers; a handler page is never read from its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-native-"));
    dirs.push(dir);
    mkdirSync(join(dir, "about"));
    writeFileSync(join(dir, "about", "index.html"), PAGE);
    mkdirSync(join(dir, "posts"));
    writeFileSync(join(dir, "posts", "index.html"), "<p>file</p>");
    const handled: string[] = [];
    const handler = {
      fetch: async (request: Request) => {
        handled.push(new URL(request.url).pathname);
        return new Response("from the handler", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    } as unknown as Handler;
    const fetchFn = createNativeFetch(handler, {
      static: dir,
      compress: false,
      onError: () => undefined,
      pages: [
        {
          path: "/about",
          mode: "static",
          headers: [["x-frame-options", "DENY"]],
          httpsHeaders: [],
          reason: undefined,
        },
        {
          path: "/posts",
          mode: "handler",
          headers: [],
          httpsHeaders: [],
          reason: "a rewrite rule matches the path",
        },
      ],
    });
    const about = await fetchFn(new Request("http://localhost/about"), undefined);
    expect(about.status).toBe(200);
    expect(about.headers.get("x-frame-options")).toBe("DENY");
    expect(await about.text()).toBe(PAGE);
    const posts = await fetchFn(new Request("http://localhost/posts"), undefined);
    expect(await posts.text()).toBe("from the handler");
    expect(handled).toEqual(["/posts"]);
  });
});

describe("the file owns its representation", () => {
  it("[SPOL-12] a header rule that names the file's validators or type does not reach the page's headers", () => {
    const [page] = policy([{ path: "/a", html: PAGE, routeMiddleware: false }], {
      routing: {
        headers: [
          {
            source: "/a",
            headers: {
              etag: '"x"',
              "content-type": "text/plain",
              "cache-control": "public, max-age=60",
            },
          },
        ],
      },
    });
    expect(headerOf(page, "etag")).toBeUndefined();
    expect(headerOf(page, "content-type")).toBeUndefined();
    expect(headerOf(page, "cache-control")).toBe("public, max-age=60");
  });
});
