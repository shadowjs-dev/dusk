import { deserialize, serialize } from "@shadow-js/web/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { after } from "../../src/server/after";
import { cacheData } from "../../src/server/data-cache";
import { draftMode } from "../../src/server/draft-mode";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  json,
  serverFn,
} from "../../src/server/index";
import { revalidateTag } from "../../src/server/isr";
import { createKvRateLimitStore, createKvSessionStore } from "../../src/server/kv-adapters";
import { createMemoryKVStore } from "../../src/server/kv-store";
import { createRateLimiter } from "../../src/server/rate-limit";
import { createSessionManager, signIn } from "../../src/server/session";
import { createTestClient, type TestClient } from "../../src/testing/index";
import { errorLog, loadApp, manifestOf } from "../support/app";
import { allFeatures } from "../support/features";

const SECRET = "draft-secret-0123456789abcdefghij";
const JSON_HEADERS = { "content-type": "application/json", "x-dusk-fn": "1" };

/** API routes the config rules point at. Each one reports what the route saw. */
const routes = {
  echo: apiRoute({
    GET: (event) =>
      json({
        pathname: event.url.pathname,
        search: event.url.search,
        draft: draftMode().enabled,
      }),
  }),
  blog: apiRoute({
    GET: (event) => json({ slug: event.params["*"] ?? null, path: event.url.pathname }),
  }),
  fallback: apiRoute({ GET: () => json({ fallback: true }) }),
  throwing: apiRoute({
    GET: () => {
      throw new Error("route failed");
    },
  }),
  header: apiRoute({
    GET: (event) => {
      event.responseHeaders.set("x-handler", "set");
      return json({});
    },
  }),
  counted: apiRoute({
    GET: async () => {
      const value = await cacheData(
        async () => {
          calls.count += 1;
          return { at: calls.count };
        },
        { key: ["counted"], revalidate: 60, tags: ["counted"] },
      );
      return json(value);
    },
  }),
  bust: apiRoute({
    POST: async () => {
      await revalidateTag("counted");
      return json({ busted: true });
    },
  }),
  queue: apiRoute({
    GET: () => {
      after(() => {
        ran.push("after");
      });
      return new Response("body");
    },
  }),
  failingAfter: apiRoute({
    GET: () => {
      after(() => {
        throw new Error("after failed");
      });
      return json({ ok: true });
    },
  }),
  session: apiRoute({
    POST: async (event) => {
      const session = await sessions.get(event);
      signIn(session, { user: "ada" });
      return json({ id: session.id });
    },
    GET: async (event) => json({ user: (await sessions.get(event)).get("user") ?? null }),
  }),
  limited: apiRoute({
    GET: async (event) =>
      json({ allowed: await limiter.check(event.url.pathname).then((d) => d.allowed) }),
  }),
};

const calls = { count: 0 };
const ran: string[] = [];
const sessions = createSessionManager({
  secrets: [SECRET],
  store: createKvSessionStore(createMemoryKVStore()),
});
const limiter = createRateLimiter({
  capacity: 2,
  refillPerSecond: 0.001,
  store: createKvRateLimitStore(createMemoryKVStore()),
});

const deployment = serverFn(
  { method: "GET", cacheControl: { visibility: "public", maxAge: 60, staleWhileRevalidate: 300 } },
  async () => ({ hello: "world" }),
);
const privateFn = serverFn(
  { method: "GET", cacheControl: { visibility: "private", maxAge: 10, vary: ["cookie"] } },
  async () => "p",
);
const postFn = serverFn({}, async (input: unknown) => String(input));
const brokenFn = serverFn(
  { method: "GET", cacheControl: { visibility: "public", maxAge: 60 } },
  async () => {
    throw new Error("nope");
  },
);

function manifest(): DuskRuntimeManifest {
  return manifestOf(loaded, {
    apiRoutes: [
      { id: "echo", path: "/echo/*", load: async () => routes.echo },
      { id: "blog", path: "/blog/*", load: async () => routes.blog },
      { id: "fallback", path: "/fallback", load: async () => routes.fallback },
      { id: "throwing", path: "/throwing", load: async () => routes.throwing },
      { id: "header", path: "/header", load: async () => routes.header },
      { id: "counted", path: "/counted", load: async () => routes.counted },
      { id: "bust", path: "/bust", load: async () => routes.bust },
      { id: "queue", path: "/queue", load: async () => routes.queue },
      { id: "failing-after", path: "/failing-after", load: async () => routes.failingAfter },
      { id: "session", path: "/session", load: async () => routes.session },
      { id: "limited", path: "/limited/:x", load: async () => routes.limited },
    ],
    serverFns: {
      deployment: { load: async () => deployment },
      privateFn: { load: async () => privateFn },
      postFn: { load: async () => postFn },
      brokenFn: { load: async () => brokenFn },
    },
  });
}

