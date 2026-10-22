import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJwksCache, isOidcError } from "../../src/auth/index";
import { type Idp, startIdp } from "./support/idp";

let idp: Idp;
beforeAll(async () => {
  idp = await startIdp({ alg: "ES256" });
});
afterAll(async () => {
  await idp.close();
});

const policy = {
  fetch: globalThis.fetch,
  timeoutMs: 2000,
  maxBytes: 1_048_576,
  allowLoopbackHttp: true,
  signal: undefined,
};
const header = (kid: string | undefined) => ({
  alg: "ES256",
  ...(kid === undefined ? {} : { kid }),
});

describe("JWKS cache", () => {
  it("[DUSK-AUTH-JWKS-01] fetches once for many lookups, also when they arrive together", async () => {
    const before = idp.stats.jwks;
    const cache = createJwksCache({ uri: `${idp.issuer}/jwks` });
    await Promise.all(Array.from({ length: 20 }, () => cache.key(header(idp.key.kid), policy)));
    for (let index = 0; index < 20; index += 1) await cache.key(header(idp.key.kid), policy);
    expect(idp.stats.jwks - before).toBe(1);
  });

  it("[DUSK-AUTH-JWKS-02] reads the set again after its lifetime", async () => {
    const before = idp.stats.jwks;
    const clock = { t: 1_000_000 };
    const cache = createJwksCache({
      uri: `${idp.issuer}/jwks`,
      ttlSeconds: 60,
      now: () => clock.t,
    });
    await cache.key(header(idp.key.kid), policy);
    clock.t += 59_000;
    await cache.key(header(idp.key.kid), policy);
    expect(idp.stats.jwks - before).toBe(1);
    clock.t += 2000;
    await cache.key(header(idp.key.kid), policy);
    expect(idp.stats.jwks - before).toBe(2);
  });

  it("[DUSK-AUTH-JWKS-03] tokens with invented key ids cannot make the server hammer the provider", async () => {
    const before = idp.stats.jwks;
    const clock = { t: 1_000_000 };
    const cache = createJwksCache({ uri: `${idp.issuer}/jwks`, now: () => clock.t });
    const outcomes: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      try {
        await cache.key(header(`random-${index}`), policy);
      } catch (error) {
        outcomes.push(isOidcError(error) ? error.code : "other");
      }
    }
    expect(outcomes).toHaveLength(200);
    expect(new Set(outcomes)).toEqual(new Set(["OIDC_ID_TOKEN_INVALID"]));
    // A burst of 3 (the first load, then two looks for a rotated key), nothing more.
    expect(idp.stats.jwks - before).toBe(3);
    // The limit refills slowly: after 30 seconds one more look is allowed, and a real key is still found.
    clock.t += 30_000;
    await expect(cache.key(header("random-x"), policy)).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    expect(idp.stats.jwks - before).toBe(4);
    await expect(cache.key(header(idp.key.kid), policy)).resolves.toBeDefined();
  });

  it("[DUSK-AUTH-JWKS-04] an unknown key id is looked up again once, which finds a rotated key", async () => {
    const rotating = await startIdp({ alg: "ES256" });
    try {
      const cache = createJwksCache({ uri: `${rotating.issuer}/jwks` });
      const oldKid = rotating.key.kid;
      await cache.key(header(oldKid), policy);
      const fresh = await rotating.rotateKey({ keepOld: true });
      expect(rotating.stats.jwks).toBe(1);
      await expect(cache.key(header(fresh.kid), policy)).resolves.toBeDefined();
      expect(rotating.stats.jwks).toBe(2);
      // The provider still publishes the old key, so tokens signed with it keep verifying.
      await expect(cache.key(header(oldKid), policy)).resolves.toBeDefined();
    } finally {
      await rotating.close();
    }
  });

  it("[DUSK-AUTH-JWKS-05] a token without kid needs exactly one key of the right type", async () => {
    const single = await startIdp({ alg: "ES256" });
    try {
      const cache = createJwksCache({ uri: `${single.issuer}/jwks` });
      await expect(cache.key(header(undefined), policy)).resolves.toBeDefined();
      await single.rotateKey({ keepOld: true });
      const second = createJwksCache({ uri: `${single.issuer}/jwks` });
      await expect(second.key(header(undefined), policy)).rejects.toMatchObject({
        code: "OIDC_ID_TOKEN_INVALID",
      });
      // A token for another key type finds no key at all.
      await expect(second.key({ alg: "RS256" }, policy)).rejects.toMatchObject({
        code: "OIDC_ID_TOKEN_INVALID",
      });
    } finally {
      await single.close();
    }
  });

  it("[DUSK-AUTH-JWKS-06] a failing endpoint is an error, never an empty or stale set", async () => {
    const failing = await startIdp({ alg: "ES256" });
    try {
      failing.hooks.jwksStatus = 503;
      const cache = createJwksCache({ uri: `${failing.issuer}/jwks` });
      await expect(cache.key(header(failing.key.kid), policy)).rejects.toMatchObject({
        code: "OIDC_JWKS_FAILED",
      });
      delete failing.hooks.jwksStatus;
      await expect(cache.key(header(failing.key.kid), policy)).resolves.toBeDefined();
    } finally {
      await failing.close();
    }
  });

  it("[DUSK-AUTH-JWKS-07] refuses a plain http key set address outside development", async () => {
    const cache = createJwksCache({ uri: `${idp.issuer}/jwks` });
    await expect(
      cache.key(header(idp.key.kid), { ...policy, allowLoopbackHttp: false }),
    ).rejects.toMatchObject({ code: "OIDC_INSECURE_URL" });
  });
});
