import { CliError, isKnownFailure, UsageError } from "./errors";
import { stripAnsi, type Terminal } from "./output";

/**
 * The machine-readable output of the `dusk` bin. With `--json`, every command writes the same envelope on stdout and
 * nothing else there; the human words (logs, the stack of an unexpected error) go to stderr or are left out.
 *
 * - A command that ends writes one document, indented, newline-terminated.
 * - A command that keeps running (`dev`, `start`) writes JSON Lines: one compact envelope per line, each with an `event`
 *   name (`ready`, `request`, `stopped`). A line with `ok: false` is the last one.
 * - The exit code is the same with and without `--json`, and `ok` is true exactly when it is 0.
 *
 * The same contract (schema 1) is printed by `shadow-ui` and `create-shadow-app`; each package has its own copy of this
 * small module, so the bins share no code at runtime.
 *
 * @packageDocumentation
 */

/** The version of the envelope. A change to a key's meaning raises it. @since 1.0.0 */
export const JSON_SCHEMA = 1;

/** A warning in the envelope: a stable code and a sentence. @since 1.0.0 */
export interface JsonWarning {
  /** A stable SCREAMING_SNAKE code with the `DUSK_` prefix. */
  readonly code: string;
  readonly message: string;
}

/** The failure in the envelope: a stable code and a sentence a person can act on. @since 1.0.0 */
export interface JsonError {
  /** A stable SCREAMING_SNAKE code with the `DUSK_` prefix. */
  readonly code: string;
  readonly message: string;
}

/**
 * What every `--json` run of the bin prints.
 * @since 1.0.0
 */
export interface JsonDocument<T extends object = Record<string, unknown>> {
  readonly schema: typeof JSON_SCHEMA;
  /** The command that ran, such as `dusk build`. An alias is named by its command (`preview` is `dusk start`). */
  readonly command: string;
  /** True exactly when the exit code is 0. */
  readonly ok: boolean;
  /** Only on a line of a stream: what happened (`ready`, `request`, `stopped`). */
  readonly event?: string;
  /** The facts of the command. `{}` when it has none, and what is known when the command failed. */
  readonly data: T;
  readonly warnings: readonly JsonWarning[];
  /** Only when `ok` is false. */
  readonly error?: JsonError;
}

/** The error codes of the bin, for the documentation and the tests. @since 1.0.0 */
export const ERROR_CODES = [
  "DUSK_UNKNOWN_COMMAND",
  "DUSK_UNKNOWN_OPTION",
  "DUSK_INVALID_OPTION",
  "DUSK_INVALID_PORT",
  "DUSK_INVALID_SHELL",
  "DUSK_PORT_IN_USE",
  "DUSK_NO_BUILD",
  "DUSK_NO_ADAPTER",
  "DUSK_WRONG_ADAPTER",
  "DUSK_BAD_BUILD",
  "DUSK_BAD_MANIFEST",
  "DUSK_NO_VERSION",
  "DUSK_BUILD_FAILED",
  "DUSK_BUDGET_EXCEEDED",
  "DUSK_DOCTOR_FAILED",
  "DUSK_FAILED",
  "DUSK_UNEXPECTED",
] as const;

/**
 * The warning codes of the bin that are fixed words. `dusk doctor` also warns with `DUSK_DOCTOR_` and the id of the check
 * in capitals (`DUSK_DOCTOR_LOCKFILE`).
 * @since 1.0.0
 */
export const WARNING_CODES = ["DUSK_BUDGET"] as const;

/** One of the error codes the bin prints. @since 1.0.0 */
export type DuskErrorCode = (typeof ERROR_CODES)[number];

/**
 * How a command prints: `false` for words, `"document"` for the one indented JSON document of a command that ends,
 * `"stream"` for JSON Lines.
 * @since 1.0.0
 */
export type JsonMode = false | "document" | "stream";

/** A failure as the bin reports it: the code and message for JSON, and the exit code. @since 1.0.0 */
export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly exitCode: number;
  /** The stack of an unexpected error, for stderr. Undefined for a failure the message explains. */
  readonly stack?: string;
}

/**
 * What a thrown value means for the user: its code, its message and the exit code. A {@link CliError} carries its own
 * code; a {@link UsageError} is a refused command line (exit 2); an error of the build tool, which names a file, is
 * `DUSK_BUILD_FAILED` for `dusk build`; anything else is `DUSK_UNEXPECTED` and keeps its stack.
 * @param scope The command the failure belongs to, such as `dusk build`.
 * @param error The thrown value.
 * @returns The failure.
 * @since 1.0.0
 */
