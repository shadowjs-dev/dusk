import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskRuntimeManifest,
  type HandlerOptions,
  json,
} from "../src/server/index";
import { validateDuskConfig } from "../src/vite/config-file";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * `security.defaultCacheControl` is the `cache-control` a response gets when neither the route nor a header rule set one.
 * The default is `private, no-store`; `false` leaves responses untouched, a string replaces the default. A route rule
 * (`routing.routeRules[path].cacheControl`) replaces the default for its paths. The route's own header always wins.
 */
const SOURCE = `
import { defineRoute, useLoaderData } from "@shadow-js/router";
export const counts = { dyn: 0 };
function Text(props) { return <p class={props.cls}>{props.text}</p>; }
const dyn = defineRoute("/dyn", {
  id: "dyn",
  loader: () => { counts.dyn += 1; return { n: counts.dyn }; },
  component: () => { const data = useLoaderData(); return <Text cls="dyn" text={"dyn " + data()?.n} />; },
});
const cached = defineRoute("/cached", { id: "cached", component: () => <Text cls="cached" text="cached" /> });
const plain = defineRoute("/plain", { id: "plain", component: () => <Text cls="plain" text="plain" /> });
export const routes = [dyn, cached, plain];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

type Api = Parameters<typeof apiRoute>[0];

const apis: Record<string, Api> = {
  "/api/item": { GET: () => json({ ok: true }) },
  "/api/own": {
    GET: () => new Response("own", { headers: { "cache-control": "public, max-age=5" } }),
  },
};

async function boot(options: Partial<HandlerOptions> = {}, routes: Record<string, Api> = apis) {
  const app = await load<{
    routes: DuskRuntimeManifest["routes"];
    App: DuskRuntimeManifest["App"];
  }>(SOURCE);
  return createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: Object.entries(routes).map(([path, module]) => ({
        id: path,
        path,
        load: async () => apiRoute(module),
      })),
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: app.App,
    },
    dev: true,
    security: { allowedHosts: ["example.com"] },
    onError: () => undefined,
    onWarning: () => undefined,
    ...options,
  });
}

const at = (path: string) => new Request(`https://example.com${path}`);

describe("[G-B7] security.defaultCacheControl", () => {
  it("[CC-01] the default is private, no-store on a page and on an API answer (unchanged)", async () => {
    const handler = await boot();
    expect((await handler.fetch(at("/dyn"))).headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect((await handler.fetch(at("/api/item"))).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("[CC-02] defaultCacheControl: false leaves the responses without a cache-control header", async () => {
    const handler = await boot({
      security: { allowedHosts: ["example.com"], defaultCacheControl: false },
    });
    expect((await handler.fetch(at("/dyn"))).headers.get("cache-control")).toBeNull();
    expect((await handler.fetch(at("/api/item"))).headers.get("cache-control")).toBeNull();
  });

  it("[CC-03] a string replaces the default for pages and API answers", async () => {
    const handler = await boot({
      security: {
        allowedHosts: ["example.com"],
        defaultCacheControl: "private, max-age=0, must-revalidate",
      },
    });
    expect((await handler.fetch(at("/dyn"))).headers.get("cache-control")).toBe(
      "private, max-age=0, must-revalidate",
    );
    expect((await handler.fetch(at("/api/item"))).headers.get("cache-control")).toBe(
      "private, max-age=0, must-revalidate",
    );
  });

  it("[CC-04] a route rule's cacheControl replaces the default for its path only", async () => {
    const handler = await boot({
      routing: { routeRules: { "/cached": { cacheControl: "public, max-age=60" } } },
    });
    expect((await handler.fetch(at("/cached"))).headers.get("cache-control")).toBe(
      "public, max-age=60",
    );
    expect((await handler.fetch(at("/dyn"))).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("[CC-05] a route rule's cacheControl: false leaves that path untouched while the default still applies elsewhere", async () => {
    const handler = await boot({ routing: { routeRules: { "/plain": { cacheControl: false } } } });
    expect((await handler.fetch(at("/plain"))).headers.get("cache-control")).toBeNull();
    expect((await handler.fetch(at("/dyn"))).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("[CC-06] the route's own cache-control wins over the route rule and the default", async () => {
    const handler = await boot({
      security: { allowedHosts: ["example.com"], defaultCacheControl: "private, no-store" },
      routing: { routeRules: { "/api/own": { cacheControl: "no-cache" } } },
    });
    expect((await handler.fetch(at("/api/own"))).headers.get("cache-control")).toBe(
      "public, max-age=5",
    );
  });

  it("[CC-07] a header rule for the path (routeRules headers) wins over the route rule's cacheControl", async () => {
    const handler = await boot({
      routing: {
        routeRules: {
          "/cached": {
            headers: { "cache-control": "private, max-age=1" },
            cacheControl: "public, max-age=60",
          },
        },
      },
    });
    expect((await handler.fetch(at("/cached"))).headers.get("cache-control")).toBe(
      "private, max-age=1",
    );
  });

  it("[CC-08] a bad value is refused when the handler is created, naming the option", () => {
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: [],
          apiRoutes: [],
          serverFns: {},
          assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
          App: () => null,
        },
        security: { allowedHosts: ["example.com"], defaultCacheControl: "" },
      }),
    ).toThrow(/security\.defaultCacheControl/);
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: [],
          apiRoutes: [],
          serverFns: {},
          assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
          App: () => null,
        },
        security: {
          allowedHosts: ["example.com"],
          defaultCacheControl: "private\r\nSet-Cookie: x=1",
        },
      }),
    ).toThrow(/security\.defaultCacheControl/);
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: [],
          apiRoutes: [],
          serverFns: {},
          assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
          App: () => null,
        },
        security: { allowedHosts: ["example.com"], defaultCacheControl: 5 as unknown as string },
      }),
    ).toThrow(/security\.defaultCacheControl/);
  });

  it("[CC-09] a route rule's cacheControl that is not a header value (or empty) is refused, naming the rule", () => {
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: [],
          apiRoutes: [],
          serverFns: {},
          assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
          App: () => null,
        },
        security: { allowedHosts: ["example.com"] },
        routing: { routeRules: { "/x": { cacheControl: "" } } },
      }),
    ).toThrow(/routeRules\["\/x"\]\.cacheControl/);
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: [],
          apiRoutes: [],
          serverFns: {},
          assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
          App: () => null,
        },
        security: { allowedHosts: ["example.com"] },
        routing: { routeRules: { "/x": { cacheControl: 3 as unknown as string } } },
      }),
    ).toThrow(/routeRules\["\/x"\]\.cacheControl/);
  });

  it("[CC-10] dusk.config accepts defaultCacheControl as a string or false, and refuses other values", () => {
    expect(() =>
      validateDuskConfig({ security: { defaultCacheControl: "public, max-age=60" } }),
    ).not.toThrow();
    expect(() => validateDuskConfig({ security: { defaultCacheControl: false } })).not.toThrow();
    expect(() => validateDuskConfig({ security: { defaultCacheControl: 5 } })).toThrow(
      /security\.defaultCacheControl/,
    );
    expect(() =>
      validateDuskConfig({ security: { defaultCacheControl: "private\r\nSet-Cookie: x=1" } }),
    ).toThrow(/security\.defaultCacheControl/);
    expect(() => validateDuskConfig({ routeRules: { "/x": { cacheControl: true } } })).toThrow(
      /cacheControl/,
    );
  });
});
