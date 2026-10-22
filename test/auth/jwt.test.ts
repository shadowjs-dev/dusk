import { describe, expect, it } from "vitest";
import {
  importVerificationKey,
  isOidcError,
  type Jwk,
  type JwsAlgorithm,
  verifyJwt,
} from "../../src/auth/index";

const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString("base64url");
const encode = (value: unknown): string => b64u(Buffer.from(JSON.stringify(value)));

interface Pair {
  readonly alg: JwsAlgorithm;
  readonly jwk: Jwk;
  sign(input: string): Promise<string>;
}

const generate = {
  RS256: [
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    { name: "RSASSA-PKCS1-v1_5" },
  ],
  RS384: [
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-384",
    },
    { name: "RSASSA-PKCS1-v1_5" },
  ],
  RS512: [
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-512",
    },
    { name: "RSASSA-PKCS1-v1_5" },
  ],
  PS256: [
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    { name: "RSA-PSS", saltLength: 32 },
  ],
  PS384: [
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-384",
    },
    { name: "RSA-PSS", saltLength: 48 },
  ],
  PS512: [
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-512",
    },
    { name: "RSA-PSS", saltLength: 64 },
  ],
  ES256: [
    { name: "ECDSA", namedCurve: "P-256" },
    { name: "ECDSA", hash: "SHA-256" },
  ],
  ES384: [
    { name: "ECDSA", namedCurve: "P-384" },
    { name: "ECDSA", hash: "SHA-384" },
  ],
  ES512: [
    { name: "ECDSA", namedCurve: "P-521" },
    { name: "ECDSA", hash: "SHA-512" },
  ],
  EdDSA: [{ name: "Ed25519" }, { name: "Ed25519" }],
} as const;

const cache = new Map<string, Promise<Pair>>();
function pair(
  alg: Exclude<JwsAlgorithm, "HS256" | "HS384" | "HS512">,
  bits?: number,
): Promise<Pair> {
  const key = `${alg}:${bits ?? ""}`;
  let existing = cache.get(key);
  if (existing === undefined) {
    existing = (async () => {
      const [params, signParams] = generate[alg];
      const adjusted = bits === undefined ? params : { ...params, modulusLength: bits };
      const made = (await crypto.subtle.generateKey(adjusted as never, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", made.publicKey)) as Jwk;
      return {
        alg,
        jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, crv: jwk.crv, x: jwk.x, y: jwk.y } as Jwk,
        sign: async (input) =>
          b64u(
            new Uint8Array(
              await crypto.subtle.sign(signParams as never, made.privateKey, Buffer.from(input)),
            ),
          ),
      };
    })();
    cache.set(key, existing);
  }
  return existing;
}

async function token(
  p: Pair,
  payload: Record<string, unknown> = { sub: "a" },
  header: Record<string, unknown> = {},
): Promise<string> {
  const input = `${encode({ alg: p.alg, ...header })}.${encode(payload)}`;
  return `${input}.${await p.sign(input)}`;
}

const keyFor = (p: Pair) => () => importVerificationKey(p.jwk, p.alg);
const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (isOidcError(error)) return error.code;
    throw error;
  }
  return "no error";
};