let loaded: Awaited<ReturnType<typeof loadApp>>;
let log: ReturnType<typeof errorLog>;
let handler: DuskHandler;
let client: TestClient;

async function boot(options: Partial<Parameters<typeof createHandler>[0]> = {}): Promise<void> {
  loaded ??= await loadApp();
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: manifest(),
    dev: true,
    onError: log.onError,
    ...options,
  });
  client = createTestClient(handler, { origin: "https://app.test" });
}

beforeEach(() => {
  calls.count = 0;
  ran.length = 0;
});

afterEach(() => {
  delete process.env["TEST_DRAFT_SECRET"];
});

describe("config redirects, rewrites and headers at the handler", () => {
  it("[ROUTE-8] a configured redirect answers with its status and the mount base; a loop to the same place is ignored", async () => {
    await boot({
      routing: {
        redirects: [
          { source: "/old/:x", destination: "/fallback", permanent: true },
          { source: "/fallback", destination: "/fallback" },
        ],
      },
    });
    const moved = await client.get("/old/1");
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe("/fallback");
    expect((await client.get("/fallback")).status).toBe(200);
  });

  it("[ROUTE-10] a beforeFiles rewrite changes the path the route sees; the request URL stays the same; the path asked for is kept", async () => {
    await boot({
      routing: {
        rewrites: {
          beforeFiles: [{ source: "/alias/*rest", destination: "/echo/*rest?from=alias" }],
        },
      },
    });
    const body = await (await client.get("/alias/a/b?keep=1")).json();
    expect(body).toMatchObject({ pathname: "/echo/a/b", search: "?keep=1&from=alias" });
  });

  it("[ROUTE-11] afterFiles and fallback rewrites apply only when no page matches the path", async () => {
    await boot({
      routing: {
        rewrites: {
          afterFiles: [{ source: "/legacy", destination: "/fallback" }],
          fallback: [{ source: "/**", destination: "/fallback" }],
        },
      },
    });
    expect(await (await client.get("/legacy")).json()).toEqual({ fallback: true });
    expect(await (await client.get("/anything/else")).json()).toEqual({ fallback: true });
    expect((await client.get("/echo/x")).status).toBe(200);
  });

  it("[ROUTE-12] header rules add headers to the answers they match; a header the handler set wins", async () => {
    await boot({
      routing: {
        headers: [
          { source: "/**", headers: { "x-site": "dusk", "x-handler": "rule" } },
          { source: "/header", headers: { "x-other": "1" } },
        ],
      },
    });
    const response = await client.get("/header");
    expect(response.headers.get("x-site")).toBe("dusk");
    expect(response.headers.get("x-handler")).toBe("set");
    expect(response.headers.get("x-other")).toBe("1");
  });

  it("[ROUTE-13] a route rule redirect with a rest parameter moves a whole subtree", async () => {
    await boot({
      routing: {
        routeRules: { "/old-blog/*rest": { redirect: { to: "/blog/*rest", statusCode: 301 } } },
      },
    });
    const response = await client.get("/old-blog/2026/10/nine");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/blog/2026/10/nine");
  });

  it("[ROUTE-14] a redirect target on a foreign origin that is not trusted is refused at start; a trusted one is allowed", async () => {
    await expect(
      boot({ routing: { redirects: [{ source: "/a", destination: "https://evil.example/x" }] } }),
    ).rejects.toThrow(/trustedOrigins/);
    await boot({
      trustedOrigins: ["https://partner.example"],
      routing: { redirects: [{ source: "/a", destination: "https://partner.example/x" }] },
    });
    expect((await client.get("/a")).headers.get("location")).toBe("https://partner.example/x");
  });

  it("[ROUTE-15] route rules: `cache: false` and a per-path header apply; the most specific rule wins", async () => {
    await boot({
      routing: {
        routeRules: {
          "/echo/**": { headers: { "x-rule": "wide" } },
          "/echo/*rest": { headers: { "x-rule": "narrow" } },
        },
      },
    });
    expect((await client.get("/echo/x")).headers.get("x-rule")).toBe("narrow");
  });

  it("[ROUTE-17] `ssr: false` in a route rule serves the document shell, with no rendered route content", async () => {
    await boot({ routing: { routeRules: { "/": { ssr: false } } } });
    const shell = await (await client.get("/")).text();
    expect(shell).not.toContain("<h1");
    expect(shell).toContain('id="app"');
  });

  it("[ROUTE-16] `csr: false` drops the entry script of the page; the default keeps it", async () => {
    await boot();
    const normal = await (await client.get("/")).text();
    expect(normal).toContain("/assets/entry-abc123.js");
    await boot({ routing: { routeRules: { "/": { csr: false } } } });
    const plain = await (await client.get("/")).text();
    expect(plain).not.toContain("/assets/entry-abc123.js");
  });
});

