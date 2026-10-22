import { beforeEach, describe, expect, it } from "vitest";
import {
  apiHandler,
  apiRoute,
  createHandler,
  type DuskHandler,
  HttpError,
  json,
  type Middleware,
} from "../src/server/index";
import { createTestClient, createTestEvent, type TestClient } from "../src/testing/index";
import { type AppModule, errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

let app: AppModule;
let handler: DuskHandler;
let client: TestClient;
let log: ReturnType<typeof errorLog>;

async function boot(
  options: Partial<Parameters<typeof createHandler>[0]> = {},
  api: Record<string, unknown> = {},
): Promise<void> {
  app = await loadApp();
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      apiRoutes: [
        ...Object.entries(api).map(([name, module]) => ({
          id: name,
          path: `/api/${name}`,
          load: async () => module as never,
        })),
        { id: "items", path: "/api/items/:id", load: async () => app["items"] as never },
        { id: "throwing", path: "/api/throwing", load: async () => app["throwing"] as never },
        { id: "teapot", path: "/api/teapot", load: async () => app["teapot"] as never },
        {
          id: "redirecting",
          path: "/api/redirecting",
          load: async () => app["redirecting"] as never,
        },
      ],
    }),
    dev: false,
    security: { allowedHosts: ["localhost"] },
    onError: log.onError,
    ...options,
  });
  client = createTestClient(handler);
}

/** Sets a header on whatever `next()` returns, the way a timing or tracing middleware does. */
const stamp: Middleware = async (_event, next) => {
  const response = await next();
  response.headers.set("x-after-next", String(response.status));
  return response;
};

describe("middleware sees route failures as responses", () => {
  beforeEach(async () => {
    await boot({ middleware: [stamp] });
  });

  it("[SMW-01] a page whose beforeLoad throws an unexpected error: next() returns the 500 and the header is set", async () => {
    const response = await client.get("/crash");
    expect(response.status).toBe(500);
    expect(response.headers.get("x-after-next")).toBe("500");
    expect(await response.text()).not.toContain("secret details");
    expect(log.errors).toHaveLength(1);
  });

  it("[SMW-02] HttpError from a page, an API route and an unmatched path all pass through next() as responses", async () => {
    const page = await client.get("/guarded");
    expect(page.status).toBe(401);
    expect(page.headers.get("x-after-next")).toBe("401");
    const api = await client.get("/api/teapot");
    expect(api.status).toBe(418);
    expect(api.headers.get("x-after-next")).toBe("418");
    // The headers of the HttpError are kept next to the one the middleware added.
    expect(api.headers.get("x-teapot")).toBe("yes");
    const missing = await client.get("/api/missing-route-xyz");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-after-next")).toBe("404");
  });

  it("[SMW-03] an unexpected API error is a 500 JSON answer with the header, reported once", async () => {
    const response = await client.get("/api/throwing");
    expect(response.status).toBe(500);
    expect(response.headers.get("x-after-next")).toBe("500");
    expect((await response.json()).error.message).toBe("Internal Server Error");
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]?.info.phase).toBe("api");
  });

  it("[SMW-04] a redirect thrown by a route reaches the middleware as the 3xx response", async () => {
    const page = await client.get("/old");
    expect(page.status).toBe(301);
    expect(page.headers.get("x-after-next")).toBe("301");
    const api = await client.get("/api/redirecting");
    expect(api.status).toBe(303);
    expect(api.headers.get("x-after-next")).toBe("303");
    expect(api.headers.get("location")).toBe("/posts/2");
  });

  it("[SMW-05] a server function failure is the wire-format response; the header is set on it", async () => {
    const result = await client.serverFn("failing", undefined);
    expect(result.status).toBe(500);
    expect(result.response.headers.get("x-after-next")).toBe("500");
    expect(result.error?.message).toBe("Internal Server Error");
    const denied = await client.serverFn("denied", undefined);
    expect(denied.response.headers.get("x-after-next")).toBe("403");
  });

  it("[SMW-06] a successful response is unchanged", async () => {
    const response = await client.get("/api/items/1");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-after-next")).toBe("200");
  });
});

