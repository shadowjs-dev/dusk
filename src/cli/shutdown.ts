/**
 * Runs a server until the user stops it. The first SIGINT or SIGTERM closes the server gracefully and the command exits
 * 0; a second signal while that is still closing forces exit 1. A failed close exits 1 and is reported.
 *
 * @packageDocumentation
 */

/** What the command says at each step of a stop. @since 1.0.0 */
export interface StopHooks {
  /** Called once, when the first signal arrives, before the close starts. */
  readonly signaled?: (signal: NodeJS.Signals) => void;
  /** Called after a clean close. */
  readonly stopped?: () => void;
  /** Called when a second signal arrives while the close is still running. */
  readonly forced?: () => void;
}

/**
 * Waits for the stop signals, then calls `stop`.
 * @param stop Closes the server. Called once, on the first signal.
 * @param report Reports a failure of `stop`.
 * @param hooks What to say at each step.
 * @returns The exit code: 0 after a clean stop, 1 after a failed stop or a second signal.
 * @since 1.0.0
 */
export function untilStopped(
  stop: () => Promise<void>,
  report: (error: unknown) => void,
  hooks: StopHooks = {},
): Promise<number> {
  return new Promise((resolve) => {
    let stopping = false;
    // The listeners are the command's own; they go away with the answer so a process that runs a command again (a test, an embedder) does not collect them.
    const resolveStopped = (code: number): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(code);
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) {
        hooks.forced?.();
        resolveStopped(1);
        return;
      }
      stopping = true;
      hooks.signaled?.(signal);
      stop().then(
        () => {
          hooks.stopped?.();
          resolveStopped(0);
        },
        (error: unknown) => {
          report(error);
          resolveStopped(1);
        },
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}
