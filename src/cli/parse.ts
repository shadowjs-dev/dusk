import { parseArgs } from "node:util";
import { parseWorkers } from "../node/worker-count";
import {
  COMMANDS,
  type CommandSpec,
  type CompletionShell,
  commandNamed,
  type RunName,
} from "./commands";
import { portNumber } from "./serving";

/**
 * Reads the command line with `util.parseArgs`. Nothing here touches the app or the network: a parsed command line
 * is what the commands run from.
 *
 * @packageDocumentation
 */

/** The flags of a command that runs (dev, build or start). @since 1.0.0 */
export interface RunFlags {
  /** The port the user asked for, from `--port`. Undefined when the flag is absent. */
  readonly port?: number;
  /** The host the user asked for. `""` is "all interfaces" (a bare `--host`). Undefined when absent. */
  readonly host?: string;
  readonly strictPort: boolean;
  readonly open: boolean;
  /** `dev --verbose`: the quiet events are printed too. */
  readonly verbose: boolean;
  /** `start --workers`: how many server processes share the port (`"auto"`: one per core). Undefined when absent. */
  readonly workers?: number | "auto";
  /** `start --log`: one line per request the app answers. */
  readonly log: boolean;
  /** `start --dir`: the build folder to serve, relative to the app. Undefined when absent (the folder the build recorded, else `dist`). */
  readonly dir?: string;
  /** `--json`: the command prints the JSON contract on stdout (a document, or JSON Lines for `dev` and `start`). */
  readonly json: boolean;
}

/** What the command line asks for. @since 1.0.0 */
export type Parsed =
  | { readonly kind: "help"; readonly command?: CommandSpec }
  | { readonly kind: "version" }
  | {
      readonly kind: "run";
      readonly run: RunName;
      readonly command: CommandSpec;
      readonly flags: RunFlags;
    }
  | { readonly kind: "completion"; readonly shell: CompletionShell }
  | {
      readonly kind: "usage";
      readonly message: string;
      /** The stable code `--json` prints: `DUSK_UNKNOWN_COMMAND`, `DUSK_UNKNOWN_OPTION`, `DUSK_INVALID_OPTION`, `DUSK_INVALID_PORT` or `DUSK_INVALID_SHELL`. */
      readonly code: string;
      readonly command?: CommandSpec;
      /** The exit code of the refusal. Undefined means 2, the parser's refusal. `completion` with a bad shell is 1. */
      readonly exitCode?: number;
    };

/**
 * Parses `dusk <command> [options]`. Help and version are answered without a command; a command with `--help`
 * shows its own help. Anything the parser refuses is a `usage` result (exit 2) that names the problem. The one
 * exception is `dusk completion` with a missing or unknown shell, which is a `usage` result with exit 1.
 *
 * @param argv The arguments after `dusk`.
 * @returns What to do.
 * @since 1.0.0
 * @example parseCommandLine(["dev", "--port", "4000"]); // { kind: "run", run: "dev", ... }
 * @example parseCommandLine(["completion", "fish"]); // { kind: "completion", shell: "fish" }
 */
export function parseCommandLine(argv: readonly string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help") return { kind: "help" };
  if (first === "-v" || first === "--version") return { kind: "version" };
  if (first.startsWith("-")) {
    return { kind: "usage", message: `unknown option "${first}"`, code: "DUSK_UNKNOWN_OPTION" };
  }
  const command = commandNamed(first);
  if (command === undefined) {
    const near = closestCommand(first);
    const hint = near === undefined ? "" : ` Did you mean "${near}"?`;
    return {
      kind: "usage",
      message: `unknown command "${first}".${hint}`,
      code: "DUSK_UNKNOWN_COMMAND",
    };
  }
  return parseCommand(command, rest);
}

/** The command a mistyped name is one or two edits away from (`biuld` for `build`), or undefined. @internal */
function closestCommand(typed: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const { name } of COMMANDS) {
    const distance = editDistance(typed, name);
    if (distance <= 2 && (best === undefined || distance < best.distance))
      best = { name, distance };
  }
  return best?.name;
}

/** The Levenshtein distance of two short words. @internal */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

