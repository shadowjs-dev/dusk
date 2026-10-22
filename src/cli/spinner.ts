import { glyphsOf, paint, type Terminal } from "./output";

/**
 * The spinner of the commands that make a person wait (`dusk build`, the start of `dusk dev`): one line that turns while
 * the work runs and is erased when it ends, so the output that follows starts on a clean line. It only exists on a
 * terminal a person is watching; on a pipe, in CI or with no color support for cursor moves it does nothing, so a log
 * never holds a frame. Anything else that prints while it runs goes through {@link Spinner.around}, which erases the
 * line first and draws it again after.
 *
 * @packageDocumentation
 */

/** A running spinner. @since 1.0.0 */
export interface Spinner {
  /** Runs `write` with the spinner line erased, then draws it again. Use it for every line printed while the spinner runs. */
  around(write: () => void): void;
  /** Changes the text next to the spinner. */
  label(text: string): void;
  /** Erases the line and stops the timer. Safe to call more than once. */
  stop(): void;
}

/** The time between two frames, in milliseconds. @since 1.0.0 */
export const FRAME_MS = 80;

/** The sequence that moves to the start of the line and erases it. @internal */
const ERASE_LINE = `\r${String.fromCharCode(27)}[2K`;

/** A spinner that does nothing, for output that is not a terminal. @internal */
const NONE: Spinner = {
  around: (write) => write(),
  label: () => undefined,
  stop: () => undefined,
};

/**
 * Starts a spinner on a terminal a person is watching.
 * @param term The output's rules; the spinner is silent unless `term.interactive`.
 * @param text What is being done (`Building for production`).
 * @param write Where the frames go. Defaults to stdout.
 * @returns The spinner. Stop it in a `finally`.
 * @since 1.0.0
 */
export function startSpinner(
  term: Terminal,
  text: string,
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): Spinner {
  if (!term.interactive) return NONE;
  const frames = glyphsOf(term).spinner;
  let label = text;
  let frame = 0;
  let running = true;
  const draw = (): void => {
    const shown = frames[frame % frames.length] ?? "";
    frame += 1;
    // Never wider than the terminal: a wrapped line cannot be erased with one carriage return.
    const room = term.columns === undefined ? label : label.slice(0, Math.max(0, term.columns - 4));
    write(`${ERASE_LINE}${paint(term, "cyan", shown)} ${paint(term, "dim", room)}`);
  };
  draw();
  const timer = setInterval(draw, FRAME_MS);
  // A spinner must never keep the process alive: the work it shows is what does.
  timer.unref();
  return {
    around(printed) {
      if (!running) {
        printed();
        return;
      }
      write(ERASE_LINE);
      try {
        printed();
      } finally {
        draw();
      }
    },
    label(next) {
      label = next;
    },
    stop() {
      if (!running) return;
      running = false;
      clearInterval(timer);
      write(ERASE_LINE);
    },
  };
}
