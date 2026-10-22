import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pages } from "../src/features/pages";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { PrerenderError, prerender } from "../src/static/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/*
 * `export const dynamicParams = false`: the server answers not found for a param the page's `prerender` export does not
 * list. The route tree carries the flag (`dynamicParams: false` on the route); the list comes from the server entry's
 * `prerenderRoutes` (the `prerender` export of each route, loaded on demand), the way the build reads it.
 */

type RouteList = DuskRuntimeManifest["routes"];
type Source = NonNullable<DuskRuntimeManifest["prerenderRoutes"]>[number];

interface Kit {
  page(path: string, id: string, options?: Record<string, unknown>): RouteList[number];
  layout(
    path: string,
    id: string,
    options: Record<string, unknown>,
    children: RouteList,
  ): RouteList[number];
  home(links: readonly string[]): RouteList[number];
}

/** Routes with real components, compiled like user code. Each page shows its own params. */
const KIT = `
import { defineRoute, Outlet, useParams } from "@shadow-js/router";

export function page(path, id, options = {}) {
  return defineRoute(path, {
    id,
    component: function Page() {
      const params = useParams();
      return <p class="page">{id} lang={params.lang ?? "-"} id={params.id ?? "-"} slug={params.slug ?? "-"}</p>;
    },
    ...options,
  });
}
export function layout(path, id, options, children) {
  return defineRoute(path, {
    id,
    component: function Frame() { return <div class="frame"><Outlet /></div>; },
    ...options,
    children,
  });
}
export function home(links) {
  return defineRoute("/", {
    id: "home",
    component: function Home() {
      return <nav>{links.map((href) => <a href={href}>{href}</a>)}</nav>;
    },
  });
}
`;

async function kit(): Promise<Kit> {
  return load<Kit>(KIT);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function source(id: string, value: unknown): Source {
  return { id, load: async () => value };
}

async function serve(
  routes: RouteList,
  prerenderRoutes: readonly Source[] | undefined,
  extra: Partial<Parameters<typeof createHandler>[0]> = {},
) {
  const app = await loadApp();
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      routes,
      ...(prerenderRoutes === undefined ? {} : { prerenderRoutes }),
    }),
    dev: true,
    onError: log.onError,
    ...extra,
  });
  return { handler, log };
}

/** The text of a response without the hydration comments the renderer writes between text nodes. */
const visible = async (response: Response): Promise<string> =>
  (await response.text()).replace(/<!--.*?-->/g, "");

const get = (handler: { fetch(request: Request): Promise<Response> }, path: string) =>
  handler.fetch(new Request(`http://localhost${path}`));

