/**
 * Single flight: concurrent callers for one key share one piece of work. The page cache (`isr.ts`) and the
 * data cache (`data-cache.ts`) both coalesce misses and background refreshes through it, so they obey the
 * same rules:
 *
 * - the first caller starts the work, the others join it and receive the same result (a failure too: it is
 *   shared by the callers that were waiting and forgotten when the work settles, so the next call runs again);
 * - a caller that leaves (its `signal` aborts) stops waiting at once and never aborts the shared work, unless
 *   every caller left: then the work's own signal aborts and the key is free for a new run;
 * - the table is bounded: at most `maxKeys` keys in flight and `maxWaiters` callers per key. Past either
 *   bound a call is not refused: it runs on its own, uncoalesced, as it would without the cache;
 * - work that outlives `timeoutMs` is abandoned: its waiters fail with a `TimeoutError` and the key is free.
 *
 * @packageDocumentation
 */

/** Options of {@link createSingleFlight}. @since 1.0.0 */
export interface SingleFlightOptions {
  /** Most callers that share one run. Default 1 000. */
  readonly maxWaiters?: number;
  /** Most keys with work in flight. Default 10 000. */
  readonly maxKeys?: number;
  /** Milliseconds after which a run is abandoned (0: never). Default 0. */
  readonly timeoutMs?: number;
}

/** What one call to {@link SingleFlight.run} can say about itself. @since 1.0.0 */
export interface FlightCall<T> {
  /**
   * The caller's own signal. When it aborts the caller stops waiting (its promise rejects with the signal's
   * reason); the shared work is aborted only when no caller is left.
   */
  readonly signal?: AbortSignal | undefined;
  /** Background work with no caller waiting: it keeps the run alive, whatever the other callers do. */
  readonly detached?: boolean;
  /**
   * Copies the result for every caller after the first, so callers cannot change what the others received.
   * Absent: the callers share the value.
   */
  readonly clone?: ((value: T) => T) | undefined;
}

/** Counters of a {@link SingleFlight}, for tests and diagnostics. @since 1.0.0 */
export interface FlightStats {
  /** Keys with work in flight now. */
  readonly keys: number;
  /** Calls that ran on their own because the table of keys was full. */
  readonly overflowKeys: number;
  /** Calls that ran on their own because a key already had `maxWaiters` callers. */
  readonly overflowWaiters: number;
  /** Runs abandoned after `timeoutMs`. */
  readonly timedOut: number;
}

/** The coalescing table. @since 1.0.0 */
export interface SingleFlight {
  /**
   * Runs `work` for `key`, or joins the run that is in flight.
   *
   * @param key The key.
   * @param work The work; it receives the signal that aborts when every caller left or the run timed out.
   * @param call The caller's signal, `detached` flag and `clone`.
   * @returns The result of the shared run.
   * @throws The reason of the caller's `signal` when it aborts; whatever the work throws.
   */
  run<T>(key: string, work: (signal: AbortSignal) => Promise<T>, call?: FlightCall<T>): Promise<T>;
  /** Whether work for `key` is in flight. */
  has(key: string): boolean;
  /** The number of callers waiting on `key` (0 when nothing is in flight). */
  waiting(key: string): number;
  /** The number of keys with work in flight. */
  readonly size: number;
  /** The counters. */
  readonly stats: FlightStats;
}

/** A run in flight. */
interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  /** Callers that joined and have not left. */
  waiters: number;
  /** Callers that still want the result (detached work counts as one that never leaves). */
  wanting: number;
  /** Callers that joined so far; the first one receives the original value. */
  joined: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_MAX_WAITERS = 1_000;
const DEFAULT_MAX_KEYS = 10_000;

function checkBound(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      `createSingleFlight: ${name} must be ${minimum === 0 ? "a whole number, 0 or more" : "a positive integer"}.`,
    );
  }
}

/**
 * Creates a coalescing table.
 *
 * @param options The bounds and the timeout.
 * @returns The table.
 * @throws RangeError for a bound that is not a positive integer, or a timeout that is not a whole number of milliseconds.
 * @example
 * const flights = createSingleFlight({ maxWaiters: 500 });
 * const page = await flights.run("/news", () => renderNews());
 * @since 1.0.0
 */
