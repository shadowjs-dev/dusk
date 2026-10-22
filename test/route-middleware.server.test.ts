import { defineRoute } from "@shadow-js/router";
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  defineLocals,
  getRequestEvent,
  HttpError,
  json,
  type Middleware,
  type MiddlewareModule,
  type Next,
  type RequestEvent,
  type RouteMiddlewareManifest,
  redirect,
} from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { allFeatures } from "./support/features";

/** Calls in the order they happen: middleware in and out, loaders, handlers. */
let trace: string[] = [];

/** A module whose `middleware` export is `value`, loaded on demand like the build's entries. */
function moduleOf(value: unknown): MiddlewareModule {
  return { load: async () => value };
}

/** Records entry and exit of a middleware, so the order of the chain is observable. */
function tag(name: string): Middleware {
  return async (_event, next) => {
    trace.push(`${name}:in`);
    const response = await next();
    trace.push(`${name}:out`);
    return response;
  };
}

const session = defineLocals({ user: undefined as string | undefined, secret: "" });

function appManifest(
  routes: DuskRuntimeManifest["routes"],
  middleware: RouteMiddlewareManifest,
  apiRoutes: DuskRuntimeManifest["apiRoutes"] = [],
): DuskRuntimeManifest {
  return {
    routes,
    apiRoutes,
    serverFns: {},
    assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
    App: (props: { children?: unknown }) => props.children as never,
    middleware,
  };
}

function boot(manifest: DuskRuntimeManifest, options: { csrf?: boolean } = {}): TestClient {
  const handler: DuskHandler = createHandler({
    features: allFeatures(),
    manifest,
    dev: false,
    mode: "string",
    security: {
      allowedHosts: ["localhost"],
      ...(options.csrf === false ? { csrf: false as const } : {}),
    },
    onError: () => undefined,
  });
  return createTestClient(handler);
}

/** `/admin` (layout) with `/admin/users` (page). */
function adminRoutes(withLoader = true) {
  const users = defineRoute("/users", {
    id: "/admin/users",
    ...(withLoader
      ? {
          loader: () => {
            trace.push("loader");
            return { names: ["ada"] };
          },
        }
      : {}),
  });
  return [defineRoute("/admin", { id: "/admin/_layout", children: [users] })];
}

const ADMIN_MIDDLEWARE: RouteMiddlewareManifest = {
  routes: {
    "/admin/_layout": moduleOf([tag("layout")]),
    "/admin/users": moduleOf([tag("page")]),
  },
  directories: {
    "": moduleOf([tag("root")]),
    admin: moduleOf([tag("admin")]),
  },
  pages: { "/admin/users": ["", "admin"] },
  apis: {},
};

beforeEach(() => {
  trace = [];
});

