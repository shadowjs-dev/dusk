import { deserialize, serialize } from "@shadow-js/web/server";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * Property tests for the server-function wire format (`serialize` / `deserialize` from `@shadow-js/web/server`, the
 * payload of every `/_dusk/fn/` call). Invariants: a value that is serialized and deserialized comes back equal, a
 * hostile payload never throws anything but a TypeError or SyntaxError, `__proto__` and `constructor` keys never reach
 * `Object.prototype`, and the serialized text never carries a raw `<`, `>`, `&`, U+2028 or U+2029 (it is safe in a
 * `<script>` element).
 */

const SEED = { seed: 20261016, numRuns: 200 };

/** Keys that a prototype-pollution attack would use, mixed with ordinary keys. */
const hostileKey = fc.oneof(
  fc.constantFrom("__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"),
  fc.string({ maxLength: 12 }),
);

/** Text that includes the characters a script-safe encoder must escape. */
const scriptHostileText = fc
  .array(
    fc.oneof(
      fc
        .integer({ min: 0, max: 0x10ffff })
        .filter((cp) => cp < 0xd800 || cp > 0xdfff)
        .map((cp) => String.fromCodePoint(cp)),
      fc.constantFrom("<", ">", "&", "\u2028", "\u2029", "</script>", "<!--"),
    ),
    {
      maxLength: 60,
    },
  )
  .map((parts) => parts.join(""));

/** JSON-shaped values plus the tagged types the wire format carries (bigint, Date, Map, Set, Uint8Array, URL). */
const wireValue: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  leaf: fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noDefaultInfinity: true, noNaN: true }),
    fc.bigInt({ min: -(2n ** 80n), max: 2n ** 80n }),
    fc.string({ maxLength: 40 }),
    fc.integer({ min: 0, max: 2_000_000_000_000 }).map((ms) => new Date(ms)),
    fc.uint8Array({ maxLength: 16 }),
    fc.webUrl().map((text) => new URL(text)),
  ),
  node: fc.oneof(
    tie("leaf"),
    fc.array(tie("node"), { maxLength: 4 }),
    fc.array(fc.tuple(hostileKey, tie("node")), { maxLength: 4 }).map((entries) => {
      const record: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        Object.defineProperty(record, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return record;
    }),
    fc.array(tie("leaf"), { maxLength: 3 }).map((items) => new Set(items)),
    fc
      .array(fc.tuple(fc.string({ maxLength: 8 }), tie("leaf")), { maxLength: 3 })
      .map((pairs) => new Map(pairs)),
  ),
})).node;

/** Two values are the same wire value: compare through the wire text, since `toEqual` ignores prototypes. */
function same(a: unknown, b: unknown): boolean {
  return serialize(a) === serialize(b);
}

/** Only a TypeError or SyntaxError may escape deserialize. */
function expectControlledFailure(error: unknown): void {
  expect(error instanceof TypeError || error instanceof SyntaxError).toBe(true);
}

describe("[FUZZ-WIRE] server-function wire format", () => {
  it("[FUZZ-WIRE-01] round trip keeps every wire value (including hostile keys, bigint, Date, URL, Map, Set)", () => {
    fc.assert(
      fc.property(wireValue, (value) => {
        const text = serialize(value);
        const back = deserialize(text);
        expect(same(back, value)).toBe(true);
        // A second round trip is stable: the wire text is a fixed point.
        expect(serialize(back)).toBe(text);
      }),
      SEED,
    );
  });

  it("[FUZZ-WIRE-02] serialized text is script-safe: no raw < > & U+2028 U+2029 for any string", () => {
    fc.assert(
      fc.property(scriptHostileText, (text) => {
        const wire = serialize({ text, tag: "</script><!--" });
        expect(wire).not.toMatch(/[<>&\u2028\u2029]/);
        expect((deserialize(wire) as { text: string }).text).toBe(text);
      }),
      SEED,
    );
  });

  it("[FUZZ-WIRE-03] hostile arbitrary text throws only TypeError or SyntaxError, never anything else", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        try {
          deserialize(text);
        } catch (error) {
          expectControlledFailure(error);
        }
      }),
      SEED,
    );
  });

  it("[FUZZ-WIRE-04] structurally hostile payloads (bad tags, bad table refs, wrong shapes) throw TypeError, never pollute", () => {
    const tags = fc.constantFrom(
      "u",
      "num",
      "big",
      "ref",
      "obj",
      "arr",
      "map",
      "set",
      "date",
      "buf",
      "bin",
      "url",
      "zz",
    );
    const cell = fc.oneof(
      fc.jsonValue(),
      fc.tuple(tags, fc.jsonValue()).map(([tag, data]) => ({ $: tag, e: data, v: data, i: data })),
      fc.integer({ min: -5, max: 50 }).map((index) => ({ $: "ref", i: index })),
    );
    fc.assert(
      fc.property(fc.array(cell, { maxLength: 6 }), fc.jsonValue(), (table, root) => {
        const text = JSON.stringify({ r: root, t: table });
        try {
          deserialize(text);
        } catch (error) {
          expectControlledFailure(error);
        }
        expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      }),
      SEED,
    );
  });

  it("[FUZZ-WIRE-05] a `__proto__` key in a payload stays an own data property and never sets the prototype", () => {
    const text = JSON.stringify({
      r: { $: "ref", i: 0 },
      t: [
        {
          $: "obj",
          e: [
            ["__proto__", { $: "u" }],
            ["constructor", { $: "u" }],
          ],
        },
      ],
    });
    const back = deserialize(text) as Record<string, unknown>;
    expect(Object.getPrototypeOf(back)).toBe(null);
    expect(Object.keys(back).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("[FUZZ-WIRE-06] a reference cycle in the table decodes without hanging or overflowing the stack", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (length) => {
        // Each array entry holds a reference to the next; the last one refers back to the first.
        const table = Array.from({ length }, (_, index) => ({
          $: "arr",
          e: [{ $: "ref", i: (index + 1) % length }],
        }));
        const text = JSON.stringify({ r: { $: "ref", i: 0 }, t: table });
        const back = deserialize(text) as unknown[];
        expect(Array.isArray(back)).toBe(true);
        expect(back[0]).toBeDefined();
      }),
      SEED,
    );
  });

  it("[FUZZ-WIRE-07] an invalid Date (NaN time) round trips and stays invalid", () => {
    const back = deserialize(serialize(new Date(Number.NaN))) as Date;
    expect(back).toBeInstanceOf(Date);
    expect(Number.isNaN(back.getTime())).toBe(true);
  });

  it("[FUZZ-WIRE-08] a bigint round trips exactly across the whole range", () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        expect(deserialize(serialize(value))).toBe(value);
      }),
      SEED,
    );
  });
});
