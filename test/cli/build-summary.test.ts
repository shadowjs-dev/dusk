/**
 * The facts of `dusk build`'s summary, from a client folder and a manifest (`build-summary.ts`, `manifest.ts`).
 *
 * - CLI-24 each page's first-load JavaScript is the gzip size of its entry, its stylesheets and its route's chunks; the
 *   shared row is the entry and the stylesheets; an API route loads nothing.
 * - CLI-25 the kind of a page: static (file) (prerendered, also for a pattern whose instance is prerendered), ISR with its
 *   revalidate, client (`ssr = false`), dynamic otherwise. Middleware counts the `_middleware` files above a route.
 * - CLI-26 budgets: a page over `firstLoadJs` (or its own route budget) gets a warning; a route budget for a path that
 *   no page has gets a warning. The manifest reader takes a manifest with and without the newer fields.
 * - CLI-44 each row names its family (the symbol of the table), the size only its page loads, and whether it is over its
 *   budget; a file shared by many routes is read once, and no more than READ_CONCURRENCY files are read at a time.
 * - CLI-27 a prerendered page the handler answers is `static (via handler)`; a page that is a file is `static (file)`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { READ_CONCURRENCY, summarizeBuild } from "../../src/cli/build-summary";
import { readBuildManifest } from "../../src/cli/manifest";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A client folder with the given files (relative paths), and the gzip size of each. */
function clientFolder(files: Record<string, string>): {
  dir: string;
  gzip: (file: string) => number;
} {
  const dir = mkdtempSync(join(tmpdir(), "dusk-summary-"));
  made.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return {
    dir,
    gzip: (file) => gzipSync(Buffer.from(files[file] ?? "")).length,
  };
}

const FILES = {
  "assets/entry.js": "export const entry = 'x'.repeat(4000);\n",
  "assets/index.css": "body { margin: 0; }\n",
  "assets/home.js": "export const home = 'y'.repeat(2000);\n",
  "assets/post.js": "export const post = 'z'.repeat(3000);\n",
  "assets/feed.js": "export const feed = 'w'.repeat(1000);\n",
};

function manifestOf(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    entry: "assets/entry.js",
    css: ["assets/index.css"],
    routes: {
      "/": { kind: "page", file: "src/routes/index.tsx", path: "/", preload: ["assets/home.js"] },
      "/posts/:id": {
        kind: "page",
        file: "src/routes/posts/[id].tsx",
        path: "/posts/:id",
        preload: ["assets/post.js"],
        prerender: true,
      },
      "/feed": {
        kind: "page",
        file: "src/routes/feed.tsx",
        path: "/feed",
        preload: ["assets/feed.js"],
        revalidate: 60,
      },
      "/admin": {
        kind: "page",
        file: "src/routes/admin/index.tsx",
        path: "/admin",
        preload: [],
      },
      "/app": { kind: "page", file: "src/routes/app.tsx", path: "/app", preload: [], ssr: false },
      "/_layout": { kind: "layout", file: "src/routes/_layout.tsx", path: "/", preload: [] },
    },
    api: [{ id: "/api/env", file: "src/routes/api/env.ts", methods: ["GET"] }],
    streams: [{ id: "/events", path: "/events", kinds: ["SSE"] }],
    middleware: [
      { file: "src/routes/_middleware.ts" },
      { file: "src/routes/admin/_middleware.ts" },
    ],
    prerendered: ["/", "/posts/1", "/posts/2"],
    ...extra,
  };
}

