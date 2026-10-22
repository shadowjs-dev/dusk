import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  createMemorySessionStore,
  createSessionManager,
  HttpError,
  json,
  type Middleware,
  type SessionRecord,
} from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { allFeatures } from "./support/features";

const SECRET = "0123456789abcdef0123456789abcdef";
const record = (data: Record<string, unknown> = {}): SessionRecord => ({
  data,
  createdAt: 0,
  rotatedAt: 0,
  lastSeenAt: 0,
});

/** A handler with a session manager and routes to read and change the session. */
function setup(
  options: Partial<Parameters<typeof createSessionManager>[0]> & { now?: () => number } = {},
) {
  const sessions = createSessionManager({ secrets: [SECRET], ...options });
  const routes = apiRoute({
    GET: async (event) => {
      const session = await sessions.get(event);
      return json({ id: session.id, isNew: session.isNew, user: session.get("user") ?? null });
    },
    POST: async (event) => {
      const session = await sessions.get(event);
      session.set("user", "ada");
      session.regenerate();
      return json({ id: session.id });
    },
    DELETE: async (event) => {
      (await sessions.get(event)).destroy();
      return json({});
    },
    PUT: async (event) => {
      (await sessions.get(event)).set("touch", 1);
      return json({});
    },
    PATCH: async (event) => {
      (await sessions.get(event)).set("attempts", 1);
      throw new HttpError(409, "try again");
    },
  });
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [{ id: "s", path: "/s", load: async () => routes }],
      serverFns: {},
      assets: { entry: "", css: [], preloads: {}, base: "/" },
      App: () => null,
    },
    dev: true,
    middleware: [sessions.middleware() as Middleware],
    onError: () => undefined,
  });
  const client = createTestClient(handler, {
    origin: "https://app.test",
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { client, sessions };
}

describe("sessions", () => {
  it("[SSES-01] a new session gets no cookie until it holds data", async () => {
    const { client } = setup();
    const first = await client.get("/s");
    expect(first.headers.getSetCookie()).toEqual([]);
    expect((await first.json()).isNew).toBe(true);
  });

  it("[SSES-02] regenerate() at sign-in issues a new id and cookie, and the data follows the user", async () => {
    const { client } = setup();
    const anonymous = (await (await client.get("/s")).json()).id;
    const login = await client.post("/s");
    const { id } = await login.json();
    expect(id).not.toBe(anonymous);
    expect(login.headers.getSetCookie()[0]).toMatch(
      /^__Host-shadow_session=.+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/,
    );
    const again = await (await client.get("/s")).json();
    expect(again).toMatchObject({ id, isNew: false, user: "ada" });
  });

  it("[SSES-13] after regenerate() the pre-login id is dead: a fixated cookie never reaches the signed-in data", async () => {
    const store = createMemorySessionStore();
    const victim = setup({ store });
    await victim.client.put("/s");
    const url = new URL("https://app.test/s");
    const fixated = victim.client.cookies.get("__Host-shadow_session", url) ?? "";
    expect(fixated).not.toBe("");
    await victim.client.post("/s");
    // The attacker planted `fixated` before the login and replays it afterward.
    const attacker = setup({ store });
    attacker.client.cookies.set(url, "__Host-shadow_session", fixated, { secure: true });
    const body = await (await attacker.client.get("/s")).json();
    expect(body).toMatchObject({ isNew: true, user: null });
  });

  it("[SSES-14] the middleware saves the session when the route fails: next() returns the error response", async () => {
    const { client } = setup();
    const failed = await client.patch("/s");
    expect(failed.status).toBe(409);
    expect(failed.headers.getSetCookie()[0]).toMatch(/^__Host-shadow_session=/);
    const next = await (await client.get("/s")).json();
    expect(next.isNew).toBe(false);
  });

  it("[SSES-03] the cookie carries a signed id, never data", async () => {
    const { client } = setup();
    await client.post("/s");
    const cookie = client.cookies.all()[0]?.value ?? "";
    expect(cookie).not.toContain("ada");
    expect(cookie.split(".")).toHaveLength(2);
  });

  it("[SSES-04] a tampered, truncated or foreign cookie is treated as no session", async () => {
    const { client } = setup();
    await client.post("/s");
    const url = new URL("https://app.test/s");
    const good = client.cookies.get("__Host-shadow_session", url) ?? "";
    expect(good).not.toBe("");
    const tampered = `${good[0] === "Z" ? "Y" : "Z"}${good.slice(1)}`;
    expect(tampered).not.toBe(good);
    for (const bad of [`${good}x`, good.slice(0, -3), tampered, "forged.sig", ""]) {
      client.cookies.set(url, "__Host-shadow_session", bad, { secure: true });
      const body = await (await client.get("/s")).json();
      expect(body.isNew, bad).toBe(true);
      expect(body.user).toBeNull();
    }
  });

  it("[SSES-05] a cookie signed with another secret is rejected", async () => {
    const a = setup({ store: createMemorySessionStore() });
    await a.client.post("/s");
    const cookie =
      a.client.cookies.get("__Host-shadow_session", new URL("https://app.test/s")) ?? "";
    const b = setup({ secrets: ["z".repeat(40)] });
    b.client.cookies.set(new URL("https://app.test/s"), "__Host-shadow_session", cookie, {
      secure: true,
    });
    expect((await (await b.client.get("/s")).json()).isNew).toBe(true);
  });

  it("[SSES-06] destroy() deletes the record and the cookie", async () => {
    const { client } = setup();
    await client.post("/s");
    const del = await client.delete("/s");
    expect(del.headers.getSetCookie()[0]).toMatch(/Max-Age=0/);
    expect(client.cookies.all()).toHaveLength(0);
    expect((await (await client.get("/s")).json()).user).toBeNull();
  });

  it("[SSES-07] the idle timeout ends a session; activity within it keeps it", async () => {
    let now = 1_000_000;
    const { client } = setup({
      idleTimeoutSeconds: 60,
      absoluteTimeoutSeconds: 3600,
      now: () => now,
    });
    await client.post("/s");
    now += 50_000;
    expect((await (await client.get("/s")).json()).user).toBe("ada");
    now += 50_000;
    expect((await (await client.get("/s")).json()).user).toBe("ada");
    now += 61_000;
    expect((await (await client.get("/s")).json()).user).toBeNull();
  });

  it("[SSES-08] the absolute timeout ends a session however active", async () => {
    let now = 1_000_000;
    const { client } = setup({
      idleTimeoutSeconds: 60,
      absoluteTimeoutSeconds: 120,
      rotateAfterSeconds: 1000,
      now: () => now,
    });
    await client.post("/s");
    for (let step = 0; step < 3; step += 1) {
      now += 40_000;
      await client.put("/s");
    }
    expect((await (await client.get("/s")).json()).user).toBeNull();
  });

  it("[SSES-09] the id rotates after rotateAfterSeconds; the old id keeps working for the grace period", async () => {
    let now = 1_000_000;
    const { client } = setup({
      rotateAfterSeconds: 100,
      rotationGraceSeconds: 5,
      idleTimeoutSeconds: 1000,
      now: () => now,
    });
    const first = (await (await client.post("/s")).json()).id;
    const url = new URL("https://app.test/s");
    const oldCookie = client.cookies.get("__Host-shadow_session", url) ?? "";
    now += 101_000;
    const rotated = await client.get("/s");
    const body = await rotated.json();
    expect(body.id).not.toBe(first);
    expect(body.user).toBe("ada");
    expect(rotated.headers.getSetCookie()).toHaveLength(1);
    // A request already in flight with the old cookie still finds the session within the grace.
    client.cookies.set(url, "__Host-shadow_session", oldCookie, { secure: true });
    now += 3000;
    expect((await (await client.get("/s")).json()).user).toBe("ada");
    client.cookies.set(url, "__Host-shadow_session", oldCookie, { secure: true });
    now += 10_000;
    expect((await (await client.get("/s")).json()).user).toBeNull();
  });

  it("[SSES-10] bound: the memory store keeps at most maxEntries sessions, least recently used first", async () => {
    const store = createMemorySessionStore({ maxEntries: 3 });
    for (const id of ["a", "b", "c"]) await store.set(id, record({ id }), 100);
    await store.get("a");
    await store.set("d", record(), 100);
    expect(store.size).toBe(3);
    expect(await store.get("b")).toBeUndefined();
    expect(await store.get("a")).toBeDefined();
    for (let n = 0; n < 50; n += 1) await store.set(`k${String(n)}`, record(), 100);
    expect(store.size).toBe(3);
  });

  it("[SSES-11] the memory store expires records, copies on the way in and out", async () => {
    let now = 0;
    const store = createMemorySessionStore({ now: () => now });
    const original = record({ list: [1] });
    await store.set("x", original, 10);
    (original.data["list"] as number[]).push(2);
    const read = await store.get("x");
    expect(read?.data["list"]).toEqual([1]);
    now += 11_000;
    expect(await store.get("x")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("[SSES-12] invalid lifetimes and secrets are refused", () => {
    expect(() => createSessionManager({ secrets: [SECRET], idleTimeoutSeconds: 0 })).toThrow(
      RangeError,
    );
    expect(() => createSessionManager({ secrets: ["short"] })).toThrow(/COOKIE_SECRET_WEAK/);
    expect(() => createMemorySessionStore({ maxEntries: 0 })).toThrow(RangeError);
  });
});
