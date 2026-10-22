import { beforeEach, describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  json,
  type Middleware,
} from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { type AppModule, errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

let app: AppModule;
let handler: DuskHandler;
let client: TestClient;
let log: ReturnType<typeof errorLog>;

async function boot(options: Partial<Parameters<typeof createHandler>[0]> = {}): Promise<void> {
  app = await loadApp();
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    onError: log.onError,
    ...options,
  });
  client = createTestClient(handler);
}

describe("API routes", () => {
  beforeEach(async () => {
    await boot();
  });

  it("[SAPI-01] dispatches by method and gives the handler the route params", async () => {
    const response = await client.get("/api/items/42");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ id: "42", method: "GET" });
  });

  it("[SAPI-02] a handler may return any JSON value, a string, or nothing", async () => {
    expect(await (await client.get("/api/plain")).text()).toBe("plain text");
    expect(await (await client.post("/api/plain")).json()).toEqual({ nested: [1, 2, 3] });
    expect((await client.put("/api/items/1")).status).toBe(204);
  });

  it("[SAPI-03] a missing method is 405 with Allow listing the implied HEAD and OPTIONS", async () => {
    const response = await client.delete("/api/items/1");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST, PUT, OPTIONS");
    expect((await response.json()).error.status).toBe(405);
  });

  it("[SAPI-04] OPTIONS is answered with Allow when the route does not handle it; HEAD runs GET without a body", async () => {
    const options = await client.options("/api/items/1");
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toContain("GET");
    const head = await client.head("/api/items/1");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await head.text()).toBe("");
  });

  it("[SAPI-05] a JSON body round trips; the request body is readable by the route", async () => {
    const response = await client.postJson("/api/items/1", { a: 1 });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ echoed: { a: 1 } });
  });

  it("[SAPI-06] an HttpError keeps its status, message and headers", async () => {
    const response = await client.get("/api/teapot");
    expect(response.status).toBe(418);
    expect(response.headers.get("x-teapot")).toBe("yes");
    expect((await response.json()).error.message).toBe("short and stout");
  });

  it("[SAPI-07] an unexpected error is a 500 whose message stays out of the response in production", async () => {
    await boot({ dev: false, security: { allowedHosts: ["localhost"] } });
    const response = await client.get("/api/throwing");
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("secret details");
    expect(JSON.parse(text).error.message).toBe("Internal Server Error");
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.info.phase).toBe("api");
  });

  it("[SAPI-08] in development the message is shown", async () => {
    const text = await (await client.get("/api/throwing")).text();
    expect(text).toContain("secret details");
  });

  it("[SAPI-09] a thrown redirect() is a real 3xx with its status", async () => {
    const response = await client.get("/api/redirecting");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/posts/2");
  });

  it("[SAPI-10] a cross-site POST is rejected before the route runs; a webhook route opts out", async () => {
    expect((await client.post("/api/items/1", { crossSite: true })).status).toBe(403);
    const hook = await client.post("/api/webhook", { crossSite: true });
    expect(hook.status).toBe(200);
    expect(await hook.json()).toEqual({ received: true });
  });

  it("[SAPI-11] route middleware wraps the methods and can short-circuit", async () => {
    const calls: string[] = [];
    const guard: Middleware = async (event, next) => {
      calls.push(event.method);
      if (event.request.headers.get("x-key") !== "k") return new Response("no", { status: 401 });
      return next();
    };
    const module = apiRoute({ GET: () => json({ ok: true }), middleware: [guard] });
    await boot({
      manifest: manifestOf(app, {
        apiRoutes: [{ id: "guarded", path: "/api/guarded", load: async () => module }],
      }),
    });
    expect((await client.get("/api/guarded")).status).toBe(401);
    expect((await client.get("/api/guarded", { headers: { "x-key": "k" } })).status).toBe(200);
    expect(calls).toEqual(["GET", "GET"]);
  });

  it("[SAPI-12] apiRoute rejects a key that is not an HTTP method, at definition time", () => {
    expect(() => apiRoute({ Get: () => json({}) } as never)).toThrow(/not an HTTP method/);
    expect(() => apiRoute({ GET: "no" } as never)).toThrow(/must be a function/);
  });

  it("[SAPI-13] API routes win over pages with the same path; unknown API paths fall to the page 404", async () => {
    const response = await client.get("/api/unknown");
    expect(response.status).toBe(404);
  });

  it("[SAPI-14] app-wide middleware sees API requests and can add headers to the response", async () => {
    const stamp: Middleware = async (_event, next) => {
      const response = await next();
      response.headers.set("x-stamp", "1");
      return response;
    };
    await boot({ middleware: [stamp] });
    const response = await client.get("/api/items/1");
    expect(response.headers.get("x-stamp")).toBe("1");
    const missing = await client.get("/nothing-here");
    expect(missing.headers.get("x-stamp")).toBe("1");
  });

  it("[SAPI-15] a middleware that calls next twice fails the request with a 500", async () => {
    const twice: Middleware = async (_event, next) => {
      await next();
      return next();
    };
    await boot({ middleware: [twice] });
    const response = await client.get("/api/items/1");
    expect(response.status).toBe(500);
    expect(log.errors.some((entry) => String(entry.error).includes("MIDDLEWARE_NEXT_TWICE"))).toBe(
      true,
    );
  });

  it("[SAPI-16] a thrown redirect to another origin from a route is blocked (500), to a trusted origin allowed", async () => {
    const { redirect } = await import("../src/server/index");
    const bad = apiRoute({
      GET: () => {
        throw redirect("//evil.example/x");
      },
    });
    const bad2 = apiRoute({
      GET: () => {
        throw redirect("https://evil.example/x");
      },
    });
    await boot({
      manifest: manifestOf(app, {
        apiRoutes: [
          { id: "a", path: "/a", load: async () => bad },
          { id: "b", path: "/b", load: async () => bad2 },
        ],
      }),
    });
    const first = await client.get("/a");
    expect(first.status).toBe(500);
    expect(first.headers.get("location")).toBeNull();
    expect((await client.get("/b")).status).toBe(500);
    await boot({
      trustedOrigins: ["https://evil.example"],
      manifest: manifestOf(app, { apiRoutes: [{ id: "b", path: "/b", load: async () => bad2 }] }),
    });
    expect((await client.get("/b")).headers.get("location")).toBe("https://evil.example/x");
  });

  it("[SAPI-17] a module whose default export is apiRoute({...}) answers like one with method exports", async () => {
    const module = {
      default: apiRoute({
        GET: (event) => json({ id: event.params["id"] ?? null }),
        POST: () => json({ created: true }, { status: 201 }),
      }),
    };
    await boot({
      manifest: manifestOf(app, {
        apiRoutes: [{ id: "d", path: "/d/:id", load: async () => module as never }],
      }),
    });
    expect(await (await client.get("/d/7")).json()).toEqual({ id: "7" });
    expect((await client.post("/d/7")).status).toBe(201);
    const refused = await client.delete("/d/7");
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
  });
});
