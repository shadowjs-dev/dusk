import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyServerEnv,
  findForbiddenEnvReads,
  loadServerEnv,
  publicPrefixes,
} from "../../src/vite/env";

const prefixes = ["DUSK_PUBLIC_"];

describe("client environment variables", () => {
  it("[SENV-01] DUSK_PUBLIC_ names and Vite's own constants are allowed", () => {
    const code = `export const a = import.meta.env.DUSK_PUBLIC_API; export const m = import.meta.env.MODE; export const d = import.meta.env.DEV;`;
    expect(findForbiddenEnvReads(code, "a.ts", prefixes)).toEqual([]);
  });

  it("[SENV-02] any other name is reported with its position", () => {
    const code = `const ok = import.meta.env.DUSK_PUBLIC_X;\nexport const key = import.meta.env.API_SECRET;\n`;
    const found = findForbiddenEnvReads(code, "a.ts", prefixes);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "API_SECRET", line: 2 });
    expect(found[0]?.frame).toContain("^");
  });

  it("[SENV-03] reads inside functions, templates and TSX are found; strings and comments are not", () => {
    const code = [
      `// import.meta.env.COMMENT_ONLY`,
      `const text = "import.meta.env.STRING_ONLY";`,
      `export function f() { return \`k=\${import.meta.env.IN_TEMPLATE}\`; }`,
      `export const g = () => <p>{import.meta.env.IN_JSX}</p>;`,
      ``,
    ].join("\n");
    expect(findForbiddenEnvReads(code, "a.tsx", prefixes).map((v) => v.name)).toEqual([
      "IN_TEMPLATE",
      "IN_JSX",
    ]);
  });

  it("[SENV-04] extra prefixes are honored; unsafe ones are refused", () => {
    expect(
      findForbiddenEnvReads(`export const a = import.meta.env.APP_NAME;`, "a.ts", [
        "DUSK_PUBLIC_",
        "APP_",
      ]),
    ).toEqual([]);
    expect(publicPrefixes(undefined)).toEqual(["DUSK_PUBLIC_"]);
    expect(publicPrefixes("APP_")).toEqual(["DUSK_PUBLIC_", "APP_"]);
    expect(publicPrefixes(["DUSK_PUBLIC_", "X_Y_"])).toEqual(["DUSK_PUBLIC_", "X_Y_"]);
    for (const unsafe of ["", "*", "V", "AB"]) {
      expect(() => publicPrefixes(unsafe)).toThrow(/ENV_PREFIX_UNSAFE/);
    }
    expect(() => publicPrefixes(["DUSK_PUBLIC_", ""])).toThrow(/ENV_PREFIX_UNSAFE/);
  });

  it("[SENV-05] code without import.meta.env is not parsed at all", () => {
    expect(findForbiddenEnvReads("this is not valid code (((", "a.ts", prefixes)).toEqual([]);
  });
});

describe("env files for server code", () => {
  /** Writes env files into a temp folder and runs `body` with it. */
  function withFiles(files: Record<string, string>, body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "shadow-env-"));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("[SENV-10] every key of .env, .env.local, .env.[mode] and .env.[mode].local is loaded, later files winning", () => {
    withFiles(
      {
        ".env":
          "SENVT_A=base\nSENVT_B=base\nSENVT_C=base\nSENVT_D=base\nSENVT_E=base\nDUSK_PUBLIC_SENVT=shown\n",
        ".env.local": "SENVT_B=local\n",
        ".env.staging": "SENVT_C=mode\nSENVT_B=mode\n",
        ".env.staging.local": "SENVT_D=mode-local\n",
        ".env.production": "SENVT_E=other-mode\n",
      },
      (dir) => {
        const values = loadServerEnv("staging", dir);
        expect(values["SENVT_A"]).toBe("base");
        // .env.local overrides .env.[mode] (the project's env file order); the mode's .local file wins over the mode file.
        expect(values["SENVT_B"]).toBe("local");
        expect(values["SENVT_C"]).toBe("mode");
        expect(values["SENVT_D"]).toBe("mode-local");
        expect(values["SENVT_E"]).toBe("base");
        expect(values["DUSK_PUBLIC_SENVT"]).toBe("shown");
      },
    );
  });

  it("[SENV-11] references to other variables are expanded, and a folder without files gives nothing of its own", () => {
    // Written in two pieces: the reference is dotenv syntax, not a template placeholder.
    const reference = ["$", "{SENVT_HOST}"].join("");
    withFiles({ ".env": `SENVT_HOST=db\nSENVT_URL=postgres://${reference}/app\n` }, (dir) => {
      expect(loadServerEnv("development", dir)["SENVT_URL"]).toBe("postgres://db/app");
    });
    withFiles({}, (dir) => {
      expect(loadServerEnv("development", dir)["SENVT_HOST"]).toBeUndefined();
    });
  });

  it("[SENV-12] applyServerEnv fills what is missing, never overrides a set variable, and never takes NODE_ENV", () => {
    const target: Record<string, string | undefined> = { SENVT_SET: "real", SENVT_EMPTY: "" };
    const applied = applyServerEnv(
      {
        SENVT_SET: "from file",
        SENVT_EMPTY: "from file",
        SENVT_NEW: "from file",
        NODE_ENV: "production",
        SENVT_ANOTHER: "x",
      },
      target,
    );
    expect(applied).toEqual(["SENVT_ANOTHER", "SENVT_NEW"]);
    expect(target).toEqual({
      SENVT_SET: "real",
      // An empty value is still a value somebody set on purpose.
      SENVT_EMPTY: "",
      SENVT_NEW: "from file",
      SENVT_ANOTHER: "x",
    });
  });
});
