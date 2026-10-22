import { processLocalStores, workerInfo } from "../shared/worker-info";

/**
 * The worker's side of the conversation with the primary of a worker pool. The primary tells a worker to drain with a
 * message; the worker tells the primary when it starts to stop (so the primary does not count that as a crash) and which
 * of its stores live in this process only. The messages carry the key `dusk`, so an app's own use of `process.send` is
 * not disturbed.
 *
 * @packageDocumentation
 */

/** What a worker sends to the primary. @internal */
export type WorkerMessage =
  | { readonly dusk: "stopping" }
  | { readonly dusk: "stores"; readonly labels: readonly string[] };

/** What the primary sends to a worker. @internal */
export interface DrainMessage {
  readonly dusk: "drain";
}

/** The link of one worker to its primary. @internal */
export interface PrimaryLink {
  /** Tells the primary that this worker has started to stop. Sent at most once. */
  stopping(): void;
  /** Tells the primary which stores keep their entries in this process only. Call it once the server listens. */
  listening(): void;
  /** Removes the message listener. */
  dispose(): void;
}

function isDrain(message: unknown): message is DrainMessage {
  return (
    typeof message === "object" && message !== null && Reflect.get(message, "dusk") === "drain"
  );
}

/**
 * Connects a worker to its primary, or returns `undefined` in a process that is not a worker of a pool.
 *
 * @param drain Stops the server gracefully (what `close()` does). Called when the primary asks the worker to drain.
 * @param exit Ends the process with a code once the drain is done.
 * @param report Receives a failure of the drain.
 * @returns The link, or `undefined` for a single process.
 * @internal
 */
export function linkToPrimary(
  drain: () => Promise<void>,
  exit: (code: number) => void,
  report: (error: unknown) => void,
): PrimaryLink | undefined {
  if (!workerInfo().clustered) return undefined;
  const send = (message: WorkerMessage): void => {
    try {
      process.send?.(message);
    } catch {
      // the channel is closed: the primary is gone, and the worker is about to be ended with it
    }
  };
  let announced = false;
  const onMessage = (message: unknown): void => {
    if (!isDrain(message)) return;
    drain().then(
      () => exit(0),
      (error: unknown) => {
        report(error);
        exit(1);
      },
    );
  };
  process.on("message", onMessage);
  return {
    stopping() {
      if (announced) return;
      announced = true;
      send({ dusk: "stopping" });
    },
    listening() {
      const labels = processLocalStores();
      if (labels.length > 0) send({ dusk: "stores", labels });
    },
    dispose() {
      process.off("message", onMessage);
    },
  };
}
