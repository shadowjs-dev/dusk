import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  comparePatterns,
  compilePattern,
  fillPattern,
  matchPattern,
  templateNames,
} from "../../src/shared/path-pattern";

describe("path patterns (shared by redirects, rewrites, headers and route rules)", () => {
  it("[PAT-1] a literal pattern matches exactly that path, with or without a trailing slash", () => {
    const pattern = compilePattern("/about");
    expect(matchPattern(pattern, "/about")).toEqual({});
    expect(matchPattern(pattern, "/about/")).toEqual({});
    expect(matchPattern(pattern, "/about/team")).toBeUndefined();
    expect(matchPattern(pattern, "/abou")).toBeUndefined();
    expect(matchPattern(pattern, "/About")).toBeUndefined();
  });

  it("[PAT-2] `:name` captures exactly one non-empty segment, percent-decoded", () => {
    const pattern = compilePattern("/posts/:id");
    expect(matchPattern(pattern, "/posts/7")).toEqual({ id: "7" });
    expect(matchPattern(pattern, "/posts/a%20b")).toEqual({ id: "a b" });
    expect(matchPattern(pattern, "/posts")).toBeUndefined();
    expect(matchPattern(pattern, "/posts/1/2")).toBeUndefined();
  });

  it("[PAT-3] a `*` inside a segment matches any run of characters (zero or more) within that segment; a segment may not start with `*`", () => {
    const images = compilePattern("/img/cover-*.png");
    expect(matchPattern(images, "/img/cover-cat.png")).toEqual({});
    expect(matchPattern(images, "/img/cover-.png")).toEqual({});
    expect(matchPattern(images, "/img/cover.jpg")).toBeUndefined();
    expect(matchPattern(images, "/img/x/cover-cat.png")).toBeUndefined();
    expect(() => compilePattern("/img/*.png")).toThrow(/must be the last segment|invalid name/);
  });

  it("[PAT-4] `**` matches zero or more trailing segments and captures nothing", () => {
    const pattern = compilePattern("/blog/**");
    expect(matchPattern(pattern, "/blog")).toEqual({});
    expect(matchPattern(pattern, "/blog/2026")).toEqual({});
    expect(matchPattern(pattern, "/blog/2026/10/09")).toEqual({});
    expect(matchPattern(pattern, "/blogs/2026")).toBeUndefined();
  });

  it("[PAT-5] `*name` (the router's splat) matches one or more trailing segments and captures them; `*` captures as `*`", () => {
    const pattern = compilePattern("/docs/*path");
    expect(matchPattern(pattern, "/docs")).toBeUndefined();
    expect(matchPattern(pattern, "/docs/a/b%20c")).toEqual({ path: "a/b c" });
    expect(matchPattern(compilePattern("/any/*"), "/any/x")).toEqual({ "*": "x" });
    expect(fillPattern("/new/*path", { path: "a/b c" })).toBe("/new/a/b%20c");
  });

  it("[PAT-6] `**` or `*name` that is not the last segment, and the retired `:name*` form, are TypeErrors", () => {
    expect(() => compilePattern("/a/**/b")).toThrow(/must be the last segment/);
    expect(() => compilePattern("/a/*rest/b")).toThrow(/must be the last segment/);
    expect(() => compilePattern("/a/:x*")).toThrow(/"\*name", not ":name\*"/);
    expect(() => compilePattern("/a/:x?")).toThrow(TypeError);
  });

  it("[PAT-7] malformed patterns are TypeErrors: no leading slash, empty segment, bad param name, a query string", () => {
    expect(() => compilePattern("blog")).toThrow(TypeError);
    expect(() => compilePattern("/a//b")).toThrow(TypeError);
    expect(() => compilePattern("/:1bad")).toThrow(TypeError);
    expect(() => compilePattern("/a?b")).toThrow(TypeError);
  });

  it("[PAT-8] fillPattern substitutes params into a destination, encoding each value; a missing one is a TypeError", () => {
    expect(fillPattern("/users/:id/edit", { id: "a/b" })).toBe("/users/a%2Fb/edit");
    expect(fillPattern("/static", {})).toBe("/static");
    expect(() => fillPattern("/users/:id", {})).toThrow(TypeError);
    expect(() => fillPattern("/x/**", {})).toThrow(TypeError);
    expect(templateNames("/a/:id/*rest")).toEqual(["id", "rest"]);
  });

  it("[PAT-9] specificity: literal beats param beats glob-free param... at each segment; a fixed path beats a splat, which beats `**`", () => {
    const literal = compilePattern("/blog/new");
    const param = compilePattern("/blog/:slug");
    const glob = compilePattern("/blog/new-*");
    const splat = compilePattern("/blog/*rest");
    const any = compilePattern("/blog/**");
    const exact = compilePattern("/blog");
    expect(comparePatterns(literal, glob)).toBeLessThan(0);
    expect(comparePatterns(glob, param)).toBeLessThan(0);
    expect(comparePatterns(param, splat)).toBeLessThan(0);
    expect(comparePatterns(splat, any)).toBeLessThan(0);
    expect(comparePatterns(exact, any)).toBeLessThan(0);
    expect(comparePatterns(any, literal)).toBeGreaterThan(0);
    expect(comparePatterns(param, compilePattern("/blog/:other"))).toBe(0);
  });

  it("[PAT-10] property: the matcher agrees with a regular-expression reference on random paths and patterns (fixed seed)", () => {
    const segment = fc.stringMatching(/^[ab]{1,2}$/);
    const token = fc.oneof(segment, fc.constant(":p"), fc.stringMatching(/^[ab]-\*[ab]?$/));
    const patternArb = fc
      .record({
        body: fc.array(token, { minLength: 0, maxLength: 3 }),
        rest: fc.constantFrom("", "**", "*r"),
      })
      .map(({ body, rest }) => {
        const parts = rest === "" ? body : [...body, rest];
        return `/${parts.join("/")}`;
      });
    const pathArb = fc
      .array(fc.stringMatching(/^[ab]{1,2}$/), { minLength: 0, maxLength: 4 })
      .map((parts) => `/${parts.join("/")}`);

    fc.assert(
      fc.property(patternArb, pathArb, (source, path) => {
        const compiled = compilePattern(source);
        const expected = referenceMatch(source, path);
        const actual = matchPattern(compiled, path) !== undefined;
        expect(actual).toBe(expected);
      }),
      { seed: 42, numRuns: 1500 },
    );
  });

  it("[PAT-11] property: specificity is a total preorder (antisymmetric and transitive on random patterns)", () => {
    const token = fc.constantFrom("a", "b", ":p", "a-*", "**", "*r");
    const patternArb = fc.array(token, { minLength: 1, maxLength: 3 }).map((parts) => {
      const cleaned = parts.map((part, index) =>
        (part === "**" || part === "*r") && index !== parts.length - 1 ? "a" : part,
      );
      return compilePattern(`/${cleaned.join("/")}`);
    });
    fc.assert(
      fc.property(patternArb, patternArb, patternArb, (x, y, z) => {
        expect(Math.sign(comparePatterns(x, y)) + Math.sign(comparePatterns(y, x))).toBe(0);
        if (comparePatterns(x, y) <= 0 && comparePatterns(y, z) <= 0) {
          expect(comparePatterns(x, z)).toBeLessThanOrEqual(0);
        }
      }),
      { seed: 42, numRuns: 500 },
    );
  });
});

/** Independent reference: each pattern segment becomes a regular-expression fragment. */
function referenceMatch(source: string, path: string): boolean {
  const parts = source.slice(1).split("/");
  let regex = "^";
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === "**" && last) regex += "(?:/.*)?";
    else if (part.startsWith("*") && last) regex += "/.+";
    else if (part === ":p") regex += "/[^/]+";
    else if (part.includes("*")) {
      const pieces = part.split("*").map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      regex += `/${pieces.join("[^/]*")}`;
    } else regex += `/${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  });
  regex += "$";
  return new RegExp(regex).test(path);
}
