/**
 * The JSON contract of the `dusk` bin (`json.ts`): the envelope every command prints with `--json`.
 *
 * - CLI-JSON-01 a success is `{ schema, command, ok: true, data, warnings }` with no `error`, in this key order.
 * - CLI-JSON-02 a failure is `{ ..., ok: false, data, warnings, error: { code, message } }`; the data may still carry the facts.
 * - CLI-JSON-03 a stream line adds the `event` name after `ok`, and prints on one line.
 * - CLI-JSON-04 a document is newline-terminated, and indented unless it is a stream line.
 * - CLI-JSON-05 every error code of the bin has the `DUSK_` prefix and is SCREAMING_SNAKE.
 * - CLI-JSON-06 the JSON terminal has no color, no keys and no spinner.
 * - CLI-JSON-07 `wantsJson` sees `--json` anywhere before a `--`, and nowhere else.
 * - CLI-JSON-08 every code the sources print is in the lists, and every listed error code is printed somewhere.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../../src/cli/errors";
import {
  ERROR_CODES,
  failureOf,
  jsonFailure,
  jsonLine,
  jsonSuccess,
  jsonTerminal,
  WARNING_CODES,
  wantsJson,
} from "../../src/cli/json";

/** The text of a source file without the code lists of json.ts, which name every code and so prove nothing. */
function withoutLists(text: string): string {
  return text.replace(/export const (?:ERROR|WARNING)_CODES = \[[\s\S]*?\] as const;/g, "");
}

describe("dusk --json contract", () => {
  it("[CLI-JSON-01] a success has the keys schema, command, ok, data, warnings and no error", () => {
    const doc = jsonSuccess("dusk build", { routes: 2 }, [{ code: "DUSK_BUDGET", message: "big" }]);
    expect(Object.keys(doc)).toEqual(["schema", "command", "ok", "data", "warnings"]);
    expect(doc).toEqual({
      schema: 1,
      command: "dusk build",
      ok: true,
      data: { routes: 2 },
      warnings: [{ code: "DUSK_BUDGET", message: "big" }],
    });
  });

  it("[CLI-JSON-02] a failure has ok false and an error with a code and a message", () => {
    const doc = jsonFailure(
      "dusk doctor",
      { code: "DUSK_DOCTOR_FAILED", message: "1 check failed" },
      { data: { checks: [] } },
    );
    expect(Object.keys(doc)).toEqual(["schema", "command", "ok", "data", "warnings", "error"]);
    expect(doc.ok).toBe(false);
    expect(doc.data).toEqual({ checks: [] });
    expect(doc.warnings).toEqual([]);
    expect(doc.error).toEqual({ code: "DUSK_DOCTOR_FAILED", message: "1 check failed" });
    expect(jsonFailure("dusk", { code: "DUSK_X", message: "m" }).data).toEqual({});
  });

  it("[CLI-JSON-03] a stream line names its event and prints on one line", () => {
    const doc = jsonSuccess("dusk dev", { url: "http://localhost:3000/" }, [], "ready");
    expect(Object.keys(doc)).toEqual(["schema", "command", "ok", "event", "data", "warnings"]);
    const line = jsonLine(doc, true);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(doc);
  });

  it("[CLI-JSON-04] a one-shot document ends with a newline and is indented", () => {
    const text = jsonLine(jsonSuccess("dusk", { version: "1.0.0" }));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.split("\n").length).toBeGreaterThan(3);
    expect(JSON.parse(text)).toMatchObject({ ok: true, data: { version: "1.0.0" } });
  });

  it("[CLI-JSON-05] every error code has the DUSK_ prefix and SCREAMING_SNAKE case", () => {
    expect(ERROR_CODES.length).toBeGreaterThan(8);
    for (const code of ERROR_CODES) expect(code).toMatch(/^DUSK_[A-Z]+(?:_[A-Z]+)*$/);
    expect(failureOf("dusk start", new CliError("no build", "DUSK_NO_BUILD"))).toMatchObject({
      code: "DUSK_NO_BUILD",
      exitCode: 1,
    });
    expect(failureOf("dusk start", new Error("boom"))).toMatchObject({
      code: "DUSK_UNEXPECTED",
      message: "unexpected error: boom",
      exitCode: 1,
    });
    expect(failureOf("dusk build", Object.assign(new Error("bad"), { id: "a.ts" }))).toMatchObject({
      code: "DUSK_BUILD_FAILED",
      message: "bad",
    });
  });

  it("[CLI-JSON-06] the JSON terminal has no color, no keys and no spinner", () => {
    expect(jsonTerminal()).toMatchObject({ color: false, interactive: false });
  });

  it("[CLI-JSON-07] --json is seen before a -- and not after it", () => {
    expect(wantsJson(["build", "--json"])).toBe(true);
    expect(wantsJson(["--json", "bogus"])).toBe(true);
    expect(wantsJson(["build"])).toBe(false);
    expect(wantsJson(["build", "--", "--json"])).toBe(false);
    expect(wantsJson(["build", "--jsonx"])).toBe(false);
  });

  it("[CLI-JSON-08] the codes in the sources and the lists of json.ts are the same set", () => {
    const folder = join(import.meta.dirname, "..", "..", "src", "cli");
    const printed = new Set<string>();
    for (const file of readdirSync(folder)) {
      if (!file.endsWith(".ts")) continue;
      const text = withoutLists(readFileSync(join(folder, file), "utf8"));
      for (const match of text.matchAll(/"(DUSK_[A-Z]+(?:_[A-Z]+)*)"/g))
        printed.add(match[1] ?? "");
    }
    // The doctor builds its warning codes from the id of a check (DUSK_DOCTOR_<ID>), and DUSK_PUBLIC_ is an env prefix.
    const known = new Set<string>([...ERROR_CODES, ...WARNING_CODES]);
    for (const code of printed) {
      if (code.startsWith("DUSK_PUBLIC_")) continue;
      expect(known.has(code), `${code} is printed but not listed`).toBe(true);
    }
    for (const code of ERROR_CODES) {
      expect(printed.has(code), `${code} is listed but never printed`).toBe(true);
    }
  });
});
