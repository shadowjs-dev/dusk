import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COOKIE_LIMITS,
  createCookieSigner,
  parseCookies,
  serializeCookie,
} from "../../src/server/cookies";

/**
 * Property tests for cookie parsing, serialization and signing.
 * Invariants: parsing never throws and stays bounded, a serialized cookie reads back to its value, a signed
 * value verifies only with its own name, value and secret, and a signature has exactly one spelling.
 */

const SEED = { seed: 20261015, numRuns: 300 };

const TOKEN_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-.^_`|~",
];

const tokenArb = fc
  .array(fc.constantFrom(...TOKEN_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

const nameArb = fc
  .tuple(fc.constantFrom("", "__Host-", "__Secure-"), tokenArb)
  .map(([prefix, rest]) => `${prefix}${rest}`);

const valueArb = fc.string({ unit: "grapheme", maxLength: 40 });

const secretArb = fc.string({ unit: "grapheme", minLength: 32, maxLength: 64 });

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Splits a signed value (`value.signature`) at its last dot. */
function signatureOf(signed: string): string {
  return signed.slice(signed.lastIndexOf(".") + 1);
}

describe("cookie parsing", () => {
  it("[FUZZ-COOKIE-01] parseCookies never throws, and returns at most the cookie limit", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 400 }), (header) => {
        const cookies = parseCookies(header);
        expect(cookies).toBeInstanceOf(Map);
        expect(cookies.size).toBeLessThanOrEqual(COOKIE_LIMITS.maxCookies);
      }),
      SEED,
    );
  });

  it("[FUZZ-COOKIE-02] a null or oversize header gives an empty map", () => {
    expect(parseCookies(null).size).toBe(0);
    fc.assert(
      fc.property(
        fc.string({
          unit: "grapheme",
          minLength: COOKIE_LIMITS.maxHeaderLength + 1,
          maxLength: COOKIE_LIMITS.maxHeaderLength + 40,
        }),
        (header) => {
          expect(parseCookies(header).size).toBe(0);
        },
      ),
      { seed: SEED.seed, numRuns: 50 },
    );
  });

  it("[FUZZ-COOKIE-03] a serialized cookie reads back to its exact value", () => {
    fc.assert(
      fc.property(nameArb, valueArb, (name, value) => {
        const serialized = serializeCookie(name, value);
        const pair = serialized.split(";")[0] ?? null;
        expect(parseCookies(pair).get(name)).toBe(value);
      }),
      SEED,
    );
  });

  it("[FUZZ-COOKIE-04] the first occurrence of a repeated name wins", () => {
    fc.assert(
      fc.property(tokenArb, valueArb, valueArb, (name, first, second) => {
        const cookies = parseCookies(
          `${name}=${encodeURIComponent(first)}; ${name}=${encodeURIComponent(second)}`,
        );
        expect(cookies.get(name)).toBe(first);
      }),
      SEED,
    );
  });

  it("[FUZZ-COOKIE-05] a serialized cookie is one header line with no CR, LF or NUL", () => {
    fc.assert(
      fc.property(nameArb, valueArb, (name, value) => {
        const serialized = serializeCookie(name, value);
        expect(serialized).not.toMatch(/[\r\n\u0000]/);
        expect(serialized.startsWith(`${name}=`)).toBe(true);
      }),
      SEED,
    );
  });

  it("[FUZZ-COOKIE-06] a path with a semicolon or control character is refused with TypeError", () => {
    fc.assert(
      fc.property(
        nameArb,
        fc.tuple(
          fc.string({ unit: "grapheme", maxLength: 10 }),
          fc.constantFrom(";", "\r", "\n", "\u0000", "\u007f"),
        ),
        (name, [head, bad]) => {
          expect(() => serializeCookie(name, "v", { path: `/${head}${bad}` })).toThrow(TypeError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-COOKIE-07] a __Host- cookie with Secure false is always refused", () => {
    fc.assert(
      fc.property(tokenArb, valueArb, (rest, value) => {
        expect(() => serializeCookie(`__Host-${rest}`, value, { secure: false })).toThrow(
          TypeError,
        );
      }),
      SEED,
    );
  });

  it("[FUZZ-COOKIE-08] SameSite=None without Secure is always refused", () => {
    fc.assert(
      fc.property(nameArb, valueArb, (name, value) => {
        const plain =
          name.startsWith("__Host-") || name.startsWith("__Secure-") ? `x${name}` : name;
        expect(() => serializeCookie(plain, value, { sameSite: "none", secure: false })).toThrow(
          TypeError,
        );
      }),
      SEED,
    );
  });
});

describe("cookie signing", () => {
  it("[FUZZ-COOKIE-09] sign then unsign returns the original value", async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, nameArb, valueArb, async (secret, name, value) => {
        const signer = createCookieSigner([secret]);
        const signed = await signer.sign(name, value);
        expect(await signer.unsign(name, signed)).toBe(value);
      }),
      { seed: SEED.seed, numRuns: 120 },
    );
  });

  it("[FUZZ-COOKIE-10] a signed value does not verify under another name", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        nameArb,
        nameArb,
        valueArb,
        async (secret, name, other, value) => {
          fc.pre(name !== other);
          const signer = createCookieSigner([secret]);
          const signed = await signer.sign(name, value);
          expect(await signer.unsign(other, signed)).toBeUndefined();
        },
      ),
      { seed: SEED.seed, numRuns: 120 },
    );
  });

  it("[FUZZ-COOKIE-11] a changed value does not verify with the original signature", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        nameArb,
        valueArb,
        valueArb,
        async (secret, name, value, forged) => {
          fc.pre(value !== forged);
          const signer = createCookieSigner([secret]);
          const signed = await signer.sign(name, value);
          expect(await signer.unsign(name, `${forged}.${signatureOf(signed)}`)).toBeUndefined();
        },
      ),
      { seed: SEED.seed, numRuns: 120 },
    );
  });

  it("[FUZZ-COOKIE-12] a value signed under one secret does not verify under another", async () => {
    await fc.assert(
      fc.asyncProperty(
        secretArb,
        secretArb,
        nameArb,
        valueArb,
        async (first, second, name, value) => {
          fc.pre(first !== second);
          const signed = await createCookieSigner([first]).sign(name, value);
          expect(await createCookieSigner([second]).unsign(name, signed)).toBeUndefined();
        },
      ),
      { seed: SEED.seed, numRuns: 120 },
    );
  });

  it("[FUZZ-COOKIE-13] a non-canonical signature spelling is refused", async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, nameArb, valueArb, async (secret, name, value) => {
        const signer = createCookieSigner([secret]);
        const signed = await signer.sign(name, value);
        const signature = signatureOf(signed);
        // 32 bytes encode to 43 base64url characters; the last character's low two bits are padding,
        // so flipping the low bit decodes to the same bytes under a second spelling.
        const last = signature.charAt(signature.length - 1);
        const index = BASE64URL.indexOf(last);
        const variant = BASE64URL.charAt(index ^ 1);
        const forged = `${value}.${signature.slice(0, -1)}${variant}`;
        expect(await signer.unsign(name, forged)).toBeUndefined();
      }),
      { seed: SEED.seed, numRuns: 120 },
    );
  });

  it("[FUZZ-COOKIE-14] unsign on arbitrary garbage never throws", async () => {
    const secret = "fuzz-secret-for-garbage-input-0123456789";
    const signer = createCookieSigner([secret]);
    await fc.assert(
      fc.asyncProperty(
        nameArb,
        fc.string({ unit: "grapheme", maxLength: 120 }),
        async (name, garbage) => {
          const result = await signer.unsign(name, garbage);
          expect(result === undefined || typeof result === "string").toBe(true);
        },
      ),
      { seed: SEED.seed, numRuns: 200 },
    );
  });
});
