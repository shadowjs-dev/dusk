import type { LogErrorOptions, Logger, LogOptions, LogType } from "vite";
import { CLEAR_SCREEN, err, logLine, out, type Terminal } from "./output";
import type { Spinner } from "./spinner";

/**
 * The logger the dev server and the build hand their messages to. The messages are Vite's (and the plugins'); the words
 * and the prefix are Dusk's, by {@link logLine}. Info goes to stdout (stderr with `infoToStderr`), warnings and errors to
 * stderr. Errors keep their stack frames as they are.
 *
 * @packageDocumentation
 */

/** How the logger prints. @since 1.0.0 */
export interface DuskLoggerOptions {
  readonly term: Terminal;
  /** Show the quiet events (hot updates, page reloads) and the timestamps of every message. */
  readonly verbose: boolean;
  /** Drop the info messages (the build prints its own summary instead of Vite's progress). */
  readonly quietInfo: boolean;
  /** Print the info messages on stderr too (`--json`: stdout carries the JSON and nothing else). */
  readonly infoToStderr?: boolean;
  /** A spinner on the current line: messages are printed around it so a line never lands on a frame. */
  readonly spinner?: Pick<Spinner, "around">;
}

/**
 * Most messages `warnOnce` remembers. A dev server runs for days and a message may carry a file name, so the memory is
 * bounded: past this many, the oldest is forgotten (it may be shown once more).
 * @since 1.0.0
 */
export const WARN_ONCE_LIMIT = 1000;

/**
 * A Vite logger that prints in Dusk's words.
 * @param options How to print.
 * @returns The logger, for `customLogger` of a Vite config.
 * @since 1.0.0
 */
export function duskLogger(options: DuskLoggerOptions): Logger {
  const logged = new WeakSet<object>();
  const once = new Set<string>();
  let warned = false;
  const emit = (kind: LogType, message: string, timestamp: boolean | undefined): void => {
    if (kind === "info" && options.quietInfo) return;
    const line = logLine(
      kind,
      message,
      { timestamp: timestamp === true, verbose: options.verbose, now: new Date() },
      options.term,
    );
    if (line === undefined) return;
    const print = (): void => {
      if (kind === "info" && options.infoToStderr !== true) out(line);
      else err(line);
    };
    if (options.spinner === undefined) print();
    else options.spinner.around(print);
  };
  return {
    get hasWarned(): boolean {
      return warned;
    },
    info(message: string, logOptions?: LogOptions): void {
      emit("info", message, logOptions?.timestamp);
    },
    warn(message: string, logOptions?: LogOptions): void {
      warned = true;
      emit("warn", message, logOptions?.timestamp);
    },
    warnOnce(message: string, logOptions?: LogOptions): void {
      if (once.has(message)) return;
      once.add(message);
      if (once.size > WARN_ONCE_LIMIT) {
        // A Set iterates in insertion order: the first value is the oldest.
        for (const oldest of once) {
          once.delete(oldest);
          break;
        }
      }
      warned = true;
      emit("warn", message, logOptions?.timestamp);
    },
    error(message: string, logOptions?: LogErrorOptions): void {
      if (logOptions?.error !== undefined && logOptions.error !== null)
        logged.add(logOptions.error);
      emit("error", message, logOptions?.timestamp);
    },
    clearScreen(): void {
      if (options.term.interactive) process.stdout.write(CLEAR_SCREEN);
    },
    hasErrorLogged(error: unknown): boolean {
      return typeof error === "object" && error !== null && logged.has(error);
    },
  };
}
