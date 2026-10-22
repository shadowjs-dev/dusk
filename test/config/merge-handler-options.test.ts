import { describe, expect, it } from "vitest";
import { mergeHandlerOptions } from "../../src/server/merge-options";
import type { HandlerOptions } from "../../src/server/types";

/** Options as the generated entry sees them: the baked file config first, the entry file second. */
type Options = Partial<HandlerOptions>;
const merge = (baked: Options, user: Options | undefined): Options =>
  mergeHandlerOptions(baked, user);
/**
 * Options that carry an explicit `undefined`: the rule under test. `exactOptionalPropertyTypes` refuses that in a typed
 * literal, and the entry file can produce it, so the test builds the value and casts it once, here.
 */
const withUndefined = (value: object): Options => value as Options;

describe("mergeHandlerOptions: precedence and merge rules", () => {
  it("[MHO-1] the user wins per leaf key; a baked key the user does not name survives", () => {
    const baked: Options = {
      security: { allowedHosts: ["example.com"], headers: { frameOptions: "DENY" } },
    };
    const user: Options = { security: { csp: false } };
    expect(merge(baked, user)).toEqual({
      security: { allowedHosts: ["example.com"], headers: { frameOptions: "DENY" }, csp: false },
    });
  });

  it("[MHO-2] the user's nested object merges into the baked one, recursively, at every depth", () => {
    const baked: Options = {
      security: { headers: { frameOptions: "DENY", contentTypeOptions: "nosniff" } },
    };
    const user: Options = { security: { headers: { frameOptions: "SAMEORIGIN" } } };
    expect(merge(baked, user).security?.headers).toEqual({
      frameOptions: "SAMEORIGIN",
      contentTypeOptions: "nosniff",
    });
  });

  it("[MHO-3] arrays replace, they are not concatenated (allowedHosts)", () => {
    const baked: Options = { security: { allowedHosts: ["example.com", "www.example.com"] } };
    const user: Options = { security: { allowedHosts: ["app.example.com"] } };
    expect(merge(baked, user).security?.allowedHosts).toEqual(["app.example.com"]);
  });

  it("[MHO-4] an empty array replaces too: [] is an explicit 'no host list', not a missing one", () => {
    const baked: Options = { security: { allowedHosts: ["example.com"] } };
    const user: Options = { security: { allowedHosts: [] } };
    expect(merge(baked, user).security?.allowedHosts).toEqual([]);
  });

  it("[MHO-5] functions and class instances replace; they are never merged into", () => {
    const first = (): void => undefined;
    const second = (): void => undefined;
    const baked: Options = { onError: first, security: { requestId: (): string => "a" } };
    const user: Options = { onError: second, security: { requestId: true } };
    const merged = merge(baked, user);
    expect(merged.onError).toBe(second);
    expect(merged.security?.requestId).toBe(true);

    expect(merge({ base: "/app" }, { base: "/other" })).toEqual({ base: "/other" });
    // A class instance in the user's options is taken as it is (the same reference, not a copy).
    const map = new Map<string, number>([["a", 1]]);
    const withMap = merge({ renderId: "a" }, { renderId: map as unknown as string });
    expect(withMap.renderId).toBe(map);
  });

  it("[MHO-6] false and null override a baked object or value: csp: false turns a baked csp off", () => {
    const baked: Options = {
      security: { csp: { directives: { "default-src": ["'self'"] } }, nonce: true },
    };
    expect(merge(baked, { security: { csp: false } }).security).toEqual({
      csp: false,
      nonce: true,
    });
    expect(merge(baked, { security: { nonce: null as unknown as boolean } }).security).toEqual({
      csp: { directives: { "default-src": ["'self'"] } },
      nonce: null,
    });
  });

  it("[MHO-7] an explicit undefined does NOT erase a baked value (it means 'not set')", () => {
    const baked: Options = { security: { allowedHosts: ["example.com"], nonce: true } };
    const user = withUndefined({ security: { allowedHosts: undefined, nonce: undefined } });
    expect(merge(baked, user)).toEqual({
      security: { allowedHosts: ["example.com"], nonce: true },
    });
  });

  it("[MHO-8] an undefined user value for a key the baked side lacks leaves the key absent", () => {
    const merged = merge({}, withUndefined({ security: { csp: undefined } }));
    expect(merged).toEqual({ security: {} });
    expect(Object.hasOwn(merged.security ?? {}, "csp")).toBe(false);
  });

  it("[MHO-9] neither input is mutated, and merged objects are fresh", () => {
    const baked: Options = { security: { headers: { frameOptions: "DENY" } } };
    const user: Options = { security: { csp: false } };
    const bakedCopy = structuredClone(baked);
    const userCopy = structuredClone(user);
    const merged = merge(baked, user);
    expect(baked).toEqual(bakedCopy);
    expect(user).toEqual(userCopy);
    expect(merged.security).not.toBe(baked.security);
    expect(merge(baked, undefined)).toEqual(baked);
  });

  it("[MHO-10] the prototype keys (__proto__, constructor, prototype) are never merged, at any depth", () => {
    // JSON.parse makes "__proto__" an own key, which an object literal cannot.
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"security":{"__proto__":{"polluted":"deep"},"constructor":{"prototype":{"polluted":"deep2"}},"nonce":true}}',
    ) as Options;
    const merged = merge({ security: { allowedHosts: ["example.com"] } }, hostile);
    expect(merged).toEqual({ security: { allowedHosts: ["example.com"], nonce: true } });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(merged.security ?? {})).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(false);
  });

  it("[MHO-11] a bare inherited name (toString, hasOwnProperty) from the baked side is not read as a value", () => {
    const merged = merge({ security: { allowedHosts: ["a"] } }, {
      security: { toString: "x" },
    } as unknown as Options);
    expect(merged.security?.allowedHosts).toEqual(["a"]);
    expect(Object.hasOwn(merged.security ?? {}, "toString")).toBe(true);
  });

  it("[MHO-12] cors merges per key: a user origins list replaces the baked list, the baked methods stay", () => {
    const baked: Options = {
      security: { cors: { origins: ["https://a.example"], methods: ["GET"] } },
    };
    const user: Options = { security: { cors: { origins: ["https://b.example"] } } };
    expect(merge(baked, user).security?.cors).toEqual({
      origins: ["https://b.example"],
      methods: ["GET"],
    });
  });

  it("[MHO-13] middleware arrays replace (never concatenate); the baked list is dropped", () => {
    const one = (): Response => new Response("one");
    const two = (): Response => new Response("two");
    const baked: Options = { middleware: [one] };
    expect(merge(baked, { middleware: [two] }).middleware).toEqual([two]);
    expect(merge(baked, undefined).middleware).toEqual([one]);
  });

  it("[MHO-14] routing: redirects replace (not concatenated), routeRules merge per path and per rule key", () => {
    const baked: Options = {
      routing: {
        redirects: [{ source: "/old", destination: "/new" }],
        routeRules: { "/blog/*": { revalidate: 60 }, "/docs/*": { cacheControl: "public" } },
      },
    };
    const user: Options = {
      routing: {
        redirects: [{ source: "/legacy", destination: "/current", permanent: true }],
        routeRules: { "/blog/*": { cacheControl: "private" } },
      },
    };
    const routing = merge(baked, user).routing;
    expect(routing?.redirects).toEqual([
      { source: "/legacy", destination: "/current", permanent: true },
    ]);
    expect(routing?.routeRules).toEqual({
      "/blog/*": { revalidate: 60, cacheControl: "private" },
      "/docs/*": { cacheControl: "public" },
    });
  });

  it("[MHO-15] routing rewrites: a phase object merges per phase, a phase array replaces", () => {
    const baked: Options = {
      routing: {
        rewrites: { beforeFiles: [{ source: "/a", destination: "/b" }], afterFiles: [] },
      },
    };
    const user: Options = {
      routing: { rewrites: { afterFiles: [{ source: "/c", destination: "/d" }] } },
    } as unknown as Options;
    expect(merge(baked, user).routing?.rewrites).toEqual({
      beforeFiles: [{ source: "/a", destination: "/b" }],
      afterFiles: [{ source: "/c", destination: "/d" }],
    });
  });

  it("[MHO-16] a missing baked side and a missing user side both return the other side's values", () => {
    expect(merge(undefined as unknown as Options, { dev: true })).toEqual({ dev: true });
    expect(merge({ dev: false }, undefined)).toEqual({ dev: false });
  });

  it("[MHO-17] nesting is walked without recursion: a 2000-level object merges (a call stack would not)", () => {
    let baked: Record<string, unknown> = { leaf: "baked" };
    let user: Record<string, unknown> = { leaf: "user" };
    for (let depth = 0; depth < 2000; depth += 1) {
      baked = { next: baked };
      user = { next: user };
    }
    let node: Record<string, unknown> = merge(baked as Options, user as Options) as Record<
      string,
      unknown
    >;
    for (let depth = 0; depth < 2000; depth += 1) node = node["next"] as Record<string, unknown>;
    expect(node["leaf"]).toBe("user");
  });

  it("[MHO-18] a cyclic object is refused with a RangeError: the walk is bounded", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => merge({ security: {} }, { security: cyclic } as Options)).toThrow(RangeError);
  });
});
