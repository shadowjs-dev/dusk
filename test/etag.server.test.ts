import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskRuntimeManifest,
  type HandlerOptions,
  json,
} from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * Entity tags. A route that sets its own `ETag` answers 304 to a matching `If-None-Match` on GET and HEAD, unless it opts
 * out with `event.etag(false)`. A buffered page that a cache may keep (its `cache-control` is not `no-store`) gets a
 * weak ETag computed from the body (`cache.etag`, default on); an API answer gets one only when it asks (`event.etag(true)`).
 */
const SOURCE = `
import { defineRoute } from "@shadow-js/router";
function Text(props) { return <p class={props.cls}>{props.text}</p>; }
const cached = defineRoute("/cached", { id: "cached", component: () => <Text cls="cached" text="stable page" /> });
const dyn = defineRoute("/dyn", { id: "dyn", component: () => <Text cls="dyn" text="dynamic page" /> });
const headed = defineRoute("/headed", { id: "headed", component: () => <Text cls="headed" text="headed page" /> });
export const routes = [cached, dyn, headed];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

/** A version the API answers with; the tests change it to show a new validator. */
const state = { version: 1 };

const apis = {
  "/api/tag": apiRoute({
    GET: () => new Response("tag body", { headers: { etag: '"v1"' } }),
    HEAD: () => new Response(null, { headers: { etag: '"v1"' } }),
  }),
  "/api/tag-optout": apiRoute({
    GET: (event) => {
      event.etag(false);
      return new Response("tag body", { headers: { etag: '"v1"' } });
    },
  }),
  "/api/cached": apiRoute({
    GET: (event) => {
      event.etag(true);
      return json(
        { version: state.version },
        { headers: { "cache-control": "public, max-age=60" } },
      );
    },
  }),
  "/api/cached-default": apiRoute({
    GET: () =>
      json({ version: state.version }, { headers: { "cache-control": "public, max-age=60" } }),
  }),
  "/api/post-public": apiRoute({
    POST: (event) => {
      event.etag(true);
      return json({ ok: true }, { headers: { "cache-control": "public, max-age=60" } });
    },
  }),
};

async function boot(options: Partial<HandlerOptions> = {}) {
  const app = await load<{
    routes: DuskRuntimeManifest["routes"];
    App: DuskRuntimeManifest["App"];
  }>(SOURCE);
  return createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: Object.entries(apis).map(([path, module]) => ({
        id: path,
        path,
        load: async () => module,
      })),
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: app.App,
    },
    dev: true,
    // Buffered pages: the default `stream` sends a page as it renders and gets no generated ETag (see ET-15).
    mode: "string",
    security: { allowedHosts: ["example.com"] },
    onError: () => undefined,
    onWarning: () => undefined,
    ...options,
  });
}

const CACHEABLE = { cacheControl: "public, max-age=60" } as const;
const at = (path: string, init?: RequestInit) => new Request(`https://example.com${path}`, init);
const conditional = (path: string, etag: string, method = "GET") =>
  at(path, { method, headers: { "if-none-match": etag } });

