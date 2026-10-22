import { describe, expect, it, vi } from "vitest";
import {
  apiRoute,
  createHandler,
  createMemorySessionStore,
  createSessionManager,
  json,
  type Middleware,
  type RequestEvent,
  type Session,
  type SessionOptions,
  signIn,
} from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { allFeatures } from "./support/features";

const SECRET = "0123456789abcdef0123456789abcdef";

interface Built {
  readonly client: ReturnType<typeof createTestClient>;
  readonly sessions: ReturnType<typeof createSessionManager>;
  readonly warnings: string[];
  readonly errors: unknown[];
}

interface BuildOptions {
  readonly origin?: string;
  readonly dev?: boolean;
  /** Leave `onWarning` unset, so the default sink (console.warn) is used. */
  readonly defaultSink?: boolean;
  readonly session?: Partial<SessionOptions>;
}

/** A handler with a session manager and one route whose POST behavior is chosen by `?mode=`. */
function build(options: BuildOptions = {}): Built {
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const sessions = createSessionManager({
    secrets: [SECRET],
    ...(options.defaultSink === true
      ? {}
      : { onWarning: (message: string) => warnings.push(message) }),
    ...options.session,
  });
  const routes = apiRoute({
    GET: async (event) => {
      const session = await sessions.get(event);
      return json({ id: session.id, isNew: session.isNew, userId: session.get("userId") ?? null });
    },
    POST: async (event) => {
      const session = await sessions.get(event);
      const mode = event.url.searchParams.get("mode");
      applyMode(session, mode);
      return json({ id: session.id });
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
    dev: options.dev ?? true,
    security: { allowedHosts: ["app.test", "localhost"] },
    middleware: [sessions.middleware() as Middleware],
    onError: (error) => errors.push(error),
  });
  const client = createTestClient(handler, { origin: options.origin ?? "https://app.test" });
  return { client, sessions, warnings, errors };
}

function applyMode(session: Session, mode: string | null): void {
  switch (mode) {
    case "bare":
      session.set("userId", "u1");
      return;
    case "regen-first":
      session.regenerate();
      session.set("userId", "u1");
      return;
    case "set-then-regen":
      session.set("userId", "u1");
      session.regenerate();
      return;
    case "sign-in":
      signIn(session, { userId: "u1" });
      return;
    case "sign-in-empty":
      signIn(session, {});
      return;
    case "multi":
      session.set("userId", "u1");
      session.set("user", "ada");
      session.set("uid", "1");
      return;
    case "plain":
      session.set("theme", "dark");
      session.set("cart", ["a"]);
      return;
    case "relogin":
      session.delete("userId");
      session.set("userId", "u2");
      return;
    default:
      if (mode?.startsWith("key:")) session.set(mode.slice(4), "x");
  }
}

const idOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { id: string }).id;

