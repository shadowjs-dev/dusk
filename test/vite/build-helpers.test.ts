import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RouteEntry, ScanResult } from "@shadow-js/router/vite";
import { afterEach, describe, expect, it } from "vitest";
import { internalLinks } from "../../src/static/crawl";
import {
  buildIdOf,
  computeAssets,
  createDuskManifest,
  PrerenderError,
  type PrerenderRouteLoader,
  prerenderFile,
  prerenderPages,
  prerenderTargets,
  resolvePrerenderTargets,
  type ViteManifest,
} from "../../src/vite/build";

const ROOT = "/work/project";

function entry(
  id: string,
  file: string,
  config: RouteEntry["info"]["config"] = {},
  kind: "page" | "layout" = "page",
): RouteEntry {
  return {
    id,
    kind,
    file,
    absolutePath: `${ROOT}/src/routes/${file}`,
    fullPath: id,
    private: false,
    path: id,
    parentId: undefined,
    info: {
      hasDefault: true,
      exports: ["default"],
      methods: [],
      defaultApi: undefined,
      hasStarExport: false,
      config,
    },
    children: [],
    isEndpoint: true,
  };
}

function scanOf(...entries: RouteEntry[]): ScanResult {
  return {
    routesDir: `${ROOT}/src/routes`,
    roots: entries,
    entries,
    api: [],
    streams: [],
    middleware: [],
    metadataImages: [],
    ignored: [],
    files: entries.map((e) => e.file),
  };
}

