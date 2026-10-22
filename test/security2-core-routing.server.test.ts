import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { routing as routingFeature } from "../src/features/routing";
import {
  apiHandler,
  apiRoute,
  createHandler,
  HttpError,
  json,
  type RoutingConfig,
} from "../src/server/index";
import { soundPath } from "../src/server/routing";
import { compilePattern, fillPattern, matchPattern } from "../src/shared/path-pattern";
import { get, handmade, post } from "./support/sec2-core";

/**
 * PASS 2, scope D (server core): the paths the router serves and the paths the declarative rules, rewrites and
 * redirects see must be the same set. Tests SEC2-CORE-01 .. 11.
 *
 * Before the fixes: a splat rewrite (`/docs/*rest` to `/content/*rest`) let `..%2F_secret%2Fdata` climb out of its folder
 * into a private route (01), a destination that began with the splat let `%2Fevil.com` change the origin of the request
 * and with it the CSRF verdict (02), and every rule was case-sensitive while the router is not (04, 05).
 */

const PRIVATE = apiRoute({ GET: () => json({ private: true }) });
const CONTENT = apiRoute({ GET: (event) => json({ content: true, path: event.url.pathname }) });
const ORIGIN_ECHO = apiRoute({
  GET: (event) => json({ origin: event.url.origin }),
  POST: (event) => json({ origin: event.url.origin }),
});

function boot(routing: RoutingConfig, caseSensitive = false) {
  return createHandler({
    features: [apiRoutes(), routingFeature()],
    manifest: {
      ...handmade([
        { id: "secret", path: "/_secret/data", module: PRIVATE },
        { id: "content", path: "/content/:x", module: CONTENT },
        { id: "x", path: "/x", module: ORIGIN_ECHO },
        { id: "account", path: "/account/data", module: CONTENT },
      ]),
      ...(caseSensitive ? { caseSensitive: true } : {}),
    },
    dev: true,
    routing,
    onWarning: () => undefined,
  });
}