export function createSingleFlight(options: SingleFlightOptions = {}): SingleFlight {
  const maxWaiters = options.maxWaiters ?? DEFAULT_MAX_WAITERS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const timeoutMs = options.timeoutMs ?? 0;
  checkBound("maxWaiters", maxWaiters, 1);
  checkBound("maxKeys", maxKeys, 1);
  checkBound("timeoutMs", timeoutMs, 0);
  const flights = new Map<string, Flight>();
  let overflowKeys = 0;
  let overflowWaiters = 0;
  let timedOut = 0;

  /** Frees the key (when it still belongs to this run) and its timer. */
  const release = (key: string, flight: Flight): void => {
    if (flight.timer !== undefined) clearTimeout(flight.timer);
    flight.timer = undefined;
    if (flights.get(key) === flight) flights.delete(key);
  };

  const start = <T>(key: string, work: (signal: AbortSignal) => Promise<T>): Flight => {
    const controller = new AbortController();
    let expire: ((reason: unknown) => void) | undefined;
    // Calling `work` inside an async function turns a synchronous throw into a rejection.
    const running = (async (): Promise<T> => work(controller.signal))();
    const racing: Promise<T> =
      timeoutMs === 0
        ? running
        : Promise.race([
            running,
            new Promise<never>((_resolve, reject) => {
              expire = reject;
            }),
          ]);
    const flight: Flight = {
      controller,
      promise: racing,
      waiters: 0,
      wanting: 0,
      joined: 0,
      timer: undefined,
    };
    if (expire !== undefined) {
      const reject = expire;
      flight.timer = setTimeout(() => {
        flight.timer = undefined;
        timedOut += 1;
        const reason = new DOMException(
          `The work for this key did not finish in ${timeoutMs} ms.`,
          "TimeoutError",
        );
        release(key, flight);
        controller.abort(reason);
        reject(reason);
      }, timeoutMs);
      // A pending timer must not keep a process alive on its own: the work it watches does that while it runs.
      if (typeof flight.timer === "object" && "unref" in flight.timer) flight.timer.unref();
    }
    const settled = (): void => release(key, flight);
    racing.then(settled, settled);
    flights.set(key, flight);
    return flight;
  };

  const join = <T>(key: string, flight: Flight, call: FlightCall<T>): Promise<T> => {
    const { signal, clone } = call;
    const detached = call.detached === true;
    const follower = flight.joined > 0;
    flight.joined += 1;
    flight.waiters += 1;
    flight.wanting += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const leave = (): void => {
        if (done) return;
        finish();
        flight.wanting -= 1;
        reject(signal?.reason);
        // Everyone left: stop the work and free the key for a new run.
        if (flight.wanting === 0) {
          release(key, flight);
          flight.controller.abort(signal?.reason);
        }
      };
      const finish = (): void => {
        done = true;
        flight.waiters -= 1;
        signal?.removeEventListener("abort", leave);
      };
      if (signal !== undefined && !detached)
        signal.addEventListener("abort", leave, { once: true });
      (flight.promise as Promise<T>).then(
        (value) => {
          if (done) return;
          finish();
          resolve(follower && clone !== undefined ? clone(value) : value);
        },
        (error: unknown) => {
          if (done) return;
          finish();
          reject(error);
        },
      );
    });
  };

  return {
    run<T>(
      key: string,
      work: (signal: AbortSignal) => Promise<T>,
      call: FlightCall<T> = {},
    ): Promise<T> {
      const { signal } = call;
      if (signal?.aborted === true && call.detached !== true) return Promise.reject(signal.reason);
      const existing = flights.get(key);
      if (existing !== undefined) {
        if (existing.waiters < maxWaiters) return join(key, existing, call);
        overflowWaiters += 1;
        return work(signal ?? new AbortController().signal);
      }
      if (flights.size >= maxKeys) {
        overflowKeys += 1;
        return work(signal ?? new AbortController().signal);
      }
      return join(key, start(key, work), call);
    },
    get size(): number {
      return flights.size;
    },
    has: (key) => flights.has(key),
    waiting: (key) => flights.get(key)?.waiters ?? 0,
    get stats(): FlightStats {
      return { keys: flights.size, overflowKeys, overflowWaiters, timedOut };
    },
  };
}