describe("middleware chain semantics for failures", () => {
  it("[SMW-07] a middleware may replace the failure response, or throw its own error", async () => {
    const mask: Middleware = async (_event, next) => {
      const response = await next();
      return response.status === 500 ? new Response("masked", { status: 503 }) : response;
    };
    await boot({ middleware: [mask] });
    const masked = await client.get("/api/throwing");
    expect(masked.status).toBe(503);
    expect(await masked.text()).toBe("masked");

    const rethrow: Middleware = async (_event, next) => {
      const response = await next();
      if (response.status >= 500) throw new HttpError(502, "upstream said no", { expose: true });
      return response;
    };
    await boot({ middleware: [rethrow] });
    const thrown = await client.get("/api/throwing");
    expect(thrown.status).toBe(502);
    expect((await thrown.json()).error.message).toBe("upstream said no");
  });

  it("[SMW-08] an inner middleware that throws reaches an outer one as a response, and the order is outermost first", async () => {
    const order: string[] = [];
    const outer: Middleware = async (_event, next) => {
      order.push("outer:before");
      const response = await next();
      order.push(`outer:after:${response.status}`);
      response.headers.set("x-outer", "1");
      return response;
    };
    const inner: Middleware = (event) => {
      order.push("inner");
      if (event.url.pathname === "/api/teapot") throw new HttpError(401, "inner says no");
      return new Response("ok");
    };
    await boot({ middleware: [outer, inner] });
    const response = await client.get("/api/teapot");
    expect(response.status).toBe(401);
    expect(response.headers.get("x-outer")).toBe("1");
    expect(order).toEqual(["outer:before", "inner", "outer:after:401"]);
  });

  it("[SMW-09] route-level middleware (the API module's middleware) also gets a response from next()", async () => {
    const seen: number[] = [];
    const watch: Middleware = async (_event, next) => {
      const response = await next();
      seen.push(response.status);
      response.headers.set("x-route-mw", "1");
      return response;
    };
    const module = apiRoute({
      GET: () => {
        throw new HttpError(409, "conflict");
      },
      middleware: [watch],
    });
    await boot({}, { module });
    const response = await client.get("/api/module");
    expect(response.status).toBe(409);
    expect(response.headers.get("x-route-mw")).toBe("1");
    expect(seen).toEqual([409]);
  });

  it("[SMW-10] apiHandler middleware also gets a response from next()", async () => {
    const seen: number[] = [];
    const watch: Middleware = async (_event, next) => {
      const response = await next();
      seen.push(response.status);
      return response;
    };
    const module = apiRoute({
      GET: apiHandler({ middleware: [watch] }, () => {
        throw new Error("boom");
      }),
    });
    await boot({}, { module });
    const response = await client.get("/api/module");
    expect(response.status).toBe(500);
    expect(seen).toEqual([500]);
    expect(log.errors).toHaveLength(1);
  });

  it("[SMW-11] calling next() twice is still a failure, not a second response", async () => {
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

  it("[SMW-12] requests rejected before the chain (CSRF, host, limits) never run middleware", async () => {
    let ran = 0;
    const count: Middleware = (_event, next) => {
      ran += 1;
      return next();
    };
    await boot({ middleware: [count] });
    expect((await client.post("/api/items/1", { crossSite: true })).status).toBe(403);
    expect(ran).toBe(0);
  });

  it("[SMW-13] an event built by hand has no failure mapper: errors from next() are exceptions", async () => {
    const route = apiHandler({ middleware: [stamp] }, () => {
      throw new Error("boom");
    });
    await expect(route(createTestEvent())).rejects.toThrow("boom");
  });

  it("[SMW-14] the response of a failure in a HEAD request has no body but keeps the header", async () => {
    await boot({ middleware: [stamp] });
    const response = await client.head("/api/throwing");
    expect(response.status).toBe(500);
    expect(response.headers.get("x-after-next")).toBe("500");
    expect(await response.text()).toBe("");
  });

  it("[SMW-15] json helper responses from a route are untouched by the mapping", async () => {
    await boot({ middleware: [stamp] }, { ok: apiRoute({ GET: () => json({ ok: 1 }) }) });
    const response = await client.get("/api/ok");
    expect(await response.json()).toEqual({ ok: 1 });
  });
});