function parseCommand(command: CommandSpec, args: readonly string[]): Parsed {
  let values: Record<string, unknown>;
  let positionals: string[] = [];
  try {
    const parsed = parseArgs({
      args: command.takesHost ? bareHost(args) : [...args],
      options: command.parse,
      allowPositionals: "shells" in command,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const message = parseMessage(error);
    const code = message.startsWith("unknown option")
      ? "DUSK_UNKNOWN_OPTION"
      : "DUSK_INVALID_OPTION";
    return { kind: "usage", message, code, command };
  }
  if (values["help"] === true) return { kind: "help", command };
  if ("shells" in command) return completionShell(command.shells, positionals, command);
  const port = portValue(values["port"]);
  if (typeof port === "string") {
    return { kind: "usage", message: port, code: "DUSK_INVALID_PORT", command };
  }
  const workers = workersValue(values["workers"]);
  if (typeof workers === "object") {
    return { kind: "usage", message: workers.message, code: "DUSK_INVALID_OPTION", command };
  }
  const host = values["host"];
  const dir = values["dir"];
  return {
    kind: "run",
    run: command.run,
    command,
    flags: {
      ...(port === undefined ? {} : { port }),
      ...(typeof host === "string" ? { host } : {}),
      ...(workers === undefined ? {} : { workers }),
      ...(typeof dir === "string" && dir !== "" ? { dir } : {}),
      strictPort: values["strictPort"] === true,
      open: values["open"] === true,
      verbose: values["verbose"] === true,
      log: values["log"] === true,
      json: values["json"] === true,
    },
  };
}

/**
 * The shell operand of `dusk completion`. A missing or unknown shell is a usage refusal with exit 1 (not the usual 2),
 * so a script that runs `dusk completion` can tell a bad shell from a bad flag. @internal
 */
function completionShell(
  shells: readonly CompletionShell[],
  positionals: readonly string[],
  command: CommandSpec,
): Parsed {
  const choices = `expected ${shells.slice(0, -1).join(", ")} or ${shells[shells.length - 1]}`;
  const [shell, extra] = positionals;
  if (shell === undefined)
    return {
      kind: "usage",
      message: `missing shell: ${choices}`,
      code: "DUSK_INVALID_SHELL",
      command,
      exitCode: 1,
    };
  if (extra !== undefined)
    return {
      kind: "usage",
      message: `unexpected argument "${extra}"`,
      code: "DUSK_INVALID_SHELL",
      command,
      exitCode: 1,
    };
  const match = shells.find((name) => name === shell);
  if (match === undefined)
    return {
      kind: "usage",
      message: `unknown shell "${shell}": ${choices}`,
      code: "DUSK_INVALID_SHELL",
      command,
      exitCode: 1,
    };
  return { kind: "completion", shell: match };
}

/**
 * A `--port` value: a whole number from 0 to 65535. Returns the message for a bad value instead of a number.
 * @internal
 */
function portValue(value: unknown): number | string | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "string" ? portNumber(value) : undefined;
  return port ?? `--port must be a port number from 0 to 65535 (got "${String(value)}")`;
}

/**
 * A `--workers` value: a whole number from 1 to 256, or `auto`. Returns the message for a bad value instead of a number.
 * @internal
 */
function workersValue(value: unknown): number | "auto" | { readonly message: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = parseWorkers(typeof value === "string" ? value : undefined, "--workers");
    if (parsed !== undefined) return parsed;
  } catch (error) {
    if (error instanceof RangeError) return { message: error.message };
    throw error;
  }
  return {
    message: `--workers must be a whole number from 1 to 256, or "auto" (got "${String(value)}")`,
  };
}

/**
 * `--host` with no value means all interfaces, which the parser cannot express (it needs a value). The arguments are
 * rewritten to `--host=<value>` (`--host=` for a bare flag) before parsing.
 * @internal
 */
function bareHost(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg !== "--host") {
      out.push(arg);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      out.push(`--host=${next}`);
      index += 1;
    } else {
      out.push("--host=");
    }
  }
  return out;
}

/** The first sentence of a parser error, with the option named the way the user typed it. @internal */
function parseMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unknown = /Unknown option '([^']+)'/.exec(message);
  if (unknown?.[1] !== undefined) return `unknown option "${unknown[1]}"`;
  return message.split(". ")[0] ?? message;
}
