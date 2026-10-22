import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRoutes } from "@shadow-js/router/vite";
import { afterEach, describe, expect, it } from "vitest";
import { routeMiddlewareSource } from "../../src/vite/route-middleware";
import { serverEntrySource } from "../../src/vite/virtual";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PAGE = "export default function Page() { return null; }\n";
const MIDDLEWARE = "export const middleware = [async (_event, next) => next()];\n";

function routesOf(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dusk-middleware-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

describe("route middleware source", () => {
  it("[DMW-1] each page and API route lists the _middleware folders above it, outermost first, and only those", async () => {
    const root = routesOf({
      "_middleware.ts": MIDDLEWARE,
      "index.tsx": PAGE,
      "public.tsx": PAGE,
      "admin/_middleware.ts": MIDDLEWARE,
      "admin/users/[id].tsx": PAGE,
      "admin/users/_middleware.ts": MIDDLEWARE,
      "api/admin/stats.ts": "export const GET = () => new Response('ok');",
      "api/open.ts": "export const GET = () => new Response('ok');",
    });
    const scan = await scanRoutes({ routesDir: root });
    const source = routeMiddlewareSource(scan);
    expect(source.directories.map((entry) => entry.key).sort()).toEqual([
      "",
      "admin",
      "admin/users",
    ]);
    expect(source.pages).toEqual(
      expect.arrayContaining([
        { id: "/", folders: [""] },
        { id: "/public", folders: [""] },
        { id: "/admin/users/:id", folders: ["", "admin", "admin/users"] },
      ]),
    );
    // `api/admin/stats.ts` sits in `api/admin`, which has no _middleware: only the root applies.
    expect(source.apis).toEqual(
      expect.arrayContaining([
        { id: "/api/admin/stats", folders: [""] },
        { id: "/api/open", folders: [""] },
      ]),
    );
  });

  it("[DMW-2] a route that exports middleware is a route-level module; folders with no middleware are not listed", async () => {
    const root = routesOf({
      "admin/_layout.tsx": `${PAGE}${MIDDLEWARE}`,
      "admin/users.tsx": PAGE,
      "open/page.tsx": PAGE,
    });
    const scan = await scanRoutes({ routesDir: root });
    const source = routeMiddlewareSource(scan);
    expect(source.routes.map((entry) => entry.key)).toEqual(["/admin/_layout"]);
    expect(source.directories).toEqual([]);
    expect(source.pages).toEqual([]);
  });
});

describe("server entry with middleware", () => {
  it("[DMW-3] the server entry imports each middleware module lazily and puts the folder chains in the manifest", async () => {
    const root = routesOf({
      "_middleware.ts": MIDDLEWARE,
      "admin/_layout.tsx": `${PAGE}${MIDDLEWARE}`,
      "admin/users.tsx": PAGE,
    });
    const scan = await scanRoutes({ routesDir: root });
    const text = serverEntrySource({
      dev: false,
      base: "",
      generatedTree: join(root, "routeTree.gen.ts"),
      appFile: undefined,
      entryServerFile: undefined,
      apiRoutes: [],
      streams: [],
      serverFns: [],
      middleware: routeMiddlewareSource(scan),
      assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
    });
    expect(text).toContain('"/admin/_layout": { load: () => import(');
    expect(text).toContain('"": { load: () => import(');
    // The page sits in `admin`, which has no _middleware here: only the routes root applies to it.
    expect(text).toContain('"/admin/users": [""],');
    expect(text).toContain(
      "export const manifest = { routes: routeTree, apiRoutes, streams, serverFns, assets, App, middleware };",
    );
  });

  it("[DMW-4] without a middleware source the manifest is the same as before (no middleware key)", () => {
    const text = serverEntrySource({
      dev: false,
      base: "",
      generatedTree: "/app/routeTree.gen.ts",
      appFile: undefined,
      entryServerFile: undefined,
      apiRoutes: [],
      streams: [],
      serverFns: [],
      assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
    });
    expect(text).toContain(
      "export const manifest = { routes: routeTree, apiRoutes, streams, serverFns, assets, App };",
    );
    expect(text).not.toContain("const middleware");
  });
});