describe("JWT verification with WebCrypto", () => {
  it.each([
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
    "EdDSA",
  ] as const)("[DUSK-AUTH-JWT-01] verifies a real %s signature", async (alg) => {
    const p = await pair(alg);
    const verified = await verifyJwt(await token(p, { sub: "ada" }), {
      algorithms: [alg],
      key: keyFor(p),
    });
    expect(verified.payload["sub"]).toBe("ada");
    expect(verified.header.alg).toBe(alg);
  });

  it("[DUSK-AUTH-JWT-02] refuses a changed payload, a changed header and a swapped signature", async () => {
    const p = await pair("ES256");
    const q = await pair("RS256");
    const good = await token(p);
    const [head, body, signature] = good.split(".") as [string, string, string];
    const options = { algorithms: ["ES256", "RS256"] as const, key: keyFor(p) };
    expect(await code(verifyJwt(`${head}.${encode({ sub: "root" })}.${signature}`, options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
    expect(
      await code(verifyJwt(`${encode({ alg: "ES256", kid: "x" })}.${body}.${signature}`, options)),
    ).toBe("OIDC_ID_TOKEN_INVALID");
    const other = await token(p, { sub: "other" });
    expect(await code(verifyJwt(`${head}.${body}.${other.split(".")[2]}`, options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
    // A signature of another algorithm family under an ES256 header.
    const rsaSigned = await token(q);
    expect(await code(verifyJwt(`${head}.${body}.${rsaSigned.split(".")[2]}`, options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
  });

  it("[DUSK-AUTH-JWT-03] refuses every algorithm outside the allowlist before using a key, including none and HS*", async () => {
    const p = await pair("RS256");
    let asked = 0;
    const options = {
      algorithms: ["RS256"] as const,
      key: async () => {
        asked += 1;
        return importVerificationKey(p.jwk, "RS256");
      },
    };
    for (const alg of [
      "none",
      "None",
      "NONE",
      "HS256",
      "HS512",
      "rs256",
      "RS384",
      "PS256",
      "ES256",
      "EdDSA",
      "RS999",
      "",
    ]) {
      const unsigned = `${encode({ alg })}.${encode({ sub: "a" })}.${b64u(Buffer.from("sig"))}`;
      expect(await code(verifyJwt(unsigned, options)), alg).toBe("OIDC_ID_TOKEN_INVALID");
    }
    expect(
      await code(verifyJwt(`${encode({ alg: "none" })}.${encode({ sub: "a" })}.`, options)),
    ).toBe("OIDC_ID_TOKEN_INVALID");
    expect(asked).toBe(0);
  });

  it("[DUSK-AUTH-JWT-04] refuses malformed tokens", async () => {
    const p = await pair("ES256");
    const options = { algorithms: ["ES256"] as const, key: keyFor(p) };
    const good = await token(p);
    const [head, body, signature] = good.split(".") as [string, string, string];
    const bad = [
      "",
      "a.b",
      "a.b.c.d",
      `${head}.${body}`,
      `${head}..${signature}`,
      `.${body}.${signature}`,
      `${head}.${body}.${signature}.`,
      `!!!.${body}.${signature}`,
      `${b64u(Buffer.from("not json"))}.${body}.${signature}`,
      `${encode([1])}.${body}.${signature}`,
      `${encode("str")}.${body}.${signature}`,
      `${encode({ typ: "JWT" })}.${body}.${signature}`,
      `${encode({ alg: 5 })}.${body}.${signature}`,
      `${head}.${encode([1])}.${signature}`,
      `${head}.${b64u(Buffer.from([0xff, 0xfe]))}.${signature}`,
      `${encode({ alg: "ES256", kid: 7 })}.${body}.${signature}`,
      `${"a".repeat(70_000)}.${body}.${signature}`,
    ];
    for (const value of bad)
      expect(await code(verifyJwt(value, options)), value.slice(0, 30)).toBe(
        "OIDC_ID_TOKEN_INVALID",
      );
  });

  it("[DUSK-AUTH-JWT-05] refuses headers that demand extensions this client does not implement", async () => {
    const p = await pair("ES256");
    const options = { algorithms: ["ES256"] as const, key: keyFor(p) };
    expect(await code(verifyJwt(await token(p, {}, { crit: ["exp"], exp: 1 }), options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
    expect(await code(verifyJwt(await token(p, {}, { zip: "DEF" }), options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
    // jku, x5u and an embedded jwk are never followed: the token verifies against the configured key only.
    const attacker = await pair("EdDSA");
    const forged = await token(
      attacker,
      {},
      { alg: "ES256", jwk: attacker.jwk, jku: "https://evil.test/keys" },
    );
    expect(await code(verifyJwt(forged, options))).toBe("OIDC_ID_TOKEN_INVALID");
  });

  it("[DUSK-AUTH-JWT-06] ECDSA and EdDSA signatures must have the exact raw length (a DER signature is refused)", async () => {
    const p = await pair("ES256");
    const options = { algorithms: ["ES256"] as const, key: keyFor(p) };
    const good = await token(p);
    const [head, body, signature] = good.split(".") as [string, string, string];
    const raw = Buffer.from(signature, "base64url");
    const der = Buffer.concat([
      Buffer.from([0x30, 0x44, 0x02, 0x20]),
      raw.subarray(0, 32),
      Buffer.from([0x02, 0x20]),
      raw.subarray(32),
    ]);
    expect(await code(verifyJwt(`${head}.${body}.${b64u(der)}`, options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
    expect(await code(verifyJwt(`${head}.${body}.${b64u(raw.subarray(0, 63))}`, options))).toBe(
      "OIDC_ID_TOKEN_INVALID",
    );
    expect(
      await code(
        verifyJwt(`${head}.${body}.${b64u(Buffer.concat([raw, Buffer.from([0])]))}`, options),
      ),
    ).toBe("OIDC_ID_TOKEN_INVALID");
  });

  it("[DUSK-AUTH-JWT-07] refuses a key that does not fit the algorithm: type, curve, use, key_ops, alg and short RSA keys", async () => {
    const ec = await pair("ES256");
    const rsa = await pair("RS256");
    const ec384 = await pair("ES384");
    const weak = await pair("RS256", 1024);
    await expect(importVerificationKey(ec.jwk, "RS256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    await expect(importVerificationKey(rsa.jwk, "ES256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    await expect(importVerificationKey(ec384.jwk, "ES256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    await expect(importVerificationKey({ ...ec.jwk, use: "enc" }, "ES256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    await expect(
      importVerificationKey({ ...ec.jwk, key_ops: ["encrypt"] }, "ES256"),
    ).rejects.toMatchObject({ code: "OIDC_ID_TOKEN_INVALID" });
    await expect(importVerificationKey({ ...ec.jwk, alg: "ES384" }, "ES256")).rejects.toMatchObject(
      { code: "OIDC_ID_TOKEN_INVALID" },
    );
    await expect(importVerificationKey(weak.jwk, "RS256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    await expect(importVerificationKey({ kty: "RSA" }, "RS256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    await expect(importVerificationKey({ kty: "oct" }, "HS256")).rejects.toMatchObject({
      code: "OIDC_ID_TOKEN_INVALID",
    });
    // Fits: a key that says nothing about use or alg.
    await expect(
      importVerificationKey({ ...rsa.jwk, use: "sig", alg: "RS256", key_ops: ["verify"] }, "RS256"),
    ).resolves.toBeDefined();
  });
});