describe("route middleware: order and composition", () => {
  it("[RMW-10] folder middleware runs outermost first, then the chain's route middleware, then the loader", async () => {
    const client = boot(appManifest(adminRoutes(), ADMIN_MIDDLEWARE));
    const response = await client.get("/admin/users");
    expect(response.status).toBe(200);
    expect(trace).toEqual([
      "root:in",
      "admin:in",
      "layout:in",
      "page:in",
      "loader",
      "page:out",
      "layout:out",
      "admin:out",
      "root:out",
    ]);
  });

  it("[RMW-11] a middleware that answers with a Response stops the chain: no loader runs", async () => {
    const manifest: RouteMiddlewareManifest = {
      ...ADMIN_MIDDLEWARE,
      routes: {
        ...ADMIN_MIDDLEWARE.routes,
        "/admin/_layout": moduleOf([
          async () => {
            trace.push("layout:answer");
            return new Response("sign in", { status: 401 });
          },
        ]),
      },
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.get("/admin/users");
    expect(response.status).toBe(401);
    expect(trace).toEqual(["root:in", "admin:in", "layout:answer", "admin:out", "root:out"]);
    expect(trace).not.toContain("loader");
  });

  it("[RMW-12] a redirect thrown by a middleware is the response; the loader does not run", async () => {
    const manifest: RouteMiddlewareManifest = {
      ...ADMIN_MIDDLEWARE,
      routes: {
        "/admin/_layout": moduleOf([
          () => {
            throw redirect("/login", { status: 303 });
          },
        ]),
      },
      directories: {},
      pages: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.get("/admin/users");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(trace).not.toContain("loader");
  });

  it("[RMW-13] an HttpError thrown by a middleware keeps its status and exposed message", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/admin/_layout": moduleOf([
          () => {
            throw new HttpError(403, "Admins only");
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.get("/admin/users");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Admins only");
    expect(trace).not.toContain("loader");
  });

  it("[RMW-14] an unexpected error in middleware is a 500 with no detail of the error", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/admin/_layout": moduleOf([
          () => {
            throw new Error("db password is hunter2");
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.get("/admin/users");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("hunter2");
  });

  it("[RMW-15] a middleware module that does not export a middleware list is a 500, not a silent pass", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: { "/admin/_layout": moduleOf({ not: "a list" }) },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.get("/admin/users");
    expect(response.status).toBe(500);
    expect(trace).not.toContain("loader");
  });
});

describe("route middleware: directory scope for API routes", () => {
  const stats = apiRoute({
    GET: () => {
      trace.push("handler");
      return json({ total: 3 });
    },
  });
  const apiManifest = (middleware: RouteMiddlewareManifest) =>
    appManifest([], middleware, [
      { id: "/api/admin/stats", path: "/api/admin/stats", load: async () => stats },
    ]);

  it("[RMW-16] a _middleware folder applies to the API routes beneath it, before the module's own middleware", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {},
      directories: { admin: moduleOf([tag("admin")]) },
      pages: {},
      apis: { "/api/admin/stats": ["admin"] },
    };
    const client = boot(apiManifest(manifest));
    const response = await client.get("/api/admin/stats");
    expect(response.status).toBe(200);
    expect(trace).toEqual(["admin:in", "handler", "admin:out"]);
  });

  it("[RMW-17] a folder middleware that refuses keeps the API handler from running", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {},
      directories: { admin: moduleOf([() => new Response("no", { status: 401 })]) },
      pages: {},
      apis: { "/api/admin/stats": ["admin"] },
    };
    const client = boot(apiManifest(manifest));
    const response = await client.get("/api/admin/stats");
    expect(response.status).toBe(401);
    expect(trace).not.toContain("handler");
  });

  it("[RMW-18] a request refused by the CSRF check never reaches middleware", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {},
      directories: { admin: moduleOf([tag("admin")]) },
      pages: {},
      apis: { "/api/admin/stats": ["admin"] },
    };
    const writer = apiRoute({
      POST: () => {
        trace.push("handler");
        return json({ ok: true });
      },
    });
    const client = boot(
      appManifest([], manifest, [
        { id: "/api/admin/stats", path: "/api/admin/stats", load: async () => writer },
      ]),
    );
    const response = await client.post("/api/admin/stats", { crossSite: true });
    expect(response.status).toBe(403);
    expect(trace).toEqual([]);
  });
});

describe("request locals", () => {
  it("[LCL-1] locals set by middleware are visible to the loader through getLocals()", async () => {
    const seen: unknown[] = [];
    const routes = [
      defineRoute("/me", {
        id: "/me",
        loader: () => {
          seen.push(session.of(getRequestEvent()).user);
          return { ok: true };
        },
      }),
    ];
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/me": moduleOf([
          async (event: RequestEvent, next: Next) => {
            session.of(event).user = "ada";
            return next();
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(routes, manifest));
    await client.get("/me");
    expect(seen).toEqual(["ada"]);
  });

  it("[LCL-2] locals never reach the page, its payload or an API answer unless a loader returns them", async () => {
    const secret = "tok_very_secret_value_42";
    const routes = [
      defineRoute("/profile", { id: "/profile", loader: () => ({ greeting: "hi" }) }),
    ];
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/profile": moduleOf([
          async (event: RequestEvent, next: Next) => {
            session.of(event).secret = secret;
            return next();
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const api = apiRoute({ GET: () => json({ greeting: "hi" }) });
    const client = boot(
      appManifest(routes, manifest, [{ id: "/api/hi", path: "/api/hi", load: async () => api }]),
    );
    const page = await client.get("/profile");
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(secret);
    const answer = await client.get("/api/hi");
    expect(answer.status).toBe(200);
    const body = await answer.text();
    expect(body).not.toContain(secret);
    expect(body).toBe('{"greeting":"hi"}');
  });

  it("[LCL-3] defineLocals sets its defaults once and keeps a value an earlier middleware set", async () => {
    const seen: Array<string | undefined> = [];
    const routes = [
      defineRoute("/who", {
        id: "/who",
        loader: () => {
          seen.push(session.of(getRequestEvent()).user);
          return null;
        },
      }),
    ];
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/who": moduleOf([session.middleware, tag("who")]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(routes, manifest));
    await client.get("/who");
    expect(seen).toEqual([undefined]);
    expect(session.defaults.secret).toBe("");
  });
});

describe("route middleware: pages are never served from the ISR cache", () => {
  it("[RMW-19] a page whose chain runs middleware runs it on every request, even with revalidate", async () => {
    let runs = 0;
    const routes = [
      defineRoute("/cached", {
        id: "/cached",
        revalidate: 60,
        loader: () => ({ ok: true }),
      }),
    ];
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/cached": moduleOf([
          async (_event: RequestEvent, next: Next) => {
            runs += 1;
            return next();
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(routes, manifest));
    expect((await client.get("/cached")).status).toBe(200);
    expect((await client.get("/cached")).status).toBe(200);
    expect(runs).toBe(2);
  });
});

describe("the navigation gate endpoint", () => {
  it("[NAV-1] an allowed path answers 204 with the allowed marker, and runs the chain without a loader", async () => {
    const client = boot(appManifest(adminRoutes(), ADMIN_MIDDLEWARE));
    const response = await client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/admin/users" }),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-dusk-gate")).toBe("allowed");
    expect(trace).toEqual([
      "root:in",
      "admin:in",
      "layout:in",
      "page:in",
      "page:out",
      "layout:out",
      "admin:out",
      "root:out",
    ]);
    expect(trace).not.toContain("loader");
  });

  it("[NAV-2] a refusal answers 200 JSON with the status, so the browser can read it", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: { "/admin/_layout": moduleOf([() => new Response("no", { status: 401 })]) },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/admin/users" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dusk-gate")).toBe("refused");
    expect(await response.json()).toEqual({ status: 401 });
  });

  it("[NAV-3] a redirect from the chain is reported as the location, not followed", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/admin/_layout": moduleOf([
          () => {
            throw redirect("/login");
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/admin/users" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 302, redirect: "/login" });
  });

  it("[NAV-4] the path must be an app path: no URLs, no protocol-relative paths, no query, no GET", async () => {
    const client = boot(appManifest(adminRoutes(), ADMIN_MIDDLEWARE));
    for (const path of [
      "//evil.example/x",
      "https://evil.example/",
      "/admin?x=1",
      "/admin#x",
      "admin",
    ]) {
      const response = await client.post("/_dusk/nav", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      expect(response.status, path).toBe(400);
    }
    const wrongMethod = await client.get("/_dusk/nav");
    expect(wrongMethod.status).toBe(405);
    expect(trace).toEqual([]);
  });

  it("[NAV-5] a cross-site gate request is refused before any middleware runs", async () => {
    const client = boot(appManifest(adminRoutes(), ADMIN_MIDDLEWARE));
    const response = await client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/admin/users" }),
      crossSite: true,
    });
    expect(response.status).toBe(403);
    expect(trace).toEqual([]);
  });
});

