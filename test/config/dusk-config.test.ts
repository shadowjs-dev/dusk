import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bakeServerConfig,
  type DuskConfig,
  defineConfig,
  devAllowedHostsOf,
  loadDuskConfigFile,
  mergeBuildOptions,
  validateDuskConfig,
} from "../../src/vite/config-file";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dusk-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dusk.config.ts", () => {
  it("[DCFG-1] defineConfig returns its argument unchanged (typing only)", () => {
    const config = { redirects: [{ source: "/a", destination: "/b" }] } satisfies DuskConfig;
    expect(defineConfig(config)).toBe(config);
  });

  it("[DCFG-2] an unknown top-level key is refused with a suggestion", () => {
    expect(() => validateDuskConfig({ secuirty: {} })).toThrow(/did you mean "security"\?/);
    expect(() => validateDuskConfig({ security: { allowedHost: [] } })).toThrow(
      /did you mean "allowedHosts"\?/,
    );
  });

  it("[DCFG-3] plugin options (srcDir, outDir, ...) are refused in the file, with the place to set them", () => {
    expect(() => validateDuskConfig({ srcDir: "app" })).toThrow(
      /dusk\(\{ srcDir \}\) in vite\.config/,
    );
  });

  it("[DCFG-4] routing errors name the rule, from the same validator the server uses", () => {
    expect(() =>
      validateDuskConfig({ redirects: [{ source: "/a", destination: "//evil.example" }] }),
    ).toThrow(/redirects\[0\]\.destination/);
  });

  it("[DCFG-5] env is declared as plain data; a RegExp pattern is refused (it cannot be baked)", () => {
    expect(() =>
      validateDuskConfig({ env: { API_URL: { type: "url", required: true, secret: true } } }),
    ).not.toThrow();
    expect(() => validateDuskConfig({ env: { NAME: { type: "string", pattern: /x/ } } })).toThrow(
      /pattern.*not supported/,
    );
    expect(() => validateDuskConfig({ env: { NAME: { type: "color" } } })).toThrow(/type/);
  });

  it("[DCFG-6] the server part of the config is plain JSON, and build-only keys are left out", () => {
    const config = validateDuskConfig({
      adapter: undefined,
      prerender: { routes: ["/a"] },
      security: { allowedHosts: ["example.com"], trustedOrigins: ["https://partner.example"] },
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      deploymentId: "rel-42",
    });
    const baked = bakeServerConfig(config);
    expect(JSON.parse(JSON.stringify(baked))).toEqual(baked);
    expect(baked).not.toHaveProperty("prerender");
    expect(baked).not.toHaveProperty("adapter");
    expect(baked.deploymentId).toBe("rel-42");
    expect(baked.security?.allowedHosts).toEqual(["example.com"]);
    expect(baked.routing?.redirects?.[0]).toMatchObject({
      source: "/old",
      destination: "/new",
      permanent: true,
    });
  });

  it("[DCFG-21] the baked env declarations are validated when the server starts (a missing required variable is an error)", async () => {
    const { serverOptionsFromConfig } = await import("../../src/server/baked-config");
    const options = serverOptionsFromConfig({
      env: { DATABASE_URL: { type: "url", required: true, secret: true } },
      skew: { reload: true },
      instrumentation: true,
    });
    expect(options.env?.parse({ DATABASE_URL: "https://db.example" }).all).toMatchObject({
      DATABASE_URL: "https://db.example/",
    });
    expect(() => options.env?.parse({})).toThrow(/DATABASE_URL/);
  });

  it("[DCFG-23] secrets are never written in the config file: cookieSecrets is refused, and the message says where they go", () => {
    expect(() =>
      validateDuskConfig({ security: { cookieSecrets: ["0123456789abcdef0123456789abcdef"] } }),
    ).toThrow(/cookieSecrets.*secret.*server environment/);
  });

  it("[DCFG-7] a function anywhere in the server part is refused, with its path", () => {
    expect(() =>
      bakeServerConfig(
        validateDuskConfig({ security: { csp: { directives: { "img-src": () => "x" } } } }),
      ),
    ).toThrow(/security\.csp\.directives\["img-src"\].*plain data/);
  });

  it("[DCFG-8] precedence: a dusk({}) option overrides the file's key; the file fills the rest", () => {
    const file = validateDuskConfig({
      deploymentId: "from-file",
      prerender: { routes: ["/file"] },
    });
    const fromPlugin = mergeBuildOptions(
      { buildId: "from-plugin", prerender: false, adapter: undefined },
      file,
    );
    expect(fromPlugin.buildId).toBe("from-plugin");
    expect(fromPlugin.prerender).toBe(false);
    const fromFile = mergeBuildOptions(
      { buildId: undefined, prerender: undefined, adapter: undefined },
      file,
    );
    expect(fromFile.buildId).toBe("from-file");
    expect(fromFile.prerender).toEqual({ routes: ["/file"] });
  });

  it("[DCFG-9] custom cacheLife profiles must be ordered (revalidate >= 1, expire >= revalidate) and named", () => {
    expect(() =>
      validateDuskConfig({ cacheLife: { quick: { stale: 0, revalidate: 0, expire: 10 } } }),
    ).toThrow(/revalidate/);
    expect(() =>
      validateDuskConfig({ cacheLife: { quick: { stale: 0, revalidate: 20, expire: 10 } } }),
    ).toThrow(/expire/);
    expect(() =>
      validateDuskConfig({ cacheLife: { Quick: { stale: 0, revalidate: 1, expire: 10 } } }),
    ).toThrow(/name/);
    expect(() =>
      validateDuskConfig({ cacheLife: { quick: { stale: 0, revalidate: 5, expire: 10 } } }),
    ).not.toThrow();
  });

  it("[DCFG-10] deploymentId, draftMode and skew have checked shapes; instrumentation is on by default and only `false` turns it off", () => {
    expect(() => validateDuskConfig({ deploymentId: "has space" })).toThrow(/deploymentId/);
    expect(() => validateDuskConfig({ draftMode: { secretEnv: "bad name" } })).toThrow(/secretEnv/);
    expect(() => validateDuskConfig({ skew: { reload: "yes" } })).toThrow(/reload/);
    expect(() => validateDuskConfig({ instrumentation: true })).toThrow(/instrumentation/);
    expect(bakeServerConfig(validateDuskConfig({ instrumentation: false })).instrumentation).toBe(
      false,
    );
    expect(bakeServerConfig(validateDuskConfig({})).instrumentation).toBe(true);
  });

  it("[DCFG-11] i18n: the default locale must be one of the locales", () => {
    expect(() =>
      validateDuskConfig({ i18n: { locales: ["en", "fr"], defaultLocale: "de" } }),
    ).toThrow(/defaultLocale/);
    expect(() =>
      validateDuskConfig({ i18n: { locales: ["en", "fr"], defaultLocale: "fr" } }),
    ).not.toThrow();
  });

  it("[DCFG-12] image: domains are hosts (not patterns or URLs); sizes give the largest width", () => {
    expect(() => validateDuskConfig({ image: { domains: ["*.cdn.example"] } })).toThrow(/domains/);
    expect(() => validateDuskConfig({ image: { domains: ["https://cdn.example"] } })).toThrow(
      /domains/,
    );
    const baked = bakeServerConfig(
      validateDuskConfig({ image: { domains: ["cdn.example"], sizes: [320, 1080] } }),
    );
    expect(baked.images).toEqual({
      remotePatterns: ["https://cdn.example"],
      widths: { deviceSizes: [320, 1080] },
    });
  });

  it("[DCFG-14] image.widths: the lists the optimizer serves are validated at build (named keys), and sizes is the device list", () => {
    const baked = bakeServerConfig(
      validateDuskConfig({ image: { widths: { deviceSizes: [500], imageSizes: [50] } } }),
    );
    expect(baked.images).toEqual({ widths: { deviceSizes: [500], imageSizes: [50] } });
    expect(() => validateDuskConfig({ image: { widths: { deviceSizes: [] } } })).toThrow(
      /image\.widths\.deviceSizes/,
    );
    expect(() => validateDuskConfig({ image: { widths: { deviceSizes: [0] } } })).toThrow(
      /image\.widths\.deviceSizes/,
    );
    expect(() => validateDuskConfig({ image: { widths: { imageSize: [64] } } })).toThrow(
      /image\.widths/,
    );
    expect(() =>
      validateDuskConfig({ image: { sizes: [640], widths: { deviceSizes: [640] } } }),
    ).toThrow(/one setting/);
  });

  it("[DCFG-13] loadDuskConfigFile finds dusk.config.ts, returns undefined when there is none, and refuses two files", async () => {
    expect(await loadDuskConfigFile(dir, "production", "build")).toBeUndefined();
    writeFileSync(
      join(dir, "dusk.config.ts"),
      'export default { deploymentId: "rel-7", redirects: [{ source: "/a", destination: "/b" }] };\n',
    );
    const loaded = await loadDuskConfigFile(dir, "production", "build");
    expect(loaded?.config.deploymentId).toBe("rel-7");
    expect(loaded?.path).toBe(join(dir, "dusk.config.ts"));
    writeFileSync(join(dir, "dusk.config.js"), "export default {};\n");
    await expect(loadDuskConfigFile(dir, "production", "build")).rejects.toThrow(/more than one/);
  });

  it("[DCFG-14] a file whose default export is not an object is an error naming the file", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "dusk.config.mjs"), "export default 42;\n");
    await expect(loadDuskConfigFile(dir, "production", "build")).rejects.toThrow(
      /dusk\.config\.mjs.*object/,
    );
  });
});

