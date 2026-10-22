/**
 * The failures of the `dusk` command. A {@link CliError} is a failure the user can fix from the message (no stack is
 * printed); a {@link UsageError} is a command line that does not parse (exit 2, with the help).
 *
 * @packageDocumentation
 */

/**
 * A failure with a message for the user. Exit code 1. With `--json` the `code` is the error's `code`.
 * @since 1.0.0
 */
export class CliError extends Error {
  readonly exitCode = 1;
  /** The stable code `--json` prints, such as `DUSK_NO_BUILD`. */
  readonly code: string;

  /**
   * @param message What went wrong and what to do about it.
   * @param code The stable code of the failure. Defaults to `DUSK_FAILED`.
   */
  constructor(message: string, code = "DUSK_FAILED") {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

/** A command line the parser refuses: unknown command or flag, a missing or bad value. Exit code 2. @since 1.0.0 */
export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The errors the build tool threw while building the app: the app's config or code is at fault, not the bin. @internal */
const BUILD_FAILURES = new WeakSet<object>();

/**
 * Marks an error the build tool threw (a config that throws, an unresolved import) as a failure the user can fix, so it
 * is reported by its message without a stack, and with the code `DUSK_BUILD_FAILED` in JSON.
 * @param error The thrown value; only an object can be marked.
 * @since 1.0.0
 */
export function markBuildFailure(error: unknown): void {
  if (typeof error === "object" && error !== null) BUILD_FAILURES.add(error);
}

/**
 * True for a failure the user can read without a stack: our own errors, and the errors of the build tool, which
 * carry the file they failed on (`id`, `loc`, `frame` or `plugin`).
 * @param error The thrown value.
 * @returns Whether the message is enough.
 * @since 1.0.0
 */
export function isKnownFailure(error: unknown): boolean {
  if (error instanceof CliError || error instanceof UsageError) return true;
  if (typeof error !== "object" || error === null) return false;
  if (BUILD_FAILURES.has(error)) return true;
  return ["id", "loc", "frame", "plugin"].some((key) => Reflect.has(error, key));
}

/**
 * True when the thrown value is a Node system error with this code (`ENOENT`, `EADDRINUSE` ...).
 * @param error The thrown value.
 * @param code The code to look for.
 * @since 1.0.0
 */
export function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
