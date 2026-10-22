/**
 * `untilStopped`, the wait that `dusk dev` and `dusk start` end with.
 *
 * - CLI-SHD-1 the first signal closes once and resolves 0; the listeners it added are gone afterward.
 * - CLI-SHD-2 a second signal while the close is running resolves 1 and removes the listeners too.
 * - CLI-SHD-3 a failed close is reported, resolves 1, and removes the listeners.
 */
import { afterEach, describe, expect, it } from "vitest";
import { untilStopped } from "../../src/cli/shutdown";

const signals = ["SIGINT", "SIGTERM"] as const;

/** How many listeners each stop signal has right now. */
function counts(): number[] {
  return signals.map((signal) => process.listenerCount(signal));
}

const before = counts();

afterEach(() => {
  // A failed assertion must not leave a listener that would answer a later test's signal.
  for (const signal of signals) process.removeAllListeners(signal);
});

describe("untilStopped", () => {
  it("[CLI-SHD-1] closes once on the first signal, resolves 0, and removes its listeners", async () => {
    let closes = 0;
    const waiting = untilStopped(
      async () => {
        closes += 1;
      },
      () => undefined,
    );
    expect(counts()).toEqual(before.map((count) => count + 1));
    process.emit("SIGTERM");
    expect(await waiting).toBe(0);
    expect(closes).toBe(1);
    expect(counts()).toEqual(before);
  });

  it("[CLI-SHD-2] a second signal during the close resolves 1 and removes its listeners", async () => {
    let release: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    let forced = 0;
    const waiting = untilStopped(
      () => closing,
      () => undefined,
      {
        forced: () => {
          forced += 1;
        },
      },
    );
    process.emit("SIGINT");
    process.emit("SIGINT");
    expect(await waiting).toBe(1);
    expect(forced).toBe(1);
    expect(counts()).toEqual(before);
    // The close that was still running settles later and must not resolve or throw anything.
    release();
  });

  it("[CLI-SHD-3] a failed close is reported, resolves 1, and removes its listeners", async () => {
    const reported: unknown[] = [];
    const failure = new Error("close failed");
    const waiting = untilStopped(
      () => Promise.reject(failure),
      (error) => reported.push(error),
    );
    process.emit("SIGINT");
    expect(await waiting).toBe(1);
    expect(reported).toEqual([failure]);
    expect(counts()).toEqual(before);
  });
});
