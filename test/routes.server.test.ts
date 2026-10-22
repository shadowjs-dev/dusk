import type { RouteDefinition } from "@shadow-js/router";
import { defineRoute } from "@shadow-js/router";
import { describe, expect, it } from "vitest";
import {
  apiRoute,
  COOKIE_LIMITS,
  createHandler,
  getRequestEvent,
  type HandlerOptions,
  HttpError,
  json,
  type RequestEvent,
  redirect,
} from "../src/server/index";
import { wrapRoutes } from "../src/server/route-wrap";
import { errorLog } from "./support/app";
import { allFeatures } from "./support/features";

const noApp = (props: { children?: unknown }): unknown => props.children;
const assets = { entry: "", css: [], preloads: {}, base: "/" };

function handlerFor(routes: RouteDefinition[], options: Partial<HandlerOptions> = {}) {
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: { routes, apiRoutes: [], serverFns: {}, assets, App: noApp },
    dev: true,
    onError: log.onError,
    ...options,
  });
  return { handler, log };
}

const get = (handler: ReturnType<typeof handlerFor>["handler"], path: string): Promise<Response> =>
  handler.fetch(new Request(`http://localhost${path}`));

describe("redirects and errors inside the router", () => {
  it("[SRTE-01] after the first redirect no later beforeLoad or loader runs application code; Location is the first hop", async () => {
    const ran: string[] = [];
    const { handler } = handlerFor([
      defineRoute("/a", {
        id: "a",
        beforeLoad: () => {
          ran.push("a");
          throw redirect("/b", { status: 307 });
        },
      }),
      defineRoute("/b", {
        id: "b",
        beforeLoad: () => {
          ran.push("b");
          throw redirect("/c");
        },
      }),
      defineRoute("/c", {
        id: "c",
        loader: () => {
          ran.push("c");
          return 1;
        },
        component: () => "c",
      }),
    ]);
    const response = await get(handler, "/a");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/b");
    expect(ran).toEqual(["a"]);
  });

  it("[SRTE-02] a redirect from a loader beats the other loaders' results and uses its own status", async () => {
    const { handler } = handlerFor([
      defineRoute("", {
        id: "layout",
        loader: () => 1,
        component: noApp,
        children: [
          defineRoute("/x", {
            id: "x",
            loader: () => {
              throw redirect("/y", { status: 308 });
            },
            component: () => "x",
          }),
        ],
      }),
    ]);
    const response = await get(handler, "/x");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/y");
  });

  it("[SRTE-03] a base path is added to redirect targets and trailing-slash redirects", async () => {
    const { handler } = handlerFor(
      [
        defineRoute("/a", {
          id: "a",
          beforeLoad: () => {
            throw redirect("/b");
          },
        }),
        defineRoute("/b", { id: "b", component: () => "b" }),
      ],
      { base: "/app" },
    );
    const moved = await get(handler, "/app/a");
    expect(moved.headers.get("location")).toBe("/app/b");
    expect((await get(handler, "/app/b/")).headers.get("location")).toBe("/app/b");
    expect((await get(handler, "/b")).status).toBe(404);
    expect((await get(handler, "/application/b")).status).toBe(404);
    expect((await get(handler, "/app/b")).status).toBe(200);
  });

  it("[SRTE-04] beforeLoad and loaders receive the request event as context.event, the same object getRequestEvent() returns", async () => {
    const seen: Array<RequestEvent | undefined> = [];
    let current: RequestEvent | undefined;
    const { handler } = handlerFor([
      defineRoute("/e", {
        id: "e",
        beforeLoad: ({ context }) => {
          seen.push(context["event"] as RequestEvent);
          current = getRequestEvent();
        },
        loader: ({ context }) => {
          seen.push(context["event"] as RequestEvent);
          return 1;
        },
        component: () => "e",
      }),
    ]);
    await get(handler, "/e");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(current);
  });

  it("[SRTE-05] a client error from a loader is not reported as a fault; a server error is, once", async () => {
    const { handler, log } = handlerFor([
      defineRoute("/client", {
        id: "client",
        loader: () => {
          throw new HttpError(409, "conflict");
        },
        component: () => "x",
      }),
      defineRoute("/server", {
        id: "server",
        loader: () => {
          throw new Error("db");
        },
        component: () => "x",
      }),
    ]);
    expect((await get(handler, "/client")).status).toBe(409);
    expect(log.errors.map((entry) => `${entry.info.phase}:${String(entry.error)}`)).toEqual([]);
    expect((await get(handler, "/server")).status).toBe(500);
    expect(log.errors).toHaveLength(1);
  });

  it("[SRTE-06] a route's head() that throws is a 500 (a bad tag is a bug, not a missing title), and is reported", async () => {
    const { handler, log } = handlerFor([
      defineRoute("/bad-head", {
        id: "bad-head",
        component: () => "x",
        head: () => ({ tag: "script", children: "alert(1)" }) as never,
      }),
    ]);
    const response = await get(handler, "/bad-head");
    expect(response.status).toBe(500);
    expect(log.errors.length).toBeGreaterThan(0);
  });

  it("[SRTE-07] /_dusk paths that are not server functions are 404, never pages", async () => {
    const { handler } = handlerFor([
      defineRoute("/_dusk/other", { id: "x", component: () => "page" }),
    ]);
    expect((await get(handler, "/_dusk/other")).status).toBe(404);
    expect((await get(handler, "/_dusk/fn/")).status).toBe(404);
  });

  it("[SRTE-08] duplicate route ids and API ids are refused at startup", () => {
    const route = defineRoute("/a", { id: "dup", component: () => "a" });
    expect(() =>
      handlerFor([route, defineRoute("/b", { id: "dup", component: () => "b" })]),
    ).toThrow(/dup/);
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: [],
          apiRoutes: [
            { id: "x", path: "/a", load: async () => apiRoute({ GET: () => json({}) }) },
            { id: "x", path: "/b", load: async () => apiRoute({ GET: () => json({}) }) },
          ],
          serverFns: {},
          assets,
          App: noApp,
        },
        dev: true,
      }),
    ).toThrow(/share an id/);
  });

  it("[SRTE-09] a module that exports no HTTP methods is a 500 naming the problem, not a hang", async () => {
    const log = errorLog();
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: [],
        apiRoutes: [{ id: "bad", path: "/bad", load: async () => ({ nothing: true }) as never }],
        serverFns: {},
        assets,
        App: noApp,
      },
      dev: true,
      onError: log.onError,
    });
    const response = await handler.fetch(new Request("http://localhost/bad"));
    expect(response.status).toBe(500);
    expect(String(log.errors[0]?.error)).toContain("HTTP method");
  });

  it("[SRTE-10] a default-exported apiRoute() module is accepted", async () => {
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: [],
        apiRoutes: [
          {
            id: "d",
            path: "/d",
            load: async () => ({ default: apiRoute({ GET: () => json({ ok: 1 }) }) }) as never,
          },
        ],
        serverFns: {},
        assets,
        App: noApp,
      },
      dev: true,
    });
    expect(await (await handler.fetch(new Request("http://localhost/d"))).json()).toEqual({
      ok: 1,
    });
  });
});

