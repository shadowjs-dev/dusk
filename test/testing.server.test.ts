import { describe, expect, it } from "vitest";
import { apiRoute, createHandler, json } from "../src/server/index";
import { createTestClient, createTestEvent } from "../src/testing/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

async function make(
  routes: Record<string, ReturnType<typeof apiRoute>> = {},
  options: Partial<Parameters<typeof createHandler>[0]> = {},
) {
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
  return { handler, app, log };
}

describe("test client", () => {
  it("[STST-01] keeps cookies between requests and sends them back, like a browser", async () => {
    const { handler } = await make({
      "/api/set": apiRoute({
        GET: (event) => {
          event.cookies.set("theme", "dark", { httpOnly: false });
          return json({});
        },
      }),
      "/api/get": apiRoute({ GET: (event) => json({ theme: event.cookies.get("theme") ?? null }) }),
    });
    const client = createTestClient(handler);
    expect(await (await client.get("/api/get")).json()).toEqual({ theme: null });
    await client.get("/api/set");
    expect(await (await client.get("/api/get")).json()).toEqual({ theme: "dark" });
    client.cookies.clear();
    expect(await (await client.get("/api/get")).json()).toEqual({ theme: null });
  });

  it("[STST-02] redirects are returned as they are by default and followed on request; POST becomes GET on 303 and keeps its body on 307", async () => {
    const seen: string[] = [];
    const { handler } = await make({
      "/api/go-303": apiRoute({
        POST: () => new Response(null, { status: 303, headers: { location: "/api/landing" } }),
      }),
      "/api/go-307": apiRoute({
        POST: () => new Response(null, { status: 307, headers: { location: "/api/landing" } }),
      }),
      "/api/loop": apiRoute({
        GET: () => new Response(null, { status: 302, headers: { location: "/api/loop" } }),
      }),
      "/api/landing": apiRoute({
        GET: (event) => {
          seen.push(`GET ${event.url.pathname}`);
          return json({ landed: true });
        },
        POST: async (event) => {
          seen.push(`POST ${await event.request.text()}`);
          return json({ landed: "post" });
        },
      }),
    });
    const manual = createTestClient(handler);
    const first = await manual.post("/api/go-303", { body: "x" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/api/landing");
    const follow = createTestClient(handler, { redirect: "follow" });
    expect(await (await follow.post("/api/go-303", { body: "payload" })).json()).toEqual({
      landed: true,
    });
    expect(await (await follow.post("/api/go-307", { body: "payload" })).json()).toEqual({
      landed: "post",
    });
    expect(seen).toEqual(["GET /api/landing", "POST payload"]);
    await expect(
      createTestClient(handler, { redirect: "follow", maxRedirects: 3 }).get("/api/loop"),
    ).rejects.toThrow(/redirects/);
  });

  it("[STST-03] same-origin requests carry the headers a browser adds; crossSite and bare simulate other clients", async () => {
    const { handler } = await make({
      "/api/h": apiRoute({
        POST: (event) =>
          json({
            site: event.request.headers.get("sec-fetch-site"),
            origin: event.request.headers.get("origin"),
          }),
      }),
    });
    const client = createTestClient(handler, { origin: "https://app.test" });
    expect(await (await client.post("/api/h")).json()).toEqual({
      site: "same-origin",
      origin: "https://app.test",
    });
    expect((await client.post("/api/h", { crossSite: true })).status).toBe(403);
    expect((await client.post("/api/h", { bare: true })).status).toBe(403);
    expect(
      await (
        await client.post("/api/h", { bare: true, headers: { origin: "https://app.test" } })
      ).json(),
    ).toEqual({ site: null, origin: "https://app.test" });
  });

  it("[STST-04] default headers and the client address reach the handler", async () => {
    const { handler } = await make({
      "/api/a": apiRoute({
        GET: (event) =>
          json({ ip: event.clientAddress, auth: event.request.headers.get("authorization") }),
      }),
    });
    const client = createTestClient(handler, {
      headers: { authorization: "Bearer t" },
      clientAddress: "9.9.9.9",
    });
    expect(await (await client.get("/api/a")).json()).toEqual({ ip: "9.9.9.9", auth: "Bearer t" });
  });

  it("[STST-05] createTestEvent builds an event for unit tests: cookies, signed cookies, keys, body", async () => {
    const SECRET = "0123456789abcdef0123456789abcdef";
    const event = createTestEvent({
      url: "https://app.test/x?y=1",
      method: "post",
      cookies: { a: "1 2" },
      cookieSecrets: [SECRET],
      body: "hello",
      nonce: "n",
    });
    expect(event.method).toBe("POST");
    expect(event.url.search).toBe("?y=1");
    expect(event.cookies.get("a")).toBe("1 2");
    expect(event.nonce).toBe("n");
    await event.cookies.setSigned("s", "v");
    expect(await event.cookies.getSigned("s")).toBe("v");
    expect(event.cookies.serialized()[0]).toContain("Secure");
    expect(await event.request.text()).toBe("hello");
  });

  it("[STST-06] client.fetch sends through the client: same-origin headers, the cookie jar, redirect modes, abort", async () => {
    const { handler } = await make({
      "/api/set": apiRoute({
        POST: async (event) => {
          event.cookies.set("theme", "dark", { httpOnly: false, secure: false });
          return json({ echoed: await event.request.json() }, { status: 201 });
        },
      }),
      "/api/get": apiRoute({ GET: (event) => json({ theme: event.cookies.get("theme") ?? null }) }),
      "/api/leave": apiRoute({ GET: () => Response.redirect("http://localhost/api/get", 302) }),
      "/api/slow": apiRoute({
        GET: (event) =>
          new Promise<never>((_resolve, reject) => {
            // The abort may already have happened by the time the route runs.
            if (event.signal.aborted) reject(event.signal.reason);
            event.signal.addEventListener("abort", () => reject(event.signal.reason));
          }),
      }),
    });
    const client = createTestClient(handler);
    const created = await client.fetch("/api/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ echoed: { a: 1 } });
    expect(await (await client.fetch(new Request("http://localhost/api/get"))).json()).toEqual({
      theme: "dark",
    });
    // fetch follows redirects unless told otherwise; "manual" returns the 3xx.
    expect((await client.fetch("/api/leave")).status).toBe(200);
    const manual = await client.fetch("/api/leave", { redirect: "manual" });
    expect(manual.status).toBe(302);
    // The CSRF check is on: a request marked cross-site is refused.
    const refused = await client.fetch("/api/set", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
    const controller = new AbortController();
    const pending = client.fetch("/api/slow", { signal: controller.signal });
    controller.abort();
    expect([499, 500, 504]).toContain((await pending).status);
  });
});
