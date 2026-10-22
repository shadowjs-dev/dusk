import { afterAll, describe, expect, it } from "vitest";
import { isOidcError, OidcError, type OidcUser, requireUser } from "../../src/auth/index";
import { all, any, HttpError, isHttpError, isRedirect } from "../../src/server/index";
import { createTestEvent } from "../../src/testing/index";
import { type App, startApp } from "./support/app";

const apps: App[] = [];
async function app(options: Parameters<typeof startApp>[0] = {}): Promise<App> {
  const created = await startApp(options);
  apps.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});
const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe("several sign-ins at once", () => {
  it("[DUSK-AUTH-SESSION-01] two tabs can sign in at the same time, each callback finishing its own sign-in", async () => {
    const a = await app();
    const first = await a.start("/first");
    const second = await a.start("/second");
    const one = await a.client.get(`${first.pathname}${first.search}`);
    expect(one.headers.get("location")).toBe("/first");
    expect((await a.client.get("/me")).status).toBe(200);
    // The waiting sign-in of the other tab moved with the data to the new session id, so it finishes too.
    const two = await a.client.get(`${second.pathname}${second.search}`);
    expect(two.headers.get("location")).toBe("/second");
  });

  it("[DUSK-AUTH-SESSION-02] at most eight sign-ins wait in one session; the oldest is dropped", async () => {
    const a = await app();
    const urls: URL[] = [];
    for (let index = 0; index < 9; index += 1) urls.push(await a.start(`/n${index}`));
    const oldest = urls[0] as URL;
    const dropped = await a.client.get(`${oldest.pathname}${oldest.search}`);
    expect((await body(dropped))["code"]).toBe("OIDC_STATE_INVALID");
    const newest = urls[8] as URL;
    expect((await a.client.get(`${newest.pathname}${newest.search}`)).headers.get("location")).toBe(
      "/n8",
    );
  });

  it("[DUSK-AUTH-SESSION-03] expired waiting sign-ins are dropped when a new one starts", async () => {
    const a = await app();
    const old = await a.start("/old");
    a.clock.t += 11 * 60 * 1000;
    const fresh = await a.start("/fresh");
    expect((await body(await a.client.get(`${old.pathname}${old.search}`)))["code"]).toBe(
      "OIDC_STATE_INVALID",
    );
    a.idp.hooks.claims = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 });
    expect((await a.client.get(`${fresh.pathname}${fresh.search}`)).headers.get("location")).toBe(
      "/fresh",
    );
  });

  it("[DUSK-AUTH-SESSION-04] only GET reaches the callback", async () => {
    const a = await app();
    const back = await a.start();
    const post = await a.client.post(`${back.pathname}${back.search}`);
    expect([403, 405]).toContain(post.status);
    expect(a.idp.stats.token).toBe(0);
  });

  it("[DUSK-AUTH-SESSION-05] without a storeTokens session, nothing but the user is kept", async () => {
    const a = await app({ client: { storeTokens: false } });
    await a.signIn();
    expect((await a.client.get("/me")).status).toBe(200);
    expect((await body(await a.client.get("/auth/token")))["accessToken"]).toBeNull();
    // Logout still works, without an id token hint.
    const out = await a.client.post("/auth/logout");
    expect(
      new URL(out.headers.get("location") as string).searchParams.get("id_token_hint"),
    ).toBeNull();
  });

  it("[DUSK-AUTH-SESSION-06] without end-session and revocation endpoints, logout redirects to the local target and still ends the session", async () => {
    const a = await app({
      client: (idp) => ({
        endpoints: {
          authorization: `${idp.issuer}/authorize`,
          token: `${idp.issuer}/token`,
          jwks: `${idp.issuer}/jwks`,
        },
      }),
    });
    await a.signIn();
    const out = await a.client.post("/auth/logout");
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signed-out");
    expect((await a.client.get("/me")).status).toBe(401);
  });

  it("[DUSK-AUTH-SESSION-07] a post-logout address on another site is refused", async () => {
    const a = await app();
    await a.signIn();
    const event = createTestEvent({
      url: "https://app.test/auth/logout",
      method: "POST",
      dev: true,
    });
    await expect(
      a.oidc.logoutUrl(event, { postLogoutRedirectUri: "https://evil.test/" }),
    ).rejects.toThrow(TypeError);
    await expect(a.oidc.logoutUrl(event, { postLogoutRedirectUri: "//evil.test" })).rejects.toThrow(
      TypeError,
    );
    await expect(a.oidc.logoutUrl(event, { postLogoutRedirectUri: "/bye" })).resolves.toContain(
      encodeURIComponent("https://app.test/bye"),
    );
  });

  it("[DUSK-AUTH-SESSION-08] authorize refuses to override protocol parameters", async () => {
    const a = await app();
    const event = createTestEvent({ url: "https://app.test/auth/login", dev: true });
    await expect(a.oidc.authorize(event, { params: { state: "fixed" } })).rejects.toThrow(
      TypeError,
    );
    await expect(a.oidc.authorize(event, { params: { code_challenge: "x" } })).rejects.toThrow(
      TypeError,
    );
  });

  it("[DUSK-AUTH-SESSION-09] extra authorization parameters and scopes are sent", async () => {
    const a = await app({ client: { authorizationParams: { audience: "https://api.example" } } });
    const event = createTestEvent({ url: "https://app.test/auth/login", dev: true });
    const response = await a.oidc.authorize(event, {
      scopes: ["openid", "email"],
      params: { prompt: "login", login_hint: "ada@example.test" },
    });
    const url = new URL(response.headers.get("location") as string);
    expect(url.searchParams.get("audience")).toBe("https://api.example");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("login_hint")).toBe("ada@example.test");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the guard", () => {
  /** What a guard throws, or `undefined`. */
  const thrown = async (outcome: unknown): Promise<unknown> => {
    try {
      await outcome;
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const user: OidcUser = { id: "u1", issuer: "https://i.example", email: "a@example.test" };
  const signedIn = { user: async () => user };
  const anonymous = { user: async () => undefined };

  it("[DUSK-AUTH-GUARD-01] passes a signed-in user, refuses others with 401 and applies the extra check with 403", async () => {
    const event = createTestEvent({ url: "https://app.test/x", method: "POST" });
    expect(await requireUser(signedIn)(event)).toBeUndefined();
    const refused = await thrown(requireUser(anonymous)(event));
    expect(isHttpError(refused) && refused.status).toBe(401);
    const forbidden = await thrown(requireUser(signedIn, { authorize: () => false })(event));
    expect(isHttpError(forbidden) && forbidden.status).toBe(403);
    expect(
      await requireUser(signedIn, { authorize: async (u) => u.id === "u1" })(event),
    ).toBeUndefined();
  });

  it("[DUSK-AUTH-GUARD-02] page requests are redirected to the login route with returnTo; other methods get 401", async () => {
    const guard = requireUser(anonymous, { loginPath: "/login" });
    const get = await thrown(
      guard(createTestEvent({ url: "https://app.test/a/b?c=1&d=%2F", method: "GET" })),
    );
    expect(isRedirect(get)).toBe(true);
    const post = await thrown(
      guard(createTestEvent({ url: "https://app.test/a", method: "POST" })),
    );
    expect(isHttpError(post) && post.status).toBe(401);
  });

  it("[DUSK-AUTH-GUARD-03] composes with all() and any() like every Dusk guard", async () => {
    const event = createTestEvent({ url: "https://app.test/x", method: "POST" });
    const admin = requireUser(signedIn, { authorize: (u) => u.email === "root@example.test" });
    expect(await all(requireUser(signedIn), requireUser(signedIn))(event)).toBeUndefined();
    const stopped = await thrown(all(requireUser(anonymous), admin)(event));
    expect(isHttpError(stopped) && stopped.status).toBe(401);
    expect(await any(admin, requireUser(signedIn))(event)).toBeUndefined();
    const none = await thrown(any(admin, requireUser(anonymous))(event));
    expect(isHttpError(none) && none.status).toBe(401);
  });
});

describe("OidcError", () => {
  it("[DUSK-AUTH-ERROR-01] is an HttpError with a status per code, a stable message and the provider's words kept apart", () => {
    const error = new OidcError("OIDC_STATE_EXPIRED", "The sign-in took too long.");
    expect(error).toBeInstanceOf(HttpError);
    expect(isHttpError(error)).toBe(true);
    expect(isOidcError(error)).toBe(true);
    expect(error.status).toBe(400);
    expect(error.message).toBe("OIDC_STATE_EXPIRED: The sign-in took too long.");
    expect(error.expose).toBe(true);
    const upstream = new OidcError("OIDC_UPSTREAM_ERROR", "down", {
      providerError: "temporarily_unavailable",
      providerDescription: "x",
    });
    expect(upstream.status).toBe(502);
    expect(upstream.expose).toBe(false);
    expect(upstream.providerError).toBe("temporarily_unavailable");
    expect(new OidcError("OIDC_TIMEOUT", "slow").status).toBe(504);
    expect(new OidcError("OIDC_ID_TOKEN_INVALID", "bad").status).toBe(401);
    expect(isOidcError(new Error("OIDC_STATE_EXPIRED"))).toBe(false);
    expect(isOidcError(null)).toBe(false);
  });
});