describe("computeAssets", () => {
  const manifest: ViteManifest = {
    "virtual:entry": {
      file: "assets/entry-1.js",
      isEntry: true,
      imports: ["_shared.js"],
      css: ["assets/entry-1.css"],
    },
    "_shared.js": { file: "assets/shared.js", css: ["assets/shared.css"] },
    "src/routes/a.tsx?shadow-route=ui": {
      file: "assets/a.js",
      isDynamicEntry: true,
      imports: ["_shared.js", "_chart.js"],
      css: ["assets/a.css"],
    },
    "_chart.js": { file: "assets/chart.js", imports: ["_shared.js"], css: ["assets/chart.css"] },
    "src/routes/b.tsx?shadow-route=ui": {
      file: "assets/b.js",
      isDynamicEntry: true,
      imports: ["_chart.js"],
    },
  };
  const scan = scanOf(entry("/a", "a.tsx"), entry("/b", "b.tsx"), entry("/c", "c.tsx"));

  it("[SBLD-40] global stylesheets come from the entry's static closure; routes add only what the entry lacks", () => {
    const assets = computeAssets({ manifest, scan, root: ROOT, base: "/", maxPreloads: 24 });
    expect(assets.entry).toBe("assets/entry-1.js");
    expect(assets.css).toEqual(["assets/entry-1.css", "assets/shared.css"]);
    expect(assets.preloads["/a"]).toEqual([
      "assets/a.css",
      "assets/chart.css",
      "assets/a.js",
      "assets/chart.js",
    ]);
    expect(assets.preloads["/b"]).toEqual(["assets/chart.css", "assets/b.js", "assets/chart.js"]);
    // The shared chunk is in the entry already: never preloaded again.
    for (const list of Object.values(assets.preloads))
      expect(list).not.toContain("assets/shared.js");
    expect(assets.preloads["/c"]).toEqual([]);
  });

  it("[SBLD-41] lists are deduplicated and bounded", () => {
    const assets = computeAssets({ manifest, scan, root: ROOT, base: "/", maxPreloads: 2 });
    expect(assets.preloads["/a"]).toEqual(["assets/a.css", "assets/chart.css"]);
    const many: Record<string, ViteManifest[string]> = { e: { file: "e.js", isEntry: true } };
    const imports: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      many[`c${index}`] = { file: `c${index}.js`, imports: ["c0"] };
      imports.push(`c${index}`);
    }
    many["src/routes/a.tsx?shadow-route=ui"] = {
      file: "a.js",
      isDynamicEntry: true,
      imports: [...imports, ...imports],
    };
    const bounded = computeAssets({
      manifest: many,
      scan: scanOf(entry("/a", "a.tsx")),
      root: ROOT,
      base: "/",
      maxPreloads: 24,
    });
    expect(bounded.preloads["/a"]).toHaveLength(24);
    expect(new Set(bounded.preloads["/a"]).size).toBe(24);
  });

  it("[SBLD-42] the output is sorted by route id whatever the scan order", () => {
    const forward = computeAssets({ manifest, scan, root: ROOT, base: "/", maxPreloads: 24 });
    const reversed = computeAssets({
      manifest,
      scan: scanOf(...[...scan.entries].reverse()),
      root: ROOT,
      base: "/",
      maxPreloads: 24,
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    expect(Object.keys(forward.preloads)).toEqual(["/a", "/b", "/c"]);
  });

  it("[SBLD-43] a build without an entry chunk is an error", () => {
    expect(() =>
      computeAssets({
        manifest: { x: { file: "x.js" } },
        scan,
        root: ROOT,
        base: "/",
        maxPreloads: 4,
      }),
    ).toThrow(/no entry chunk/);
  });

  it("[SBLD-44] the build id depends on the assets only", () => {
    expect(buildIdOf(manifest)).toMatch(/^[\w-]{16}$/);
    expect(buildIdOf(manifest)).toBe(buildIdOf({ ...manifest }));
    expect(buildIdOf(manifest)).not.toBe(
      buildIdOf({ ...manifest, "_shared.js": { file: "assets/shared2.js" } }),
    );
  });

  it("[SBLD-45] the start manifest is sorted and relative", () => {
    const assets = computeAssets({ manifest, scan, root: ROOT, base: "/app/", maxPreloads: 24 });
    const result = createDuskManifest({
      buildId: "id",
      assets,
      scan: {
        ...scan,
        api: [
          {
            id: "/api/x",
            file: "api/x.ts",
            absolutePath: `${ROOT}/src/routes/api/x.ts`,
            fullPath: "/api/x",
            methods: ["GET"],
            matchFilters: false,
            private: false,
          },
        ],
      },
      serverFns: [],
      root: ROOT,
      prerendered: ["/a"],
    });
    expect(Object.keys(result.routes)).toEqual(["/a", "/b", "/c"]);
    expect(result.routes["/a"]?.file).toBe("src/routes/a.tsx");
    expect(result.base).toBe("/app/");
    expect(result.api).toEqual([{ id: "/api/x", file: "src/routes/api/x.ts", methods: ["GET"] }]);
    expect(JSON.stringify(result)).not.toContain(ROOT);
  });

  it("[DP-M1] the manifest carries dynamicParams of a page that sets it, and nothing for one that does not", () => {
    const assets = computeAssets({ manifest, scan, root: ROOT, base: "/", maxPreloads: 24 });
    const result = createDuskManifest({
      buildId: "id",
      assets,
      scan: scanOf(
        entry("/a", "a.tsx", { dynamicParams: false, prerender: ["/a"] }),
        entry("/b", "b.tsx", { dynamicParams: true }),
        entry("/c", "c.tsx"),
      ),
      serverFns: [],
      root: ROOT,
      prerendered: [],
    });
    expect(result.routes["/a"]?.dynamicParams).toBe(false);
    expect(result.routes["/b"]?.dynamicParams).toBe(true);
    expect(Object.hasOwn(result.routes["/c"] ?? {}, "dynamicParams")).toBe(false);
  });
});

describe("prerender targets and output files", () => {
  it("[SPRE-01] static prerender routes, lists of paths, ssr = false shells and explicit routes", () => {
    const scan = scanOf(
      entry("/about", "about.tsx", { prerender: true }),
      entry("/", "index.tsx", { ssr: false }),
      entry("/docs/:slug", "docs/[slug].tsx", { prerender: ["/docs/intro", "/docs/api"] }),
      entry("/plain", "plain.tsx"),
      entry("/layout", "_layout.tsx", { prerender: true }, "layout"),
    );
    const targets = prerenderTargets(scan, { routes: ["/extra", "/about"] });
    expect(targets).toEqual([
      { path: "/", shell: true },
      { path: "/about", shell: false },
      { path: "/docs/api", shell: false },
      { path: "/docs/intro", shell: false },
      { path: "/extra", shell: false },
    ]);
  });

  it("[SPRE-02] prerender = true on a route with params, or an optional segment, names the route", () => {
    expect(() =>
      prerenderTargets(scanOf(entry("/u/:id", "u/[id].tsx", { prerender: true })), {}),
    ).toThrow(PrerenderError);
    expect(() =>
      prerenderTargets(scanOf(entry("/:lang?/x", "x.tsx", { prerender: true })), {}),
    ).toThrow(/params/);
    expect(() =>
      prerenderTargets(scanOf(entry("/files/*rest", "f.tsx", { prerender: true })), {}),
    ).toThrow(/u\/|files|params/);
  });

  const CLIENT = join(tmpdir(), "client");
  it.each([
    ["/", "index.html"],
    ["/about", "about/index.html"],
    ["/a/b/c", "a/b/c/index.html"],
    ["/caf%C3%A9", "caf\u00e9/index.html"],
    ["/with%20space", "with space/index.html"],
    ["/trailing/", "trailing/index.html"],
  ])("[SPRE-03] %s is written to %s", (path, expected) => {
    expect(prerenderFile(CLIENT, path)).toBe(join(CLIENT, expected));
  });

  it.each<[string, string]>([
    ["a path without a leading slash", "about"],
    ["a parent segment", "/.."],
    ["parents that climb out", "/a/../../etc"],
    ["an encoded parent", "/%2e%2e/x"],
    ["an encoded slash", "/a%2f..%2fb"],
    ["an encoded backslash", "/a%5c..%5cb"],
    ["an encoded NUL", "/a%00b"],
    ["a malformed escape", "/%E0%A4%A"],
    ["a segment of 201 characters", `/${"x".repeat(201)}`],
    ["a path longer than 1000 characters", `/${"a/".repeat(600)}`],
    ["a drive letter", "/c:/windows"],
    ["an encoded colon", "/a%3Ab"],
  ])("[SPRE-04] %s cannot be written", (_label, path) => {
    expect(() => prerenderFile(CLIENT, path)).toThrow(PrerenderError);
  });
});

describe("prerenderPages", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fakeServer(source: string): { entry: string; clientDir: string } {
    const dir = mkdtempSync(join(tmpdir(), "shadow-prerender-"));
    dirs.push(dir);
    mkdirSync(join(dir, "server"));
    const entryFile = join(dir, "server", "entry.mjs");
    writeFileSync(entryFile, source);
    return { entry: entryFile, clientDir: join(dir, "client") };
  }

  const OK = `export const handler = { fetch: async (request) => new Response("<html>" + new URL(request.url).pathname + "</html>", { status: new URL(request.url).pathname === "/missing" ? 404 : 200 }), renderShell: async () => new Response("<html>shell</html>") };`;

  it("[SPRE-10] renders pages and shells with the handler and writes them", async () => {
    const { entry: entryFile, clientDir } = fakeServer(OK);
    const done = await prerenderPages({
      entryFile,
      clientDir,
      targets: [
        { path: "/", shell: false },
        { path: "/a", shell: false },
        { path: "/spa", shell: true },
      ],
      options: {},
      base: "",
    });
    expect(done).toEqual(["/", "/a", "/spa"]);
    expect(readFileSync(join(clientDir, "index.html"), "utf8")).toBe("<html>/</html>");
    expect(readFileSync(join(clientDir, "a", "index.html"), "utf8")).toBe("<html>/a</html>");
    expect(readFileSync(join(clientDir, "spa", "index.html"), "utf8")).toBe("<html>shell</html>");
  });

  it("[SPRE-11] a non-200 answer fails the build unless failOnError is false", async () => {
    const { entry: entryFile, clientDir } = fakeServer(OK);
    const input = {
      entryFile,
      clientDir,
      targets: [
        { path: "/missing", shell: false },
        { path: "/a", shell: false },
      ],
      base: "",
    };
    await expect(prerenderPages({ ...input, options: {} })).rejects.toThrow(/answered 404/);
    const done = await prerenderPages({ ...input, options: { failOnError: false } });
    expect(done).toEqual(["/a"]);
  });

  /** A handler that answers 400 for a host outside its list, like the real host check. */
  const HOSTED = `const allowedHosts = ["*.cdn.example", "www.example.com"];
export const handler = {
  allowedHosts,
  fetch: async (request) => {
    const host = new URL(request.url).host;
    return host === "www.example.com" ? new Response("<html>" + host + "</html>") : new Response("no", { status: 400 });
  },
};`;

  it("[SPRH-10] with allowedHosts that lack localhost, the build renders from the first plain listed host", async () => {
    const { entry: entryFile, clientDir } = fakeServer(HOSTED);
    const done = await prerenderPages({
      entryFile,
      clientDir,
      targets: [{ path: "/a", shell: false }],
      options: {},
      base: "",
    });
    expect(done).toEqual(["/a"]);
    expect(readFileSync(join(clientDir, "a", "index.html"), "utf8")).toBe(
      "<html>www.example.com</html>",
    );
  });

  it("[SPRH-11] an explicit origin that the host check refuses names allowedHosts and the host used", async () => {
    const { entry: entryFile, clientDir } = fakeServer(HOSTED);
    const error = await prerenderPages({
      entryFile,
      clientDir,
      targets: [{ path: "/x", shell: false }],
      options: { origin: "http://staging.test" },
      base: "",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrerenderError);
    const message = (error as Error).message;
    expect(message).toContain('"/x" answered 400');
    expect(message).toContain("security.allowedHosts");
    expect(message).toContain("staging.test");
    expect(message).toContain("www.example.com");
  });

  it("[SPRH-12] a list of wildcards only names allowedHosts instead of guessing a host", async () => {
    const { entry: entryFile, clientDir } = fakeServer(
      `export const handler = { allowedHosts: ["*.example.com"], fetch: async () => new Response("no", { status: 400 }) };`,
    );
    await expect(
      prerenderPages({
        entryFile,
        clientDir,
        targets: [{ path: "/x", shell: false }],
        options: {},
        base: "",
      }),
    ).rejects.toThrow(/security\.allowedHosts.*only wildcard/);
  });

  it("[SPRH-13] a 400 from a handler without a host list keeps the plain message", async () => {
    const { entry: entryFile, clientDir } = fakeServer(
      `export const handler = { fetch: async () => new Response("no", { status: 400 }) };`,
    );
    await expect(
      prerenderPages({
        entryFile,
        clientDir,
        targets: [{ path: "/x", shell: false }],
        options: {},
        base: "",
      }),
    ).rejects.toThrow(/"\/x" answered 400/);
  });

  it("[SPRE-12] the base is part of the request URL", async () => {
    const { entry: entryFile, clientDir } = fakeServer(OK);
    await prerenderPages({
      entryFile,
      clientDir,
      targets: [{ path: "/a", shell: false }],
      options: {},
      base: "/app",
    });
    expect(readFileSync(join(clientDir, "a", "index.html"), "utf8")).toBe("<html>/app/a</html>");
  });

  it("[SPRE-13] a server entry without a handler is reported", async () => {
    const { entry: entryFile, clientDir } = fakeServer("export const nothing = 1;");
    await expect(
      prerenderPages({
        entryFile,
        clientDir,
        targets: [{ path: "/", shell: false }],
        options: {},
        base: "",
      }),
    ).rejects.toThrow(/does not export a handler/);
  });

  it("[SPRE-14] no targets means the server entry is not even loaded", async () => {
    const done = await prerenderPages({
      entryFile: pathToFileURL("/nonexistent.mjs").pathname,
      clientDir: "/x",
      targets: [],
      options: {},
      base: "",
    });
    expect(done).toEqual([]);
  });

  it("[SPRE-15] concurrency is bounded by the option", async () => {
    const active = 0;
    let peak = 0;
    const source = `let active = 0; export const handler = { fetch: async () => { globalThis.__peak ??= 0; active += 1; globalThis.__peak = Math.max(globalThis.__peak, active); await new Promise((resolve) => setImmediate(resolve)); active -= 1; return new Response("ok"); } };`;
    const { entry: entryFile, clientDir } = fakeServer(source);
    const targets = Array.from({ length: 12 }, (_, index) => ({
      path: `/p${index}`,
      shell: false,
    }));
    await prerenderPages({ entryFile, clientDir, targets, options: { concurrency: 3 }, base: "" });
    peak = (globalThis as { __peak?: number }).__peak ?? 0;
    void active;
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});

// ---- [A3] prerender params, crawling, retry and hooks ---------------------------------------

/** A route entry with a parent, a full path and (optionally) a `prerender` function export. */
function routeWith(
  id: string,
  file: string,
  options: {
    readonly kind?: "page" | "layout";
    readonly parentId?: string;
    readonly fn?: boolean;
    readonly config?: RouteEntry["info"]["config"];
  } = {},
): RouteEntry {
  const base = entry(id, file, options.config ?? {}, options.kind ?? "page");
  return {
    ...base,
    fullPath: id,
    parentId: options.parentId,
    info: { ...base.info, exports: options.fn === true ? ["default", "prerender"] : ["default"] },
  };
}

describe("prerender params: route functions feed nested routes", () => {
  it("[A3-P2] a layout's function feeds the routes below it, and each function receives its parent's params", async () => {
    const calls: Record<string, string>[] = [];
    const scan = scanOf(
      routeWith("/:lang/_layout", "[lang]/_layout.tsx", { kind: "layout", fn: true }),
      routeWith("/:lang/posts/:id", "[lang]/posts/[id].tsx", {
        parentId: "/:lang/_layout",
        fn: true,
      }),
      routeWith("/:lang/about", "[lang]/about.tsx", { parentId: "/:lang/_layout" }),
    );
    const loaders: PrerenderRouteLoader[] = [
      {
        id: "/:lang/_layout",
        load:
          async () =>
          async ({ params }: { params: Record<string, string> }) => {
            calls.push(params);
            return [{ lang: "en" }, { lang: "ar" }];
          },
      },
      {
        id: "/:lang/posts/:id",
        load:
          async () =>
          async ({ params }: { params: Record<string, string> }) => {
            calls.push(params);
            return params["lang"] === "en" ? [{ id: "1" }] : [{ id: "2" }];
          },
      },
    ];
    const targets = await resolvePrerenderTargets({ scan, options: {}, loaders });
    expect(targets.map((target) => target.path)).toEqual([
      "/ar/about",
      "/ar/posts/2",
      "/en/about",
      "/en/posts/1",
    ]);
    expect(calls).toEqual([{}, { lang: "en" }, { lang: "ar" }]);
  });

  it("[A3-P2] a function that returns something other than param objects fails, naming the route and file", async () => {
    const scan = scanOf(routeWith("/posts/:id", "posts/[id].tsx", { fn: true }));
    const loaders: PrerenderRouteLoader[] = [
      { id: "/posts/:id", load: async () => async () => ["1", "2"] },
    ];
    await expect(resolvePrerenderTargets({ scan, options: {}, loaders })).rejects.toThrow(
      /posts\/\[id\]\.tsx[\s\S]*array of param objects/,
    );
  });

  it("[A3-P2] a value the route's own function leaves out of its path fails, naming the param", async () => {
    const scan = scanOf(routeWith("/posts/:id", "posts/[id].tsx", { fn: true }));
    const loaders: PrerenderRouteLoader[] = [
      { id: "/posts/:id", load: async () => async () => [{}] },
    ];
    await expect(resolvePrerenderTargets({ scan, options: {}, loaders })).rejects.toThrow(
      /"id"[\s\S]*posts\/\[id\]\.tsx/,
    );
  });

  it("[A3-P2] a page without a function under a function layout is skipped when it has a param the layout does not give", async () => {
    const scan = scanOf(
      routeWith("/:lang/_layout", "[lang]/_layout.tsx", { kind: "layout", fn: true }),
      routeWith("/:lang/posts/:id", "[lang]/posts/[id].tsx", { parentId: "/:lang/_layout" }),
    );
    const loaders: PrerenderRouteLoader[] = [
      { id: "/:lang/_layout", load: async () => async () => [{ lang: "en" }] },
    ];
    const targets = await resolvePrerenderTargets({ scan, options: {}, loaders });
    expect(targets).toEqual([]);
  });

  it("[A3-P2] options.entries adds paths, as a list or from a function", async () => {
    const scan = scanOf(routeWith("/about", "about.tsx"));
    const fromList = await resolvePrerenderTargets({
      scan,
      options: { entries: ["/x"] },
      loaders: [],
    });
    expect(fromList.map((target) => target.path)).toEqual(["/x"]);
    const fromFunction = await resolvePrerenderTargets({
      scan,
      options: { entries: async () => ["/y"] },
      loaders: [],
    });
    expect(fromFunction.map((target) => target.path)).toEqual(["/y"]);
  });
});

describe("prerender crawling: internal links", () => {
  it("[A3-P3] internalLinks keeps same-origin paths, drops the query and fragment, and skips files and external links", () => {
    const html = [
      '<a href="/a">a</a>',
      '<a href="/b?q=1#x">b</a>',
      '<a href="https://example.com/">e</a>',
      '<a href="//cdn.example/x">cdn</a>',
      '<a href="#top">top</a>',
      '<a href="/logo.png">logo</a>',
      "<a href='/single'>s</a>",
      "<a href=/unquoted>u</a>",
      '<a href="/a">again</a>',
      '<a href="mailto:me@example.com">m</a>',
    ].join("");
    expect(internalLinks(html, new URL("http://localhost/"), "http://localhost", "")).toEqual([
      "/a",
      "/b",
      "/single",
      "/unquoted",
    ]);
  });

  it("[A3-P3] with a base, only links under the base are kept, and the base is removed from them", () => {
    const html = '<a href="/app/c">c</a><a href="/a">a</a><a href="/app">home</a>';
    expect(
      internalLinks(html, new URL("http://localhost/app/"), "http://localhost", "/app"),
    ).toEqual(["/", "/c"]);
  });
});

describe("prerenderPages: crawl, filter, retry, hooks and failure reports", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A fake site. `/flaky` answers 500 on its first request of each module instance, then 200. `/gone`
   * and `/missing` are 404. Every other path answers the links listed for it, if any.
   */
  const SITE = `const links = {
  "/": '<a href="/a">a</a><a href="/z1">z1</a><a href="/z2">z2</a><a href="https://example.com/x">x</a><a href="/logo.png">img</a>',
  "/a": '<a href="/b?q=1">b</a><a href="#top">top</a>',
  "/b": '<a href="/c">c</a>',
  "/c": "<p>end</p>",
};
let flaky = 0;
export const handler = {
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/gone" || path === "/missing") return new Response("nope", { status: 404 });
    if (path === "/flaky") {
      flaky += 1;
      return new Response("<p>flaky</p>", { status: flaky === 1 ? 500 : 200, headers: { "content-type": "text/html" } });
    }
    const body = links[path] ?? "<p>" + path + "</p>";
    return new Response("<html>" + body + "</html>", { status: 200, headers: { "content-type": "text/html" } });
  },
  renderShell: async () => new Response("<html>shell</html>"),
};`;

  function site(): { entryFile: string; clientDir: string } {
    const dir = mkdtempSync(join(tmpdir(), "shadow-crawl-"));
    dirs.push(dir);
    mkdirSync(join(dir, "server"));
    const entryFile = join(dir, "server", "entry.mjs");
    writeFileSync(entryFile, SITE);
    return { entryFile, clientDir: join(dir, "client") };
  }

  const start = (...paths: string[]) => paths.map((path) => ({ path, shell: false }));

  it("[A3-P3] crawlLinks follows internal links one hop per depth, and only that far", async () => {
    const at = (depth: number) =>
      prerenderPages({
        ...site(),
        targets: start("/"),
        options: depth === 0 ? {} : { crawlLinks: { depth } },
        base: "",
      });
    expect(await at(0)).toEqual(["/"]);
    expect(await at(1)).toEqual(["/", "/a", "/z1", "/z2"]);
    expect(await at(2)).toEqual(["/", "/a", "/b", "/z1", "/z2"]);
    expect(await at(3)).toEqual(["/", "/a", "/b", "/c", "/z1", "/z2"]);
  });

  it("[A3-P3] without crawlLinks nothing beyond the listed paths is written", async () => {
    const done = await prerenderPages({ ...site(), targets: start("/"), options: {}, base: "" });
    expect(done).toEqual(["/"]);
  });

  it("[A3-P3] crawlLinks.limit caps the number of crawled pages, in sorted order", async () => {
    const done = await prerenderPages({
      ...site(),
      targets: start("/"),
      options: { crawlLinks: { depth: 5, limit: 2 } },
      base: "",
    });
    expect(done).toEqual(["/", "/a", "/z1"]);
  });

  it("[A3-P4] filter keeps a path out, and the links behind it are never reached", async () => {
    const done = await prerenderPages({
      ...site(),
      targets: start("/", "/a"),
      options: { crawlLinks: { depth: 5 }, filter: (path) => path !== "/a" },
      base: "",
    });
    expect(done).toContain("/");
    expect(done).not.toContain("/a");
    expect(done).not.toContain("/b");
    expect(done).toContain("/z1");
  });

  it("[A3-P4] retry: a failing answer is retried; without retry it fails the run", async () => {
    const withRetry = await prerenderPages({
      ...site(),
      targets: start("/flaky"),
      options: { retry: 1 },
      base: "",
    });
    expect(withRetry).toEqual(["/flaky"]);
    await expect(
      prerenderPages({ ...site(), targets: start("/flaky"), options: {}, base: "" }),
    ).rejects.toThrow(/\/flaky[\s\S]*answered 500/);
  });

  it("[A3-P5] onSuccess is called for every written page; onError for every failed explicit path", async () => {
    const succeeded: string[] = [];
    const failed: string[] = [];
    await expect(
      prerenderPages({
        ...site(),
        targets: start("/a", "/gone"),
        options: {
          onSuccess: (page) => void succeeded.push(`${page.path}:${page.status}`),
          onError: (failure) => void failed.push(failure.path),
        },
        base: "",
      }),
    ).rejects.toThrow(/\/gone/);
    expect(succeeded).toEqual(["/a:200"]);
    expect(failed).toEqual(["/gone"]);
  });

  it("[A3-P6] a failed run reports every failing path, sorted, and says how to fix it", async () => {
    const error = await prerenderPages({
      ...site(),
      targets: start("/missing", "/gone"),
      options: {},
      base: "",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PrerenderError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(/2 pages failed[\s\S]*\/gone[\s\S]*\/missing/);
    expect(message).toMatch(/failOnError|filter/);
  });

  it("[A3-P7] the result does not depend on concurrency", async () => {
    const options = { crawlLinks: { depth: 3 } };
    const one = await prerenderPages({
      ...site(),
      targets: start("/"),
      options: { ...options, concurrency: 1 },
      base: "",
    });
    const four = await prerenderPages({
      ...site(),
      targets: start("/"),
      options: { ...options, concurrency: 4 },
      base: "",
    });
    expect(four).toEqual(one);
  });
});