export function failureOf(scope: string, error: unknown): Failure {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message, exitCode: error.exitCode };
  }
  if (error instanceof UsageError) {
    return { code: "DUSK_INVALID_OPTION", message: error.message, exitCode: error.exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isKnownFailure(error)) {
    return {
      code: scope === "dusk build" ? "DUSK_BUILD_FAILED" : "DUSK_FAILED",
      message,
      exitCode: 1,
    };
  }
  return {
    code: "DUSK_UNEXPECTED",
    message: `unexpected error: ${message}`,
    exitCode: 1,
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };
}

/**
 * A successful document.
 * @param command The command that ran.
 * @param data The facts of the command.
 * @param warnings The warnings; none by default.
 * @param event The event name, for a line of a stream.
 * @returns The document.
 * @since 1.0.0
 * @example jsonSuccess("dusk", { version: "1.0.0" }).ok; // true
 */
export function jsonSuccess<T extends object>(
  command: string,
  data: T,
  warnings: readonly JsonWarning[] = [],
  event?: string,
): JsonDocument<T> {
  return {
    schema: JSON_SCHEMA,
    command,
    ok: true,
    ...(event === undefined ? {} : { event }),
    data,
    warnings,
  };
}

/** What a failure document may carry besides its error. @since 1.0.0 */
export interface JsonFailureExtras<T extends object> {
  /** The facts that are known even though the command failed (the checks of a failed `doctor`). */
  readonly data?: T;
  readonly warnings?: readonly JsonWarning[];
}

/**
 * A failed document.
 * @param command The command that ran.
 * @param error The code and the message.
 * @param extras The facts and the warnings known at the failure.
 * @returns The document, with `ok: false`.
 * @since 1.0.0
 * @example jsonFailure("dusk start", { code: "DUSK_NO_BUILD", message: "no build" }).error?.code; // "DUSK_NO_BUILD"
 */
export function jsonFailure<T extends object = Record<string, never>>(
  command: string,
  error: JsonError,
  extras: JsonFailureExtras<T> = {},
): JsonDocument<T | Record<string, never>> {
  return {
    schema: JSON_SCHEMA,
    command,
    ok: false,
    data: extras.data ?? {},
    warnings: extras.warnings ?? [],
    // The words of a tool may carry color codes; a document never does.
    error: { code: error.code, message: stripAnsi(error.message) },
  };
}

/**
 * The text to write for a document: indented for a command that ends, one compact line for a line of a stream. Always
 * newline-terminated.
 * @param document The document.
 * @param compact True for a line of a stream.
 * @returns The text.
 * @since 1.0.0
 */
export function jsonLine(document: JsonDocument<object>, compact = false): string {
  return `${JSON.stringify(document, null, compact ? undefined : 2)}\n`;
}

/**
 * Writes a document to stdout.
 * @param document The document.
 * @param compact True for a line of a stream.
 * @since 1.0.0
 */
export function writeJson(document: JsonDocument<object>, compact = false): void {
  process.stdout.write(jsonLine(document, compact));
}

/**
 * Whether the command line asks for JSON: `--json` anywhere before a `--`. Read before the line is parsed, so a refused
 * command line is answered in JSON too.
 * @param argv The arguments after `dusk`.
 * @returns True for `--json`.
 * @since 1.0.0
 */
export function wantsJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--json") return true;
  }
  return false;
}

/**
 * The output rules of a `--json` run: no color, no keys, no spinner and no clear-screen, whatever the stream is.
 * @returns The rules.
 * @since 1.0.0
 */
export function jsonTerminal(): Terminal {
  return { color: false, interactive: false, unicode: false, columns: undefined };
}

/**
 * Prints an uncaught exception or a rejected promise as a JSON failure, then exits 1. Installed by the bin when the
 * command line asks for JSON, so a crash is no exception to "stdout carries only JSON". A reader that went away
 * (`| head -n 1` closed the pipe) is not a crash: the process exits quietly.
 * @param command The command line's command, such as `dusk dev`.
 * @since 1.0.0
 */
export function installCrashHandlers(command: string): void {
  let crashed = false;
  const crash = (error: unknown): void => {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "EPIPE") {
      process.exit(0);
    }
    // The document itself may fail to write (the pipe closed meanwhile); one attempt is all there is.
    if (crashed) process.exit(1);
    crashed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`);
    }
    writeJson(
      jsonFailure(command, { code: "DUSK_UNEXPECTED", message: `unexpected error: ${message}` }),
    );
    process.stdout.write("", () => process.exit(1));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
}
