import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { soundPath } from "../../src/server/routing";
import { matchPattern } from "../../src/shared/path-match";
import { compilePattern, fillPattern } from "../../src/shared/path-pattern";

/**
 * Property tests for path normalization and rewrite (destination filling, sound paths, and matching).
 * Invariants: a filled parameter never adds a path separator, a dot or empty segment is refused by
 * soundPath, a filled destination survives WHATWG URL parsing unchanged, and matching a filled path
 * recovers the captured value.
 */

const SEED = { seed: 20261017, numRuns: 300 };

const SAFE_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~"];

const safeSegmentArb = fc
  .array(fc.constantFrom(...SAFE_CHARS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

/** Any non-empty value a route parameter can hold, excluding lone surrogates (not a valid URL text). */
const valueArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 30 });

/** A value that encodes to a single segment the router must refuse. */
const DOT_VALUES = [".", ".."];

describe("path normalization and rewrite", () => {
  it("[FUZZ-PATH-01] a filled parameter is one encoded segment that decodes back to its value", () => {
    fc.assert(
      fc.property(valueArb, (value) => {
        const filled = fillPattern("/users/:id", { id: value });
        const pieces = filled.split("/");
        expect(pieces).toHaveLength(3);
        expect(pieces[2]).not.toContain("/");
        expect(decodeURIComponent(pieces[2] ?? "")).toBe(value);
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-02] a splat parameter keeps its '/' separators and decodes piece by piece", () => {
    fc.assert(
      fc.property(fc.array(safeSegmentArb, { minLength: 1, maxLength: 5 }), (pieces) => {
        const filled = fillPattern("/files/*rest", { rest: pieces.join("/") });
        expect(filled).toBe(`/files/${pieces.join("/")}`);
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-03] soundPath refuses any path with an empty, '.' or '..' segment", () => {
    fc.assert(
      fc.property(
        fc.array(safeSegmentArb, { maxLength: 3 }),
        fc.constantFrom("", ".", ".."),
        fc.array(safeSegmentArb, { maxLength: 3 }),
        (before, bad, after) => {
          // "/" alone is the root and is sound, so an empty bad segment needs a neighbor to form an empty piece.
          fc.pre(bad !== "" || before.length + after.length > 0);
          const path = `/${[...before, bad, ...after].join("/")}`;
          expect(() => soundPath(path)).toThrow(TypeError);
          expect(() => soundPath(path)).toThrow(/DESTINATION_UNSOUND/);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-PATH-04] soundPath returns a path with only safe segments unchanged", () => {
    fc.assert(
      fc.property(fc.array(safeSegmentArb, { minLength: 1, maxLength: 6 }), (segments) => {
        const path = `/${segments.join("/")}`;
        expect(soundPath(path)).toBe(path);
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-05] a parameter that is a dot segment is refused after filling", () => {
    fc.assert(
      fc.property(fc.constantFrom(...DOT_VALUES), (value) => {
        expect(() => soundPath(fillPattern("/users/:id", { id: value }))).toThrow(TypeError);
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-06] a splat holding a dot segment is refused after filling", () => {
    fc.assert(
      fc.property(
        fc.array(safeSegmentArb, { maxLength: 3 }),
        fc.constantFrom(...DOT_VALUES),
        fc.array(safeSegmentArb, { maxLength: 3 }),
        (before, bad, after) => {
          const rest = [...before, bad, ...after].join("/");
          expect(() => soundPath(fillPattern("/files/*rest", { rest }))).toThrow(TypeError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-PATH-07] a filled destination survives WHATWG URL parsing with the same pathname", () => {
    fc.assert(
      fc.property(valueArb, (value) => {
        fc.pre(value !== "." && value !== "..");
        const filled = soundPath(fillPattern("/users/:id/edit", { id: value }));
        expect(new URL(`https://app.example${filled}`).pathname).toBe(filled);
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-08] matching a filled path recovers the captured value", () => {
    const pattern = compilePattern("/posts/:id");
    fc.assert(
      fc.property(valueArb, (value) => {
        fc.pre(value !== "." && value !== "..");
        const filled = fillPattern("/posts/:id", { id: value });
        expect(matchPattern(pattern, filled)).toEqual({ id: value });
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-09] matchPattern never throws on arbitrary pathnames", () => {
    const pattern = compilePattern("/a/:x/*rest");
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 80 }), (pathname) => {
        const result = matchPattern(pattern, pathname);
        expect(result === undefined || typeof result === "object").toBe(true);
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-10] a rest capture with a dot or empty segment never matches", () => {
    const pattern = compilePattern("/files/*rest");
    fc.assert(
      fc.property(
        fc.array(safeSegmentArb, { maxLength: 3 }),
        fc.constantFrom(".", "..", "%2e", "%2E%2e", "%2e%2e"),
        (before, bad) => {
          const pathname = `/files/${[...before, bad].join("/")}`;
          const result = matchPattern(pattern, pathname);
          const decoded = decodeURIComponent(bad);
          if (decoded === "." || decoded === "..") {
            expect(result).toBeUndefined();
          }
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-PATH-11] a parameter cannot inject a '/' that changes the segment count", () => {
    fc.assert(
      fc.property(valueArb, (value) => {
        const pattern = compilePattern("/a/:x/b");
        const filled = fillPattern("/a/:x/b", { x: value });
        expect(filled.split("/")).toHaveLength(4);
        expect(matchPattern(pattern, filled)).toEqual({ x: value });
      }),
      SEED,
    );
  });

  it("[FUZZ-PATH-12] documents: a literal encoded dot segment in a developer template is not refused by soundPath", () => {
    // Non-goal: soundPath checks literal segments only. The template is developer-authored and params are
    // encoded, so an encoded dot can reach a destination only from a literal "%2e%2e" written in the template.
    // WHATWG URL parsing then normalizes it, which is why the template must not contain one.
    const path = "/a/%2e%2e/b";
    expect(soundPath(path)).toBe(path);
    expect(new URL(`https://app.example${path}`).pathname).toBe("/b");
  });
});
