import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  createRateLimiter,
  type DuskHandler,
  defineEnv,
  EnvError,
  getRequestEvent,
  type HandlerOptions,
  json,
  readJson,
} from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { deferred } from "./support/deferred";
import { allFeatures } from "./support/features";

const SECRET = "0123456789abcdef0123456789abcdef-secret";

type Routes = Record<string, ReturnType<typeof apiRoute>>;

/** A handler over the shared app plus extra API routes, with a recording error sink. */
async function boot(
  routes: Routes = {},
  options: Partial<HandlerOptions> = {},
): Promise<{ handler: DuskHandler; client: TestClient; log: ReturnType<typeof errorLog> }> {
  const app = await loadApp();
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      apiRoutes: Object.entries(routes).map(([path, module]) => ({
        id: path,
        path,
        load: async () => module,
      })),
    }),
    dev: true,
    onError: log.onError,
    ...options,
  });
  return { handler, client: createTestClient(handler, { origin: "https://app.test" }), log };
}

const PROD = { dev: false, security: { allowedHosts: ["app.test"] } } as const;

describe("secure headers", () => {
  it("[SSEC-01] snapshot: the default security headers on a page, an API answer and an error", async () => {
    const { client } = await boot({ "/api/x": apiRoute({ GET: () => json({}) }) }, PROD);
    const names = [
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
      "x-frame-options",
      "cache-control",
      "strict-transport-security",
      "content-security-policy",
      "server",
      "x-powered-by",
    ];
    const pick = (response: Response): Record<string, string | null> =>
      Object.fromEntries(names.map((name) => [name, response.headers.get(name)]));
    const page = pick(await client.get("/"));
    expect(page).toMatchInlineSnapshot(`
      {
        "cache-control": "private, no-store",
        "content-security-policy": null,
        "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
        "referrer-policy": "strict-origin-when-cross-origin",
        "server": null,
        "strict-transport-security": null,
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
        "x-powered-by": null,
      }
    `);
    expect(pick(await client.get("/api/x"))).toEqual(page);
    expect(pick(await client.get("/missing-page"))).toEqual(page);
  });

  it("[SSEC-02] HSTS is opt-in and sent on https requests only; individual headers can be replaced or removed", async () => {
    const { handler } = await boot(
      {},
      {
        ...PROD,
        security: {
          allowedHosts: ["app.test"],
          headers: {
            hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
            referrerPolicy: "no-referrer",
            frameOptions: false,
            crossOriginOpenerPolicy: "same-origin",
          },
        },
      },
    );
    const secure = await handler.fetch(new Request("https://app.test/"));
    expect(secure.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(secure.headers.get("referrer-policy")).toBe("no-referrer");
    expect(secure.headers.get("x-frame-options")).toBeNull();
    expect(secure.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const plain = await handler.fetch(new Request("http://app.test/"));
    expect(plain.headers.get("strict-transport-security")).toBeNull();
  });

  it("[SSEC-03] headers: false turns the security headers off", async () => {
    const { client } = await boot(
      {},
      { ...PROD, security: { allowedHosts: ["app.test"], headers: false } },
    );
    expect((await client.get("/")).headers.get("x-content-type-options")).toBeNull();
  });
});

describe("content security policy", () => {
  it("[SSEC-10] a policy with a fresh nonce per request; inline scripts and styles carry it", async () => {
    const { client } = await boot(
      {},
      { ...PROD, security: { allowedHosts: ["app.test"], csp: {} } },
    );
    const first = await client.get("/posts/1");
    const html = await first.text();
    const header = first.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
    expect(nonce).toBeDefined();
    expect(header).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(header).toContain("object-src 'none'");
    expect(header).toContain("frame-ancestors 'self'");
    expect(html).toContain(
      `<script type="module" src="/assets/entry-abc123.js" nonce="${nonce}"></script>`,
    );
    const second = (await client.get("/")).headers.get("content-security-policy");
    expect(second).not.toBe(header);
  });

  it("[SSEC-13] the swap scripts of a streamed page carry the nonce too", async () => {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app),
      dev: true,
      onError: errorLog().onError,
      security: { csp: {} },
    });
    const slow = deferred<string>();
    app.gates["n"] = slow;
    const response = await handler.fetch(new Request("http://localhost/stream/n"));
    const nonce =
      /'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1] ?? "";
    const body = response.text();
    slow.resolve("late");
    const html = await body;
    const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")([^>]*)>/g)].map(
      (match) => match[1] ?? "",
    );
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const attributes of scripts) expect(attributes).toContain(`nonce="${nonce}"`);
  });

  it("[SSEC-11] the policy is only on HTML; report-only mode uses its own header; directives can be replaced", async () => {
    const { client } = await boot(
      { "/api/x": apiRoute({ GET: () => json({}) }) },
      {
        ...PROD,
        security: {
          allowedHosts: ["app.test"],
          csp: {
            reportOnly: true,
            directives: {
              "img-src": ["'self'", "https://img.test"],
              "upgrade-insecure-requests": true,
              "style-src": [],
            },
          },
        },
      },
    );
    const page = await client.get("/");
    expect(page.headers.get("content-security-policy")).toBeNull();
    const policy = page.headers.get("content-security-policy-report-only") ?? "";
    expect(policy).toContain("img-src 'self' https://img.test");
    expect(policy).toContain("upgrade-insecure-requests");
    expect(policy).not.toContain("style-src ");
    expect(
      (await client.get("/api/x")).headers.get("content-security-policy-report-only"),
    ).toBeNull();
  });

  it("[SSEC-12] an invalid policy fails at startup, not on the first request", async () => {
    await expect(
      boot({}, { security: { csp: { directives: { "script-src": ["'self'; script-src *"] } } } }),
    ).rejects.toThrow(/invalid/);
  });
});

