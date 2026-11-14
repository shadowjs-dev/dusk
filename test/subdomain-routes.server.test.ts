import { defineRoute } from "@shadow-js/router";
import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  HttpError,
  json,
  type Middleware,
  type MiddlewareModule,
  type RouteMiddlewareManifest,
  rewrite,
} from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { allFeatures } from "./support/features";

/*
 * One app serves the hosts `example.com` and `api.example.com`. A global middleware rewrites the api host into the
 * private folder `/_hosts/api`; the target route decides about CSRF, and the navigation gate checks the middleware of
 * the route the browser will render, not of the public route of the same path.
 */

const calls: string[] = [];

const ISSUE = apiRoute({
  csrf: false,
  POST: async (event) =>
    json({ via: "issue", path: event.url.pathname, body: await event.request.text() }),
});
const GUARDED = apiRoute({
  POST: (event) => json({ via: "guarded", path: event.url.pathname }),
  GET: () => json({ via: "guarded-get" }),
});

function moduleOf(value: unknown): MiddlewareModule {
  return { load: async () => value };
}

const hostRouting: Middleware = (event, next) => {
  calls.push(`host:${event.method} ${event.url.hostname}${event.url.pathname}`);
  if (event.url.pathname.startsWith("/_dusk/")) return next();
  if (event.url.hostname !== "api.example.com") return next();
  return rewrite(`/_hosts/api${event.url.pathname}${event.url.search}`);
};

const page = (id: string, path: string, children?: ReturnType<typeof defineRoute>[]) =>
  defineRoute(path, {
    id,
    component: () => null,
    ...(children === undefined ? {} : { children }),
  });

const MIDDLEWARE: RouteMiddlewareManifest = {
  routes: {
    // The private page refuses; the public page of the same visible path does not.
    "dash-admin": moduleOf([
      (event: { url: URL }) => {
        calls.push(`dash-admin-middleware:${event.url.pathname}`);
        throw new HttpError(401, "sign in");
      },
    ]),
  },
  directories: {},
  pages: {},
  apis: {},
};

async function boot(
  options: { middleware?: Middleware[]; rewriteHosts?: readonly string[] | undefined } = {},
): Promise<DuskHandler> {
  const rewriteHosts = "rewriteHosts" in options ? options.rewriteHosts : ["api.example.com"];
  calls.length = 0;
  return createHandler({
    features: allFeatures(),
    manifest: {
      routes: [
        defineRoute("", {
          id: "root",
          component: (props: { children?: unknown }) => props.children as never,
          children: [
            page("site-admin", "/admin"),
            page("dash", "/_hosts/dash", [page("dash-admin", "/admin")]),
          ],
        }),
      ],
      apiRoutes: [
        { id: "issue", path: "/_hosts/api/v1/invites", load: async () => ISSUE as never },
        { id: "guarded", path: "/_hosts/api/v1/members", load: async () => GUARDED as never },
        { id: "public-members", path: "/v1/members", load: async () => GUARDED as never },
      ],
      serverFns: {},
      assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
      App: (props: { children?: unknown }) => props.children as never,
      middleware: MIDDLEWARE,
    },
    dev: false,
    security: {
      allowedHosts: ["example.com", "api.example.com", "localhost"],
      ...(rewriteHosts === undefined ? {} : { csrf: { rewriteHosts } }),
    },
    onError: () => undefined,
    middleware: options.middleware ?? [hostRouting],
  });
}

/** A request with no browser headers: a script, a webhook sender, a server. */
function script(url: string, init: RequestInit = {}): Request {
  return new Request(url, { method: "POST", body: "{}", ...init });
}