describe("dusk.config.ts: dev.allowedHosts", () => {
  it("[DCFG-23] dev takes allowedHosts as a list of host names or true; another key or shape is refused", () => {
    expect(() => validateDuskConfig({ dev: { allowedHosts: ["join.example.com"] } })).not.toThrow();
    expect(() => validateDuskConfig({ dev: { allowedHosts: true } })).not.toThrow();
    expect(() => validateDuskConfig({ dev: {} })).not.toThrow();
    expect(() => validateDuskConfig({ dev: { allowedHost: [] } })).toThrow(
      /did you mean "allowedHosts"\?/,
    );
    expect(() => validateDuskConfig({ dev: { allowedHosts: false } })).toThrow(
      /dev\.allowedHosts must be an array of host names, or true/,
    );
    expect(() => validateDuskConfig({ dev: { allowedHosts: ["a b"] } })).toThrow(
      /dev\.allowedHosts\[0\]/,
    );
    expect(() => validateDuskConfig({ dev: { allowedHosts: [""] } })).toThrow(
      /dev\.allowedHosts\[0\]/,
    );
    expect(() => validateDuskConfig({ dev: "localhost" })).toThrow(/dev must be an object/);
  });

  it("[DCFG-23] devAllowedHostsOf: nothing configured means nothing to add", () => {
    expect(devAllowedHostsOf(undefined)).toBeUndefined();
    expect(devAllowedHostsOf({})).toBeUndefined();
    expect(devAllowedHostsOf({ security: { allowedHosts: [] } })).toBeUndefined();
  });

  it("[DCFG-23] devAllowedHostsOf: the listed hosts, and true for every host", () => {
    expect(devAllowedHostsOf({ dev: { allowedHosts: ["join.notah.me"] } })).toEqual([
      "join.notah.me",
    ]);
    expect(devAllowedHostsOf({ dev: { allowedHosts: true } })).toBe(true);
    expect(
      devAllowedHostsOf({ dev: { allowedHosts: true }, security: { allowedHosts: ["a.test"] } }),
    ).toBe(true);
  });

  it("[DCFG-24] devAllowedHostsOf: the hosts the app declares for host routing are allowed in dev too, in Vite's spelling", () => {
    const hosts = devAllowedHostsOf({
      security: {
        allowedHosts: ["notah.me", "join.notah.me:8443", "*.preview.notah.me", "NOTAH.me"],
      },
    });
    // A port is dropped (Vite matches the host name only); `*.x` is `.x` (Vite's subdomain form); case folds; no duplicates.
    expect(hosts).toEqual(["notah.me", "join.notah.me", ".preview.notah.me"]);
  });

  it("[DCFG-24] devAllowedHostsOf: dev.allowedHosts and the declared hosts add up without duplicates", () => {
    expect(
      devAllowedHostsOf({
        dev: { allowedHosts: ["tunnel.example", "join.notah.me"] },
        security: { allowedHosts: ["join.notah.me", "notah.me"] },
      }),
    ).toEqual(["tunnel.example", "join.notah.me", "notah.me"]);
  });

  it("[DCFG-25] dev is not part of the server bundle", () => {
    const config = validateDuskConfig({ dev: { allowedHosts: ["join.notah.me"] } });
    expect(JSON.stringify(bakeServerConfig(config))).not.toContain("join.notah.me");
  });
});

describe("dusk.config.ts: prerender.skipMissing", () => {
  it("[DCFG-27] prerender takes skipMissing as a boolean; another type is refused, a typo gets a suggestion", () => {
    expect(() => validateDuskConfig({ prerender: { skipMissing: true } })).not.toThrow();
    expect(() => validateDuskConfig({ prerender: { skipMissing: "yes" } })).toThrow(
      /prerender\.skipMissing must be true or false/,
    );
    expect(() => validateDuskConfig({ prerender: { skipMising: true } })).toThrow(
      /did you mean "skipMissing"\?/,
    );
  });
});