describe("dynamicParams = false on the server", () => {
  it("[DP-R1] a listed param renders (200) and an unlisted one is not found (404)", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false })],
      [source("post", ["/posts/1", "/posts/2"])],
    );
    const listed = await get(handler, "/posts/1");
    expect(listed.status).toBe(200);
    expect(await visible(listed)).toContain("id=1");
    expect((await get(handler, "/posts/2?utm=x")).status).toBe(200);
    const unknown = await get(handler, "/posts/zzz");
    expect(unknown.status).toBe(404);
    expect(await visible(unknown)).not.toContain("id=zzz");
    expect(
      (await handler.fetch(new Request("http://localhost/posts/zzz", { method: "HEAD" }))).status,
    ).toBe(404);
  });

  it("[DPL-1] a gated page with no dynamicParams loader in pages() is refused when the handler is created, naming the fix", async () => {
    const { page } = await kit();
    const app = await loadApp();
    const routes = [page("/posts/:id", "post", { dynamicParams: false })];
    expect(() =>
      createHandler({
        features: [pages()],
        manifest: manifestOf(app, { routes, prerenderRoutes: [source("post", ["/posts/1"])] }),
        dev: true,
      }),
    ).toThrow(/dynamicParams/);
  });

  it("[DP-R2] without the export, and with dynamicParams = true, an unlisted param still renders", async () => {
    const { page } = await kit();
    for (const options of [{}, { dynamicParams: true }]) {
      const { handler } = await serve(
        [page("/posts/:id", "post", options)],
        [source("post", ["/posts/1"])],
      );
      const unknown = await get(handler, "/posts/zzz");
      expect(unknown.status, JSON.stringify(options)).toBe(200);
      expect(await visible(unknown)).toContain("id=zzz");
    }
  });

  it("[DP-R3] a manifest without prerender sources still serves every route that does not set false", async () => {
    const { page } = await kit();
    const { handler } = await serve([page("/posts/:id", "post")], undefined);
    expect((await get(handler, "/posts/anything")).status).toBe(200);
  });

  it("[DP-R4] the not-found answer renders the app's own not-found UI, as notFound() does", async () => {
    const { page, layout } = await kit();
    const { handler } = await serve(
      [
        layout("", "root", { notFound: () => "this page does not exist" }, [
          page("/posts/:id", "post", { dynamicParams: false }),
        ]),
      ],
      [source("post", ["/posts/1"])],
    );
    const unknown = await get(handler, "/posts/zzz");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("this page does not exist");
    expect((await get(handler, "/posts/1")).status).toBe(200);
  });

  it("[DP-R5] a path with several params is checked as a whole: both listed, not each on its own", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/:lang/posts/:id", "post", { dynamicParams: false })],
      [source("post", ["/en/posts/1", "/ar/posts/2"])],
    );
    expect((await get(handler, "/en/posts/1")).status).toBe(200);
    expect((await get(handler, "/ar/posts/2")).status).toBe(200);
    expect((await get(handler, "/en/posts/2")).status).toBe(404);
    expect((await get(handler, "/ar/posts/1")).status).toBe(404);
  });

  it("[DP-R6] an optional param: the listed shape renders, another one is not found", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/docs/:slug?", "docs", { dynamicParams: false })],
      [source("docs", ["/docs", "/docs/intro"])],
    );
    expect((await get(handler, "/docs")).status).toBe(200);
    expect((await get(handler, "/docs/intro")).status).toBe(200);
    expect((await get(handler, "/docs/other")).status).toBe(404);
  });

  it("[DP-R7] a function receives the params of the layouts above it, as in the build", async () => {
    const { page, layout } = await kit();
    const received: unknown[] = [];
    const { handler } = await serve(
      [layout("/:lang", "lang", {}, [page("/posts/:id", "post", { dynamicParams: false })])],
      [
        source("lang", async () => [{ lang: "en" }, { lang: "ar" }]),
        source("post", async (args: { params: Record<string, string> }) => {
          received.push(args.params["lang"]);
          return args.params["lang"] === "en" ? [{ id: "1" }] : [{ id: "2" }];
        }),
      ],
    );
    expect((await get(handler, "/en/posts/1")).status).toBe(200);
    expect((await get(handler, "/ar/posts/2")).status).toBe(200);
    expect((await get(handler, "/en/posts/2")).status).toBe(404);
    expect((await get(handler, "/ar/posts/1")).status).toBe(404);
    // A language no layout list names has no page.
    expect((await get(handler, "/fr/posts/1")).status).toBe(404);
    expect(new Set(received)).toEqual(new Set(["en", "ar"]));
  });

  it("[DP-R8] the list is compared on the decoded value: an escaped space matches, a double escape does not", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false })],
      [source("post", ["/posts/a%20b"])],
    );
    expect((await get(handler, "/posts/a%20b")).status).toBe(200);
    expect((await get(handler, "/posts/a%2520b")).status).toBe(404);
  });

  it("[DP-R9] a route with ssr = false answers 404 for an unlisted param, not the empty shell", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false, ssr: false })],
      [source("post", ["/posts/1"])],
    );
    expect((await get(handler, "/posts/1")).status).toBe(200);
    expect((await get(handler, "/posts/zzz")).status).toBe(404);
  });

  it("[DP-R10] a route that sets false with no prerender source in the manifest is a reported 500, naming the route", async () => {
    const { page } = await kit();
    const { handler, log } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false })],
      undefined,
    );
    expect((await get(handler, "/posts/1")).status).toBe(500);
    expect(String(log.errors[0]?.error)).toMatch(/"post"[\s\S]*prerenderRoutes/);
    // A page that does not set it is not affected.
    expect((await get(handler, "/other")).status).toBe(404);
  });

  it("[DP-R11] in production the list is read once; in development it is read for every request", async () => {
    const { page } = await kit();
    for (const dev of [false, true]) {
      let reads = 0;
      const { handler } = await serve(
        [page("/posts/:id", "post", { dynamicParams: false })],
        [
          {
            id: "post",
            load: async () => {
              reads += 1;
              return ["/posts/1"];
            },
          },
        ],
        dev ? {} : { dev: false, security: { allowedHosts: ["localhost"] } },
      );
      for (const path of ["/posts/1", "/posts/1", "/posts/9"]) await get(handler, path);
      expect(reads, `dev ${dev}`).toBe(dev ? 3 : 1);
    }
  });

  it("[DP-R12] a list that fails to load is a 500, reported, and the next request tries again", async () => {
    const { page } = await kit();
    let attempts = 0;
    const { handler, log } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false })],
      [
        {
          id: "post",
          load: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("database is down");
            return ["/posts/1"];
          },
        },
      ],
      { dev: false, security: { allowedHosts: ["localhost"] } },
    );
    expect((await get(handler, "/posts/1")).status).toBe(500);
    expect(log.errors.length).toBeGreaterThan(0);
    expect((await get(handler, "/posts/1")).status).toBe(200);
    expect((await get(handler, "/posts/9")).status).toBe(404);
  });

  it("[DP-R13] a prerender export that is neither a list nor a function is a 500, not an open door", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false })],
      [source("post", true)],
    );
    expect((await get(handler, "/posts/1")).status).toBe(500);
  });
});

