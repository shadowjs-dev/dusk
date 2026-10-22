import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  createMemorySessionStore,
  createSessionManager,
  json,
  type Middleware,
  type SessionRecord,
  type SessionStore,
  signIn,
} from "../src/server/index";
import { allFeatures } from "./support/features";

const SECRET = "0123456789abcdef0123456789abcdef";
const ORIGIN = "https://app.test";
const COOKIE = "__Host-shadow_session";

/** A store that remembers every id it was asked to delete, so tests can prove retirement. */
function recordingStore(): SessionStore & { readonly deleted: string[] } {
  const inner = createMemorySessionStore();
  const deleted: string[] = [];
  return {
    deleted,
    get: (id) => inner.get(id),
    set: (id, record: SessionRecord, ttl) => inner.set(id, record, ttl),
    delete: async (id) => {
      deleted.push(id);
      await inner.delete(id);
    },
  };
}

/**
 * A handler whose `/s` routes read the session and sign in. `POST ?mode=seed` sets data without
 * rotating (an anonymous visitor); `POST` with no mode uses `regenerate()` then sets `user`;
 * `POST ?mode=sign-in` uses `signIn()`.
 */
function app(store: SessionStore) {
  const sessions = createSessionManager({ secrets: [SECRET], store });
  const routes = apiRoute({
    GET: async (event) => {
      const session = await sessions.get(event);
      return json({ id: session.id, isNew: session.isNew, user: session.get("user") ?? null });
    },
    POST: async (event) => {
      const session = await sessions.get(event);
      const mode = event.url.searchParams.get("mode");
      if (mode === "seed") {
        session.set("cart", 1);
      } else if (mode === "sign-in") {
        signIn(session, { user: "ada" });
      } else {
        session.regenerate();
        session.set("user", "ada");
      }
      return json({ id: session.id });
    },
  });
  return createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [{ id: "s", path: "/s", load: async () => routes }],
      serverFns: {},
      assets: { entry: "", css: [], preloads: {}, base: "/" },
      App: () => null,
    },
    dev: true,
    security: { allowedHosts: ["app.test"] },
    middleware: [sessions.middleware() as Middleware],
    onError: () => undefined,
  });
}

/** The `name=value` pair of the session cookie in a response, or `""` when it has none. */
function sessionPair(response: Response): string {
  const line = response.headers.getSetCookie().find((entry) => entry.startsWith(`${COOKIE}=`));
  return (line ?? "").split(";")[0] ?? "";
}

/** The raw signed id a `name=value` pair carries (the part before the signature). */
function idOf(pair: string): string {
  return (pair.slice(`${COOKIE}=`.length).split(".")[0] ?? "").trim();
}

describe("session fixation: rotation on privilege change", () => {
  it("[SESS-FIX-01] regenerate() deletes the pre-login record from the store, not only the cookie", async () => {
    const store = recordingStore();
    const handler = app(store);
    const anonymous = sessionPair(
      await handler.fetch(
        new Request(`${ORIGIN}/s?mode=seed`, { method: "POST", headers: { origin: ORIGIN } }),
      ),
    );
    const oldId = idOf(anonymous);
    expect(oldId).not.toBe("");
    expect(await store.get(oldId)).toBeDefined();
    const login = await handler.fetch(
      new Request(`${ORIGIN}/s`, {
        method: "POST",
        headers: { cookie: anonymous, origin: ORIGIN },
      }),
    );
    const newPair = sessionPair(login);
    expect(idOf(newPair)).not.toBe(oldId);
    expect(store.deleted).toContain(oldId);
    expect(await store.get(oldId)).toBeUndefined();
    expect(await store.get(idOf(newPair))).toMatchObject({ data: { user: "ada" } });
  });

  it("[SESS-FIX-02] signIn() retires the pre-login id and issues a cookie with the hardened attributes", async () => {
    const store = recordingStore();
    const handler = app(store);
    const anonymous = sessionPair(
      await handler.fetch(
        new Request(`${ORIGIN}/s?mode=seed`, { method: "POST", headers: { origin: ORIGIN } }),
      ),
    );
    const oldId = idOf(anonymous);
    const login = await handler.fetch(
      new Request(`${ORIGIN}/s?mode=sign-in`, {
        method: "POST",
        headers: { cookie: anonymous, origin: ORIGIN },
      }),
    );
    expect(login.status).toBe(200);
    expect(store.deleted).toContain(oldId);
    expect(await store.get(oldId)).toBeUndefined();
    const lines = login.headers.getSetCookie().filter((entry) => entry.startsWith(`${COOKIE}=`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    expect(lines[0]).not.toMatch(/; Domain=/i);
    expect(idOf(sessionPair(login))).not.toBe(oldId);
  });

  it("[SESS-FIX-03] concurrent sign-ins that present the same pre-login cookie each get a distinct id, and the old id is dead for both", async () => {
    const store = recordingStore();
    const handler = app(store);
    const anonymous = sessionPair(
      await handler.fetch(
        new Request(`${ORIGIN}/s?mode=seed`, { method: "POST", headers: { origin: ORIGIN } }),
      ),
    );
    const oldId = idOf(anonymous);
    const [first, second] = await Promise.all([
      handler.fetch(
        new Request(`${ORIGIN}/s`, {
          method: "POST",
          headers: { cookie: anonymous, origin: ORIGIN },
        }),
      ),
      handler.fetch(
        new Request(`${ORIGIN}/s?mode=sign-in`, {
          method: "POST",
          headers: { cookie: anonymous, origin: ORIGIN },
        }),
      ),
    ]);
    const firstId = idOf(sessionPair(first));
    const secondId = idOf(sessionPair(second));
    expect(firstId).not.toBe("");
    expect(secondId).not.toBe("");
    expect(firstId).not.toBe(oldId);
    expect(secondId).not.toBe(oldId);
    expect(store.deleted).toContain(oldId);
    expect(await store.get(oldId)).toBeUndefined();
    const replay = await handler.fetch(
      new Request(`${ORIGIN}/s`, { headers: { cookie: anonymous } }),
    );
    expect(await replay.json()).toMatchObject({ isNew: true, user: null });
  });

  it("[SESS-FIX-04] a pre-login cookie replayed after sign-in starts an empty session and cannot read the signed-in data", async () => {
    const store = recordingStore();
    const handler = app(store);
    const anonymous = sessionPair(
      await handler.fetch(
        new Request(`${ORIGIN}/s?mode=seed`, { method: "POST", headers: { origin: ORIGIN } }),
      ),
    );
    const login = await handler.fetch(
      new Request(`${ORIGIN}/s?mode=sign-in`, {
        method: "POST",
        headers: { cookie: anonymous, origin: ORIGIN },
      }),
    );
    const signedIn = await handler.fetch(
      new Request(`${ORIGIN}/s`, { headers: { cookie: sessionPair(login) } }),
    );
    expect(await signedIn.json()).toMatchObject({ isNew: false, user: "ada" });
    const replay = await handler.fetch(
      new Request(`${ORIGIN}/s`, { headers: { cookie: anonymous } }),
    );
    expect(await replay.json()).toMatchObject({ isNew: true, user: null });
  });
});
