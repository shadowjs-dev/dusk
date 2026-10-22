/**
 * The command line (`parse.ts`): the short flags, the build's `--json`, and the hint for a mistyped command.
 *
 * - CLI-45 `-p` is `--port` on dev, start and preview; every command takes `--json`.
 * - CLI-46 a mistyped command names the command it is one or two edits from; a word far from every command does not guess.
 */
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../../src/cli/parse";

describe("dusk command line", () => {
  it("[CLI-45] -p is --port on dev, start and preview", () => {
    for (const command of ["dev", "start", "preview"]) {
      const parsed = parseCommandLine([command, "-p", "4000"]);
      expect(parsed.kind).toBe("run");
      if (parsed.kind === "run") expect(parsed.flags.port).toBe(4000);
    }
    const bad = parseCommandLine(["dev", "-p", "99999"]);
    expect(bad).toMatchObject({ kind: "usage" });
  });

  it("[CLI-45] every command takes --json", () => {
    for (const command of ["dev", "build", "start", "preview", "doctor"]) {
      const parsed = parseCommandLine([command, "--json"]);
      expect(parsed.kind === "run" && parsed.flags.json, command).toBe(true);
    }
    expect(parseCommandLine(["build"])).toMatchObject({ kind: "run", flags: { json: false } });
    expect(parseCommandLine(["completion", "bash", "--json"])).toEqual({
      kind: "completion",
      shell: "bash",
    });
    expect(parseCommandLine(["build", "--nope"])).toMatchObject({
      kind: "usage",
      code: "DUSK_UNKNOWN_OPTION",
    });
  });

  it("[CLI-46] a mistyped command names the one it is near", () => {
    expect(parseCommandLine(["biuld"])).toMatchObject({
      kind: "usage",
      message: 'unknown command "biuld". Did you mean "build"?',
    });
    expect(parseCommandLine(["dv"])).toMatchObject({
      message: 'unknown command "dv". Did you mean "dev"?',
    });
    expect(parseCommandLine(["strat"])).toMatchObject({
      message: 'unknown command "strat". Did you mean "start"?',
    });
    expect(parseCommandLine(["preveiw"])).toMatchObject({
      message: 'unknown command "preveiw". Did you mean "preview"?',
    });
  });

  it("[CLI-46] a word far from every command gets no guess", () => {
    expect(parseCommandLine(["deploy"])).toMatchObject({
      kind: "usage",
      message: 'unknown command "deploy".',
    });
  });
});