describe("guards", () => {
  it("[SSEC-20] a host that is not allowed gets 400; wildcards and ports follow the rules; the health path is exempt", async () => {
    const { handler } = await boot(
      {},
      { dev: true, security: { allowedHosts: ["app.test", "*.app.test", "dev.test:8443"] } },
    );
    const status = async (url: string): Promise<number> =>
      (await handler.fetch(new Request(url))).status;
    expect(await status("https://app.test/")).toBe(200);
    expect(await status("https://api.app.test/")).toBe(200);
    expect(await status("https://evil.test/")).toBe(400);
    expect(await status("https://app.test.evil.test/")).toBe(400);
    expect(await status("https://xapp.test/")).toBe(400);
    expect(await status("https://dev.test:8443/")).toBe(200);
    expect(await status("https://dev.test:9000/")).toBe(400);
    expect(await status("https://evil.test/_dusk/health")).toBe(200);
  });

  it("[SSEC-21] a URL over the limit is 414 before any routing", async () => {
    const { client } = await boot({}, { dev: true, security: { limits: { maxUrlLength: 100 } } });
    expect((await client.get(`/posts/${"a".repeat(200)}`)).status).toBe(414);
    expect((await client.get("/posts/1")).status).toBe(200);
  });

  it("[SSEC-22] an unknown method is 501 with Allow (G-B8: a known method a route lacks is the 405)", async () => {
    const { client } = await boot();
    const response = await client.request("/", { method: "PURGE" });
    expect(response.status).toBe(501);
    expect(response.headers.get("allow")).toContain("GET");
  });

  it("[SSEC-23] framing that smuggling relies on is rejected: bad or repeated Content-Length, TE with CL, other codings", async () => {
    const { client } = await boot(
      { "/api/x": apiRoute({ POST: () => json({}) }) },
      { dev: true, security: { limits: { maxBodyBytes: 1000 } } },
    );
    const post = (headers: Record<string, string>): Promise<Response> =>
      client.post("/api/x", { headers, body: "hello" });
    expect((await post({ "content-length": "5, 5" })).status).toBe(400);
    expect((await post({ "content-length": "abc" })).status).toBe(400);
    expect((await post({ "content-length": "-1" })).status).toBe(400);
    expect((await post({ "content-length": "5", "transfer-encoding": "chunked" })).status).toBe(
      400,
    );
    expect((await post({ "transfer-encoding": "gzip, chunked" })).status).toBe(400);
    expect((await post({ "content-length": "5000" })).status).toBe(413);
  });

  it("[SSEC-24] a body that grows past the limit is cut off while it streams, with 413 for whichever route reads it", async () => {
    const { client } = await boot(
      {
        "/api/read": apiRoute({
          POST: async (event) => json({ n: (await event.request.text()).length }),
        }),
      },
      { dev: true, security: { limits: { maxBodyBytes: 100 } } },
    );
    const chunks = Array.from({ length: 10 }, () => new TextEncoder().encode("x".repeat(30)));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    });
    const response = await client.request("/api/read", {
      method: "POST",
      body: stream,
      duplex: "half",
    });
    expect(response.status).toBe(413);
    expect(chunks.length).toBeGreaterThan(0);
    const small = await client.request("/api/read", { method: "POST", body: "x".repeat(50) });
    expect(await small.json()).toEqual({ n: 50 });
  });

  it("[SSEC-25] a request that outlives the time budget is 504 and its signal is aborted", async () => {
    const seen = deferred<boolean>();
    const { client } = await boot(
      {
        "/api/slow": apiRoute({
          GET: async (event) => {
            event.signal.addEventListener("abort", () => seen.resolve(true));
            await new Promise<never>(() => undefined);
            return json({});
          },
        }),
      },
      { dev: false, security: { allowedHosts: ["app.test"], limits: { requestTimeoutMs: 20 } } },
    );
    const response = await client.get("/api/slow");
    expect(response.status).toBe(504);
    expect((await response.json()).error.message).toBe("Gateway Timeout");
    expect(await seen.promise).toBe(true);
  });

  it("[SSEC-26] a request whose own signal is already aborted gets no work done", async () => {
    let ran = false;
    const { handler } = await boot({
      "/api/x": apiRoute({
        GET: () => {
          ran = true;
          return json({});
        },
      }),
    });
    const response = await handler.fetch(
      new Request("http://localhost/api/x", { signal: AbortSignal.abort() }),
    );
    expect(response.status).toBe(499);
    expect(ran).toBe(false);
  });

  it("[SSEC-27] the health endpoint answers without middleware; it can be moved or turned off", async () => {
    const { handler } = await boot(
      {},
      { dev: true, middleware: [() => new Response("blocked", { status: 401 })] },
    );
    const health = await handler.fetch(new Request("http://localhost/_dusk/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const { handler: off } = await boot({}, { dev: true, healthPath: false });
    expect((await off.fetch(new Request("http://localhost/_dusk/health"))).status).toBe(404);
  });
});

