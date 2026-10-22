import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  credentialNameWarnings,
  findForbiddenEnvReads,
  nextPublicNotes,
  readEnvFiles,
} from "../../src/vite/env";

/*
 * Audit lane ENV: the client env reads (G-A4), the credential-named public names (G-A9), the Next.js public prefix (G-A1)
 * and the test mode's env files (G-A2).
 */

const prefixes = ["DUSK_PUBLIC_"];

function names(code: string): string[] {
  return findForbiddenEnvReads(code, "a.ts", prefixes).map((violation) => violation.name);
}

describe("[G-A4] client reads of env that the browser does not get", () => {
  it("[G-A4] a computed string-literal key is checked like a dot read", () => {
    const found = findForbiddenEnvReads(
      `export const a = import.meta.env["API_SECRET"];\nexport const b = import.meta.env["DUSK_PUBLIC_OK"];\n`,
      "a.ts",
      prefixes,
    );
    expect(found.map((v) => v.name)).toEqual(["API_SECRET"]);
    expect(found[0]).toMatchObject({
      expression: "import.meta.env.API_SECRET",
      dynamic: false,
      line: 1,
    });
  });

  it("[G-A4] a template key without substitutions is a literal key", () => {
    expect(names("export const a = import.meta.env[`API_SECRET`];")).toEqual(["API_SECRET"]);
  });

  it("[G-A4] a computed key that is not a literal fails and says why", () => {
    const found = findForbiddenEnvReads(
      `const key = "API_SECRET";\nexport const a = import.meta.env[key];\n`,
      "a.ts",
      prefixes,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dynamic: true, expression: "import.meta.env[key]", line: 2 });
  });

  it("[G-A4] a destructured read of a non-public name is found; public and rest elements are not", () => {
    expect(names(`const { API_SECRET, DUSK_PUBLIC_OK, MODE } = import.meta.env;`)).toEqual([
      "API_SECRET",
    ]);
    expect(names(`const { DUSK_PUBLIC_OK, ...rest } = import.meta.env; export { rest };`)).toEqual(
      [],
    );
    expect(names(`const { "API_SECRET": s } = import.meta.env; export { s };`)).toEqual([
      "API_SECRET",
    ]);
  });

  it("[G-A4] a destructured computed key that is not a literal fails and says why", () => {
    const found = findForbiddenEnvReads(
      `const k = "API_SECRET";\nexport const { [k]: v } = import.meta.env;\n`,
      "a.ts",
      prefixes,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dynamic: true, expression: "import.meta.env[k]" });
  });

  it("[G-A4] an alias of import.meta.env is followed, through a chain of aliases too", () => {
    expect(names(`const e = import.meta.env;\nexport const k = e.API_SECRET;`)).toEqual([
      "API_SECRET",
    ]);
    expect(names(`const e = import.meta.env;\nexport const k = e["API_SECRET"];`)).toEqual([
      "API_SECRET",
    ]);
    expect(
      names(`const a = import.meta.env;\nconst b = a;\nexport const k = b.API_SECRET;`),
    ).toEqual(["API_SECRET"]);
    expect(names(`let e;\ne = import.meta.env;\nexport const k = e.API_SECRET;`)).toEqual([
      "API_SECRET",
    ]);
    expect(names(`const e = import.meta.env;\nexport const k = e.DUSK_PUBLIC_OK;`)).toEqual([]);
  });

  it("[G-A4] an alias read with a key that is not a literal fails", () => {
    const found = findForbiddenEnvReads(
      `const e = import.meta.env;\nexport const k = (e as Record<string, string>)[name];\n`,
      "a.ts",
      prefixes,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dynamic: true });
  });

  it("[G-A4] passing the whole import.meta.env object is not a read of a name", () => {
    expect(names(`export const all = JSON.stringify(import.meta.env);`)).toEqual([]);
  });

  it("[G-A4] client process.env reads of a non-public name are found; NODE_ENV and public names are not", () => {
    const found = findForbiddenEnvReads(
      [
        `export const a = process.env.API_SECRET;`,
        `export const b = process.env["DB_PASS_WORD"];`,
        `export const c = process.env.NODE_ENV;`,
        `export const d = process.env.DUSK_PUBLIC_OK;`,
        `export const e = process.env;`,
      ].join("\n"),
      "a.ts",
      prefixes,
    );
    expect(found.map((v) => v.expression)).toEqual([
      "process.env.API_SECRET",
      "process.env.DB_PASS_WORD",
    ]);
    expect(found[0]).toMatchObject({ name: "API_SECRET", line: 1 });
  });

  it("[G-A4] a destructured or aliased process.env read is found as well", () => {
    expect(names(`const { API_SECRET } = process.env;`)).toEqual(["API_SECRET"]);
    expect(names(`const p = process.env;\nexport const a = p.API_SECRET;`)).toEqual(["API_SECRET"]);
    expect(names(`const { NODE_ENV, DUSK_PUBLIC_OK } = process.env;`)).toEqual([]);
  });

  it("[G-A4] reads in comments and strings are still not reads", () => {
    expect(names(`// import.meta.env["API_SECRET"]\nconst s = "process.env.API_SECRET";`)).toEqual(
      [],
    );
  });
});