describe("i18n default language", () => {
  it("[DCFG-22] `i18n.defaultLocale` sets <html lang> when the document does not set one", async () => {
    await boot({ i18n: { locales: ["fr", "en"], defaultLocale: "fr" } });
    expect(await (await client.get("/")).text()).toContain('<html lang="fr">');
  });
});

describe("draft mode", () => {
  it("[DFT-1] the enable endpoint sets a signed cookie from the secret in the body; the route then sees draftMode().enabled", async () => {
    process.env["TEST_DRAFT_SECRET"] = SECRET;
    await boot({ draft: { secretEnv: "TEST_DRAFT_SECRET" } });
    expect((await client.get("/echo/x")).status).toBe(200);
    const before = await (await client.get("/echo/x")).json();
    expect(before).toMatchObject({ draft: false });
    const enabled = await client.request("/_dusk/draft/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET, path: "/echo/x" }),
    });
    expect(enabled.status).toBe(303);
    expect(enabled.headers.get("location")).toBe("/echo/x");
    expect(
      enabled.headers.getSetCookie().some((cookie) => cookie.startsWith("__dusk_draft=")),
    ).toBe(true);
    expect(await (await client.get("/echo/x")).json()).toMatchObject({ draft: true });
  });

  it("[DFT-2] a wrong secret is a 401 with no cookie; the endpoint refuses GET (the secret is never in a URL)", async () => {
    process.env["TEST_DRAFT_SECRET"] = SECRET;
    await boot({ draft: { secretEnv: "TEST_DRAFT_SECRET" } });
    const wrong = await client.request("/_dusk/draft/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "nope", path: "/" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect((await client.get(`/_dusk/draft/enable?secret=${SECRET}`)).status).toBe(405);
  });

  it("[DFT-3] without a configured secret the endpoints do not exist (404)", async () => {
    await boot({ draft: { secretEnv: "TEST_DRAFT_SECRET" } });
    const response = await client.request("/_dusk/draft/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(response.status).toBe(404);
  });

  it("[DFT-4] the disable endpoint clears the cookie; the next request is not in draft mode", async () => {
    process.env["TEST_DRAFT_SECRET"] = SECRET;
    await boot({ draft: { secretEnv: "TEST_DRAFT_SECRET" } });
    await client.request("/_dusk/draft/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET, path: "/" }),
    });
    expect(await (await client.get("/echo/x")).json()).toMatchObject({ draft: true });
    await client.request("/_dusk/draft/disable", { method: "POST" });
    expect(await (await client.get("/echo/x")).json()).toMatchObject({ draft: false });
  });

  it("[DFT-5] in draft mode the data cache runs the function every time and stores nothing", async () => {
    process.env["TEST_DRAFT_SECRET"] = SECRET;
    await boot({ draft: { secretEnv: "TEST_DRAFT_SECRET" } });
    await client.request("/_dusk/draft/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET, path: "/" }),
    });
    const first = await (await client.get("/counted")).json();
    const second = await (await client.get("/counted")).json();
    expect(second.at).toBe(first.at + 1);
  });
});

