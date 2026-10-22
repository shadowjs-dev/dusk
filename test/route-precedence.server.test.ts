import { describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskRuntimeManifest,
  type Middleware,
  rewrite,
} from "../src/server/index";
import { errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/*
 * Precedence between API routes, stream routes and pages: the most
 * specific pattern answers, whatever its kind (a static segment beats a param, a param beats a splat). Two routes of
 * equal specificity (the same path) are told apart by the method: the API route answers the methods it exports, the
 * page answers GET and HEAD. A `_`-prefixed segment makes a route private: a request from outside never reaches it,
 * and a middleware rewrite (`rewrite()`) to it does.
 */

const APP_SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { apiRoute, json } from "@start/server";

const preview = defineRoute("/f/:id/preview", { id: "preview", component: () => <p class="preview">preview page</p> });
const contact = defineRoute("/contact", { id: "contact", component: () => <p class="contact">contact page</p> });
const privatePreview = defineRoute("/_preview/:id", { id: "private-preview", component: () => <p class="private-preview">private preview</p> });
const root = defineRoute("", { id: "root", component: function Root() { return <main class="root"><Outlet /></main>; }, children: [preview, contact, privatePreview] });
export const routes = [root];
export function App(props) { return <div class="app">{props.children}</div>; }

export const file = apiRoute({ GET: (event) => json({ api: "file", id: event.params.id ?? null, name: event.params.name ?? null }) });
export const contactApi = apiRoute({ POST: () => json({ api: "contact-post" }) });
export const internal = apiRoute({ GET: () => json({ api: "internal" }) });
export const filtered = apiRoute({ GET: (event) => json({ api: "filtered", id: event.params.id ?? null }) });
export const dynamicFile = apiRoute({ GET: (event) => json({ api: "dynamic", name: event.params.name ?? null }) });
`;

/** The manifest of the precedence app: pages from the module, the API routes listed here. */
async function boot(
  apiRoutes: DuskRuntimeManifest["apiRoutes"],
  middleware: Middleware[] = [],
): Promise<{
  fetch(url: string, init?: RequestInit): Promise<Response>;
  log: ReturnType<typeof errorLog>;
}> {
  const app = await load<{
    routes: DuskRuntimeManifest["routes"];
    App: DuskRuntimeManifest["App"];
    [name: string]: unknown;
  }>(APP_SOURCE);
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes,
      serverFns: {},
      assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
      App: app.App,
    },
    dev: true,
    onError: log.onError,
    middleware,
  });
  return {
    log,
    fetch: (url, init) => handler.fetch(new Request(`http://localhost${url}`, init)),
  };
}

const lazy = (module: unknown) => ({ load: async () => module as never });

async function standard(middleware: Middleware[] = []): Promise<Awaited<ReturnType<typeof boot>>> {
  const app = await load<Record<string, unknown>>(APP_SOURCE);
  return boot(
    [
      { id: "file", path: "/f/:id/:name", load: lazy(app["file"]).load },
      { id: "contact-api", path: "/contact", load: lazy(app["contactApi"]).load },
      { id: "internal", path: "/_internal/ping", load: lazy(app["internal"]).load },
      {
        id: "filtered",
        path: "/api/filtered/:id",
        matchFilters: { id: /^\d+$/ },
        load: lazy(app["filtered"]).load,
      },
    ],
    middleware,
  );
}

describe("route precedence between API routes and pages", () => {
  it("[PRE-1] a static page beats an API route with a param at the same segment (GET)", async () => {
    const app = await standard();
    const response = await app.fetch("/f/1/preview");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('class="preview"');
  });

  it("[PRE-2] the API route answers the path the page does not claim", async () => {
    const app = await standard();
    const response = await app.fetch("/f/1/other");
    expect(await response.json()).toEqual({ api: "file", id: "1", name: "other" });
  });

  it("[PRE-3] the more specific page answers every method it does not handle with 405 (no fall through)", async () => {
    const app = await standard();
    const response = await app.fetch("/f/1/preview", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("[PRE-4] HEAD on the page answers the page's status and headers without a body; OPTIONS answers 204 with Allow", async () => {
    const app = await standard();
    const get = await app.fetch("/f/1/preview");
    const head = await app.fetch("/f/1/preview", { method: "HEAD" });
    expect(head.status).toBe(get.status);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
    const options = await app.fetch("/f/1/preview", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("[PRE-5] at the same path, the method decides: a page answers GET, the API route answers the POST it exports", async () => {
    const app = await standard();
    const page = await app.fetch("/contact");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('class="contact"');
    const post = await app.fetch("/contact", {
      method: "POST",
      headers: { origin: "http://localhost", "x-dusk-fn": "1" },
    });
    expect(await post.json()).toEqual({ api: "contact-post" });
  });

  it("[PRE-6] a static API path beats a dynamic API path with the same shape (one API route, two patterns)", async () => {
    const app = await load<Record<string, unknown>>(APP_SOURCE);
    const fetcher = await boot([
      { id: "dynamic", path: "/f/:id/:name", load: lazy(app["dynamicFile"]).load },
      { id: "static", path: "/f/:id/special", load: lazy(app["file"]).load },
    ]);
    expect(await (await fetcher.fetch("/f/1/special")).json()).toEqual({
      api: "file",
      id: "1",
      name: null,
    });
    expect(await (await fetcher.fetch("/f/1/other")).json()).toEqual({
      api: "dynamic",
      name: "other",
    });
  });
});

describe("matchFilters on API routes", () => {
  it("[PRE-7] an API route's matchFilters rule is applied by the server: a failing value is 404, a passing one answers", async () => {
    const app = await standard();
    expect((await app.fetch("/api/filtered/abc")).status).toBe(404);
    expect(await (await app.fetch("/api/filtered/42")).json()).toEqual({
      api: "filtered",
      id: "42",
    });
  });
});

describe("private (`_`-prefixed) routes", () => {
  it("[PRIV-10] a request from outside to a private page is 404", async () => {
    const app = await standard();
    expect((await app.fetch("/_preview/7")).status).toBe(404);
  });

  it("[PRIV-11] a request from outside to a private API route is 404", async () => {
    const app = await standard();
    expect((await app.fetch("/_internal/ping")).status).toBe(404);
  });

  it("[PRIV-12] a middleware rewrite to a private page answers it; the address the client asked for is kept", async () => {
    const shortcut: Middleware = (event, next) =>
      event.url.pathname === "/shortcut" ? rewrite("/_preview/9") : next();
    const app = await standard([shortcut]);
    const response = await app.fetch("/shortcut");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('class="private-preview"');
  });

  it("[PRIV-13] a middleware rewrite to a private API route answers it", async () => {
    const shortcut: Middleware = (event, next) =>
      event.url.pathname === "/shortcut-api" ? rewrite("/_internal/ping") : next();
    const app = await standard([shortcut]);
    expect(await (await app.fetch("/shortcut-api")).json()).toEqual({ api: "internal" });
    expect((await app.fetch("/_internal/ping")).status).toBe(404);
  });

  it("[PRIV-14] a private page does not shadow a public one: the public path still answers", async () => {
    const app = await standard();
    expect((await app.fetch("/f/1/preview")).status).toBe(200);
    expect(app.log.errors.length).toBe(0);
  });
});