describe("SEC-R1 session fixation: signIn() and the development warning", () => {
  it("SEC-R1-01 signIn() gives the session a new id, keeps earlier data and sets the values", async () => {
    const { client, warnings } = build();
    await client.post("/s?mode=plain");
    const anonymous = await idOf(await client.get("/s"));
    const login = await client.post("/s?mode=sign-in");
    expect(await idOf(login)).not.toBe(anonymous);
    const after = (await (await client.get("/s")).json()) as { id: string; userId: unknown };
    expect(after.userId).toBe("u1");
    expect(after.id).not.toBe(anonymous);
    expect(warnings).toEqual([]);
  });

  it("SEC-R1-02 after signIn() the id from before the sign-in is dead: a fixated cookie never reaches the signed-in data", async () => {
    const store = createMemorySessionStore();
    const victim = build({ session: { store } });
    await victim.client.post("/s?mode=plain");
    const url = new URL("https://app.test/s");
    const name = victim.client.cookies.all()[0]?.name ?? "";
    const fixated = victim.client.cookies.get(name, url) ?? "";
    expect(fixated).not.toBe("");
    await victim.client.post("/s?mode=sign-in");
    const attacker = build({ session: { store } });
    attacker.client.cookies.set(url, name, fixated, { secure: true });
    const body = (await (await attacker.client.get("/s")).json()) as {
      isNew: boolean;
      userId: unknown;
    };
    expect(body).toMatchObject({ isNew: true, userId: null });
  });

  it("SEC-R1-03 signIn() regenerates even when it is given no values", async () => {
    const { client } = build();
    await client.post("/s?mode=plain");
    const before = await idOf(await client.get("/s"));
    const response = await client.post("/s?mode=sign-in-empty");
    expect(response.status).toBe(200);
    expect(await idOf(response)).not.toBe(before);
  });

  it("SEC-R1-04 set() of an identity key on a session that was not regenerated warns once, naming the key and the fix", async () => {
    const { client, warnings } = build();
    const response = await client.post("/s?mode=bare");
    expect(response.status).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"userId"');
    expect(warnings[0]).toContain("signIn");
    expect(warnings[0]).toContain("regenerate");
  });

  it("SEC-R1-05 the warning is once per request, however many identity keys are written, and again on the next request", async () => {
    const { client, warnings } = build();
    await client.post("/s?mode=multi");
    expect(warnings).toHaveLength(1);
    await client.post("/s?mode=relogin");
    expect(warnings).toHaveLength(2);
  });

  it.each(["userId", "user", "uid", "sub", "accountId"])(
    "SEC-R1-06 the identity key %s triggers the warning",
    async (key) => {
      const { client, warnings } = build();
      await client.post(`/s?mode=key:${key}`);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`"${key}"`);
    },
  );

  it("SEC-R1-07 regenerate() before set(), regenerate() after set() in the same request, and signIn() produce no warning", async () => {
    const { client, warnings } = build();
    for (const mode of ["regen-first", "set-then-regen", "sign-in"]) {
      expect((await client.post(`/s?mode=${mode}`)).status).toBe(200);
    }
    expect(warnings).toEqual([]);
  });

  it("SEC-R1-08 keys that are not an identity (theme, cart) never warn", async () => {
    const { client, warnings } = build();
    await client.post("/s?mode=plain");
    await client.post("/s?mode=key:theme");
    expect(warnings).toEqual([]);
  });

  it("SEC-R1-09 updating an identity key the signed-in session already holds does not warn", async () => {
    const { client, warnings } = build();
    expect((await client.post("/s?mode=sign-in")).status).toBe(200);
    expect((await client.post("/s?mode=bare")).status).toBe(200);
    expect(warnings).toEqual([]);
  });

  it("SEC-R1-10 outside development nothing is reported (the warning is a development aid)", async () => {
    const { client, warnings } = build({ dev: false });
    const response = await client.post("/s?mode=bare");
    expect(response.status).toBe(200);
    expect(warnings).toEqual([]);
  });

  it("SEC-R1-11 without an onWarning option the warning goes to console.warn with the [dusk] prefix", async () => {
    const { client } = build({ defaultSink: true });
    await client.post("/s?mode=bare");
    const calls = vi.mocked(console.warn).mock.calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toMatch(/^\[dusk\] .*"userId"/);
    vi.mocked(console.warn).mockClear();
  });

  it("SEC-R1-12 signIn() works on any Session, also one whose regenerate() is the only method it relies on", () => {
    const calls: string[] = [];
    const session: Session = {
      id: "x",
      isNew: false,
      get: () => undefined,
      set: (key) => {
        calls.push(`set:${key}`);
      },
      delete: () => undefined,
      clear: () => undefined,
      regenerate: () => {
        calls.push("regenerate");
      },
      destroy: () => undefined,
    };
    signIn(session, { userId: "u1", role: "admin" });
    expect(calls).toEqual(["regenerate", "set:userId", "set:role"]);
  });
});

/** Name and attributes of the first Set-Cookie of a response. */
function firstCookie(response: Response): { name: string; line: string } {
  const line = response.headers.getSetCookie()[0] ?? "";
  return { name: line.split("=")[0] ?? "", line };
}