describe("[G-B7] entity tags and If-None-Match", () => {
  it("[ET-01] a route's own ETag answers 304 to a matching If-None-Match on GET (kept)", async () => {
    const handler = await boot();
    const response = await handler.fetch(conditional("/api/tag", '"v1"'));
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(await response.text()).toBe("");
  });

  it("[ET-02] the same route answers 304 to HEAD", async () => {
    const handler = await boot();
    const response = await handler.fetch(conditional("/api/tag", '"v1"', "HEAD"));
    expect(response.status).toBe(304);
  });

  it("[ET-03] event.etag(false) opts a route out: a matching If-None-Match gets the full 200 with its own ETag", async () => {
    const handler = await boot();
    const response = await handler.fetch(conditional("/api/tag-optout", '"v1"'));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(await response.text()).toBe("tag body");
  });

  it("[ET-04] a non-matching If-None-Match gets the full answer", async () => {
    const handler = await boot();
    const response = await handler.fetch(conditional("/api/tag", '"v0"'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tag body");
  });

  it("[ET-05] a cacheable page gets a weak ETag computed from its body; If-None-Match gives 304 with no body", async () => {
    const handler = await boot({
      routing: { routeRules: { "/cached": CACHEABLE } },
    });
    const first = await handler.fetch(at("/cached"));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(await first.text()).toContain("stable page");
    const again = await handler.fetch(conditional("/cached", etag));
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await again.text()).toBe("");
  });

  it("[ET-06] the same body gives the same weak ETag; another body gives another one", async () => {
    const handler = await boot({
      routing: { routeRules: { "/cached": CACHEABLE, "/headed": CACHEABLE } },
    });
    const one = await handler.fetch(at("/cached"));
    const two = await handler.fetch(at("/cached"));
    const other = await handler.fetch(at("/headed"));
    expect(one.headers.get("etag")).toBe(two.headers.get("etag"));
    expect(other.headers.get("etag")).not.toBe(one.headers.get("etag"));
  });

  it("[ET-07] a dynamic page (default private, no-store) gets no ETag, and If-None-Match does not give 304", async () => {
    const handler = await boot();
    const response = await handler.fetch(at("/dyn"));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    const conditionalRequest = await handler.fetch(conditional("/dyn", '"anything"'));
    expect(conditionalRequest.status).toBe(200);
  });

  it("[ET-08] cache.etag: false turns the automatic ETag of pages off", async () => {
    const handler = await boot({
      cache: { etag: false },
      routing: { routeRules: { "/cached": CACHEABLE } },
    });
    const response = await handler.fetch(at("/cached"));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toContain("stable page");
  });

  it("[ET-09] an API answer gets no automatic ETag by default (dynamic API), even when it is cacheable", async () => {
    const handler = await boot();
    const response = await handler.fetch(at("/api/cached-default"));
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("[ET-10] event.etag(true) gives an API answer a weak ETag, and If-None-Match then gives 304", async () => {
    state.version = 1;
    const handler = await boot();
    const first = await handler.fetch(at("/api/cached"));
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const again = await handler.fetch(conditional("/api/cached", etag));
    expect(again.status).toBe(304);
  });

  it("[ET-11] the ETag follows the body: a changed answer is a new validator, and the old one gets the full answer", async () => {
    state.version = 1;
    const handler = await boot();
    const old = (await handler.fetch(at("/api/cached"))).headers.get("etag") ?? "";
    state.version = 2;
    const fresh = await handler.fetch(conditional("/api/cached", old));
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).not.toBe(old);
    expect(await fresh.json()).toEqual({ version: 2 });
    state.version = 1;
  });

  it("[ET-12] a POST never gets a generated ETag, and HEAD of a cacheable page gets none (its body is not rendered)", async () => {
    const handler = await boot({ routing: { routeRules: { "/cached": CACHEABLE } } });
    const post = await handler.fetch(
      at("/api/post-public", {
        method: "POST",
        headers: { "x-dusk-fn": "1", origin: "https://example.com" },
      }),
    );
    expect(post.headers.get("etag")).toBeNull();
    const head = await handler.fetch(at("/cached", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBeNull();
  });

  it("[ET-13] an answer that is no-store gets no automatic ETag (a cache may not keep it)", async () => {
    const handler = await boot({
      routing: { routeRules: { "/cached": { headers: { "cache-control": "no-store" } } } },
    });
    const response = await handler.fetch(at("/cached"));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
  });

  it("[ET-15] a streamed page (the default mode) gets no generated ETag: its body is not read before it is sent", async () => {
    const app = await load<{
      routes: DuskRuntimeManifest["routes"];
      App: DuskRuntimeManifest["App"];
    }>(SOURCE);
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: app.routes,
        apiRoutes: [],
        serverFns: {},
        assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
        App: app.App,
      },
      dev: true,
      security: { allowedHosts: ["example.com"] },
      routing: { routeRules: { "/cached": CACHEABLE } },
      onError: () => undefined,
      onWarning: () => undefined,
    });
    const response = await handler.fetch(at("/cached"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toContain("stable page");
  });

  it("[ET-14] with cache.etag false, a route's own ETag still answers 304 (the option is for generated tags only)", async () => {
    const handler = await boot({ cache: { etag: false } });
    const response = await handler.fetch(conditional("/api/tag", '"v1"'));
    expect(response.status).toBe(304);
  });
});
