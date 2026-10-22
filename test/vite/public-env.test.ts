import { describe, expect, it } from "vitest";
import { bakeServerConfig, publicEnvOf, validateDuskConfig } from "../../src/vite/config-file";
import {
  clientProcessEnvDefines,
  findSecretLeaks,
  publicEnvValues,
  secretLikePublicNames,
} from "../../src/vite/env";

const values: Record<string, string> = {
  NEXT_PUBLIC_SITE: "https://site.example",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_publishable_value",
  DUSK_PUBLIC_LEGACY: "legacy",
  DATABASE_URL: "postgres://user:hunter2hunter2@db.internal/app",
  CLERK_SECRET_KEY: "sk_test_secret_value_0123456789",
};
const prefixes = ["DUSK_PUBLIC_", "NEXT_PUBLIC_"];

describe("public environment contract (env.public)", () => {
  it("[PENV-01] env.public is accepted, read as the public contract, and is not a variable declaration", () => {
    const config = validateDuskConfig({
      env: {
        public: { prefixes: ["NEXT_PUBLIC_"], processEnv: true },
        DATABASE_URL: { type: "url" },
      },
    });
    expect(publicEnvOf(config)).toEqual({
      prefixes: ["NEXT_PUBLIC_"],
      processEnv: true,
      allow: [],
    });
    expect(publicEnvOf(undefined)).toEqual({ prefixes: [], processEnv: false, allow: [] });
    expect(publicEnvOf(validateDuskConfig({}))).toEqual({
      prefixes: [],
      processEnv: false,
      allow: [],
    });
  });

  it("[PENV-02] an unsafe prefix, an unknown key or a non-boolean processEnv is refused", () => {
    expect(() => validateDuskConfig({ env: { public: { prefixes: ["*"] } } })).toThrow(
      /would expose server variables/,
    );
    expect(() => validateDuskConfig({ env: { public: { prefixes: ["AB"] } } })).toThrow(
      /at least three characters/,
    );
    expect(() => validateDuskConfig({ env: { public: { prefixes: "NEXT_" } } })).toThrow(
      /must be an array/,
    );
    expect(() => validateDuskConfig({ env: { public: { secret: true } } })).toThrow();
    expect(() => validateDuskConfig({ env: { public: { processEnv: "yes" } } })).toThrow(
      /true or false/,
    );
  });

  it("[PENV-03] the server bundle keeps the declarations and drops the public contract", () => {
    const config = validateDuskConfig({
      env: {
        public: { prefixes: ["NEXT_PUBLIC_"], processEnv: true },
        DATABASE_URL: { type: "url" },
      },
    });
    const baked = bakeServerConfig(config);
    expect(Object.keys(baked.env ?? {})).toEqual(["DATABASE_URL"]);
  });

  it("[PENV-04] the client defines are the public variables only, as literals and as one object", () => {
    const defines = clientProcessEnvDefines(values, prefixes);
    expect(defines["process.env.NEXT_PUBLIC_SITE"]).toBe('"https://site.example"');
    expect(defines["process.env.DUSK_PUBLIC_LEGACY"]).toBe('"legacy"');
    expect(Object.keys(defines).some((key) => key.includes("DATABASE_URL"))).toBe(false);
    expect(Object.keys(defines).some((key) => key.includes("CLERK_SECRET_KEY"))).toBe(false);
    const object = JSON.parse(defines["process.env"] ?? "null") as Record<string, string>;
    expect(Object.keys(object).sort()).toEqual([
      "DUSK_PUBLIC_LEGACY",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SITE",
    ]);
    expect(JSON.stringify(defines)).not.toContain("hunter2");
    expect(JSON.stringify(defines)).not.toContain("sk_test_secret");
  });

  it("[PENV-05] publicEnvValues never returns a name without a public prefix", () => {
    expect(
      Object.keys(publicEnvValues(values, prefixes)).every((name) =>
        prefixes.some((p) => name.startsWith(p)),
      ),
    ).toBe(true);
    expect(publicEnvValues({ EMPTY: undefined, X_PUBLIC_A: "1" }, ["DUSK_PUBLIC_"])).toEqual({});
  });

  it("[PENV-06] [G-A9] a public name that reads like a credential is listed, a publishable key included; a server name is not", () => {
    // A publishable key has a credential-like name too: the build refuses it unless env.public.allow lists it.
    expect(
      secretLikePublicNames(
        [
          "NEXT_PUBLIC_API_SECRET",
          "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
          "DATABASE_URL",
          "NEXT_PUBLIC_PASSWORD_RESET_URL",
          "NEXT_PUBLIC_SITE_URL",
        ],
        prefixes,
      ),
    ).toEqual([
      "NEXT_PUBLIC_API_SECRET",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_PASSWORD_RESET_URL",
    ]);
  });

  it("[PENV-07] a server secret whose value is in a client chunk is found; public values and short values are not", () => {
    const chunk = `const db = "postgres://user:hunter2hunter2@db.internal/app"; const k = "sk_test_secret_value_0123456789";`;
    expect(findSecretLeaks(chunk, values, prefixes)).toEqual(["CLERK_SECRET_KEY", "DATABASE_URL"]);
    expect(findSecretLeaks('const s = "https://site.example";', values, prefixes)).toEqual([]);
    expect(findSecretLeaks('const x = "legacy";', { DB_PASSWORD: "legacy" }, prefixes)).toEqual([]);
  });

  it("[PENV-08b] Vercel's framework-prefixed copies of its system variables are public by contract, not leaks", () => {
    // With "Automatically expose System Environment Variables" on (the default), Vercel copies each VERCEL_* variable
    // under the public prefix of every framework it supports; Vite then puts the VITE_ copy into import.meta.env. A build
    // on Vercel must not fail on them, and a real secret that happens to share the value must still be found.
    const config = '{"version":1,"endpoint":"https://insights.example/v1/abcdef123456"}';
    const copies = Object.fromEntries(
      ["NEXT_PUBLIC_", "PUBLIC_", "VITE_", "REACT_APP_", "GATSBY_", "NUXT_PUBLIC_", "VUE_APP_"].map(
        (prefix) => [`${prefix}VERCEL_OBSERVABILITY_CLIENT_CONFIG`, config],
      ),
    );
    const chunk = `const env = {VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG:${JSON.stringify(config)}};`;
    expect(findSecretLeaks(chunk, copies, ["DUSK_PUBLIC_"])).toEqual([]);
    // The unprefixed variable and any other name are judged as before.
    expect(
      findSecretLeaks(chunk, { ...copies, CLERK_SECRET_KEY: config }, ["DUSK_PUBLIC_"]),
    ).toEqual(["CLERK_SECRET_KEY"]);
    // A prefixed Vercel name that looks like a secret is still scanned.
    expect(findSecretLeaks(chunk, { VITE_VERCEL_API_TOKEN: config }, ["DUSK_PUBLIC_"])).toEqual([
      "VITE_VERCEL_API_TOKEN",
    ]);
  });

  it("[PENV-08] a non-secret-looking server value is not scanned (no false alarm on plain config)", () => {
    expect(
      findSecretLeaks(
        'const t = "https://api.example.com";',
        { APP_NAME: "https://api.example.com" },
        prefixes,
      ),
    ).toEqual([]);
  });
  it("[PENV-09] a secret counts as leaked only as a string literal: a bare digit run in unrelated code is not a leak", () => {
    expect(
      findSecretLeaks(
        "const n = 12345678; const id = 'x12345678';",
        { CLERK_SECRET_KEY: "12345678" },
        prefixes,
      ),
    ).toEqual([]);
    expect(
      findSecretLeaks('const k = "12345678";', { CLERK_SECRET_KEY: "12345678" }, prefixes),
    ).toEqual(["CLERK_SECRET_KEY"]);
  });
});