describe("dusk build summary", () => {
  it("[CLI-24] first-load sizes are gzip sizes of the entry, the stylesheets and the route's chunks", async () => {
    const { dir, gzip } = clientFolder(FILES);
    const manifestFile = join(dir, "dusk-manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifestOf()));
    const manifest = await readBuildManifest(manifestFile);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const summary = await summarizeBuild({
      version: "0.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: undefined,
      ms: 10,
    });
    const shared = gzip("assets/entry.js") + gzip("assets/index.css");
    expect(summary.shared).toEqual({ bytes: shared, files: 2 });
    const home = summary.routes.find((row) => row.path === "/");
    expect(home?.bytes).toBe(shared + gzip("assets/home.js"));
    // The API route has no JavaScript of its own: it is listed, with zero bytes.
    expect(summary.routes.find((row) => row.path === "/api/env")).toMatchObject({
      kind: "API",
      bytes: 0,
    });
    expect(summary.routes.find((row) => row.path === "/events")).toMatchObject({
      kind: "stream SSE",
      bytes: 0,
    });
  });

  it("[CLI-25] a page's kind: static file (also a pattern with a prerendered instance), ISR, client, dynamic", async () => {
    const { dir } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(file, JSON.stringify(manifestOf()));
    const manifest = await readBuildManifest(file);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const summary = await summarizeBuild({
      version: "0.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: undefined,
      ms: 1,
    });
    const kindOf = (path: string): string | undefined =>
      summary.routes.find((row) => row.path === path)?.kind;
    expect(kindOf("/")).toBe("static (file)");
    expect(kindOf("/posts/:id")).toBe("static (file)");
    expect(kindOf("/feed")).toBe("ISR 60s");
    expect(kindOf("/app")).toBe("client");
    expect(kindOf("/admin")).toBe("dynamic");
    // Layouts are not listed: they are not pages.
    expect(kindOf("/_layout")).toBeUndefined();
  });

  it("[CLI-27] a prerendered page the handler answers (its rules apply) is `static (via handler)`; a file is `static (file)`", async () => {
    const { dir } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    const staticPages = [
      {
        path: "/",
        mode: "handler",
        headers: [],
        httpsHeaders: [],
        reason: "a global middleware runs",
      },
      {
        path: "/posts/1",
        mode: "static",
        headers: [["x-frame-options", "DENY"]],
        httpsHeaders: [],
        reason: undefined,
      },
      { path: "/posts/2", mode: "static", headers: [], httpsHeaders: [], reason: undefined },
    ];
    writeFileSync(file, JSON.stringify(manifestOf({ staticPages })));
    const manifest = await readBuildManifest(file);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const summary = await summarizeBuild({
      version: "0.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: undefined,
      ms: 1,
    });
    const kindOf = (path: string): string | undefined =>
      summary.routes.find((row) => row.path === path)?.kind;
    expect(kindOf("/")).toBe("static (via handler)");
    expect(kindOf("/posts/:id")).toBe("static (file)");
    const plain = join(dir, "dusk-manifest-plain.json");
    writeFileSync(
      plain,
      JSON.stringify(
        manifestOf({ prerendered: ["/", "/posts/1"], staticPages: staticPages.slice(1, 2) }),
      ),
    );
    const plainManifest = await readBuildManifest(plain);
    if (plainManifest === undefined) throw new Error("the manifest was not read");
    const fileOnly = await summarizeBuild({
      version: "0.0.0",
      manifest: plainManifest,
      clientDir: dir,
      report: undefined,
      budgets: undefined,
      ms: 1,
    });
    expect(fileOnly.routes.find((row) => row.path === "/")?.kind).toBe("static (file)");
  });

  it("[CLI-25] middleware counts the _middleware files of the route's folder and above it", async () => {
    const { dir } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(file, JSON.stringify(manifestOf()));
    const manifest = await readBuildManifest(file);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const summary = await summarizeBuild({
      version: "0.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: undefined,
      ms: 1,
    });
    const middleware = (path: string): number | undefined =>
      summary.routes.find((row) => row.path === path)?.middleware;
    expect(middleware("/")).toBe(1);
    expect(middleware("/admin")).toBe(2);
    expect(middleware("/feed")).toBe(1);
  });

  it("[CLI-26] budgets warn for a page over firstLoadJs or over its own route budget, and name a route that is not there", async () => {
    const { dir } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(file, JSON.stringify(manifestOf()));
    const manifest = await readBuildManifest(file);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const summary = await summarizeBuild({
      version: "0.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: { firstLoadJs: 100, routes: { "/feed": 1_000_000, "/nowhere": 5 } },
      ms: 1,
    });
    const warnings = summary.warnings.join("\n");
    expect(warnings).toContain("/ loads");
    expect(warnings).toContain("over its budget of 0.1 kB (build.budgets in dusk.config.ts)");
    // The feed has its own, larger budget: no warning for it.
    expect(warnings).not.toContain("/feed loads");
    expect(warnings).toContain("build.budgets.routes names /nowhere, but no page has that path.");
  });

  it("[CLI-26] a manifest written before the newer fields still reads (no routes' paths, streams or middleware)", async () => {
    const { dir } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entry: "assets/entry.js",
        css: [],
        routes: { "/": { kind: "page", file: "src/routes/index.tsx", preload: [] } },
        api: [],
        prerendered: [],
        adapter: { name: "node", outDir: "dist/node" },
      }),
    );
    const manifest = await readBuildManifest(file);
    expect(manifest?.routes["/"]).toMatchObject({ kind: "page", path: "/", preload: [] });
    expect(manifest?.streams).toEqual([]);
    expect(manifest?.middleware).toEqual([]);
    expect(manifest?.adapter).toEqual({ name: "node", outDir: "dist/node" });
  });

  it("[DP-M2] a route's dynamicParams is read as a boolean; any other value is left out", async () => {
    const { dir } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entry: "assets/entry.js",
        css: [],
        routes: {
          "/a/:id": {
            kind: "page",
            file: "a.tsx",
            path: "/a/:id",
            preload: [],
            dynamicParams: false,
          },
          "/b/:id": {
            kind: "page",
            file: "b.tsx",
            path: "/b/:id",
            preload: [],
            dynamicParams: "no",
          },
        },
        api: [],
        prerendered: [],
      }),
    );
    const manifest = await readBuildManifest(file);
    expect(manifest?.routes["/a/:id"]?.dynamicParams).toBe(false);
    expect(Object.hasOwn(manifest?.routes["/b/:id"] ?? {}, "dynamicParams")).toBe(false);
  });

  it("[CLI-44] a row names its family, the size only its page loads, and whether it is over its budget", async () => {
    const { dir, gzip } = clientFolder(FILES);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(file, JSON.stringify(manifestOf()));
    const manifest = await readBuildManifest(file);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const summary = await summarizeBuild({
      version: "1.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: { routes: { "/": 1 } },
      ms: 1,
    });
    const rowOf = (path: string) => summary.routes.find((row) => row.path === path);
    expect(rowOf("/")).toMatchObject({
      family: "static",
      size: gzip("assets/home.js"),
      overBudget: true,
    });
    expect(rowOf("/feed")).toMatchObject({ family: "isr", overBudget: false });
    expect(rowOf("/app")?.family).toBe("client");
    expect(rowOf("/admin")?.family).toBe("dynamic");
    expect(rowOf("/api/env")?.family).toBe("api");
    expect(rowOf("/events")?.family).toBe("stream");
    // A page with no chunk of its own loads nothing beyond the shell.
    expect(rowOf("/admin")?.size).toBe(0);
  });

  it("[CLI-44] a file shared by many routes is read once, and the reads are bounded", async () => {
    const chunks = 200;
    const files: Record<string, string> = { ...FILES };
    const routes: Record<string, unknown> = {};
    for (let index = 0; index < chunks; index += 1) {
      files[`assets/c${index}.js`] = `export const c${index} = ${index};\n`;
      routes[`/p${index}`] = {
        kind: "page",
        file: `src/routes/p${index}.tsx`,
        path: `/p${index}`,
        preload: [`assets/c${index}.js`, "assets/home.js"],
      };
    }
    const { dir } = clientFolder(files);
    const file = join(dir, "dusk-manifest.json");
    writeFileSync(file, JSON.stringify(manifestOf({ routes })));
    const manifest = await readBuildManifest(file);
    if (manifest === undefined) throw new Error("the manifest was not read");
    const reads = new Map<string, number>();
    let active = 0;
    let peak = 0;
    const summary = await summarizeBuild({
      version: "1.0.0",
      manifest,
      clientDir: dir,
      report: undefined,
      budgets: undefined,
      ms: 1,
      read: async (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        active += 1;
        peak = Math.max(peak, active);
        // Let the other reads start, so a missing bound shows.
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return readFileSync(path);
      },
    });
    expect(summary.routes.filter((row) => row.family === "dynamic")).toHaveLength(chunks);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    // entry, stylesheet, home.js and the 200 chunks.
    expect(reads.size).toBe(chunks + 3);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(READ_CONCURRENCY);
  });
});
