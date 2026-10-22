import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { jsonLdText } from "../../src/metadata/to-head";
import { islandAttributes } from "../../src/shared/island";

/**
 * Property tests for JSON-in-HTML escaping (JSON-LD head blocks and island props attributes).
 * Invariants: no raw "<", ">", "&", U+2028 or U+2029 reaches the output, so no "</script>" can close the
 * element early; the escaped text parses back to the original value; invalid input and oversize input are
 * refused with the documented error type.
 */

const SEED = { seed: 20261018, numRuns: 300 };

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NUL = String.fromCharCode(0);

/** Characters that must never appear raw in an element or attribute value. */
const BREAKOUT_CHARS = ["<", ">", "&", LINE_SEPARATOR, PARAGRAPH_SEPARATOR];

const HOSTILE_PIECES = [
  "<",
  ">",
  "&",
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
  "</script>",
  "<!--",
  "]]>",
  "\\",
  '"',
  "'",
  NUL,
];

/** A string rich in characters that break out of a script element. */
const hostileStringArb = fc
  .array(
    fc.oneof(fc.constantFrom(...HOSTILE_PIECES), fc.string({ unit: "grapheme", maxLength: 4 })),
    { maxLength: 6 },
  )
  .map((parts) => parts.join(""));

const keyArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 });

/** Plain JSON data, round-tripped so only JSON-representable values remain. */
const jsonDataArb = fc
  .jsonValue({ maxDepth: 3 })
  .map((value) => JSON.parse(JSON.stringify(value)) as unknown);

const hostileObjectArb = fc.dictionary(keyArb, fc.oneof(hostileStringArb, jsonDataArb), {
  maxKeys: 5,
});

function hasBreakout(text: string): boolean {
  return BREAKOUT_CHARS.some((char) => text.includes(char));
}

describe("JSON-in-HTML escaping", () => {
  it("[FUZZ-JSON-01] jsonLdText output has no raw <, >, &, U+2028 or U+2029 and no closing script tag", () => {
    fc.assert(
      fc.property(hostileObjectArb, (value) => {
        const text = jsonLdText(value);
        expect(hasBreakout(text)).toBe(false);
        expect(text.toLowerCase()).not.toContain("</script");
      }),
      SEED,
    );
  });

  it("[FUZZ-JSON-02] jsonLdText output parses back to the original value", () => {
    fc.assert(
      fc.property(hostileObjectArb, (value) => {
        const expected = JSON.parse(JSON.stringify(value)) as unknown;
        expect(JSON.parse(jsonLdText(value))).toEqual(expected);
      }),
      SEED,
    );
  });

  it("[FUZZ-JSON-03] islandAttributes data-props has no raw <, >, &, U+2028 or U+2029", () => {
    fc.assert(
      fc.property(keyArb, hostileObjectArb, (key, props) => {
        const island = islandAttributes({ id: "chart", props: { [key]: props } });
        const attribute = island["data-props"] ?? "";
        expect(hasBreakout(attribute)).toBe(false);
        expect(attribute.toLowerCase()).not.toContain("</script");
      }),
      SEED,
    );
  });

  it("[FUZZ-JSON-04] islandAttributes data-props parses back to the original props", () => {
    fc.assert(
      fc.property(hostileObjectArb, (props) => {
        const island = islandAttributes({ id: "chart", props });
        const expected = JSON.parse(JSON.stringify(props)) as unknown;
        expect(JSON.parse(island["data-props"] ?? "null")).toEqual(expected);
      }),
      SEED,
    );
  });

  it("[FUZZ-JSON-05] jsonLdText refuses a non-object value with TypeError", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: "grapheme", maxLength: 20 }),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
        ),
        (value) => {
          expect(() => jsonLdText(value)).toThrow(TypeError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-JSON-06] islandAttributes refuses props that are not plain data with TypeError", () => {
    const notPlain = fc.constantFrom<unknown>(
      () => 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      BigInt(1),
      undefined,
      new Date(0),
      new Map(),
      Symbol("s"),
    );
    fc.assert(
      fc.property(keyArb, notPlain, (key, bad) => {
        expect(() => islandAttributes({ id: "chart", props: { [key]: bad } })).toThrow(TypeError);
      }),
      SEED,
    );
  });

  it("[FUZZ-JSON-07] islandAttributes refuses an id with a character outside the id grammar", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom("x", "Ab", "1"),
          fc.constantFrom("<", ">", "&", '"', "'", " ", "/", LINE_SEPARATOR, "A"),
          fc.string({ unit: "grapheme", maxLength: 6 }),
        ),
        ([head, bad, tail]) => {
          expect(() => islandAttributes({ id: `${head}${bad}${tail}` })).toThrow(TypeError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-JSON-08] over-limit JSON-LD and island props are refused with RangeError", () => {
    expect(() => jsonLdText({ name: "a".repeat(100_000) })).toThrow(RangeError);
    expect(() => islandAttributes({ id: "chart", props: { blob: "a".repeat(16 * 1024) } })).toThrow(
      RangeError,
    );
  });
});
