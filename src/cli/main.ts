import { runBuild } from "./build";
import type { CommandSpec } from "./commands";
import { completionScript } from "./completion";
import { runDev } from "./dev";
import { runDoctor } from "./doctor";
import { jsonFailure, jsonSuccess, jsonTerminal, wantsJson, writeJson } from "./json";
import { commandHelp, currentTerminal, err, mainHelp, out, usageLine } from "./output";
import { parseCommandLine } from "./parse";
import { reportFailure } from "./report";
import { runStart } from "./start";
import { duskVersion } from "./version";

/**
 * The bin's dispatch: parses the command line, runs the command, and returns the exit code. Exit codes: 0 for help,
 * version, a successful build, a clean stop, or a completion script; 1 for a failure of a command and for a
 * `dusk completion` with a missing or unknown shell; 2 for a command line the parser refuses. With `--json` the
 * answer, the refusal and the failure are all the JSON contract of `json.ts` on stdout, with the same exit codes.
 *
 * @packageDocumentation
 */

/** The command a document names: `dusk`, or `dusk build` (`preview` is `dusk start`). @internal */
function scopeOf(command: CommandSpec | undefined): string {
  if (command === undefined) return "dusk";
  return `dusk ${command.name === "preview" ? "start" : command.name}`;
}

/**
 * Runs the bin. A command line with `--json` (before any `--`) gets the contract of `json.ts` on stdout and no words.
 * @param argv The arguments after `dusk`.
 * @returns The exit code.
 * @since 1.0.0
 */
export async function main(argv: readonly string[]): Promise<number> {
  const json = wantsJson(argv);
  const parsed = parseCommandLine(argv);
  const term = json ? jsonTerminal() : currentTerminal();
  switch (parsed.kind) {
    case "help": {
      const usage =
        parsed.command === undefined
          ? mainHelp(duskVersion(), term)
          : commandHelp(parsed.command, term);
      if (json) writeJson(jsonSuccess(scopeOf(parsed.command), { usage }));
      else process.stdout.write(usage);
      return 0;
    }
    case "version":
      if (json) writeJson(jsonSuccess("dusk", { version: duskVersion() }));
      else out(`dusk ${duskVersion()}`);
      return 0;
    case "completion": {
      const script = completionScript(parsed.shell);
      if (json) writeJson(jsonSuccess("dusk completion", { shell: parsed.shell, script }));
      else process.stdout.write(script);
      return 0;
    }
    case "usage": {
      if (json) {
        writeJson(
          jsonFailure(scopeOf(parsed.command), { code: parsed.code, message: parsed.message }),
        );
        return parsed.exitCode ?? 2;
      }
      const scope = parsed.command === undefined ? "dusk" : `dusk ${parsed.command.name}`;
      err(usageLine(scope, parsed.message, term));
      process.stderr.write(
        parsed.command === undefined
          ? mainHelp(duskVersion(), term)
          : commandHelp(parsed.command, term),
      );
      return parsed.exitCode ?? 2;
    }
    case "run": {
      const mode = !parsed.flags.json
        ? false
        : parsed.run === "dev" || parsed.run === "start"
          ? "stream"
          : "document";
      try {
        if (parsed.run === "dev") return await runDev(parsed.flags);
        if (parsed.run === "build") return await runBuild(parsed.flags);
        if (parsed.run === "doctor") return await runDoctor(parsed.flags);
        return await runStart(parsed.flags);
      } catch (error) {
        return reportFailure(`dusk ${parsed.run}`, error, mode);
      }
    }
  }
}
