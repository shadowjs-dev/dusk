import { describe, expect, it } from "vitest";
import { expectKeys, suggestKey } from "../../src/shared/check";
import { validateRouting } from "../../src/shared/routing-config";

const trusted = new Set(["https://partner.example"]);
const ok = (input: Parameters<typeof validateRouting>[0]) =>
  validateRouting(input, { trustedOrigins: trusted });

describe("config checks", () => {
  it("[CHK-1] an unknown key names the closest known key", () => {
    expect(() => expectKeys("dusk.config", { adaptr: 1 }, ["adapter", "security"])).toThrow(
      /unknown key "adaptr"; did you mean "adapter"\?/,
    );
    expect(suggestKey("Security", ["security", "env"])).toBe("security");
    expect(suggestKey("zzzz", ["security", "env"])).toBeUndefined();
  });

  it("[CHK-2] a key with no close match is reported without a suggestion", () => {
    expect(() => expectKeys("dusk.config", { banana: 1 }, ["adapter"])).toThrow(
      /dusk.config: unknown key "banana"$/,
    );
  });
});

describe("routing config validation", () => {
  it("[RCFG-1] a redirect defaults to 307, `permanent` gives 308, `statusCode` wins", () => {
    const routing = ok({
      redirects: [
        { source: "/a", destination: "/b" },
        { source: "/c", destination: "/d", permanent: true },
        { source: "/e", destination: "/f", permanent: true, statusCode: 301 },
      ],
    });
    expect(routing.redirects.map((rule) => rule.status)).toEqual([307, 308, 301]);
  });

  it("[RCFG-2] a redirect may only use a status of 301, 302, 303, 307 or 308", () => {
    expect(() =>
      ok({ redirects: [{ source: "/a", destination: "/b", statusCode: 200 as 301 }] }),
    ).toThrow(/statusCode/);
  });

  it("[RCFG-3] a destination with a foreign origin is refused unless its origin is in trustedOrigins", () => {
    expect(() =>
      ok({ redirects: [{ source: "/a", destination: "https://evil.example/x" }] }),
    ).toThrow(/trustedOrigins/);
    const routing = ok({
      redirects: [{ source: "/a", destination: "https://partner.example/x" }],
    });
    expect(routing.redirects[0]?.destination.kind).toBe("absolute");
  });

  it("[RCFG-4] protocol-relative, backslash, javascript: and control-character destinations are refused", () => {
    for (const destination of [
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/a\nb",
      "mailto:x@y.z",
    ]) {
      expect(() => ok({ redirects: [{ source: "/a", destination }] }), destination).toThrow(
        TypeError,
      );
    }
  });

  it("[RCFG-5] a destination may only use parameters the source captures", () => {
    expect(() => ok({ redirects: [{ source: "/posts/:id", destination: "/p/:slug" }] })).toThrow(
      /:slug/,
    );
    const routing = ok({ redirects: [{ source: "/posts/:id", destination: "/p/:id" }] });
    expect(routing.redirects[0]?.destination.template).toBe("/p/:id");
  });

  it("[RCFG-6] a rewrite destination is internal: a path that does not start with /_dusk/ and is not a foreign URL", () => {
    expect(() =>
      ok({ rewrites: [{ source: "/a", destination: "https://partner.example/x" }] }),
    ).toThrow(TypeError);
    expect(() => ok({ rewrites: [{ source: "/a", destination: "/_dusk/fn/x" }] })).toThrow(/_dusk/);
    const routing = ok({
      rewrites: {
        beforeFiles: [{ source: "/old/:p", destination: "/new/:p" }],
        fallback: [{ source: "/**", destination: "/404" }],
      },
    });
    expect(routing.rewrites.beforeFiles).toHaveLength(1);
    expect(routing.rewrites.afterFiles).toEqual([]);
    expect(routing.rewrites.fallback).toHaveLength(1);
  });

  it("[RCFG-7] an array of rewrites is the afterFiles phase", () => {
    const routing = ok({ rewrites: [{ source: "/a", destination: "/b" }] });
    expect(routing.rewrites.afterFiles).toHaveLength(1);
    expect(routing.rewrites.beforeFiles).toEqual([]);
  });

  it("[RCFG-8] `has` and `missing` conditions are checked: a known type, a key where one is needed, a string value", () => {
    expect(() =>
      ok({
        redirects: [{ source: "/a", destination: "/b", has: [{ type: "agent" as "header" }] }],
      }),
    ).toThrow(/type/);
    expect(() =>
      ok({ redirects: [{ source: "/a", destination: "/b", has: [{ type: "header" }] }] }),
    ).toThrow(/key/);
    expect(() =>
      ok({
        redirects: [
          {
            source: "/a",
            destination: "/b",
            missing: [{ type: "host", value: 1 as unknown as string }],
          },
        ],
      }),
    ).toThrow(/value/);
    const routing = ok({
      redirects: [
        {
          source: "/a",
          destination: "/b",
          has: [{ type: "header", key: "X-Beta", value: "1" }],
          missing: [{ type: "cookie", key: "sid" }],
        },
      ],
    });
    expect(routing.redirects[0]?.has[0]).toEqual({ type: "header", key: "x-beta", value: "1" });
    expect(routing.redirects[0]?.missing[0]).toEqual({
      type: "cookie",
      key: "sid",
      value: undefined,
    });
  });

  it("[RCFG-9] header rules: names are tokens, values have no line breaks, and cookie headers are refused", () => {
    expect(() => ok({ headers: [{ source: "/**", headers: { "bad name": "x" } }] })).toThrow(
      /header name/,
    );
    expect(() => ok({ headers: [{ source: "/**", headers: { "x-a": "a\r\nb: c" } }] })).toThrow(
      /line break/,
    );
    expect(() => ok({ headers: [{ source: "/**", headers: { "set-cookie": "a=b" } }] })).toThrow(
      /set-cookie/,
    );
    const routing = ok({
      headers: [{ source: "/assets/**", headers: { "X-Frame-Options": "DENY" } }],
    });
    expect(routing.headers[0]?.headers).toEqual([["x-frame-options", "DENY"]]);
  });

  it("[RCFG-10] route rules: cache, revalidate, headers, redirect, ssr and csr are read; an unknown field is refused with a suggestion", () => {
    const routing = ok({
      routeRules: {
        "/blog/**": {
          revalidate: 60,
          cache: { staleSeconds: 30, cookies: ["theme"] },
          headers: { "x-a": "1" },
          csr: false,
        },
        "/old": { redirect: { to: "/new", statusCode: 301 } },
        "/static": { ssr: false, prerender: true },
      },
    });
    expect(routing.routeRules).toHaveLength(3);
    expect(() => ok({ routeRules: { "/x": { revalidat: 60 } as never } })).toThrow(
      /did you mean "revalidate"/,
    );
  });

  it("[RCFG-11] route rules: revalidate is false or a positive number of seconds; ssr accepts only false", () => {
    expect(() => ok({ routeRules: { "/x": { revalidate: 0 } } })).toThrow(/revalidate/);
    expect(() => ok({ routeRules: { "/x": { revalidate: Number.NaN } } })).toThrow(/revalidate/);
    expect(() => ok({ routeRules: { "/x": { ssr: "data-only" as never } } })).toThrow(/ssr/);
    expect(ok({ routeRules: { "/x": { revalidate: false } } }).routeRules[0]?.rule.revalidate).toBe(
      false,
    );
  });

  it("[RCFG-12] prerender: true needs a literal path (no wildcards or parameters)", () => {
    expect(() => ok({ routeRules: { "/blog/**": { prerender: true } } })).toThrow(/literal/);
    expect(() => ok({ routeRules: { "/blog/:slug": { prerender: true } } })).toThrow(/literal/);
    expect(ok({ routeRules: { "/about": { prerender: true } } }).routeRules).toHaveLength(1);
  });

  it("[RCFG-13] a malformed pattern names the rule it is in", () => {
    expect(() => ok({ redirects: [{ source: "a/b", destination: "/x" }] })).toThrow(
      /redirects\[0\].*must start with/,
    );
  });
});
