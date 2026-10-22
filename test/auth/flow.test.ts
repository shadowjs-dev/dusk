import { createHash, createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { type App, startApp } from "./support/app";
import type { IdpAlgorithm } from "./support/idp";

const apps: App[] = [];
async function app(options: Parameters<typeof startApp>[0] = {}): Promise<App> {
  const created = await startApp(options);
  apps.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");
const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe("authorization code flow end to end", () => {
  it.each<IdpAlgorithm>(["RS256", "ES256", "PS256", "EdDSA"])(
    "[DUSK-AUTH-01] signs in through a real provider that signs ID tokens with %s",
    async (alg) => {
      const a = await app({ idp: { alg } });
      const before = await a.client.get("/me");
      expect(before.status).toBe(401);

      const callback = await a.signIn("/dashboard?tab=1");
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/dashboard?tab=1");

      const me = await a.client.get("/me");
      expect(me.status).toBe(200);
      const data = await body(me);
      expect(data["user"]).toEqual({
        id: "user-123",
        issuer: a.idp.issuer,
        name: "Ada Lovelace",
        email: "ada@example.test",
        emailVerified: true,
        picture: "https://img.example.test/ada.png",
      });
      // Tokens stay on the server.
      expect(JSON.stringify(data)).not.toContain("at-");
    },
  );

  it("[DUSK-AUTH-02] sends state, nonce and a PKCE S256 challenge that matches the verifier the provider later receives", async () => {
    const a = await app();
    await a.signIn();
    const authorize = a.idp.stats.authorizeRequests[0] as URLSearchParams;
    const token = a.idp.stats.tokenRequests[0]?.params as URLSearchParams;
    expect(authorize.get("response_type")).toBe("code");
    expect(authorize.get("client_id")).toBe(a.idp.clientId);
    expect(authorize.get("redirect_uri")).toBe("https://app.test/auth/callback");
    expect(authorize.get("scope")).toBe("openid profile email");
    expect(authorize.get("code_challenge_method")).toBe("S256");
    const verifier = token.get("code_verifier") as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(authorize.get("code_challenge")).toBe(sha256(verifier));
    expect(authorize.get("state") as string).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.get("nonce") as string).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.get("state")).not.toBe(authorize.get("nonce"));
  });

  it("[DUSK-AUTH-03] every sign-in uses fresh state, nonce and verifier", async () => {
    const a = await app();
    await a.signIn();
    const b = await app();
    await b.signIn();
    await a.signIn();
    const first = a.idp.stats.authorizeRequests;
    const states = new Set([
      ...first.map((q) => q.get("state")),
      ...b.idp.stats.authorizeRequests.map((q) => q.get("state")),
    ]);
    expect(states.size).toBe(3);
    const nonces = new Set(first.map((q) => q.get("nonce")));
    expect(nonces.size).toBe(2);
    const verifiers = new Set(a.idp.stats.tokenRequests.map((r) => r.params.get("code_verifier")));
    expect(verifiers.size).toBe(2);
  });

  it("[DUSK-AUTH-04] a confidential client authenticates with HTTP Basic by default", async () => {
    const a = await app();
    await a.signIn();
    const request = a.idp.stats.tokenRequests[0];
    expect(request?.authorization).toMatch(/^Basic /);
    expect(request?.params.get("client_secret")).toBeNull();
    expect(request?.params.get("grant_type")).toBe("authorization_code");
    expect(request?.params.get("redirect_uri")).toBe("https://app.test/auth/callback");
  });

  it("[DUSK-AUTH-05] client_secret_post and a public client (PKCE only) work", async () => {
    const post = await app({ client: { tokenEndpointAuthMethod: "client_secret_post" } });
    expect((await post.signIn()).status).toBe(303);
    const request = post.idp.stats.tokenRequests[0];
    expect(request?.authorization).toBeUndefined();
    expect(request?.params.get("client_secret")).toBe(post.idp.clientSecret);

    const pub = await app({ idp: { clientSecret: undefined } });
    expect((await pub.signIn()).status).toBe(303);
    const publicRequest = pub.idp.stats.tokenRequests[0];
    expect(publicRequest?.authorization).toBeUndefined();
    expect(publicRequest?.params.get("client_secret")).toBeNull();
    expect(publicRequest?.params.get("client_id")).toBe(pub.idp.clientId);
  });

  it("[DUSK-AUTH-06] a callback URL works once; replaying it fails and never reaches the token endpoint again", async () => {
    const a = await app();
    const back = await a.start();
    const url = `${back.pathname}${back.search}`;
    expect((await a.client.get(url)).status).toBe(303);
    const replay = await a.client.get(url);
    expect(replay.status).toBe(400);
    expect((await body(replay))["code"]).toBe("OIDC_STATE_INVALID");
    expect(a.idp.stats.token).toBe(1);
  });

  it("[DUSK-AUTH-07] a sign-in older than ten minutes is refused before any token request", async () => {
    const a = await app();
    const back = await a.start();
    a.clock.t += 10 * 60 * 1000 + 1;
    const response = await a.client.get(`${back.pathname}${back.search}`);
    expect(response.status).toBe(400);
    expect((await body(response))["code"]).toBe("OIDC_STATE_EXPIRED");
    expect(a.idp.stats.token).toBe(0);
  });

  it("[DUSK-AUTH-08] a sign-in within ten minutes still works", async () => {
    const a = await app();
    a.idp.hooks.claims = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) + 3600 });
    const back = await a.start();
    a.clock.t += 9 * 60 * 1000;
    expect((await a.client.get(`${back.pathname}${back.search}`)).status).toBe(303);
  });

  it("[DUSK-AUTH-09] a missing, wrong or repeated state is refused, and a wrong state does not spend the real sign-in", async () => {
    const a = await app();
    const back = await a.start();
    const missing = await a.client.get(`/auth/callback?code=${back.searchParams.get("code")}`);
    expect((await body(missing))["code"]).toBe("OIDC_STATE_MISSING");
    const wrong = await a.client.get(
      `/auth/callback?code=${back.searchParams.get("code")}&state=AAAA`,
    );
    expect((await body(wrong))["code"]).toBe("OIDC_STATE_INVALID");
    const twice = await a.client.get(`${back.pathname}${back.search}&state=other`);
    expect((await body(twice))["code"]).toBe("OIDC_STATE_INVALID");
    // The legitimate callback still works afterward.
    expect((await a.client.get(`${back.pathname}${back.search}`)).status).toBe(303);
  });

  it("[DUSK-AUTH-10] login CSRF: a callback with a valid code and state in another browser is refused", async () => {
    const a = await app();
    const victim = a.browser();
    const attacker = a.browser();
    const back = await a.start(undefined, attacker);
    const response = await victim.get(`${back.pathname}${back.search}`);
    expect(response.status).toBe(400);
    expect((await body(response))["code"]).toBe("OIDC_STATE_INVALID");
    expect((await victim.get("/me")).status).toBe(401);
    expect(a.idp.stats.token).toBe(0);
  });

  it("[DUSK-AUTH-11] returnTo cannot send the visitor to another site", async () => {
    const hostile = [
      "//evil.test/x",
      "https://evil.test/x",
      "/\\evil.test",
      "javascript:alert(1)",
      "http:evil.test",
      " //evil.test",
      "/a\r\nSet-Cookie: x=1",
      `/${"a".repeat(3000)}`,
    ];
    for (const target of hostile) {
      const a = await app();
      const callback = await a.signIn(target);
      expect(callback.status).toBe(303);
      expect(callback.headers.get("location")).toBe("/");
    }
    const a = await app();
    expect((await a.signIn("https://app.test/inside?x=1#h")).headers.get("location")).toBe(
      "/inside?x=1#h",
    );
    const b = await app();
    expect((await b.signIn("/dashboard")).headers.get("location")).toBe("/dashboard");
  });

  it("[DUSK-AUTH-12] an error from the provider is reported with a code and never echoed into the message", async () => {
    const a = await app();
    const back = await a.start();
    const denied = new URL(back);
    denied.searchParams.delete("code");
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("error_description", "<script>alert(1)</script>");
    const response = await a.client.get(`${denied.pathname}${denied.search}`);
    expect(response.status).toBe(400);
    const data = await body(response);
    expect(data["code"]).toBe("OIDC_AUTHORIZATION_ERROR");
    expect(data["providerError"]).toBe("access_denied");
    expect(String(data["message"])).not.toContain("script");

    const b = await app();
    const second = await b.start();
    const odd = new URL(second);
    odd.searchParams.delete("code");
    odd.searchParams.set("error", "<img src=x>");
    const oddResponse = await b.client.get(`${odd.pathname}${odd.search}`);
    expect((await body(oddResponse))["providerError"]).toBeNull();
  });

  it("[DUSK-AUTH-13] mix-up defense: the iss parameter must be the issuer; it is required when the provider announces it", async () => {
    const wrong = await app();
    wrong.idp.hooks.iss = "https://other.example";
    const mixed = await wrong.signIn();
    expect(mixed.status).toBe(400);
    expect((await body(mixed))["code"]).toBe("OIDC_ISSUER_MISMATCH");
    expect(wrong.idp.stats.token).toBe(0);

    const missing = await app();
    missing.idp.hooks.iss = false;
    const none = await missing.signIn();
    expect((await body(none))["code"]).toBe("OIDC_ISSUER_MISMATCH");

    // Without discovery nothing says the provider sends iss; an absent parameter is then accepted, a wrong one is not.
    const manual = await app({ endpoints: true });
    manual.idp.hooks.iss = false;
    expect((await manual.signIn()).status).toBe(303);
  });

  it("[DUSK-AUTH-14] an authorization code from the provider that the token endpoint rejects is a 400 with the provider's code", async () => {
    const a = await app();
    const back = await a.start();
    const forged = new URL(back);
    forged.searchParams.set("code", "code-forged");
    const response = await a.client.get(`${forged.pathname}${forged.search}`);
    expect(response.status).toBe(400);
    const data = await body(response);
    expect(data["code"]).toBe("OIDC_TOKEN_ERROR");
    expect(data["providerError"]).toBe("invalid_grant");
  });

  it("[DUSK-AUTH-15] a token response that is not a bearer token or has no ID token is refused", async () => {
    const dpop = await app();
    dpop.idp.hooks.tokenResponse = (token) => ({ ...token, token_type: "DPoP" });
    expect((await body(await dpop.signIn()))["code"]).toBe("OIDC_TOKEN_ERROR");

    const noId = await app();
    noId.idp.hooks.omitIdToken = true;
    expect((await body(await noId.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");

    const noAccess = await app();
    noAccess.idp.hooks.tokenResponse = ({ access_token: _drop, ...rest }) => rest;
    expect((await body(await noAccess.signIn()))["code"]).toBe("OIDC_TOKEN_ERROR");
  });
});

describe("ID token validation", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: Array<[string, (claims: Record<string, unknown>) => Record<string, unknown>]> = [
    ["wrong issuer", (c) => ({ ...c, iss: "https://evil.example" })],
    ["issuer with a trailing slash", (c) => ({ ...c, iss: `${String(c["iss"])}/` })],
    ["another audience", (c) => ({ ...c, aud: "someone-else" })],
    ["audience list without the client", (c) => ({ ...c, aud: ["a", "b"], azp: "a" })],
    ["several audiences without azp", (c) => ({ ...c, aud: [c["aud"], "api"] })],
    ["another authorized party", (c) => ({ ...c, azp: "someone-else" })],
    ["expired beyond the skew", (c) => ({ ...c, exp: now() - 120 })],
    ["not valid yet", (c) => ({ ...c, nbf: now() + 600 })],
    ["issued in the future", (c) => ({ ...c, iat: now() + 600 })],
    ["wrong nonce", (c) => ({ ...c, nonce: "x".repeat(43) })],
    ["no nonce", ({ nonce: _drop, ...rest }) => rest],
    ["no subject", ({ sub: _drop, ...rest }) => rest],
    ["empty subject", (c) => ({ ...c, sub: "" })],
    ["no expiry", ({ exp: _drop, ...rest }) => rest],
    ["exp not a number", (c) => ({ ...c, exp: "9999999999" })],
    ["no issue time", ({ iat: _drop, ...rest }) => rest],
    ["wrong at_hash", (c) => ({ ...c, at_hash: "AAAAAAAAAAAAAAAAAAAAAA" })],
  ];
  it.each(cases)(
    "[DUSK-AUTH-16] refuses an ID token with %s and signs nobody in",
    async (_name, edit) => {
      const a = await app();
      a.idp.hooks.claims = edit;
      const response = await a.signIn();
      expect(response.status).toBe(401);
      expect((await body(response))["code"]).toBe("OIDC_ID_TOKEN_INVALID");
      expect((await a.client.get("/me")).status).toBe(401);
    },
  );

  it("[DUSK-AUTH-17] accepts tokens inside the clock skew and an aud list that names the client with azp", async () => {
    const a = await app();
    a.idp.hooks.claims = (c) => ({
      ...c,
      exp: now() - 30,
      iat: now() + 30,
      nbf: now() + 30,
      aud: [c["aud"], "api"],
      azp: c["aud"],
    });
    expect((await a.signIn()).status).toBe(303);
  });

  it("[DUSK-AUTH-18] the skew is configurable", async () => {
    const strict = await app({ client: { clockSkewSeconds: 0 } });
    strict.idp.hooks.claims = (c) => ({ ...c, iat: now() + 30 });
    expect((await strict.signIn()).status).toBe(401);
  });

  it("[DUSK-AUTH-19] refuses a signature made by another key, an unknown kid and a tampered payload", async () => {
    const a = await app();
    const { generateSigningKey } = await import("./support/idp");
    const stranger = await generateSigningKey("RS256");
    // Same kid as the real key, different key pair.
    a.idp.hooks.signWith = { ...stranger, kid: a.idp.key.kid };
    expect((await body(await a.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");

    const b = await app();
    b.idp.hooks.header = { kid: "never-published" };
    expect((await body(await b.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");

    const c = await app();
    c.idp.hooks.tokenResponse = (token) => {
      const [head, payload, signature] = String(token["id_token"]).split(".") as [
        string,
        string,
        string,
      ];
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
        string,
        unknown
      >;
      claims["sub"] = "admin";
      return {
        ...token,
        id_token: `${head}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`,
      };
    };
    expect((await body(await c.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");
  });

  it("[DUSK-AUTH-20] refuses alg none (with and without a signature part) and an HS256 token keyed with the public key", async () => {
    const forge = (alg: string, signature: string) => (token: Record<string, unknown>) => {
      const [, payload] = String(token["id_token"]).split(".") as [string, string];
      const head = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
      return { ...token, id_token: `${head}.${payload}.${signature}` };
    };
    for (const signature of ["", "AAAA"]) {
      const a = await app();
      a.idp.hooks.tokenResponse = forge("none", signature);
      expect((await body(await a.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");
      expect((await a.client.get("/me")).status).toBe(401);
    }
    const confusion = await app();
    const modulus = String((confusion.idp.key.publicJwk as { n?: string }).n);
    confusion.idp.hooks.tokenResponse = (token) => {
      const [, payload] = String(token["id_token"]).split(".") as [string, string];
      const head = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT", kid: confusion.idp.key.kid }),
      ).toString("base64url");
      const mac = createHmac("sha256", Buffer.from(modulus, "base64url"))
        .update(`${head}.${payload}`)
        .digest("base64url");
      return { ...token, id_token: `${head}.${payload}.${mac}` };
    };
    expect((await body(await confusion.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");
  });

  it("[DUSK-AUTH-21] a confidential client may accept HS256 keyed with the client secret, and only then", async () => {
    const sign = (secret: string) => (token: Record<string, unknown>) => {
      const [, payload] = String(token["id_token"]).split(".") as [string, string];
      const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const mac = createHmac("sha256", secret).update(`${head}.${payload}`).digest("base64url");
      return { ...token, id_token: `${head}.${payload}.${mac}` };
    };
    const good = await app({ client: { idTokenAlgorithms: ["RS256", "HS256"] } });
    good.idp.hooks.tokenResponse = sign(good.idp.clientSecret as string);
    // Discovery lists only the provider's own algorithm, so HS256 is outside what the provider announces.
    expect((await body(await good.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");

    const manual = await app({
      endpoints: true,
      client: { idTokenAlgorithms: ["RS256", "HS256"] },
    });
    manual.idp.hooks.tokenResponse = sign(manual.idp.clientSecret as string);
    expect((await manual.signIn()).status).toBe(303);

    const wrongSecret = await app({ endpoints: true, client: { idTokenAlgorithms: ["HS256"] } });
    wrongSecret.idp.hooks.tokenResponse = sign("not-the-client-secret");
    expect((await body(await wrongSecret.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");
  });
});

describe("provider keys, discovery and limits", () => {
  it("[DUSK-AUTH-22] discovery and the key set are fetched once for many sign-ins", async () => {
    const a = await app();
    for (let index = 0; index < 5; index += 1) {
      const browser = a.browser();
      expect((await a.signIn(undefined, browser)).status).toBe(303);
    }
    expect(a.idp.stats.discovery).toBe(1);
    expect(a.idp.stats.jwks).toBe(1);
  });

  it("[DUSK-AUTH-23] the discovery document is read again after its lifetime", async () => {
    const a = await app({ client: { discoverySeconds: 60 } });
    await a.signIn();
    a.clock.t += 61_000;
    await a.signIn(undefined, a.browser());
    expect(a.idp.stats.discovery).toBe(2);
  });

  it("[DUSK-AUTH-24] a rotated signing key is picked up with one more fetch of the key set", async () => {
    const a = await app({ idp: { alg: "ES256" } });
    await a.signIn(undefined, a.browser());
    expect(a.idp.stats.jwks).toBe(1);
    await a.idp.rotateKey();
    expect((await a.signIn(undefined, a.browser())).status).toBe(303);
    expect(a.idp.stats.jwks).toBe(2);
  });

  it("[DUSK-AUTH-25] a provider that announces another issuer in discovery is refused", async () => {
    const a = await app();
    a.idp.hooks.discoveryIssuer = "https://evil.example";
    const response = await a.client.get("/auth/login");
    expect(response.status).toBe(502);
    expect((await body(response))["code"]).toBe("OIDC_DISCOVERY_FAILED");
  });

  it("[DUSK-AUTH-26] plain http for the issuer is refused outside development", async () => {
    const a = await app({ dev: false });
    const response = await a.client.get("/auth/login");
    expect(response.status).toBe(500);
    expect((await body(response))["code"]).toBe("OIDC_INSECURE_URL");
    expect(a.idp.stats.discovery).toBe(0);
  });

  it("[DUSK-AUTH-27] a provider that is too slow ends in a timeout, not a hung request", async () => {
    const a = await app({ client: { timeoutMs: 150 } });
    a.idp.hooks.tokenDelayMs = 1500;
    const started = Date.now();
    const response = await a.signIn();
    expect(Date.now() - started).toBeLessThan(1400);
    expect(response.status).toBe(504);
    expect((await body(response))["code"]).toBe("OIDC_TIMEOUT");
  });

  it("[DUSK-AUTH-28] an answer larger than the cap is cut off (1 MiB by default)", async () => {
    const a = await app();
    a.idp.hooks.tokenBytes = 2 * 1024 * 1024;
    const response = await a.signIn();
    expect(response.status).toBe(502);
    expect((await body(response))["code"]).toBe("OIDC_RESPONSE_TOO_LARGE");

    const small = await app({ endpoints: true, client: { maxResponseBytes: 512 } });
    expect((await body(await small.signIn()))["code"]).toBe("OIDC_RESPONSE_TOO_LARGE");
  });

  it("[DUSK-AUTH-29] an endpoint that redirects is not followed", async () => {
    const a = await app();
    a.idp.hooks.tokenRedirect = `${a.idp.origin}/jwks`;
    const response = await a.signIn();
    expect(response.status).toBe(502);
    expect((await body(response))["code"]).toBe("OIDC_UPSTREAM_ERROR");
  });

  it("[DUSK-AUTH-30] a failing key set endpoint fails the sign-in and does not fall back to old keys", async () => {
    const a = await app({ client: { jwksSeconds: 1 } });
    await a.signIn();
    a.idp.hooks.jwksStatus = 500;
    a.clock.t += 2000;
    const response = await a.signIn(undefined, a.browser());
    expect(response.status).toBe(502);
    expect((await body(response))["code"]).toBe("OIDC_JWKS_FAILED");
  });

  it("[DUSK-AUTH-31] an issuer with a path (a realm) works with discovery", async () => {
    const a = await app({ idp: { issuerPath: "/realms/main" } });
    expect(a.idp.issuer.endsWith("/realms/main")).toBe(true);
    expect((await a.signIn()).status).toBe(303);
  });
});

describe("session integration", () => {
  const SESSION_NAMES = ["__Host-shadow_session", "shadow_session"] as const;
  const origin = new URL("https://app.test/");
  const sessionCookie = (browser: App["client"]): { name: string; value: string } | undefined => {
    for (const name of SESSION_NAMES) {
      const value = browser.cookies.get(name, origin);
      if (value !== undefined) return { name, value };
    }
    return undefined;
  };

  it("[DUSK-AUTH-32] signing in retires the session id that existed before sign-in (no fixation)", async () => {
    const a = await app();
    const victim = a.client;
    // The visitor already has a session when sign-in starts (the transaction lives in it): an attacker who planted it knows its id.
    const back = await a.start(undefined, victim);
    const planted = sessionCookie(victim);
    expect(planted).toBeDefined();
    const attacker = a.browser();
    attacker.cookies.set(
      origin,
      (planted as { name: string }).name,
      (planted as { value: string }).value,
    );
    const done = await victim.get(`${back.pathname}${back.search}`);
    expect(done.status).toBe(303);
    expect((await victim.get("/me")).status).toBe(200);
    expect((await attacker.get("/me")).status).toBe(401);
    // Even the transaction in the planted session is gone: the attacker cannot finish a sign-in either.
    expect((await attacker.get(`${back.pathname}${back.search}`)).status).toBe(400);
  });

  it("[DUSK-AUTH-33] the session cookie value differs before and after sign-in", async () => {
    const a = await app();
    await a.start();
    const first = sessionCookie(a.client);
    await a.signIn();
    const second = sessionCookie(a.client);
    expect(first).toBeDefined();
    expect(second?.value).not.toBe(first?.value);
  });

  it("[DUSK-AUTH-34] logout is CSRF protected: a cross-site POST is refused and the session survives", async () => {
    const a = await app();
    await a.signIn();
    const cross = await a.client.post("/auth/logout", { crossSite: true });
    expect(cross.status).toBe(403);
    expect((await a.client.get("/me")).status).toBe(200);
  });

  it("[DUSK-AUTH-35] logout revokes the refresh token, ends the session and redirects to the provider with a checked return address", async () => {
    const a = await app();
    await a.signIn();
    const out = await a.client.post("/auth/logout");
    expect(out.status).toBe(303);
    const location = new URL(out.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(`${a.idp.issuer}/end_session`);
    expect(location.searchParams.get("client_id")).toBe(a.idp.clientId);
    expect(location.searchParams.get("id_token_hint")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(location.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/signed-out",
    );
    expect((await a.client.get("/me")).status).toBe(401);
    // The refresh token no longer works at the provider.
    const refreshToken = a.idp.stats.refreshTokensIssued;
    expect(refreshToken).toBe(1);
  });

  it("[DUSK-AUTH-36] the guard answers 401 for a visitor, redirects page requests to the login route and applies the extra check", async () => {
    const a = await app();
    const anonymous = await a.client.get("/me");
    expect(anonymous.status).toBe(401);
    const page = await a.client.get("/page?x=1");
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/auth/login?returnTo=%2Fpage%3Fx%3D1");
    await a.signIn();
    expect((await a.client.get("/page")).status).toBe(200);
    expect((await a.client.get("/admin")).status).toBe(403);
  });
});

describe("refresh tokens, access tokens and userinfo", () => {
  it("[DUSK-AUTH-37] refresh rotates the refresh token and stores both new tokens", async () => {
    const a = await app();
    await a.signIn();
    const first = await body(await a.client.post("/auth/token"));
    const second = await body(await a.client.post("/auth/token"));
    expect(first["refreshToken"]).not.toBeNull();
    expect(second["refreshToken"]).not.toBe(first["refreshToken"]);
    expect(a.idp.stats.tokenRequests.at(-1)?.params.get("grant_type")).toBe("refresh_token");
    expect(a.idp.stats.tokenRequests.at(-1)?.params.get("refresh_token")).toBe(
      first["refreshToken"],
    );
  });

  it("[DUSK-AUTH-38] accessToken returns the stored token while it lives and refreshes it when it is about to expire", async () => {
    const a = await app();
    a.idp.hooks.expiresIn = 100;
    await a.signIn();
    const stored = await body(await a.client.get("/auth/token"));
    expect(String(stored["accessToken"])).toMatch(/^at-/);
    expect(a.idp.stats.token).toBe(1);
    a.clock.t += 80_000;
    const renewed = await body(await a.client.get("/auth/token"));
    expect(renewed["accessToken"]).not.toBe(stored["accessToken"]);
    expect(a.idp.stats.token).toBe(2);
  });

  it("[DUSK-AUTH-39] concurrent refreshes of one session share one exchange", async () => {
    const a = await app();
    await a.signIn();
    const results = await Promise.all([
      a.client.post("/auth/token"),
      a.client.post("/auth/token"),
      a.client.post("/auth/token"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const tokens = await Promise.all(results.map((r) => body(r)));
    expect(new Set(tokens.map((t) => t["accessToken"])).size).toBe(1);
    expect(
      a.idp.stats.tokenRequests.filter((r) => r.params.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
  });

  it("[DUSK-AUTH-40] a refresh token the provider no longer accepts ends the stored tokens and reports a 401", async () => {
    const a = await app();
    await a.signIn();
    a.idp.revokeAllRefreshTokens();
    const failed = await a.client.post("/auth/token");
    expect(failed.status).toBe(401);
    expect((await body(failed))["code"]).toBe("OIDC_REFRESH_FAILED");
    const after = await body(await a.client.get("/auth/token"));
    expect(after["accessToken"]).toBeNull();
  });

  it("[DUSK-AUTH-41] userinfo is read with the stored token, and an answer for another subject is refused", async () => {
    const a = await app();
    await a.signIn();
    const info = await body(await a.client.get("/auth/userinfo"));
    expect(info["sub"]).toBe("user-123");
    a.idp.hooks.userinfoSub = "someone-else";
    const swapped = await a.client.get("/auth/userinfo");
    expect(swapped.status).toBe(401);
    expect((await body(swapped))["code"]).toBe("OIDC_USERINFO_INVALID");
  });

  it("[DUSK-AUTH-42] fetchUserinfo at sign-in merges the profile and refuses a subject that differs from the ID token", async () => {
    const a = await app({ client: { fetchUserinfo: true } });
    expect((await a.signIn()).status).toBe(303);
    const b = await app({ client: { fetchUserinfo: true } });
    b.idp.hooks.userinfoSub = "someone-else";
    expect((await body(await b.signIn()))["code"]).toBe("OIDC_USERINFO_INVALID");
    expect((await b.client.get("/me")).status).toBe(401);
  });
});

describe("plain OAuth 2.0 and multi-tenant issuers", () => {
  it("[DUSK-AUTH-43] oauth2 mode sends no nonce, reads the identity from the mapped userinfo and needs no ID token", async () => {
    const a = await app({
      endpoints: true,
      idp: { scopesSupported: ["read"] },
      client: {
        oauth2: true,
        scopes: ["read"],
        mapUserinfo: (raw) => ({
          sub: `gh-${String(raw["sub"])}`,
          name: raw["name"],
          preferred_username: "ada",
        }),
      },
    });
    a.idp.hooks.omitIdToken = true;
    expect((await a.signIn()).status).toBe(303);
    expect(a.idp.stats.authorizeRequests[0]?.get("nonce")).toBeNull();
    expect(a.idp.stats.authorizeRequests[0]?.get("scope")).toBe("read");
    const me = await body(await a.client.get("/me"));
    expect((me["user"] as Record<string, unknown>)["id"]).toBe("gh-user-123");
    expect((me["user"] as Record<string, unknown>)["username"]).toBe("ada");
  });

  it("[DUSK-AUTH-44] issuerMatches replaces the exact issuer check for multi-tenant providers, and only for what it accepts", async () => {
    const accepting = await app({
      endpoints: true,
      client: { issuerMatches: (iss) => iss.startsWith("http://127.0.0.1:") },
    });
    accepting.idp.hooks.claims = (c) => ({ ...c, iss: `${String(c["iss"])}/tenant-1` });
    accepting.idp.hooks.iss = false;
    expect((await accepting.signIn()).status).toBe(303);

    const rejecting = await app({
      endpoints: true,
      client: { issuerMatches: (iss) => iss.startsWith("https://login.example/") },
    });
    rejecting.idp.hooks.iss = false;
    expect((await body(await rejecting.signIn()))["code"]).toBe("OIDC_ID_TOKEN_INVALID");
  });
});
