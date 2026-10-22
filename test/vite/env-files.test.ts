import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicValueFindings } from "../../src/vite/build-scan";
import { publicEnvOf, validateDuskConfig } from "../../src/vite/config-file";
import {
  checkEnvFiles,
  findForbiddenEnvReads,
  publicEnvNames,
  publicEnvTypesSource,
  publicPrefixes,
  readEnvFiles,
  resolvedValues,
  secretLikePublicNames,
} from "../../src/vite/env";

/** Writes env files into a temp folder and runs `body` with it. */
function withFiles(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "shadow-env-files-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the public prefix and the client reads", () => {
  it("[ENV-01] the default public prefix is DUSK_PUBLIC_; a bare DUSK_PUBLIC_ name is not public any more", () => {
    expect(publicPrefixes(undefined)).toEqual(["DUSK_PUBLIC_"]);
    const code = `export const a = import.meta.env.DUSK_PUBLIC_API;\nexport const b = import.meta.env.PUBLIC_API;\n`;
    expect(findForbiddenEnvReads(code, "a.ts", ["DUSK_PUBLIC_"]).map((v) => v.name)).toEqual([
      "PUBLIC_API",
    ]);
  });

  it("[ENV-02] a name declared in .env.public may be read in client code, prefix or not", () => {
    const code = `export const site = import.meta.env.SITE_URL;\nexport const key = import.meta.env.API_KEY;\n`;
    const found = findForbiddenEnvReads(code, "a.ts", ["DUSK_PUBLIC_"], ["SITE_URL"]);
    expect(found.map((v) => v.name)).toEqual(["API_KEY"]);
  });
});

describe("env files: layering and sources", () => {
  it("[ENV-03] files layer as .env.public < .env.[mode].public < .env < .env.[mode] < .env.local < .env.[mode].local < .env.public.local", () => {
    withFiles(
      {
        ".env.public": "ENVT_A=public\nENVT_B=public\nENVT_C=public\nENVT_F=public\n",
        ".env.staging.public": "ENVT_B=public-mode\nENVT_C=public-mode\nENVT_G=public-mode\n",
        ".env": "ENVT_A=base\nENVT_B=base\nENVT_D=base\nENVT_E=base\nDUSK_PUBLIC_ENVT_H=base\n",
        ".env.staging": "ENVT_D=mode\nENVT_E=mode\n",
        ".env.local": "ENVT_E=local\nDUSK_PUBLIC_ENVT_H=local\n",
        ".env.staging.local": "ENVT_G=mode-local\n",
        ".env.public.local": "ENVT_F=public-local\n",
      },
      (dir) => {
        const files = readEnvFiles("staging", dir);
        expect(files.values["ENVT_A"]).toBe("base");
        // .env overrides the public files; .env.[mode].public overrides .env.public.
        expect(files.values["ENVT_B"]).toBe("base");
        expect(files.values["ENVT_C"]).toBe("public-mode");
        // .env.[mode] overrides .env; .env.local overrides .env.[mode] (the project's env file order).
        expect(files.values["ENVT_D"]).toBe("mode");
        expect(files.values["ENVT_E"]).toBe("local");
        expect(files.values["DUSK_PUBLIC_ENVT_H"]).toBe("local");
        expect(files.values["ENVT_G"]).toBe("mode-local");
        // .env.public.local is the highest file.
        expect(files.values["ENVT_F"]).toBe("public-local");
        expect(files.sources["ENVT_E"]).toBe(".env.local");
      },
    );
  });

  it("[ENV-04] the names declared in the public files are public; the other files are server files", () => {
    withFiles(
      {
        ".env.public": "SITE_URL=https://site.example\n",
        ".env": "DATABASE_URL=postgres://db/app\nDUSK_PUBLIC_FLAG=on\n",
      },
      (dir) => {
        const files = readEnvFiles("development", dir);
        expect(files.publicNames).toEqual(["SITE_URL"]);
        expect(files.serverNames).toEqual(["DATABASE_URL", "DUSK_PUBLIC_FLAG"]);
        expect(
          publicEnvNames(Object.keys(files.values), files.publicNames, ["DUSK_PUBLIC_"]),
        ).toEqual(["DUSK_PUBLIC_FLAG", "SITE_URL"]);
      },
    );
  });

  it("[ENV-05] a real environment variable wins over every file", () => {
    withFiles({ ".env.public": "SITE_URL=from-file\n" }, (dir) => {
      const files = readEnvFiles("development", dir);
      expect(resolvedValues(files, { SITE_URL: "from-env" })["SITE_URL"]).toBe("from-env");
      expect(resolvedValues(files, {})["SITE_URL"]).toBe("from-file");
    });
  });
});