describe("csrf", () => {
  const origin = "https://app.test";
  const cases: Array<{ name: string; headers: Record<string, string>; ok: boolean }> = [
    { name: "same-origin fetch metadata", headers: { "sec-fetch-site": "same-origin" }, ok: true },
    {
      name: "same-origin metadata beats a hostile Origin",
      headers: { "sec-fetch-site": "same-origin", origin: "https://evil.test" },
      ok: true,
    },
    {
      name: "cross-site",
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
      ok: false,
    },
    {
      name: "same-site sibling",
      headers: { "sec-fetch-site": "same-site", origin: "https://sibling.app.test" },
      ok: false,
    },
    { name: "user navigation sends none", headers: { "sec-fetch-site": "none" }, ok: false },
    {
      name: "cross-site from a trusted origin",
      headers: { "sec-fetch-site": "cross-site", origin: "https://partner.test" },
      ok: true,
    },
    { name: "no metadata, matching Origin", headers: { origin }, ok: true },
    { name: "no metadata, other Origin", headers: { origin: "https://evil.test" }, ok: false },
    { name: "no metadata, trusted Origin", headers: { origin: "https://partner.test" }, ok: true },
    { name: "Origin: null", headers: { origin: "null" }, ok: false },
    { name: "two Origins", headers: { origin: `${origin}, https://evil.test` }, ok: false },
    {
      name: "Origin with a look-alike host",
      headers: { origin: "https://app.test.evil.test" },
      ok: false,
    },
    { name: "Origin with another scheme", headers: { origin: "http://app.test" }, ok: false },
    { name: "Origin with another port", headers: { origin: "https://app.test:444" }, ok: false },
    { name: "no Origin, matching Referer", headers: { referer: `${origin}/form` }, ok: true },
    {
      name: "no Origin, foreign Referer",
      headers: { referer: "https://evil.test/form" },
      ok: false,
    },
    { name: "nothing at all", headers: {}, ok: false },
  ];

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    it(`[SSEC-30] ${method}: the decision table (${cases.length} cases) is enforced before the route runs`, async () => {
      let runs = 0;
      const count = (): Response => {
        runs += 1;
        return json({});
      };
      const { handler } = await boot(
        { "/api/c": apiRoute({ POST: count, PUT: count, PATCH: count, DELETE: count }) },
        { dev: true, trustedOrigins: ["https://partner.test"] },
      );
      let expected = 0;
      for (const entry of cases) {
        const response = await handler.fetch(
          new Request(`${origin}/api/c`, { method, headers: entry.headers, body: "{}" }),
        );
        expect(response.status, entry.name).toBe(entry.ok ? 200 : 403);
        if (entry.ok) expected += 1;
      }
      expect(runs).toBe(expected);
    });
  }

  it("[SSEC-31] safe methods are never checked; allowMissingOrigin admits header-less clients; csrf: false disables it", async () => {
    const { handler } = await boot(
      { "/api/c": apiRoute({ GET: () => json({}), POST: () => json({}) }) },
      { dev: true },
    );
    expect(
      (
        await handler.fetch(
          new Request(`${origin}/api/c`, { headers: { "sec-fetch-site": "cross-site" } }),
        )
      ).status,
    ).toBe(200);
    const lenient = await boot(
      { "/api/c": apiRoute({ POST: () => json({}) }) },
      { dev: true, security: { csrf: { allowMissingOrigin: true } } },
    );
    expect(
      (await lenient.handler.fetch(new Request(`${origin}/api/c`, { method: "POST" }))).status,
    ).toBe(200);
    expect(
      (
        await lenient.handler.fetch(
          new Request(`${origin}/api/c`, {
            method: "POST",
            headers: { origin: "https://evil.test" },
          }),
        )
      ).status,
    ).toBe(403);
    const off = await boot(
      { "/api/c": apiRoute({ POST: () => json({}) }) },
      { dev: true, security: { csrf: false } },
    );
    expect(
      (
        await off.handler.fetch(
          new Request(`${origin}/api/c`, {
            method: "POST",
            headers: { "sec-fetch-site": "cross-site" },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it("[SSEC-32] the reason is shown in development only", async () => {
    const dev = await boot({ "/api/c": apiRoute({ POST: () => json({}) }) }, { dev: true });
    const shown = await dev.handler.fetch(
      new Request(`${origin}/api/c`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect((await shown.json()).error.message).toContain("cross-site");
    const prod = await boot({ "/api/c": apiRoute({ POST: () => json({}) }) }, PROD);
    const hidden = await prod.handler.fetch(
      new Request(`${origin}/api/c`, {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect((await hidden.json()).error.message).toBe("Forbidden");
  });
});

describe("context, cookies, env, limits through the handler", () => {
  it("[SSEC-40] request ids are generated per request and the client cannot choose one", async () => {
    const { client } = await boot();
    const a = (await client.get("/", { headers: { "x-request-id": "attacker" } })).headers.get(
      "x-request-id",
    );
    const b = (await client.get("/")).headers.get("x-request-id");
    expect(a).not.toBe("attacker");
    expect(a).not.toBe(b);
  });

  it("[SSEC-41] cookies are secure by default in production; in development over http://localhost they are not Secure", async () => {
    const route = apiRoute({
      GET: (event) => {
        event.cookies.set("a", "1");
        event.cookies.set("b", "two words", { sameSite: "strict", maxAge: 60, httpOnly: false });
        return json({});
      },
    });
    const prod = await boot({ "/api/c": route }, PROD);
    const set = (await prod.client.get("/api/c")).headers.getSetCookie();
    expect(set).toEqual([
      "a=1; Path=/; HttpOnly; Secure; SameSite=Lax",
      "b=two%20words; Path=/; Max-Age=60; Secure; SameSite=Strict",
    ]);
    const dev = await boot({ "/api/c": route }, { dev: true });
    const local = createTestClient(dev.handler);
    expect((await local.get("/api/c")).headers.getSetCookie()[0]).toBe(
      "a=1; Path=/; HttpOnly; SameSite=Lax",
    );
  });

  it("[SSEC-42] signed cookies verify, and a tampered value, a swapped name or a stranger's signature are rejected", async () => {
    const route = apiRoute({
      GET: async (event) => {
        await event.cookies.setSigned("sid", "user-1");
        return json({});
      },
      POST: async (event) =>
        json({
          sid: (await event.cookies.getSigned("sid")) ?? null,
          other: (await event.cookies.getSigned("other")) ?? null,
        }),
    });
    const secrets = [SECRET];
    const { client, handler } = await boot(
      { "/api/c": route },
      { ...PROD, security: { allowedHosts: ["app.test"], cookieSecrets: secrets } },
    );
    await client.get("/api/c");
    const issued = client.cookies.get("sid", new URL("https://app.test/")) ?? "";
    expect(issued.startsWith("user-1.")).toBe(true);
    expect(await (await client.post("/api/c")).json()).toEqual({ sid: "user-1", other: null });
    const call = async (cookie: string): Promise<unknown> =>
      (
        await createTestClient(handler, { origin: "https://app.test" }).post("/api/c", {
          headers: { cookie },
        })
      ).json();
    expect(await call(`sid=${encodeURIComponent(issued.replace("user-1", "admin"))}`)).toEqual({
      sid: null,
      other: null,
    });
    expect(await call(`sid=${encodeURIComponent(issued.slice(0, -2))}`)).toEqual({
      sid: null,
      other: null,
    });
    expect(await call(`other=${encodeURIComponent(issued)}`)).toEqual({ sid: null, other: null });
    expect(await call(`sid=${encodeURIComponent("user-1.")}`)).toEqual({ sid: null, other: null });
  });

  it("[SSEC-43] secrets rotate: a cookie signed with the old secret still verifies and new ones use the new", async () => {
    const OLD = "old-secret-old-secret-old-secret-0000";
    const route = apiRoute({
      GET: async (event) => {
        await event.cookies.setSigned("sid", "x");
        return json({});
      },
      POST: async (event) => json({ sid: (await event.cookies.getSigned("sid")) ?? null }),
    });
    const before = await boot(
      { "/api/c": route },
      { ...PROD, security: { allowedHosts: ["app.test"], cookieSecrets: [OLD] } },
    );
    await before.client.get("/api/c");
    const cookie = `sid=${encodeURIComponent(before.client.cookies.get("sid", new URL("https://app.test/")) ?? "")}`;
    const after = await boot(
      { "/api/c": route },
      { ...PROD, security: { allowedHosts: ["app.test"], cookieSecrets: [SECRET, OLD] } },
    );
    expect(await (await after.client.post("/api/c", { headers: { cookie } })).json()).toEqual({
      sid: "x",
    });
    const removed = await boot(
      { "/api/c": route },
      { ...PROD, security: { allowedHosts: ["app.test"], cookieSecrets: [SECRET] } },
    );
    expect(await (await removed.client.post("/api/c", { headers: { cookie } })).json()).toEqual({
      sid: null,
    });
  });

  it("[SSEC-44] signed cookies without a configured secret fail loudly; weak secrets fail at startup", async () => {
    const route = apiRoute({
      GET: async (event) => {
        await event.cookies.setSigned("a", "b");
        return json({});
      },
    });
    const { client, log } = await boot({ "/api/c": route }, { dev: true });
    expect((await client.get("/api/c")).status).toBe(500);
    expect(log.errors[0]?.error).toMatchObject({
      message: expect.stringContaining("COOKIE_SECRET_MISSING"),
    });
    await expect(boot({}, { security: { cookieSecrets: ["short"] } })).rejects.toThrow(
      /COOKIE_SECRET_WEAK/,
    );
  });

  it("[SSEC-45] the client address comes from the host object; proxy headers count only when trusted, from the right", async () => {
    const route = apiRoute({ GET: (event) => json({ ip: event.clientAddress ?? null }) });
    const call = async (
      security: HandlerOptions["security"],
      headers: Record<string, string>,
    ): Promise<unknown> => {
      const { handler } = await boot(
        { "/api/ip": route },
        { dev: true, ...(security === undefined ? {} : { security }) },
      );
      return (
        await (
          await handler.fetch(new Request("http://localhost/api/ip", { headers }), {
            clientAddress: "::ffff:10.0.0.2",
          })
        ).json()
      ).ip;
    };
    expect(await call(undefined, { "x-forwarded-for": "6.6.6.6" })).toBe("10.0.0.2");
    expect(await call({ trustProxy: {} }, { "x-forwarded-for": "6.6.6.6, 1.2.3.4" })).toBe(
      "1.2.3.4",
    );
    expect(await call({ trustProxy: { hops: 2 } }, { "x-forwarded-for": "6.6.6.6, 1.2.3.4" })).toBe(
      "6.6.6.6",
    );
    expect(await call({ trustProxy: {} }, { "x-forwarded-for": "not an ip" })).toBe("10.0.0.2");
    expect(
      await call({ trustProxy: { header: "x-real-ip" } }, { "x-real-ip": "[2001:db8::1]:80" }),
    ).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(
      await call(
        { trustProxy: { trustedPeers: ["192.168.0.1"] } },
        { "x-forwarded-for": "1.2.3.4" },
      ),
    ).toBe("10.0.0.2");
    expect(
      await call({ trustProxy: { trustedPeers: ["10.0.0.2"] } }, { "x-forwarded-for": "1.2.3.4" }),
    ).toBe("1.2.3.4");
  });

  it("[SSEC-46] the rate limit middleware answers 429 with Retry-After and rate-limit headers", async () => {
    let now = 0;
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
    const { handler } = await boot(
      { "/api/x": apiRoute({ GET: () => json({}) }) },
      { dev: true, middleware: [limiter.middleware()] },
    );
    const hit = (address: string): Promise<Response> =>
      handler.fetch(new Request("http://localhost/api/x"), { clientAddress: address });
    expect((await hit("1.1.1.1")).status).toBe(200);
    const second = await hit("1.1.1.1");
    expect(second.status).toBe(200);
    expect(second.headers.get("ratelimit-remaining")).toBe("0");
    const blocked = await hit("1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect(blocked.headers.get("ratelimit-limit")).toBe("2");
    expect((await hit("2.2.2.2")).status).toBe(200);
    now += 1000;
    expect((await hit("1.1.1.1")).status).toBe(200);
  });

  it("[SSEC-47] the environment is validated at startup and exposed to handlers; errors name keys, never values", async () => {
    const env = defineEnv({
      API_KEY: { type: "string", minLength: 8, secret: true },
      PORT: { type: "number", integer: true, default: 3000 },
      DUSK_PUBLIC_NAME: { type: "string" },
    });
    const route = apiRoute({
      GET: (event) => json({ port: event.env["PORT"], name: event.env["DUSK_PUBLIC_NAME"] }),
    });
    const good = await boot(
      { "/api/e": route },
      { dev: true, env, envSource: { API_KEY: "supersecret", DUSK_PUBLIC_NAME: "shadow" } },
    );
    expect(await (await good.client.get("/api/e")).json()).toEqual({ port: 3000, name: "shadow" });
    expect(good.handler.env?.public).toEqual({ DUSK_PUBLIC_NAME: "shadow" });
    const failure = await boot(
      {},
      { dev: true, env, envSource: { API_KEY: "tiny-secret-value-123" } },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnvError);
    expect(String(failure)).toContain("DUSK_PUBLIC_NAME (required)");
    const short = await boot(
      {},
      { dev: true, env, envSource: { API_KEY: "short", DUSK_PUBLIC_NAME: "x" } },
    ).catch((error: unknown) => error);
    expect(String(short)).toContain("API_KEY (shorter than 8 characters)");
    expect(String(short)).not.toContain('short"');
  });

  it("[SSEC-48] without a startup source (Workers) the schema is validated from the host object on the first request", async () => {
    const env = defineEnv({ TOKEN: { type: "string" } });
    const route = apiRoute({ GET: (event) => json({ token: event.env["TOKEN"] }) });
    const { handler, log } = await boot({ "/api/e": route }, { dev: true, env, envSource: false });
    expect(handler.env).toBeUndefined();
    const ok = await handler.fetch(new Request("http://localhost/api/e"), {
      TOKEN: "t0k3n",
      OTHER: 1,
    });
    expect(await ok.json()).toEqual({ token: "t0k3n" });
    expect(handler.env?.all).toEqual({ TOKEN: "t0k3n" });
    const missing = await boot({ "/api/e": route }, { dev: true, env, envSource: false });
    const failed = await missing.handler.fetch(new Request("http://localhost/api/e"), {});
    expect(failed.status).toBe(500);
    expect(missing.log.errors).toHaveLength(1);
    expect(log.errors).toHaveLength(0);
  });

  it("[SSEC-49] with asyncContext off getRequestEvent() throws and the event is passed explicitly", async () => {
    const route = apiRoute({
      GET: (event) => {
        try {
          getRequestEvent();
          return json({ context: true });
        } catch (error) {
          return json({
            context: false,
            code: (error as { code?: string }).code,
            same: event.id.length > 0,
          });
        }
      },
    });
    const on = await boot({ "/api/c": route });
    expect(await (await on.client.get("/api/c")).json()).toEqual({ context: true });
    const off = await boot({ "/api/c": route }, { asyncContext: false });
    expect(await (await off.client.get("/api/c")).json()).toEqual({
      context: false,
      code: "SERVER_NO_REQUEST_EVENT",
      same: true,
    });
  });

  it("[SSEC-50] JSON bodies with prototype-pollution keys are rejected; Object.prototype stays clean", async () => {
    const route = apiRoute({
      POST: async (event) => json({ body: await readJson(event.request) }),
    });
    const { client } = await boot({ "/api/j": route });
    for (const body of [
      '{"__proto__":{"polluted":true}}',
      '{"a":{"__proto__":{"x":1}}}',
      '{"constructor":{"prototype":{"x":1}}}',
      '[{"__proto__":1}]',
    ]) {
      expect(
        (await client.post("/api/j", { headers: { "content-type": "application/json" }, body }))
          .status,
        body,
      ).toBe(400);
    }
    const fine = await client.post("/api/j", {
      headers: { "content-type": "application/json" },
      body: '{"constructor":"x","a":[1]}',
    });
    expect(await fine.json()).toEqual({ body: { constructor: "x", a: [1] } });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(
      (await client.post("/api/j", { headers: { "content-type": "text/plain" }, body: "{}" }))
        .status,
    ).toBe(415);
    expect(
      (await client.post("/api/j", { headers: { "content-type": "application/json" }, body: "{" }))
        .status,
    ).toBe(400);
  });

  it("[SSEC-51] ETag handling: a matching If-None-Match gives 304 without a body", async () => {
    const route = apiRoute({
      GET: () =>
        json({ v: 1 }, { headers: { etag: 'W/"abc"', "cache-control": "public, max-age=60" } }),
    });
    const { client } = await boot({ "/api/e": route });
    const first = await client.get("/api/e");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    const second = await client.get("/api/e", { headers: { "if-none-match": '"abc", "def"' } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect((await client.get("/api/e", { headers: { "if-none-match": '"zzz"' } })).status).toBe(
      200,
    );
  });

  it("[SSEC-52] production without allowedHosts starts, and warns once on the first request; development is silent", async () => {
    // Updated by G-C6: the note is sent on the first request in production, never while the module is evaluated.
    const warnings: string[] = [];
    const prod = await boot({}, { dev: false, onWarning: (message) => warnings.push(message) });
    expect(warnings).toEqual([]);
    await prod.handler.fetch(new Request("https://localhost/"));
    await prod.handler.fetch(new Request("https://localhost/"));
    expect(warnings.filter((message) => /security\.allowedHosts/.test(message))).toHaveLength(1);
    await boot({}, { dev: true, onWarning: (message) => warnings.push(message) });
    expect(warnings).toHaveLength(1);
  });

  it("[SSEC-53] invalid configuration throws at startup", async () => {
    await expect(boot({}, { base: "app" })).rejects.toThrow(/base/);
    await expect(boot({}, { base: "//evil" })).rejects.toThrow(/base/);
    await expect(boot({}, { trustedOrigins: ["javascript:alert(1)"] })).rejects.toThrow(/origin/);
    await expect(boot({}, { security: { limits: { maxBodyBytes: 0 } } })).rejects.toThrow(
      /maxBodyBytes/,
    );
    await expect(boot({}, { document: { lang: "en us" } })).rejects.toThrow(/lang/);
    await expect(boot({}, { renderId: "bad id" })).rejects.toThrow(/renderId/);
    await expect(boot({}, { security: { allowedHosts: ["*"] } })).rejects.toThrow(/invalid/);
  });
});