describe("limits through the handler", () => {
  it("[SRTE-20] bound: oversized loader data is dropped from the hydration payload and the page still renders (200)", async () => {
    const { handler } = handlerFor(
      [defineRoute("/big", { id: "big", loader: () => "x".repeat(5000), component: () => "page" })],
      { maxPayloadBytes: 1000 },
    );
    const response = await get(handler, "/big");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('id="__shadow_router">{"version":1,"matches":[]}');
    expect(html).not.toContain("xxxxx");
  });

  it("[SRTE-21] bound: a response may set at most 50 cookies", async () => {
    const log = errorLog();
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: [],
        apiRoutes: [
          {
            id: "c",
            path: "/c",
            load: async () =>
              apiRoute({
                GET: (event) => {
                  for (let n = 0; n <= COOKIE_LIMITS.maxOutgoing; n += 1)
                    event.cookies.set(`c${String(n)}`, "v");
                  return json({});
                },
              }),
          },
        ],
        serverFns: {},
        assets,
        App: noApp,
      },
      dev: true,
      onError: log.onError,
    });
    expect((await handler.fetch(new Request("http://localhost/c"))).status).toBe(500);
    expect(String(log.errors[0]?.error)).toContain("at most 50 cookies");
  });

  it("[SRTE-22] the same cookie name set twice sends one header; different paths send two", async () => {
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: [],
        apiRoutes: [
          {
            id: "c",
            path: "/c",
            load: async () =>
              apiRoute({
                GET: (event) => {
                  event.cookies.set("a", "1");
                  event.cookies.set("a", "2");
                  event.cookies.set("a", "3", { path: "/x" });
                  return json({});
                },
              }),
          },
        ],
        serverFns: {},
        assets,
        App: noApp,
      },
      dev: true,
    });
    const set = (await handler.fetch(new Request("http://localhost/c"))).headers.getSetCookie();
    expect(set).toHaveLength(2);
    expect(set[0]).toContain("a=2");
  });
});

describe("route wrapping", () => {
  it("[SRTE-30] a route tree 20 000 levels deep is copied without recursion", () => {
    let route = defineRoute("/leaf", { id: "leaf" });
    for (let depth = 0; depth < 20_000; depth += 1)
      route = defineRoute("", { id: `l${String(depth)}`, children: [route] }) as never;
    const wrapped = wrapRoutes([route], { dev: true, report: () => undefined });
    expect(wrapped.specs.size).toBe(20_001);
    expect(wrapped.routes).toHaveLength(1);
    expect(wrapped.tree).toHaveLength(1);
  });

  it("[SRTE-31] the originals are not modified", () => {
    const loader = (): number => 1;
    const route = defineRoute("/a", { id: "a", loader });
    wrapRoutes([route], { dev: true, report: () => undefined });
    expect(route.spec.loader).toBe(loader);
  });
});