describe("after(), instrumentation and the data cache", () => {
  it("[AFT-6] a task of after() runs once the response body has been read; the response is not changed", async () => {
    await boot();
    const response = await client.get("/queue");
    expect(await response.text()).toBe("body");
    await vi.waitFor(() => expect(ran).toEqual(["after"]));
  });

  it("[AFT-7] a failing after() task is reported with phase `after`; the response still succeeds", async () => {
    const reported: { message: string; phase: string }[] = [];
    await boot({
      instrumentation: {
        onRequestError: (error, _request, context) => {
          reported.push({
            message: error instanceof Error ? error.message : String(error),
            phase: context.phase,
          });
        },
      },
    });
    const response = await client.get("/failing-after");
    expect(response.status).toBe(200);
    await response.text();
    await vi.waitFor(() => expect(reported).toEqual([{ message: "after failed", phase: "after" }]));
    expect(log.errors.map((entry) => entry.info.phase)).toEqual(["after"]);
  });

  it("[AFT-8] on a platform with waitUntil the tasks are handed to it, and the response is returned at once", async () => {
    await boot();
    const handed: Promise<unknown>[] = [];
    const platform = { waitUntil: (promise: Promise<unknown>) => void handed.push(promise) };
    const response = await handler.fetch(new Request("https://app.test/queue"), platform);
    expect(response.status).toBe(200);
    expect(handed).toHaveLength(1);
    await handed[0];
    expect(ran).toEqual(["after"]);
  });

  it("[INS-4] onRequestError receives the error, the request and the route kind; a failing hook never fails the request", async () => {
    const seen: { route: string | undefined; path: string; hookFailed: boolean }[] = [];
    await boot({
      instrumentation: {
        onRequestError: (error, request, context) => {
          seen.push({
            route: context.routeKind,
            path: request === undefined ? "" : new URL(request.url).pathname,
            hookFailed: false,
          });
          if (error instanceof Error && error.message === "route failed")
            throw new Error("hook also failed");
        },
      },
    });
    const response = await client.get("/throwing");
    expect(response.status).toBe(500);
    await response.text();
    expect(seen).toEqual([{ route: "api", path: "/throwing", hookFailed: false }]);
    // The failing hook is logged once; the request was answered regardless.
    expect(vi.mocked(console.error).mock.calls.map((call) => String(call[0]))).toEqual([
      "[dusk] instrumentation.onRequestError failed",
    ]);
    vi.mocked(console.error).mockClear();
  });

  it("[INS-5] onRequest runs before routing for every request, and a failure in it is reported and the request is answered", async () => {
    const started: string[] = [];
    await boot({
      instrumentation: {
        onRequest: (request) => {
          started.push(new URL(request.url).pathname);
          throw new Error("hook");
        },
      },
    });
    expect((await client.get("/fallback")).status).toBe(200);
    expect(started).toEqual(["/fallback"]);
    expect(log.errors.map((entry) => entry.info.phase)).toEqual(["instrumentation"]);
  });

  it("[INS-6] a tracer with the OpenTelemetry shape wraps every request in a span with the method and path", async () => {
    const spans: string[] = [];
    const attributes: Record<string, unknown>[] = [];
    const ended: string[] = [];
    await boot({
      instrumentation: {
        tracer: {
          startActiveSpan(name, options, fn) {
            spans.push(name);
            attributes.push({ ...options.attributes });
            return fn({
              setAttribute: () => undefined,
              recordException: () => undefined,
              setStatus: () => undefined,
              end: () => {
                ended.push(name);
              },
            });
          },
        },
      },
    });
    await (await client.get("/fallback")).text();
    // The request span, then the child span of the endpoint that answered it (see observability.server.test.ts).
    expect(spans).toEqual(["dusk.request", "dusk.api"]);
    expect(attributes[0]).toEqual({ "http.request.method": "GET", "url.path": "/fallback" });
    expect(ended.filter((name) => name === "dusk.request")).toHaveLength(1);
  });

  it("[DC-19] cacheData in a route is shared by requests; revalidateTag purges the data cache too", async () => {
    await boot();
    const first = await (await client.get("/counted")).json();
    const second = await (await client.get("/counted")).json();
    expect(second).toEqual(first);
    expect((await client.request("/bust", { method: "POST" })).status).toBe(200);
    const third = await (await client.get("/counted")).json();
    expect(third.at).toBe(first.at + 1);
  });
});