describe("env files: conflicts and secrets", () => {
  it("[ENV-06] a public name also set in a server file is an error that names the variable, not its value", () => {
    withFiles(
      {
        ".env.public": "SITE_URL=https://public.example\n",
        ".env.local": "SITE_URL=https://local.example\n",
      },
      (dir) => {
        const files = readEnvFiles("development", dir);
        let message = "";
        try {
          checkEnvFiles(files, ["DUSK_PUBLIC_"]);
        } catch (error) {
          message = String((error as Error).message);
        }
        expect(message).toContain("[ENV_PUBLIC_CONFLICT]");
        expect(message).toContain("SITE_URL");
        expect(message).not.toContain("local.example");
      },
    );
  });

  it("[ENV-07] a prefixed name may appear in several files: the prefix already makes it public", () => {
    withFiles(
      { ".env.public": "DUSK_PUBLIC_SITE=a\n", ".env.local": "DUSK_PUBLIC_SITE=b\n" },
      (dir) => {
        expect(() =>
          checkEnvFiles(readEnvFiles("development", dir), ["DUSK_PUBLIC_"]),
        ).not.toThrow();
      },
    );
  });

  it("[ENV-08] a public value that looks like a credential is found by rule (never by value)", () => {
    expect(publicValueFindings("sk_live_0123456789abcdefghij")).toEqual([
      "Stripe or Clerk secret key",
    ]);
    expect(
      publicValueFindings(
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
      ),
    ).toEqual(["private key"]);
    expect(publicValueFindings("postgres://admin:hunter2@db.internal/app")).toEqual([
      "credentials in a URL",
    ]);
    expect(
      publicValueFindings(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toEqual(["JWT"]);
  });

  it("[ENV-09] publishable keys, plain URLs, placeholders and ordinary values are not findings", () => {
    for (const value of [
      "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
      "https://api.example.com/v1",
      "sk_test_xxxxxxxx",
      "production",
      "3000",
    ]) {
      expect(publicValueFindings(value)).toEqual([]);
    }
  });

  it("[ENV-10] a secret-looking public name is reported as a warning candidate, not an error", () => {
    expect(
      secretLikePublicNames(["DUSK_PUBLIC_API_SECRET", "DUSK_PUBLIC_SITE"], ["DUSK_PUBLIC_"]),
    ).toEqual(["DUSK_PUBLIC_API_SECRET"]);
  });
});

describe("env.public in dusk.config and the typings", () => {
  it("[ENV-11] env.public.allow lists names whose values are public on purpose; it must be an array of names", () => {
    const config = validateDuskConfig({
      env: { public: { allow: ["DUSK_PUBLIC_KEY"] } },
    });
    expect(publicEnvOf(config).allow).toEqual(["DUSK_PUBLIC_KEY"]);
    expect(publicEnvOf(validateDuskConfig({})).allow).toEqual([]);
    expect(() => validateDuskConfig({ env: { public: { allow: "DUSK_PUBLIC_KEY" } } })).toThrow(
      /must be an array/,
    );
  });

  it("[ENV-12] the generated typings augment ImportMetaEnv and ProcessEnv with the public names only", () => {
    const source = publicEnvTypesSource(["DUSK_PUBLIC_API", "SITE_URL"]);
    expect(source).toContain("declare global");
    expect(source).toContain("interface ImportMetaEnv");
    expect(source).toContain("readonly SITE_URL: string;");
    expect(source).toContain("readonly DUSK_PUBLIC_API: string;");
    expect(source).toContain("interface ProcessEnv");
    expect(source).toContain("export {};");
    expect(source).not.toContain("DATABASE_URL");
  });
});
