import { failureOf, type JsonMode, jsonFailure, writeJson } from "./json";
import { currentTerminal, err, failureLine } from "./output";

/**
 * Prints a failure and returns its exit code. A failure the user can fix from its message prints that message only;
 * an unexpected one also prints its stack, once. With `json`, the failure is the JSON document on stdout (the stack
 * of an unexpected error still goes to stderr).
 *
 * @packageDocumentation
 */

/**
 * Reports a failure of a command.
 * @param scope The command the failure belongs to, such as `dusk build`.
 * @param error The thrown value.
 * @param json How the failure is printed: `false` for words on stderr, `"document"` for the indented JSON document of a
 *   command that ends, `"stream"` for one compact JSON line (the commands that keep running).
 * @returns The exit code: the error's own for a CliError or UsageError, otherwise 1.
 * @since 1.0.0
 */
export function reportFailure(scope: string, error: unknown, json: JsonMode = false): number {
  const failure = failureOf(scope, error);
  if (json) {
    if (failure.stack !== undefined) err(failure.stack);
    writeJson(
      jsonFailure(scope, { code: failure.code, message: failure.message }),
      json === "stream",
    );
    return failure.exitCode;
  }
  const term = currentTerminal();
  err(failureLine(scope, failure.message, term));
  if (failure.stack !== undefined) err(failure.stack);
  return failure.exitCode;
}