describe("CSRF for a request a middleware rewrites", () => {
  it("[SUB-CSRF-1] a non-browser POST reaches the rewrite target that sets csrf = false", async () => {
    const handler = await boot();
    const response = await handler.fetch(script("https://api.example.com/v1/invites"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      via: "issue",
      path: "/_hosts/api/v1/invites",
      body: "{}",
    });
  });

  it("[SUB-CSRF-2] a rewrite target that keeps the check still refuses a non-browser POST, and answers a same-origin one", async () => {
    const handler = await boot();
    const refused = await handler.fetch(script("https://api.example.com/v1/members"));
    expect(refused.status).toBe(403);
    const allowed = await handler.fetch(
      script("https://api.example.com/v1/members", {
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it("[SUB-CSRF-3] a cross-site browser POST is refused by a target that keeps the check, whatever the host", async () => {
    const handler = await boot();
    for (const headers of [
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { origin: "https://evil.example" },
      { referer: "https://evil.example/x" },
      { "sec-fetch-site": "same-site", origin: "https://other.example.com" },
    ]) {
      const response = await handler.fetch(
        script("https://api.example.com/v1/members", { headers }),
      );
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("[SUB-CSRF-4] the opt-out is the target's: the same POST to a route that is not rewritten keeps the check", async () => {
    const handler = await boot();
    expect((await handler.fetch(script("https://example.com/v1/members"))).status).toBe(403);
    // The private folder is not a public path, and the check comes first for a request that names no route.
    expect((await handler.fetch(script("https://example.com/_hosts/api/v1/invites"))).status).toBe(
      403,
    );
    const browser = { "sec-fetch-site": "same-origin" };
    expect(
      (
        await handler.fetch(
          script("https://example.com/_hosts/api/v1/invites", { headers: browser }),
        )
      ).status,
    ).toBe(404);
  });

  it("[SUB-CSRF-5] the global middleware runs once for the request, and the refusal does not run the endpoint", async () => {
    const handler = await boot();
    const refused = await handler.fetch(script("https://api.example.com/v1/members"));
    expect(refused.status).toBe(403);
    expect(calls).toEqual(["host:POST api.example.com/v1/members"]);
  });

  it("[SUB-CSRF-6] a request the check refuses and nothing rewrites is a 403 whatever the middleware answers", async () => {
    const answers: Middleware[] = [() => new Response("middleware says ok", { status: 200 })];
    const handler = await boot({ middleware: answers, rewriteHosts: ["example.com"] });
    const response = await handler.fetch(script("https://example.com/v1/members"));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("middleware says ok");
  });

  it("[SUB-CSRF-7] a middleware that throws on a refused request still gives the 403, not its own failure", async () => {
    const throwing: Middleware[] = [
      () => {
        throw new HttpError(418, "teapot");
      },
    ];
    const handler = await boot({ middleware: throwing, rewriteHosts: ["example.com"] });
    const response = await handler.fetch(script("https://example.com/v1/members"));
    expect(response.status).toBe(403);
  });

  it("[SUB-CSRF-8] a safe method is never affected, and a handler with no middleware refuses at once", async () => {
    const handler = await boot();
    expect((await handler.fetch(new Request("https://api.example.com/v1/members"))).status).toBe(
      200,
    );
    const bare = await boot({ middleware: [] });
    expect((await bare.fetch(script("https://example.com/v1/members"))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("[SUB-CSRF-9] a browser's own headers decide at the target: a user-initiated unsafe request is refused there", async () => {
    const handler = await boot();
    const response = await handler.fetch(
      script("https://api.example.com/v1/members", { headers: { "sec-fetch-site": "none" } }),
    );
    expect(response.status).toBe(403);
  });
});

describe("which hosts wait for the middleware", () => {
  it("[SUB-CSRF-10] without security.csrf.rewriteHosts a refused request never reaches the middleware, and the target's opt-out is not seen", async () => {
    const handler = await boot({ rewriteHosts: undefined });
    const response = await handler.fetch(script("https://api.example.com/v1/invites"));
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("[SUB-CSRF-11] a host that is not listed keeps that rule while another host is listed", async () => {
    const answers: Middleware[] = [
      (event, next) => {
        calls.push(`ran:${event.url.host}`);
        return next();
      },
    ];
    const handler = await boot({ middleware: answers });
    expect((await handler.fetch(script("https://example.com/v1/members"))).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await handler.fetch(script("https://api.example.com/v1/members"))).status).toBe(403);
    expect(calls).toEqual(["ran:api.example.com"]);
  });

  it("[SUB-CSRF-12] hosts are written as allowedHosts are: wildcards and ports", async () => {
    for (const pattern of ["*.example.com", "API.example.com"]) {
      const handler = await boot({ rewriteHosts: [pattern] });
      const response = await handler.fetch(script("https://api.example.com/v1/invites"));
      expect(response.status, pattern).toBe(200);
    }
    const wrongPort = await boot({ rewriteHosts: ["api.example.com:8443"] });
    expect((await wrongPort.fetch(script("https://api.example.com/v1/invites"))).status).toBe(403);
  });

  it("[SUB-CSRF-13] an empty list, and an invalid host, are the defaults and an error at startup", async () => {
    const empty = await boot({ rewriteHosts: [] });
    expect((await empty.fetch(script("https://api.example.com/v1/invites"))).status).toBe(403);
    await expect(boot({ rewriteHosts: ["*"] })).rejects.toThrow(TypeError);
  });
});

describe("the navigation gate of a mapped host", () => {
  const post = (client: ReturnType<typeof createTestClient>, body: unknown) =>
    client.post("/_dusk/nav", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("[SUB-NAV-1] without `route` the gate checks the route of the path as written (the site's)", async () => {
    const client = createTestClient(await boot());
    const response = await post(client, { path: "/admin" });
    expect(response.status).toBe(204);
    expect(calls.filter((call) => call.startsWith("dash-admin"))).toEqual([]);
  });

  it("[SUB-NAV-2] with `route` the gate runs the middleware of that route's chain, and the middleware sees the visible URL", async () => {
    const client = createTestClient(await boot());
    const response = await post(client, { path: "/admin", route: "/_hosts/dash/admin" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dusk-gate")).toBe("refused");
    expect(await response.json()).toEqual({ status: 401 });
    expect(calls.filter((call) => call.startsWith("dash-admin"))).toEqual([
      "dash-admin-middleware:/admin",
    ]);
  });

  it("[SUB-NAV-3] `route` must be an app path like `path`: no URLs, no protocol-relative paths, no query", async () => {
    const client = createTestClient(await boot());
    for (const route of [
      "//evil.example/x",
      "https://evil.example/",
      "/admin?x=1",
      "/admin#x",
      "admin",
      7,
    ]) {
      const response = await post(client, { path: "/admin", route });
      expect(response.status, String(route)).toBe(400);
    }
  });

  it("[SUB-NAV-4] a `route` that matches no route is a pass, as an unknown path is: the page's own 404 follows in the browser", async () => {
    const client = createTestClient(await boot());
    const response = await post(client, { path: "/admin", route: "/_hosts/dash/nope" });
    expect(response.status).toBe(204);
  });
});
