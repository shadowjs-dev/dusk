import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  conditionsMatch,
  effectiveRule,
  headersFor,
  redirectFor,
  rewriteFor,
} from "../../src/server/routing";
import {
  type ResolvedRouting,
  type RoutingConfig,
  validateRouting,
} from "../../src/shared/routing-config";

function routing(input: RoutingConfig): ResolvedRouting {
  return validateRouting(input, { trustedOrigins: ["https://partner.example"] });
}
const req = (path: string, init: RequestInit = {}) => {
  const url = new URL(`https://app.example${path}`);
  return { request: new Request(url, init), url };
};

describe("runtime routing", () => {
  it("[ROUTE-1] the first matching redirect answers, with its parameters filled and its status", () => {
    const table = routing({
      redirects: [
        { source: "/old/:id", destination: "/new/:id", permanent: true },
        { source: "/old/**", destination: "/archive" },
      ],
    });
    const { request, url } = req("/old/42?x=1");
    // The request's query string moves to the target (G-C9): the destination has none of its own.
    expect(redirectFor(table, "/old/42", request, url)).toEqual({
      status: 308,
      target: "/new/42?x=1",
    });
    const second = req("/old/a/b");
    expect(redirectFor(table, "/old/a/b", second.request, second.url)).toEqual({
      status: 307,
      target: "/archive",
    });
    const none = req("/elsewhere");
    expect(redirectFor(table, "/elsewhere", none.request, none.url)).toBeUndefined();
  });

  it("[ROUTE-2] `has` and `missing` conditions: a header value, a cookie presence, a query value, the host", () => {
    const table = routing({
      redirects: [
        {
          source: "/a",
          destination: "/b",
          has: [{ type: "header", key: "x-beta", value: "1" }],
          missing: [{ type: "cookie", key: "sid" }],
        },
        { source: "/c", destination: "/d", has: [{ type: "query", key: "go", value: "yes" }] },
        { source: "/e", destination: "/f", has: [{ type: "host", value: "app.example" }] },
      ],
    });
    const withHeader = req("/a", { headers: { "x-beta": "1" } });
    expect(redirectFor(table, "/a", withHeader.request, withHeader.url)).toBeDefined();
    const withCookie = req("/a", { headers: { "x-beta": "1", cookie: "sid=1" } });
    expect(redirectFor(table, "/a", withCookie.request, withCookie.url)).toBeUndefined();
    const wrongValue = req("/a", { headers: { "x-beta": "2" } });
    expect(redirectFor(table, "/a", wrongValue.request, wrongValue.url)).toBeUndefined();
    const query = req("/c?go=yes");
    expect(redirectFor(table, "/c", query.request, query.url)).toBeDefined();
    const host = req("/e");
    expect(redirectFor(table, "/e", host.request, host.url)).toBeDefined();
  });

  it("[ROUTE-3] conditions are all-of for `has` and none-of for `missing`", () => {
    const table = routing({
      redirects: [
        {
          source: "/a",
          destination: "/b",
          has: [
            { type: "header", key: "a" },
            { type: "header", key: "b" },
          ],
        },
      ],
    });
    const one = req("/a", { headers: { a: "1" } });
    expect(conditionsMatch(table.redirects[0]?.has ?? [], [], one.request, one.url)).toBe(false);
    const both = req("/a", { headers: { a: "1", b: "1" } });
    expect(conditionsMatch(table.redirects[0]?.has ?? [], [], both.request, both.url)).toBe(true);
  });

  it("[ROUTE-4] rewrites: the phases are tried in their order; a query of the request is kept and the destination's query wins", () => {
    const table = routing({
      rewrites: {
        beforeFiles: [{ source: "/legacy/:slug", destination: "/posts/:slug?from=legacy" }],
        afterFiles: [{ source: "/docs/:page", destination: "/manual/:page" }],
        fallback: [{ source: "/**", destination: "/not-found" }],
      },
    });
    const before = req("/legacy/hello?from=x&keep=1");
    const hit = rewriteFor(table.rewrites.beforeFiles, "/legacy/hello", before.request, before.url);
    expect(hit).toEqual({ path: "/posts/hello", search: "?keep=1&from=legacy" });
    const after = req("/docs/intro");
    expect(rewriteFor(table.rewrites.afterFiles, "/docs/intro", after.request, after.url)).toEqual({
      path: "/manual/intro",
      search: "",
    });
  });

  it("[ROUTE-5] headers: every matching rule applies in declaration order; a later rule overwrites an earlier one", () => {
    const table = routing({
      headers: [
        { source: "/**", headers: { "x-a": "1", "x-b": "1" } },
        { source: "/docs/**", headers: { "x-b": "2" } },
      ],
    });
    const one = req("/docs/a");
    // Each entry is name, value and whether the rule overrides the route's header (false by default).
    expect(headersFor(table, "/docs/a", one.request, one.url)).toEqual([
      ["x-a", "1", false],
      ["x-b", "2", false],
    ]);
    const other = req("/other");
    expect(headersFor(table, "/other", other.request, other.url)).toEqual([
      ["x-a", "1", false],
      ["x-b", "1", false],
    ]);
  });

  it("[ROUTE-6] route rules merge: the most specific rule wins each property; equal shapes merge in declaration order", () => {
    const table = routing({
      routeRules: {
        "/blog/**": { revalidate: 600, headers: { "x-blog": "1" }, csr: false },
        "/blog/:slug": { revalidate: 60 },
        "/blog/new": { revalidate: false },
      },
    });
    expect(effectiveRule(table, "/blog/new")).toMatchObject({
      revalidate: false,
      csr: false,
      headers: { "x-blog": "1" },
    });
    expect(effectiveRule(table, "/blog/hello")).toMatchObject({ revalidate: 60, csr: false });
    expect(effectiveRule(table, "/blog/a/b")).toMatchObject({ revalidate: 600 });
    expect(effectiveRule(table, "/about")).toEqual({});
  });

  it("[ROUTE-7] property: redirectFor agrees with a reference first-match over random rule sets (fixed seed)", () => {
    const segment = fc.constantFrom("a", "b", "c");
    const rule = fc.record({
      source: fc
        .array(fc.oneof(segment, fc.constant(":p")), { minLength: 1, maxLength: 2 })
        .map((parts) => `/${parts.join("/")}`),
      target: fc.constantFrom("/x", "/y", "/z"),
    });
    fc.assert(
      fc.property(
        fc.array(rule, { minLength: 1, maxLength: 4 }),
        fc.array(segment, { minLength: 1, maxLength: 2 }),
        (rules, parts) => {
          const table = routing({
            redirects: rules.map((item) => ({ source: item.source, destination: item.target })),
          });
          const path = `/${parts.join("/")}`;
          const { request, url } = req(path);
          const expected = rules.find((item) => matchesReference(item.source, path));
          const actual = redirectFor(table, path, request, url);
          expect(actual?.target).toBe(expected?.target);
        },
      ),
      { seed: 42, numRuns: 400 },
    );
  });
});

/** Independent reference for ROUTE-7: `:p` matches one segment, everything else must be equal. */
function matchesReference(source: string, path: string): boolean {
  const pattern = source.split("/").slice(1);
  const parts = path.split("/").slice(1);
  if (pattern.length !== parts.length) return false;
  return pattern.every((piece, index) => piece === ":p" || piece === parts[index]);
}
