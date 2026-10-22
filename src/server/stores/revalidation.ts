/**
 * The small parts the page cache and the data cache share around a background refresh: a backoff for a key
 * whose refresh keeps failing, the hand-off to the platform's `waitUntil`, and a guard that keeps a render
 * that started before a purge from storing its (older) result after it.
 *
 * @packageDocumentation
 */

/** A bounded record of keys whose background refresh failed. @since 1.0.0 */
export interface RefreshBackoff {
  /** Whether a refresh of `key` should wait: it failed recently and its delay has not passed. */
  waiting(key: string, now: number): boolean;
  /** Records a failed refresh: the next one waits twice as long as the last, up to the maximum. */
  failed(key: string, now: number): void;
  /** Records a successful refresh: the key is forgotten. */
  succeeded(key: string): void;
  /** Keys remembered now (for tests and diagnostics). */
  readonly size: number;
}

/** Options of {@link createRefreshBackoff}. @since 1.0.0 */
export interface RefreshBackoffOptions {
  /** Delay after the first failure, in milliseconds. Default 1 000. */
  readonly baseMs?: number;
  /** Longest delay, in milliseconds. Default 60 000. */
  readonly maxMs?: number;
  /** Keys remembered; the oldest is forgotten past it. Default 10 000. */
  readonly maxKeys?: number;
}

interface Failure {
  readonly failures: number;
  readonly until: number;
}

/**
 * Creates a refresh backoff. A key that stays quiet for a whole maximum delay after its wait ended starts
 * again from the base delay, and the table never holds more than `maxKeys` keys.
 *
 * @param options The delays and the bound.
 * @returns The backoff.
 * @throws RangeError for a delay or bound that is not a positive integer, or `maxMs` below `baseMs`.
 * @example
 * const backoff = createRefreshBackoff({ baseMs: 500 });
 * backoff.failed("/news", Date.now());
 * backoff.waiting("/news", Date.now()); // true
 * @since 1.0.0
 */
export function createRefreshBackoff(options: RefreshBackoffOptions = {}): RefreshBackoff {
  const baseMs = options.baseMs ?? 1_000;
  const maxMs = options.maxMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  for (const [name, value] of [
    ["baseMs", baseMs],
    ["maxMs", maxMs],
    ["maxKeys", maxKeys],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`createRefreshBackoff: ${name} must be a positive integer.`);
    }
  }
  if (maxMs < baseMs) throw new RangeError("createRefreshBackoff: maxMs must not be below baseMs.");
  const failures = new Map<string, Failure>();
  return {
    get size(): number {
      return failures.size;
    },
    waiting(key, now) {
      const found = failures.get(key);
      if (found === undefined) return false;
      if (now < found.until) return true;
      if (now - found.until > maxMs) failures.delete(key);
      return false;
    },
    failed(key, now) {
      const previous = failures.get(key);
      const quiet = previous === undefined || now - previous.until > maxMs;
      const count = quiet ? 1 : previous.failures + 1;
      // Insertion order is age order: a key that fails again moves to the young end.
      failures.delete(key);
      failures.set(key, {
        failures: count,
        until: now + Math.min(maxMs, baseMs * 2 ** (count - 1)),
      });
      while (failures.size > maxKeys) {
        const oldest = failures.keys().next();
        if (oldest.done === true) break;
        failures.delete(oldest.value);
      }
    },
    succeeded(key) {
      failures.delete(key);
    },
  };
}

/**
 * Hands background work to the platform's `waitUntil`, so a serverless instance stays alive until it ends.
 * Without a `waitUntil` the work simply continues in the process (bounded by the caller's own limits). A
 * `waitUntil` that throws (Workers do after the response was sent) is reported, never rethrown.
 *
 * @param platform The host object of the request (`event.platform`).
 * @param work The background work; it must not reject.
 * @param report Receives a failure of the hand-off.
 * @returns Whether the platform took the work.
 * @example
 * keepAlive(event.platform, refresh, (error) => console.error(error));
 * @since 1.0.0
 */
export function keepAlive(
  platform: unknown,
  work: Promise<unknown>,
  report: (error: unknown) => void,
): boolean {
  const hook: unknown =
    typeof platform === "object" && platform !== null
      ? Reflect.get(platform, "waitUntil")
      : undefined;
  if (typeof hook !== "function") return false;
  try {
    Reflect.apply(hook, platform, [work]);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

/** Remembers recent purges so a result computed before one is not stored after it. @since 1.0.0 */
export interface PurgeGuard {
  /** A mark to take before the work starts. */
  mark(): number;
  /** Records a purge of `tag`; call it before the entries are removed. */
  purged(tag: string): void;
  /** Whether a purge of any of `tags` happened after `mark` was taken. */
  touched(mark: number, tags: readonly string[]): boolean;
}

/**
 * Creates a purge guard. It keeps the last `limit` purges (default 256); a mark older than the oldest one
 * kept is treated as touched, so a result is never stored when the guard cannot prove it is current.
 *
 * @param limit Purges remembered.
 * @returns The guard.
 * @throws RangeError for a limit that is not a positive integer.
 * @example
 * const guard = createPurgeGuard();
 * const mark = guard.mark();
 * guard.purged("posts");
 * guard.touched(mark, ["posts"]); // true
 * @since 1.0.0
 */
export function createPurgeGuard(limit = 256): PurgeGuard {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("createPurgeGuard: limit must be a positive integer.");
  }
  let epoch = 0;
  /** Epoch of the newest purge that was dropped from the log. */
  let dropped = 0;
  const log: { readonly epoch: number; readonly tag: string }[] = [];
  return {
    mark: () => epoch,
    purged(tag) {
      epoch += 1;
      log.push({ epoch, tag });
      if (log.length > limit) {
        const oldest = log.shift();
        if (oldest !== undefined) dropped = oldest.epoch;
      }
    },
    touched(mark, tags) {
      if (mark < dropped) return true;
      for (const purge of log) if (purge.epoch > mark && tags.includes(purge.tag)) return true;
      return false;
    },
  };
}
