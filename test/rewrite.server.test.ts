import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  json,
  type Middleware,
  rewrite,
} from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

/**
 * Middleware can rewrite a request to another route of the app, the way Next's `NextResponse.rewrite`
 * does: the URL the client sees stays the same, the target route answers, and the request headers the
 * rewrite sets are visible to the target. Malaf's host routing (`{slug}.{sites host}` to the site route)
 * depends on this, because a middleware cannot change the path of a request in any other way.
 */
async function boot(
  middleware: Middleware[],
  apiRoutes: Array<{ id: string; path: string; module: unknown }>,
): Promise<{ handler: DuskHandler; log: ReturnType<typeof errorLog> }> {
  const app = await loadApp();
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      apiRoutes: apiRoutes.map((route) => ({
        id: route.id,
        path: route.path,
        load: async () => route.module as never,
      })),
    }),
    dev: false,
    security: { allowedHosts: ["localhost"] },
    onError: log.onError,
    middleware,
  });
  return { handler, log };
}

const target = apiRoute({
  GET: (event) =>
    json({
      path: event.url.pathname,
      site: event.request.headers.get("x-site-host"),
      method: event.request.method,
    }),
  POST: async (event) => json({ body: await event.request.text() }),
});

describe("middleware rewrites", () => {
  it("[RW-01] answers with the target route, keeps the URL, and passes the rewrite's request headers to the target", async () => {
    const rewriter: Middleware = (event, next) =>
      event.url.pathname === "/shop"
        ? rewrite("/api/target?x=1", { headers: { "x-site-host": "acme.sites.test" } })
        : next();
    const { handler } = await boot(
      [rewriter],
      [{ id: "target", path: "/api/target", module: target }],
    );
    const client = createTestClient(handler);
    const response = await client.get("/shop?y=2");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["path"]).toBe("/api/target");
    expect(body["site"]).toBe("acme.sites.test");
    expect(body["method"]).toBe("GET");
  });

  it("[RW-02] a POST keeps its body through the rewrite", async () => {
    const rewriter: Middleware = () => rewrite("/api/target");
    const { handler } = await boot(
      [rewriter],
      [{ id: "target", path: "/api/target", module: target }],
    );
    const response = await createTestClient(handler).postJson("/api/anything", { a: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: '{"a":1}' });
  });

  it("[RW-03] the middleware chain does not run again on the target of a rewrite", async () => {
    let runs = 0;
    const rewriter: Middleware = (event, next) => {
      runs += 1;
      return event.url.pathname === "/shop" ? rewrite("/api/target") : next();
    };
    const { handler } = await boot(
      [rewriter],
      [{ id: "target", path: "/api/target", module: target }],
    );
    const response = await createTestClient(handler).get("/shop");
    expect(response.status).toBe(200);
    expect(runs).toBe(1);
  });

  it("[RW-04] a rewrite to a path no route matches is a 404 of the target, not a loop", async () => {
    const rewriter: Middleware = () => rewrite("/no/such/route");
    const { handler } = await boot([rewriter], []);
    const response = await createTestClient(handler).get("/anything");
    expect(response.status).toBe(404);
  });

  it("[RW-05] a rewrite that asks for another rewrite is refused (500), so a rewrite cannot loop", async () => {
    // The route's own middleware rewrites to itself: the first rewrite is served, the second is refused.
    const loop: Middleware = () => rewrite("/api/loop");
    const looping = apiRoute({ GET: () => json({ unreachable: true }), middleware: [loop] });
    const { handler, log } = await boot([], [{ id: "loop", path: "/api/loop", module: looping }]);
    const response = await createTestClient(handler).get("/api/loop");
    expect(response.status).toBe(500);
    expect(log.errors.length).toBeGreaterThan(0);
  });

  it("[RW-06] rewrite destinations must be paths of this app: an absolute URL, a protocol-relative one or a reserved path throws", () => {
    expect(() => rewrite("https://evil.example/x")).toThrow(TypeError);
    expect(() => rewrite("//evil.example/x")).toThrow(TypeError);
    expect(() => rewrite("/\\evil.example")).toThrow(TypeError);
    expect(() => rewrite("/_dusk/health")).toThrow(TypeError);
    expect(() => rewrite("relative/path")).toThrow(TypeError);
  });

  it("[RW-07] a request that is not rewritten is answered as before", async () => {
    const pass: Middleware = (_event, next) => next();
    const { handler } = await boot([pass], [{ id: "target", path: "/api/target", module: target }]);
    const response = await createTestClient(handler).get("/api/target");
    expect(((await response.json()) as Record<string, unknown>)["path"]).toBe("/api/target");
  });
});

describe("x-request-id", () => {
  it("[RW-08] a request id the route set is kept; the handler only fills the header when nothing set it", async () => {
    const withId = apiRoute({
      GET: () => new Response("ok", { headers: { "x-request-id": "client-42" } }),
    });
    const { handler } = await boot([], [{ id: "with-id", path: "/api/with-id", module: withId }]);
    const response = await createTestClient(handler).get("/api/with-id");
    expect(response.headers.get("x-request-id")).toBe("client-42");

    const plain = apiRoute({ GET: () => new Response("ok") });
    const second = await boot([], [{ id: "plain", path: "/api/plain", module: plain }]);
    const generated = await createTestClient(second.handler).get("/api/plain");
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