describe("[G-A9] a credential-named public name", () => {
  for (const word of [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASS",
    "KEY",
    "DATABASE_URL",
    "DSN",
    "PRIVATE",
  ]) {
    it(`[G-A9] a public name with ${word} gets a warning note, never an error, naming the variable`, () => {
      const name = `DUSK_PUBLIC_API_${word}`;
      const notes = credentialNameWarnings([name], []);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("[ENV_PUBLIC_NAME]");
      expect(notes[0]).toContain(name);
      expect(notes[0]).toContain("env.public.allow");
    });
  }

  it("[G-A9] a name in env.public.allow is silent, and a plain name is silent", () => {
    expect(credentialNameWarnings(["DUSK_PUBLIC_CLERK_KEY"], ["DUSK_PUBLIC_CLERK_KEY"])).toEqual(
      [],
    );
    expect(credentialNameWarnings(["DUSK_PUBLIC_SITE_URL", "SITE_URL"], [])).toEqual([]);
  });
});

describe("[G-A1] the Next.js public prefix", () => {
  it("[G-A1] nothing is noted while the app keeps the prefix out of env.public.prefixes", () => {
    expect(nextPublicNotes(["NEXT_PUBLIC_SITE_URL", "DUSK_PUBLIC_OK"], prefixes)).toEqual([]);
  });

  it("[G-A1] once the app lists NEXT_PUBLIC_, one note recommends the Dusk prefix, naming the variable only", () => {
    const notes = nextPublicNotes(["NEXT_PUBLIC_SITE_URL"], [...prefixes, "NEXT_PUBLIC_"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("[ENV_NEXT_PUBLIC]");
    expect(notes[0]).toContain("DUSK_PUBLIC_SITE_URL");
  });
});

describe("[G-A2] the env files of mode test", () => {
  function withFiles(files: Record<string, string>, body: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "shadow-audit-env-"));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("[G-A2] .env.local is ignored in mode test; .env.test and .env.test.local are read", () => {
    withFiles(
      {
        ".env": "AUDITA_BASE=base\n",
        ".env.local": "AUDITA_LOCAL=local\nAUDITA_BOTH=local\n",
        ".env.test": "AUDITA_BOTH=test\nAUDITA_TEST=test\n",
        ".env.test.local": "AUDITA_TEST_LOCAL=yes\n",
      },
      (dir) => {
        const files = readEnvFiles("test", dir);
        expect(files.values["AUDITA_LOCAL"]).toBeUndefined();
        expect(files.values["AUDITA_BOTH"]).toBe("test");
        expect(files.values["AUDITA_TEST"]).toBe("test");
        expect(files.values["AUDITA_TEST_LOCAL"]).toBe("yes");
        expect(files.values["AUDITA_BASE"]).toBe("base");
        // The other modes still read .env.local.
        expect(readEnvFiles("development", dir).values["AUDITA_LOCAL"]).toBe("local");
      },
    );
  });
});