describe("the navigation check sees the target", () => {
  it("[NAV-6] the chain runs with event.url = the target (path and search) and isNavigationCheck true", async () => {
    const seen: Array<{ href: string; check: boolean }> = [];
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/admin/_layout": moduleOf([
          (event: RequestEvent, next: Next) => {
            seen.push({
              href: `${event.url.pathname}${event.url.search}`,
              check: event.isNavigationCheck,
            });
            return next();
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/admin/users", search: "?page=2&q=a" }),
    });
    expect(response.status).toBe(204);
    expect(seen).toEqual([{ href: "/admin/users?page=2&q=a", check: true }]);
  });

  it("[NAV-7] a middleware redirects a navigation with redirect_url built from event.url (the target)", async () => {
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/admin/_layout": moduleOf([
          (event: RequestEvent) => {
            if (!event.isNavigationCheck) return undefined;
            const back = `${event.url.pathname}${event.url.search}`;
            throw redirect(`/sign-in?redirect_url=${encodeURIComponent(back)}`);
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    const response = await client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/admin/users", search: "?tab=files" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 302,
      redirect: `/sign-in?redirect_url=${encodeURIComponent("/admin/users?tab=files")}`,
    });
  });

  it("[NAV-8] a document request is not a navigation check, and its url is the request's own", async () => {
    const seen: Array<{ href: string; check: boolean }> = [];
    const manifest: RouteMiddlewareManifest = {
      routes: {
        "/admin/_layout": moduleOf([
          (event: RequestEvent, next: Next) => {
            seen.push({
              href: `${event.url.pathname}${event.url.search}`,
              check: event.isNavigationCheck,
            });
            return next();
          },
        ]),
      },
      directories: {},
      pages: {},
      apis: {},
    };
    const client = boot(appManifest(adminRoutes(), manifest));
    await client.get("/admin/users?page=1");
    expect(seen).toEqual([{ href: "/admin/users?page=1", check: false }]);
  });

  it("[NAV-9] a search that is not a query (no leading ?, a fragment, a backslash) is a 400 before any middleware runs", async () => {
    const client = boot(appManifest(adminRoutes(), ADMIN_MIDDLEWARE));
    for (const search of ["page=2", "?a=1#x", "?a=\\b", "?a=\u0001"]) {
      const response = await client.post("/_dusk/nav", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/admin/users", search }),
      });
      expect(response.status, search).toBe(400);
    }
    expect(trace).toEqual([]);
  });
});