describe("SEC2-CORE routing: rewrites and redirects cannot leave their prefix", () => {
  const rewrites: RoutingConfig = {
    rewrites: {
      beforeFiles: [
        { source: "/docs/*rest", destination: "/content/*rest" },
        { source: "/go/*rest", destination: "/*rest" },
      ],
    },
  };

  it("[SEC2-CORE-01] an encoded slash in a splat cannot climb out of the destination folder into a private route", async () => {
    const handler = boot(rewrites);
    expect((await handler.fetch(get("/_secret/data"))).status).toBe(404);
    for (const path of [
      "/docs/..%2F_secret%2Fdata",
      "/docs/..%2f_secret%2fdata",
      "/docs/a%2F..%2F..%2F_secret%2Fdata",
      "/docs/%2E%2E%2F_secret%2Fdata",
    ]) {
      const response = await handler.fetch(get(path));
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain("private");
    }
    // The ordinary use keeps working.
    const ok = await handler.fetch(get("/docs/a"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ content: true, path: "/content/a" });
  });

  it("[SEC2-CORE-02] a splat that starts with an encoded slash cannot name another host (the origin, and with it CSRF, stays put)", async () => {
    const handler = boot(rewrites);
    const response = await handler.fetch(get("/go/%2Fevil.com%2Fx"));
    expect(response.status).toBe(404);
    // A cross-site POST that claims the foreign origin is refused, not accepted as same-origin.
    const forged = await handler.fetch(
      post("/go/%2Fevil.com%2Fx", "{}", {
        "content-type": "application/json",
        origin: "http://evil.com",
      }),
    );
    // The CSRF check judges the origin the request really has (403); before the fix it was the attacker's own.
    expect([403, 404]).toContain(forged.status);
    const normal = await handler.fetch(get("/go/x"));
    expect(await normal.json()).toEqual({ origin: "http://localhost" });
  });

  it("[SEC2-CORE-03] a redirect built from a splat never sends a path with a dot, empty or climbing segment", async () => {
    const handler = boot({ redirects: [{ source: "/old/*rest", destination: "/new/*rest" }] });
    for (const path of ["/old/..%2Fadmin", "/old/%2Fevil.com", "/old/a%2F%2Fb", "/old/a%2F.%2Fb"]) {
      const response = await handler.fetch(get(path));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
    const ok = await handler.fetch(get("/old/a/b?x=1"));
    expect(ok.status).toBe(307);
    expect(ok.headers.get("location")).toBe("/new/a/b?x=1");
  });

  it("[SEC2-CORE-11] the matcher never captures a climbing rest, and a filled destination that climbs is refused (defense in depth)", () => {
    const pattern = compilePattern("/docs/*rest");
    for (const bad of ["..%2Fx", "a%2F..", "%2F", "a%2F%2Fb", ".%2Fx"]) {
      expect(matchPattern(pattern, `/docs/${bad}`), bad).toBeUndefined();
    }
    expect(matchPattern(pattern, "/docs/a.b/c..d")).toEqual({ rest: "a.b/c..d" });
    for (const climbing of [
      "/content/../x",
      "//evil.example/x",
      "/content/./x",
      "/content//x",
      "/a/..",
    ]) {
      expect(() => soundPath(climbing), climbing).toThrow(TypeError);
    }
    expect(soundPath(fillPattern("/content/*rest", { rest: "a/b" }))).toBe("/content/a/b");
    expect(soundPath("/")).toBe("/");
  });
});

describe("SEC2-CORE routing: a rule applies to every spelling the router serves", () => {
  const rules: RoutingConfig = {
    headers: [{ source: "/account/**", headers: { "x-rule": "yes" } }],
    redirects: [{ source: "/account/old", destination: "/login" }],
    routeRules: { "/account/**": { cacheControl: "private, no-store" } },
  };

  it("[SEC2-CORE-04] ASCII case does not dodge a redirect, a header rule or a route rule (the router ignores case)", async () => {
    const handler = boot(rules);
    for (const path of ["/account/data", "/ACCOUNT/data", "/Account/DATA", "/account/Data"]) {
      const response = await handler.fetch(get(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("x-rule"), path).toBe("yes");
      expect(response.headers.get("cache-control"), path).toBe("private, no-store");
    }
    for (const path of ["/account/old", "/ACCOUNT/OLD", "/%41ccount/old"]) {
      const response = await handler.fetch(get(path));
      expect(response.status, path).toBe(307);
      expect(response.headers.get("location"), path).toBe("/login");
    }
  });

  it("[SEC2-CORE-05] with router.caseSensitive the rules stay case-sensitive, as the router is (no change for those apps)", async () => {
    const handler = boot(
      {
        headers: [{ source: "/account/**", headers: { "x-rule": "yes" } }],
      },
      true,
    );
    const exact = await handler.fetch(get("/account/data"));
    expect(exact.headers.get("x-rule")).toBe("yes");
    const upper = await handler.fetch(get("/ACCOUNT/data"));
    // The router does not serve /ACCOUNT here either, so nothing is left uncovered.
    expect(upper.status).toBe(404);
  });

  it("[SEC2-CORE-06] captured values keep their case while the literal parts fold", () => {
    const pattern = compilePattern("/Posts/:id");
    expect(matchPattern(pattern, "/posts/AbC", true)).toEqual({ id: "AbC" });
    expect(matchPattern(pattern, "/posts/AbC", false)).toBeUndefined();
    const glob = compilePattern("/img-*.PNG");
    expect(matchPattern(glob, "/IMG-a.png", true)).toEqual({});
    expect(matchPattern(glob, "/IMG-a.png", false)).toBeUndefined();
  });

  it("[SEC2-CORE-07] every spelling the router serves for a protected path gets the rule (percent, case, trailing slash); the others 404", async () => {
    const handler = boot({ headers: [{ source: "/account/**", headers: { "x-rule": "yes" } }] });
    const spellings = [
      "/account/data",
      "/%61ccount/data",
      "/account/%64ata",
      "/ACCOUNT/DATA",
      "/account/data/",
      "//account/data",
      "/account//data",
      "/./account/data",
      "/account/./data",
      "/x/../account/data",
      "/account/data;a=1",
      "/account/data.",
      "/account%2Fdata",
      "/account%252Fdata",
      "/account/data%00",
      "/account\\data",
    ];
    for (const path of spellings) {
      const response = await handler.fetch(get(path));
      if (response.status === 200) {
        // Served: the rule must have been applied to it.
        expect(response.headers.get("x-rule"), path).toBe("yes");
      } else {
        expect([301, 308, 400, 404], path).toContain(response.status);
      }
    }
    // The canonicalized spellings are served (so the assertion above is not vacuous).
    for (const path of [
      "/%61ccount/data",
      "/ACCOUNT/DATA",
      "/./account/data",
      "/x/../account/data",
      "/account\\data",
    ]) {
      expect((await handler.fetch(get(path))).status, path).toBe(200);
    }
  });

  it("[SEC2-CORE-08] property: for any case and percent spelling of the path, served means covered (seed 20261010)", async () => {
    const handler = boot({ headers: [{ source: "/account/**", headers: { "x-rule": "yes" } }] });
    const spell = fc
      .tuple(
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
      )
      .map(([upper, encode]) => {
        const chars = [..."/account/data"];
        return chars
          .map((char, index) => {
            if (char === "/") return char;
            const cased = upper[index] === true ? char.toUpperCase() : char;
            return encode[index] === true ? `%${cased.charCodeAt(0).toString(16)}` : cased;
          })
          .join("");
      });
    await fc.assert(
      fc.asyncProperty(spell, async (path) => {
        const response = await handler.fetch(get(path));
        return response.status !== 200 || response.headers.get("x-rule") === "yes";
      }),
      { seed: 20261010, numRuns: 200 },
    );
  });

  it("[SEC2-CORE-09] the trailing-slash redirect never produces a protocol-relative or foreign Location, whatever the path", async () => {
    const handler = createHandler({
      features: [apiRoutes(), routingFeature()],
      manifest: handmade([{ id: "a", path: "/api/x", module: CONTENT }]),
      dev: true,
      trailingSlash: "never",
      onWarning: () => undefined,
    });
    for (const path of [
      "/api/x/",
      "//api/x/",
      "/api/x//",
      "/\\evil.com/",
      "/%2Fevil.com/",
      "/api/x/%2F",
      "///",
    ]) {
      const response = await handler.fetch(get(path));
      const location = response.headers.get("location");
      if (location !== null) {
        expect(location.startsWith("//"), path).toBe(false);
        expect(new URL(location, "http://localhost").origin, path).toBe("http://localhost");
      }
    }
  });
});

describe("SEC2-CORE routing: auth that belongs to the route follows the route", () => {
  it("[SEC2-CORE-94] a guard and a middleware on a route run for every spelling the router serves; a path check in app-wide middleware does not (see the guide)", async () => {
    const denied = (): never => {
      throw new HttpError(401, "sign in");
    };
    const handler = createHandler({
      features: [apiRoutes(), routingFeature()],
      manifest: handmade([
        {
          id: "guarded",
          path: "/admin/data",
          module: apiRoute({ GET: apiHandler({ guard: denied }, () => ({ ok: true })) }),
        },
        {
          id: "mw",
          path: "/admin/other",
          module: apiRoute({
            middleware: [(_event, _next) => denied()],
            GET: () => json({ ok: true }),
          }),
        },
      ]),
      dev: true,
      onWarning: () => undefined,
    });
    for (const path of [
      "/admin/data",
      "/ADMIN/data",
      "/%61dmin/%64ata",
      "/Admin/Data",
      "/./admin/data",
      "/x/../admin/data",
      "/admin/other",
      "/ADMIN/OTHER",
      "/%41dmin/other",
    ]) {
      expect((await handler.fetch(get(path))).status, path).toBe(401);
    }
  });
});

describe("SEC2-CORE routing: the matchers are linear (the rules are path patterns, not regular expressions)", () => {
  it("[SEC2-CORE-10] a rule table of 200 rules with multi-wildcard globs answers a 8000-character hostile path at once", async () => {
    const rules = Array.from({ length: 200 }, (_, index) => ({
      source: `/a*a*a*a*a*a*${index}b`,
      destination: "/x",
    }));
    const handler = boot({ rewrites: { beforeFiles: rules } });
    const hostile = `/${"a".repeat(8000)}`;
    const started = performance.now();
    const response = await handler.fetch(get(hostile));
    expect(response.status).toBe(404);
    // 200 globs x 8000 characters is 1.6M steps for a linear matcher; an exponential one would not finish.
    expect(performance.now() - started).toBeLessThan(2000);
    // Many segments: the matcher splits once per rule, linear in the path.
    const deep = `/${"a/".repeat(2000)}b`;
    const started2 = performance.now();
    await handler.fetch(get(deep));
    expect(performance.now() - started2).toBeLessThan(2000);
  });
});