describe("SEC-R12 the default session cookie name is __Host- when the cookie is Secure", () => {
  it("SEC-R12-01 over https the default name is __Host-shadow_session with Secure, Path=/ and no Domain", async () => {
    const { client, errors } = build();
    const response = await client.post("/s?mode=sign-in");
    const { name, line } = firstCookie(response);
    expect(name).toBe("__Host-shadow_session");
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toContain("; Secure");
    expect(line).not.toContain("Domain=");
    expect(errors).toEqual([]);
    expect(((await (await client.get("/s")).json()) as { userId: unknown }).userId).toBe("u1");
  });

  it("SEC-R12-02 in development over plain http on localhost (Secure is off) the plain name is kept and nothing throws", async () => {
    const { client, errors } = build({ origin: "http://localhost:3000" });
    const response = await client.post("/s?mode=sign-in");
    const { name, line } = firstCookie(response);
    expect(name).toBe("shadow_session");
    expect(line).not.toContain("Secure");
    expect(errors).toEqual([]);
    expect(((await (await client.get("/s")).json()) as { userId: unknown }).userId).toBe("u1");
  });

  it("SEC-R12-03 a cookie.domain falls back to the plain name instead of throwing", async () => {
    const { client, errors } = build({ session: { cookie: { domain: "app.test" } } });
    const response = await client.post("/s?mode=sign-in");
    expect(response.status).toBe(200);
    const { name, line } = firstCookie(response);
    expect(name).toBe("shadow_session");
    expect(line).toContain("Domain=app.test");
    expect(errors).toEqual([]);
  });

  it("SEC-R12-04 a cookie.path other than / falls back to the plain name instead of throwing", async () => {
    const { client, errors } = build({ session: { cookie: { path: "/app" } } });
    const response = await client.post("/s?mode=sign-in");
    expect(response.status).toBe(200);
    expect(firstCookie(response).name).toBe("shadow_session");
    expect(errors).toEqual([]);
  });

  it("SEC-R12-05 cookie.secure false on https falls back to the plain name instead of throwing", async () => {
    const { client, errors } = build({ session: { cookie: { secure: false } } });
    const response = await client.post("/s?mode=sign-in");
    expect(response.status).toBe(200);
    const { name, line } = firstCookie(response);
    expect(name).toBe("shadow_session");
    expect(line).not.toContain("Secure");
    expect(errors).toEqual([]);
  });

  it("SEC-R12-06 an explicit cookieName always wins, with or without a __Host- prefix", async () => {
    const plain = build({ session: { cookieName: "sid" } });
    expect(firstCookie(await plain.client.post("/s?mode=sign-in")).name).toBe("sid");
    const prefixed = build({ session: { cookieName: "__Host-mine" } });
    expect(firstCookie(await prefixed.client.post("/s?mode=sign-in")).name).toBe("__Host-mine");
  });

  it("SEC-R12-07 an explicit __Host- name that breaks the rules still fails loudly (the explicit name is never rewritten)", async () => {
    const { client, errors } = build({
      session: { cookieName: "__Host-mine", cookie: { domain: "app.test" } },
    });
    const response = await client.post("/s?mode=sign-in");
    expect(response.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("__Host-");
  });

  it("SEC-R12-08 over https a plain shadow_session cookie (planted by a sibling subdomain) is not a session", async () => {
    const store = createMemorySessionStore();
    const dev = build({ origin: "http://localhost:3000", session: { store } });
    await dev.client.post("/s?mode=sign-in");
    const planted = dev.client.cookies.all()[0]?.value ?? "";
    expect(planted).not.toBe("");
    const prod = build({ session: { store } });
    prod.client.cookies.set(new URL("https://app.test/s"), "shadow_session", planted, {
      secure: true,
    });
    const body = (await (await prod.client.get("/s")).json()) as {
      isNew: boolean;
      userId: unknown;
    };
    expect(body).toMatchObject({ isNew: true, userId: null });
  });

  it("SEC-R12-09 destroy() removes the cookie under the same name it was set with", async () => {
    const sessions = createSessionManager({ secrets: [SECRET] });
    const routes = apiRoute({
      POST: async (event) => {
        signIn(await sessions.get(event), { userId: "u1" });
        return json({});
      },
      DELETE: async (event: RequestEvent) => {
        (await sessions.get(event)).destroy();
        return json({});
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
    const client = createTestClient(handler, { origin: "https://app.test" });
    await client.post("/s");
    const removed = await client.delete("/s");
    const line = removed.headers.getSetCookie()[0] ?? "";
    expect(line).toMatch(/^__Host-shadow_session=; /);
    expect(line).toContain("Max-Age=0");
  });
});
