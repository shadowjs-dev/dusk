import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPurgeGuard,
  createRefreshBackoff,
  keepAlive,
} from "../../src/server/stores/revalidation";
import { createSingleFlight } from "../../src/server/stores/single-flight";

/** A promise that is settled by hand, to hold work open while callers join. */
function gate<T>() {
  let open: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("single flight: concurrent callers share one run", () => {
  it("[SF-01] 200 concurrent callers for one key run the work once and all receive its result", async () => {
    const flights = createSingleFlight();
    const held = gate<string>();
    let runs = 0;
    const work = (): Promise<string> => {
      runs += 1;
      return held.promise;
    };
    const callers = Array.from({ length: 200 }, () => flights.run("k", work));
    expect(flights.waiting("k")).toBe(200);
    held.open("page");
    expect(await Promise.all(callers)).toEqual(Array.from({ length: 200 }, () => "page"));
    expect(runs).toBe(1);
    expect(flights.has("k")).toBe(false);
    expect(flights.stats.keys).toBe(0);
  });

  it("[SF-02] different keys run in parallel, and each runs once", async () => {
    const flights = createSingleFlight();
    const runs: Record<string, number> = {};
    const work = (key: string) => async () => {
      runs[key] = (runs[key] ?? 0) + 1;
      return key;
    };
    const results = await Promise.all([
      flights.run("a", work("a")),
      flights.run("b", work("b")),
      flights.run("a", work("a")),
      flights.run("b", work("b")),
    ]);
    expect(results).toEqual(["a", "b", "a", "b"]);
    expect(runs).toEqual({ a: 1, b: 1 });
  });

  it("[SF-03] a failure is shared by the callers that were waiting and forgotten when the run settles", async () => {
    const flights = createSingleFlight();
    const held = gate<string>();
    let runs = 0;
    const work = (): Promise<string> => {
      runs += 1;
      return held.promise;
    };
    const callers = Array.from({ length: 5 }, () => flights.run("k", work));
    const outcomes = Promise.allSettled(callers);
    held.fail(new Error("database is down"));
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toEqual(new Error("database is down"));
    }
    expect(runs).toBe(1);
    // Not cached beyond the in-flight window: the next call runs again and can succeed.
    expect(await flights.run("k", async () => "recovered")).toBe("recovered");
  });

  it("[SF-04] a work function that throws synchronously is a rejection shared like any other", async () => {
    const flights = createSingleFlight();
    const work = (): Promise<string> => {
      throw new TypeError("sync");
    };
    const [a, b] = await Promise.allSettled([flights.run("k", work), flights.run("k", work)]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(flights.has("k")).toBe(false);
  });

  it("[SF-05] with clone, the first caller gets the original and every other caller its own copy", async () => {
    const flights = createSingleFlight();
    const held = gate<{ n: number[] }>();
    const clone = (value: { n: number[] }) => ({ n: [...value.n] });
    const work = () => held.promise;
    const callers = Array.from({ length: 4 }, () => flights.run("k", work, { clone }));
    const original = { n: [1] };
    held.open(original);
    const results = await Promise.all(callers);
    expect(results[0]).toBe(original);
    for (const other of results.slice(1)) {
      expect(other).toEqual(original);
      expect(other).not.toBe(original);
    }
    results[1]?.n.push(2);
    expect(results[2]?.n).toEqual([1]);
  });
});

describe("single flight: leaving and aborting", () => {
  it("[SF-06] a caller that aborts stops waiting at once; the others still get the result and the work is not aborted", async () => {
    const flights = createSingleFlight();
    const held = gate<string>();
    let workSignal: AbortSignal | undefined;
    const work = (signal: AbortSignal): Promise<string> => {
      workSignal = signal;
      return held.promise;
    };
    const leaving = new AbortController();
    const stays = flights.run("k", work);
    const left = flights.run("k", work, { signal: leaving.signal });
    const alsoStays = flights.run("k", work, { signal: new AbortController().signal });
    leaving.abort(new Error("client went away"));
    await expect(left).rejects.toThrow("client went away");
    expect(workSignal?.aborted).toBe(false);
    expect(flights.waiting("k")).toBe(2);
    held.open("done");
    expect(await stays).toBe("done");
    expect(await alsoStays).toBe("done");
  });

  it("[SF-07] when every caller left, the work's signal aborts and the key is free for a new run", async () => {
    const flights = createSingleFlight();
    const first = new AbortController();
    const second = new AbortController();
    let signals: AbortSignal[] = [];
    const work = (signal: AbortSignal): Promise<string> => {
      signals = [...signals, signal];
      return new Promise<string>(() => undefined);
    };
    const a = flights.run("k", work, { signal: first.signal });
    const b = flights.run("k", work, { signal: second.signal });
    first.abort(new Error("a left"));
    await expect(a).rejects.toThrow("a left");
    expect(signals[0]?.aborted).toBe(false);
    second.abort(new Error("b left"));
    await expect(b).rejects.toThrow("b left");
    expect(signals[0]?.aborted).toBe(true);
    expect(flights.has("k")).toBe(false);
    // A new caller starts a new run with a live signal.
    void flights.run("k", work).catch(() => undefined);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("[SF-08] a caller without a signal never leaves: the work is never aborted by the others leaving", async () => {
    const flights = createSingleFlight();
    const held = gate<string>();
    let workSignal: AbortSignal | undefined;
    const work = (signal: AbortSignal): Promise<string> => {
      workSignal = signal;
      return held.promise;
    };
    const leaving = new AbortController();
    const patient = flights.run("k", work);
    const left = flights.run("k", work, { signal: leaving.signal });
    leaving.abort();
    await expect(left).rejects.toBeDefined();
    expect(workSignal?.aborted).toBe(false);
    held.open("ok");
    expect(await patient).toBe("ok");
  });

  it("[SF-09] detached work (a background refresh) keeps the run alive when every caller left", async () => {
    const flights = createSingleFlight();
    const held = gate<string>();
    let workSignal: AbortSignal | undefined;
    const work = (signal: AbortSignal): Promise<string> => {
      workSignal = signal;
      return held.promise;
    };
    const background = flights.run("k", work, { detached: true });
    const leaving = new AbortController();
    const caller = flights.run("k", work, { signal: leaving.signal });
    leaving.abort();
    await expect(caller).rejects.toBeDefined();
    expect(workSignal?.aborted).toBe(false);
    held.open("kept");
    expect(await background).toBe("kept");
  });

  it("[SF-10] a signal that is already aborted is refused without starting or joining a run", async () => {
    const flights = createSingleFlight();
    const gone = new AbortController();
    gone.abort(new Error("already gone"));
    let runs = 0;
    await expect(
      flights.run(
        "k",
        async () => {
          runs += 1;
          return 1;
        },
        { signal: gone.signal },
      ),
    ).rejects.toThrow("already gone");
    expect(runs).toBe(0);
    expect(flights.has("k")).toBe(false);
  });

  it("[SF-11] a caller that stopped waiting holds no listener and no slot", async () => {
    const flights = createSingleFlight({ maxWaiters: 2 });
    const held = gate<string>();
    const work = () => held.promise;
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const calls = controllers.map((controller) =>
      flights.run("k", work, { signal: controller.signal }),
    );
    // Two shared the run, the third ran on its own (the bound); nobody is rejected for the bound.
    expect(flights.waiting("k")).toBe(2);
    controllers[0]?.abort();
    await expect(calls[0]).rejects.toBeDefined();
    expect(flights.waiting("k")).toBe(1);
    held.open("x");
    expect(await calls[1]).toBe("x");
  });
});

describe("single flight: bounds", () => {
  it("[SF-12] past maxWaiters per key the extra caller runs on its own and nothing is refused", async () => {
    const flights = createSingleFlight({ maxWaiters: 3 });
    const held = gate<string>();
    let runs = 0;
    const work = (): Promise<string> => {
      runs += 1;
      return runs === 1 ? held.promise : Promise.resolve(`own-${runs}`);
    };
    const callers = Array.from({ length: 5 }, () => flights.run("k", work));
    // Three joined the first run; the 4th and 5th ran alone.
    expect(runs).toBe(3);
    expect(flights.stats.overflowWaiters).toBe(2);
    held.open("shared");
    expect(await Promise.all(callers)).toEqual(["shared", "shared", "shared", "own-2", "own-3"]);
  });

  it("[SF-13] past maxKeys keys in flight a new key runs on its own; the existing keys still coalesce", async () => {
    const flights = createSingleFlight({ maxKeys: 2 });
    const held = gate<string>();
    const work = () => held.promise;
    const a = flights.run("a", work);
    const b = flights.run("b", work);
    let overflowRuns = 0;
    const c = flights.run("c", async () => {
      overflowRuns += 1;
      return "c";
    });
    expect(await c).toBe("c");
    expect(flights.stats.overflowKeys).toBe(1);
    expect(flights.has("c")).toBe(false);
    // A second caller of "a" still joins the run in flight.
    const again = flights.run("a", async () => "never");
    held.open("shared");
    expect(await Promise.all([a, b, again])).toEqual(["shared", "shared", "shared"]);
    expect(overflowRuns).toBe(1);
  });

  it("[SF-14] defaults: 1 000 callers per key and 10 000 keys", async () => {
    const flights = createSingleFlight();
    const held = gate<number>();
    let runs = 0;
    const work = (): Promise<number> => {
      runs += 1;
      return held.promise;
    };
    const sharing = Array.from({ length: 1_000 }, () => flights.run("hot", work));
    const overflow = flights.run("hot", async () => -1);
    expect(runs).toBe(1);
    expect(flights.stats.overflowWaiters).toBe(1);
    expect(await overflow).toBe(-1);
    const keyed = Array.from({ length: 9_999 }, (_unused, index) =>
      flights.run(`key-${index}`, () => held.promise),
    );
    expect(flights.stats.keys).toBe(10_000);
    const beyond = flights.run("one-more", async () => -2);
    expect(await beyond).toBe(-2);
    expect(flights.stats.overflowKeys).toBe(1);
    held.open(7);
    expect((await Promise.all(sharing)).every((value) => value === 7)).toBe(true);
    await Promise.all(keyed);
    expect(flights.stats.keys).toBe(0);
  });

  it("[SF-15] bounds that are not whole numbers are RangeErrors", () => {
    expect(() => createSingleFlight({ maxWaiters: 0 })).toThrow(RangeError);
    expect(() => createSingleFlight({ maxKeys: 1.5 })).toThrow(RangeError);
    expect(() => createSingleFlight({ timeoutMs: -1 })).toThrow(RangeError);
  });
});

describe("single flight: timeout", () => {
  it("[SF-16] work that outlives the timeout is abandoned: waiters fail with TimeoutError, the signal aborts, the key is free", async () => {
    vi.useFakeTimers();
    const flights = createSingleFlight({ timeoutMs: 5_000 });
    let workSignal: AbortSignal | undefined;
    const work = (signal: AbortSignal): Promise<string> => {
      workSignal = signal;
      return new Promise<string>(() => undefined);
    };
    const callers = [flights.run("k", work), flights.run("k", work)];
    const outcomes = Promise.allSettled(callers);
    await vi.advanceTimersByTimeAsync(5_000);
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe("rejected");
      expect(((outcome as PromiseRejectedResult).reason as DOMException).name).toBe("TimeoutError");
    }
    expect(workSignal?.aborted).toBe(true);
    expect(flights.has("k")).toBe(false);
    expect(flights.stats.timedOut).toBe(1);
    expect(await flights.run("k", async () => "again")).toBe("again");
  });

  it("[SF-17] a run that finishes in time leaves no timer behind", async () => {
    vi.useFakeTimers();
    const flights = createSingleFlight({ timeoutMs: 5_000 });
    await flights.run("k", async () => 1);
    await flights
      .run("k", async () => {
        throw new Error("x");
      })
      .catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("refresh backoff", () => {
  it("[SF-18] each failure doubles the wait up to the maximum, and a success forgets the key", () => {
    const backoff = createRefreshBackoff({ baseMs: 1_000, maxMs: 5_000 });
    expect(backoff.waiting("k", 0)).toBe(false);
    backoff.failed("k", 0);
    expect(backoff.waiting("k", 999)).toBe(true);
    expect(backoff.waiting("k", 1_000)).toBe(false);
    backoff.failed("k", 1_000);
    expect(backoff.waiting("k", 2_999)).toBe(true);
    expect(backoff.waiting("k", 3_000)).toBe(false);
    backoff.failed("k", 3_000);
    expect(backoff.waiting("k", 6_999)).toBe(true);
    expect(backoff.waiting("k", 7_000)).toBe(false);
    // The fourth wait would be 8 000 ms: capped at 5 000.
    backoff.failed("k", 7_000);
    expect(backoff.waiting("k", 11_999)).toBe(true);
    expect(backoff.waiting("k", 12_000)).toBe(false);
    backoff.succeeded("k");
    expect(backoff.size).toBe(0);
  });

  it("[SF-19] a key that stays quiet for a whole maximum wait starts again from the base delay", () => {
    const backoff = createRefreshBackoff({ baseMs: 1_000, maxMs: 4_000 });
    backoff.failed("k", 0);
    backoff.failed("k", 1_000);
    backoff.failed("k", 3_000);
    expect(backoff.waiting("k", 6_999)).toBe(true);
    backoff.failed("k", 20_000);
    expect(backoff.waiting("k", 20_999)).toBe(true);
    expect(backoff.waiting("k", 21_000)).toBe(false);
  });

  it("[SF-20] the table is bounded: the oldest keys are forgotten past maxKeys", () => {
    const backoff = createRefreshBackoff({ maxKeys: 3 });
    for (let index = 0; index < 10; index += 1) backoff.failed(`k${index}`, 0);
    expect(backoff.size).toBe(3);
    expect(backoff.waiting("k0", 1)).toBe(false);
    expect(backoff.waiting("k9", 1)).toBe(true);
  });

  it("[SF-21] delays that are not positive whole numbers, or a maximum below the base, are RangeErrors", () => {
    expect(() => createRefreshBackoff({ baseMs: 0 })).toThrow(RangeError);
    expect(() => createRefreshBackoff({ baseMs: 2_000, maxMs: 1_000 })).toThrow(RangeError);
  });
});

describe("purge guard", () => {
  it("[SF-22] a result computed before a purge of one of its tags is touched; a purge of another tag, or before the mark, is not", () => {
    const guard = createPurgeGuard();
    guard.purged("old");
    const mark = guard.mark();
    expect(guard.touched(mark, ["old", "posts"])).toBe(false);
    guard.purged("other");
    expect(guard.touched(mark, ["old", "posts"])).toBe(false);
    guard.purged("posts");
    expect(guard.touched(mark, ["old", "posts"])).toBe(true);
    expect(guard.touched(guard.mark(), ["posts"])).toBe(false);
  });

  it("[SF-23] a mark older than the purges still remembered is treated as touched", () => {
    const guard = createPurgeGuard(2);
    const mark = guard.mark();
    guard.purged("a");
    guard.purged("b");
    guard.purged("c");
    expect(guard.touched(mark, ["unrelated"])).toBe(true);
    expect(guard.touched(guard.mark(), ["unrelated"])).toBe(false);
  });
});

describe("keepAlive", () => {
  it("[SF-24] hands the work to the platform's waitUntil, with the platform as this", () => {
    const taken: Promise<unknown>[] = [];
    const platform = {
      waitUntil(this: unknown, promise: Promise<unknown>) {
        expect(this).toBe(platform);
        taken.push(promise);
      },
    };
    const work = Promise.resolve();
    expect(keepAlive(platform, work, () => undefined)).toBe(true);
    expect(taken).toEqual([work]);
  });

  it("[SF-25] without a waitUntil nothing is handed over; a waitUntil that throws is reported, not rethrown", () => {
    expect(keepAlive(undefined, Promise.resolve(), () => undefined)).toBe(false);
    expect(keepAlive({}, Promise.resolve(), () => undefined)).toBe(false);
    const seen: unknown[] = [];
    const platform = {
      waitUntil() {
        throw new Error("after the response was sent");
      },
    };
    expect(keepAlive(platform, Promise.resolve(), (error) => seen.push(error))).toBe(false);
    expect(seen).toEqual([new Error("after the response was sent")]);
  });
});