describe("dynamicParams = false in a static export", () => {
  function files(dir: string, base = dir): string[] {
    return readdirSync(dir)
      .flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? files(full, base) : [full.slice(base.length + 1)];
      })
      .sort();
  }

  it("[DP-ST1] a link to an unlisted param is not written; the listed pages are", async () => {
    const { page, home } = await kit();
    const { handler } = await serve(
      [home(["/posts/1", "/posts/zzz"]), page("/posts/:id", "post", { dynamicParams: false })],
      [source("post", ["/posts/1"])],
    );
    const outDir = mkdtempSync(join(tmpdir(), "dusk-dynamic-params-"));
    dirs.push(outDir);
    const failed: string[] = [];
    await prerender({
      handler,
      outDir,
      paths: ["/"],
      crawlLinks: true,
      onError: (failure) => void failed.push(failure.path),
    });
    const written = files(outDir).filter((file) => file !== "200.html" && file !== "404.html");
    expect(written).toEqual(["index.html", "posts/1/index.html"]);
    expect(failed).toEqual(["/posts/zzz"]);
  });

  it("[DP-ST2] an unlisted param in the paths of the run fails it, naming the path and the 404", async () => {
    const { page } = await kit();
    const { handler } = await serve(
      [page("/posts/:id", "post", { dynamicParams: false })],
      [source("post", ["/posts/1"])],
    );
    const outDir = mkdtempSync(join(tmpdir(), "dusk-dynamic-params-"));
    dirs.push(outDir);
    const run = prerender({ handler, outDir, paths: ["/posts/1", "/posts/zzz"] });
    await expect(run).rejects.toBeInstanceOf(PrerenderError);
    await expect(run).rejects.toThrow(/\/posts\/zzz[\s\S]*404/);
  });

  it("[DP-ST3] without dynamicParams = false the crawl writes the unlisted page too", async () => {
    const { page, home } = await kit();
    const { handler } = await serve(
      [home(["/posts/1", "/posts/zzz"]), page("/posts/:id", "post")],
      [source("post", ["/posts/1"])],
    );
    const outDir = mkdtempSync(join(tmpdir(), "dusk-dynamic-params-"));
    dirs.push(outDir);
    await prerender({ handler, outDir, paths: ["/"], crawlLinks: true });
    expect(files(outDir)).toContain("posts/zzz/index.html");
  });
});
