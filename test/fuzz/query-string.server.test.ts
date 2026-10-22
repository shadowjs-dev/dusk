import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { percentDecode } from "../../src/internal/encoding";
import { searchRecord } from "../../src/metadata/feature";

/**
 * Property tests for query-string handling: `percentDecode` (the decoder behind cookie values and the cookie jar) and
 * `searchRecord` (the record the generator functions read from a query string). Invariants: decoding never throws and
 * never grows the text, text without an escape is unchanged, well-formed text round-trips through `encodeURIComponent`,
 * `+`, `&` and `#` keep their meaning, malformed escapes stay literal, a repeated key collects every value in order, and
 * hostile keys never reach `Object.prototype`.
 */

const SEED = { seed: 20261018, numRuns: 200 };

/** Any Unicode scalar value (surrogates excluded), as a string. */
const codePoint = fc
  .integer({ min: 0, max: 0x10ffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));

/** Pieces of a query: literal text, valid and malformed escapes, and the separators the decoder must keep. */
const queryPiece = fc.constantFrom(
  "x",
  "+",
  "&",
  "#",
  "=",
  " ",
  "%20",
  "%26",
  "%23",
  "%2B",
  "%25",
  "%41",
  "%FF",
  "%C3%A9",
  "%G1",
  "%4",
  "%",
);

const queryText = fc
  .array(fc.oneof(codePoint, queryPiece), { maxLength: 60 })
  .map((parts) => parts.join(""));

/**
 * Text in which no escape is valid: every "%" is followed by a non-hex character. No chunk starts with a hex digit, so
 * a "%" at the end of one chunk can never be completed by the next.
 */
const noEscapeChunk = fc.constantFrom(
  "x",
  "g",
  "+",
  "&",
  "#",
  "=",
  "-",
  "!",
  "_",
  ".",
  "%g",
  "%z",
  "%%",
  "%-",
  "%+",
  "%&",
  "%#",
  "%=",
);
const noEscapeText = fc.array(noEscapeChunk, { maxLength: 60 }).map((parts) => parts.join(""));

/** The decoded text of each piece that `queryPiece` can produce in the structured tests. */
const PIECE_DECODE: ReadonlyMap<string, string> = new Map([
  ["+", "+"],
  ["&", "&"],
  ["#", "#"],
  ["=", "="],
  ["x", "x"],
  ["%20", " "],
  ["%26", "&"],
  ["%23", "#"],
  ["%2B", "+"],
  ["%25", "%"],
]);

/** A query value: any text, percent-encoded so it cannot split the query. */
const queryValue = fc.array(codePoint, { maxLength: 12 }).map((parts) => parts.join(""));

/** Keys that a prototype-pollution attack would use, mixed with an ordinary key. */
const HOSTILE_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
  "__defineGetter__",
  "ok",
];

describe("[FUZZ-QUERY] query-string decoding and parsing", () => {
  it("[FUZZ-QUERY-01] percentDecode never throws, and never returns more text than it was given", () => {
    fc.assert(
      fc.property(queryText, (raw) => {
        const out = percentDecode(raw);
        expect(typeof out).toBe("string");
        expect(out.length).toBeLessThanOrEqual(raw.length);
      }),
      SEED,
    );
  });

  it("[FUZZ-QUERY-02] text without a % is returned unchanged, so + & # = keep their meaning", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.oneof(codePoint, fc.constantFrom("+", "&", "#", "=", " ", "\t", "\n")), {
            maxLength: 60,
          })
          .map((parts) => parts.join("")),
        (raw) => {
          fc.pre(!raw.includes("%"));
          expect(percentDecode(raw)).toBe(raw);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-QUERY-03] well-formed text round-trips through encodeURIComponent", () => {
    fc.assert(
      fc.property(queryValue, (text) => {
        expect(percentDecode(encodeURIComponent(text))).toBe(text);
      }),
      SEED,
    );
  });

  it("[FUZZ-QUERY-04] an escape is decoded, but a + & # written as text stay as they are (only escapes change)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...PIECE_DECODE.keys()), { maxLength: 40 }),
        (pieces) => {
          const raw = pieces.join("");
          const expected = pieces.map((piece) => PIECE_DECODE.get(piece) ?? "").join("");
          expect(percentDecode(raw)).toBe(expected);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-QUERY-05] malformed escapes (a % that is not followed by two hex digits) are kept literally", () => {
    fc.assert(
      fc.property(noEscapeText, (raw) => {
        expect(percentDecode(raw)).toBe(raw);
      }),
      SEED,
    );
    expect(percentDecode("%G1%")).toBe("%G1%");
    expect(percentDecode("%%41")).toBe("%A");
    expect(percentDecode("%2541")).toBe("%41");
  });

  it("[FUZZ-QUERY-06] a key that repeats collects every value in order; a key that appears once is a string", () => {
    const KEYS = ["a", "b", "tag", "page"];
    const pairs = fc.array(fc.tuple(fc.constantFrom(...KEYS), queryValue), { maxLength: 30 });
    fc.assert(
      fc.property(pairs, (list) => {
        const query = list
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join("&");
        const grouped = new Map<string, string[]>();
        for (const [key, value] of list) grouped.set(key, [...(grouped.get(key) ?? []), value]);
        const expected: Record<string, string | string[]> = {};
        for (const [key, values] of grouped)
          expected[key] = values.length === 1 ? (values[0] as string) : values;
        expect(searchRecord(query)).toEqual(expected);
      }),
      SEED,
    );
  });

  it("[FUZZ-QUERY-07] hostile keys stay own data: __proto__ is dropped, and Object.prototype is never changed", () => {
    const hostilePairs = fc.array(fc.tuple(fc.constantFrom(...HOSTILE_KEYS), queryValue), {
      maxLength: 20,
    });
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    fc.assert(
      fc.property(hostilePairs, (list) => {
        const query = list
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join("&");
        const out = searchRecord(query);
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        const expected: Record<string, string | string[]> = {};
        const grouped = new Map<string, string[]>();
        for (const [key, value] of list) {
          if (key === "__proto__") continue;
          grouped.set(key, [...(grouped.get(key) ?? []), value]);
        }
        for (const [key, values] of grouped) {
          Object.defineProperty(expected, key, {
            value: values.length === 1 ? values[0] : values,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        expect(out).toEqual(expected);
      }),
      SEED,
    );
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>)["ok"]).toBeUndefined();
  });

  it("[FUZZ-QUERY-08] bounded huge input decodes and parses quickly: a 1 MB escape run, and an 8192-character query at the default URL limit", () => {
    const started = performance.now();
    expect(percentDecode("%41".repeat(350_000))).toBe("A".repeat(350_000));
    expect(percentDecode("%FF")).toBe("�");
    expect(performance.now() - started).toBeLessThan(1000);

    // 8192 characters is the default `limits.maxUrlLength`: a query of repeated keys at that size stays fast. Repeat
    // cost in searchRecord is quadratic, so a raised maxUrlLength makes it slower; that is an observation, not a bug at
    // the default bound.
    const query = "a=1&".repeat(2048).slice(0, 8192);
    const parsed = performance.now();
    const record = searchRecord(query);
    expect((record["a"] as string[]).length).toBe(2048);
    expect(performance.now() - parsed).toBeLessThan(200);
  });
});