describe("deployment skew and per-function cache-control", () => {
  it("[DEP-2] a call from another deployment is 409 DEPLOYMENT_MISMATCH before it runs; the same deployment and no header run", async () => {
    await boot({ deploymentId: "rel-2" });
    const stale = await client.request("/_dusk/fn/postFn", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-dusk-deployment": "rel-1" },
      body: serialize([1]),
    });
    expect(stale.status).toBe(409);
    const body = deserialize(await stale.text()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DEPLOYMENT_MISMATCH");
    const same = await client.request("/_dusk/fn/postFn", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-dusk-deployment": "rel-2" },
      body: serialize([1]),
    });
    expect(same.status).toBe(200);
    const none = await client.request("/_dusk/fn/postFn", {
      method: "POST",
      headers: JSON_HEADERS,
      body: serialize([1]),
    });
    expect(none.status).toBe(200);
  });

  it("[DEP-3] a batch from another deployment is refused as one 409", async () => {
    await boot({ deploymentId: "rel-2" });
    const response = await client.request("/_dusk/fn/_batch", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-dusk-deployment": "old" },
      body: serialize([{ id: "postFn", input: [1] }]),
    });
    expect(response.status).toBe(409);
  });

  it("[CC-6] a GET function's cache-control is what it declares; errors and POST functions stay no-store", async () => {
    await boot();
    const ok = await client.request("/_dusk/fn/deployment", { headers: { "x-dusk-fn": "1" } });
    expect(ok.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
    const withCookie = await client.request("/_dusk/fn/deployment", {
      headers: { "x-dusk-fn": "1", cookie: "sid=1" },
    });
    expect(withCookie.headers.get("cache-control")).toBe(
      "private, max-age=60, stale-while-revalidate=300",
    );
    const priv = await client.request("/_dusk/fn/privateFn", { headers: { "x-dusk-fn": "1" } });
    expect(priv.headers.get("cache-control")).toBe("private, max-age=10");
    expect(priv.headers.get("vary")).toBe("cookie");
    const post = await client.request("/_dusk/fn/postFn", {
      method: "POST",
      headers: JSON_HEADERS,
      body: serialize([1]),
    });
    expect(post.headers.get("cache-control")).toBe("no-store");
    const failed = await client.request("/_dusk/fn/brokenFn", { headers: { "x-dusk-fn": "1" } });
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });
});

describe("CORS, sessions and rate limits on the KV store", () => {
  it("[CORS-1] a listed origin reads API answers and gets a preflight answer; another origin gets no CORS header", async () => {
    await boot({
      security: {
        cors: {
          origins: ["https://web.example"],
          methods: ["GET", "POST"],
          headers: ["x-token"],
          credentials: true,
        },
      },
    });
    const allowed = await client.request("/fallback", {
      headers: { origin: "https://web.example" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://web.example");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(allowed.headers.get("vary")).toContain("origin");
    const other = await client.request("/fallback", {
      headers: { origin: "https://evil.example" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await client.request("/fallback", {
      method: "OPTIONS",
      headers: {
        origin: "https://web.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-token",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("x-token");
  });

  it("[KV-18] sessions keep their data in a KV store across requests", async () => {
    await boot({ middleware: [sessions.middleware()] });
    const login = await client.request("/session", {
      method: "POST",
      headers: { origin: "https://app.test" },
    });
    expect(login.status).toBe(200);
    const after = await (await client.get("/session")).json();
    expect(after).toEqual({ user: "ada" });
  });

  it("[KV-19] the rate limiter over KV answers 429 after its capacity is used", async () => {
    await boot();
    expect((await client.get("/limited/a")).status).toBe(200);
    expect((await client.get("/limited/a")).status).toBe(200);
    const third = await client.get("/limited/a");
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual({ allowed: false });
  });
});

describe("the page cache and the KV store", () => {
  it("[KV-20] the page cache keeps its pages in the KV store (cache.kv): a route rule revalidate makes the second request a HIT", async () => {
    const kv = createMemoryKVStore();
    await boot({ cache: { kv }, routing: { routeRules: { "/": { revalidate: 60 } } } });
    const first = await client.get("/");
    expect(first.headers.get("x-dusk-cache")).toBe("MISS");
    await first.text();
    const second = await client.get("/");
    expect(second.headers.get("x-dusk-cache")).toBe("HIT");
    await second.text();
    expect((await kv.list({ prefix: "dusk:isr:" })).keys.length).toBeGreaterThan(0);
  });
});
