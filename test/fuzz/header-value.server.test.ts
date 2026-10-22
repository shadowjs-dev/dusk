import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cacheControlOf, headersOf } from "../../src/shared/header-value";

/**
 * Property tests for header value validation (header injection).
 * Invariants: a line break or NUL never reaches a header value, a name must be an RFC 9110 token, and
 * forbidden framework headers are refused in any letter case.
 *
 * RFC 9110 field values exclude control characters other than HTAB: headersOf refuses U+0000 to U+0008,
 * U+000A to U+001F and U+007F.
 */

const SEED = { seed: 20261016, numRuns: 300 };

const TOKEN_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-.^_`|~",
];

const nameArb = fc
  .array(fc.constantFrom(...TOKEN_CHARS), { minLength: 1, maxLength: 16 })
  .map((chars) => chars.join(""));

const textArb = fc.string({ unit: "grapheme", maxLength: 60 });

/** A value with one line break or NUL placed at a random position. */
const injectedArb = fc
  .tuple(textArb, fc.constantFrom("\r", "\n", "\u0000", "\r\n", "\n\r"), textArb)
  .map(([head, bad, tail]) => `${head}${bad}${tail}`);

const FORBIDDEN = ["set-cookie", "content-length", "transfer-encoding", "connection", "keep-alive"];

describe("header value validation", () => {
  it("[FUZZ-HEADER-01] a value with a CR, LF or NUL is always refused", () => {
    fc.assert(
      fc.property(nameArb, injectedArb, (name, value) => {
        expect(() => headersOf("headers", { [name]: value })).toThrow(TypeError);
      }),
      SEED,
    );
  });

  it("[FUZZ-HEADER-02] an accepted header has no CR, LF or NUL and keeps its value", () => {
    fc.assert(
      fc.property(nameArb, textArb, (name, value) => {
        const [entry] = headersOf("headers", { [name]: value });
        const [lowered, text] = entry ?? ["", ""];
        expect(lowered).toBe(name.toLowerCase());
        expect(text).toBe(value);
        expect(text).not.toMatch(/[\r\n\u0000]/);
      }),
      SEED,
    );
  });

  it("[FUZZ-HEADER-03] a name that is not an RFC 9110 token is refused with TypeError", () => {
    fc.assert(
      fc.property(
        fc.tuple(nameArb, fc.constantFrom(" ", ":", "\r", "\n", "\u0000", "(", ")", "/", "@", '"')),
        textArb,
        ([name, bad], value) => {
          expect(() => headersOf("headers", { [`${name}${bad}`]: value })).toThrow(TypeError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-HEADER-04] a forbidden framework header is refused in any letter case", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
        (base, caseBits) => {
          const name = [...base]
            .map((char, index) => (caseBits[index % caseBits.length] ? char.toUpperCase() : char))
            .join("");
          expect(() => headersOf("headers", { [name]: "x" })).toThrow(TypeError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-HEADER-05] a value longer than the limit is refused", () => {
    fc.assert(
      fc.property(nameArb, fc.integer({ min: 8193, max: 9000 }), (name, length) => {
        expect(() => headersOf("headers", { [name]: "a".repeat(length) })).toThrow(TypeError);
      }),
      { seed: SEED.seed, numRuns: 50 },
    );
  });

  it("[FUZZ-HEADER-06] cache-control refuses a value with a CR, LF or NUL", () => {
    fc.assert(
      fc.property(injectedArb, (value) => {
        expect(() => cacheControlOf("cacheControl", value)).toThrow(TypeError);
      }),
      SEED,
    );
  });

  it("[FUZZ-HEADER-07] a control character other than HTAB is refused (RFC 9110 field-value)", () => {
    fc.assert(
      fc.property(
        nameArb,
        fc.constantFrom("\u0001", "\u0008", "\u000b", "\u001f", "\u007f"),
        (name, control) => {
          expect(() => headersOf("headers", { [name]: `a${control}b` })).toThrow(TypeError);
        },
      ),
      { seed: SEED.seed, numRuns: 50 },
    );
  });
});
