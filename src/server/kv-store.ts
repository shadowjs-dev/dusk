/**
 * The one key-value interface of Dusk. The ISR page cache, the data cache (`cacheData`), sessions and the
 * rate limiter are all built on a {@link KVStore}, so one store (memory, a file, or a Redis-like service
 * behind the adapter contract) serves them all.
 *
 * Contract (every implementation passes the conformance suite in `@shadow-js/dusk/testing`):
 * - a key is a string of 1 to 512 characters without NUL;
 * - a value is JSON data: a stored value is a copy, so a later change to the object does not change it;
 *   `undefined`, functions, symbols, bigints, cycles and non-finite numbers are refused with a TypeError;
 * - `ttlSeconds` expires an entry; an expired entry is absent from `get`, `increment` and `list`;
 * - `increment` adds to a number (a missing key starts at 0); its `ttlSeconds` applies when the call creates
 *   the key, and an existing key keeps its expiry;
 * - `list` returns keys with a prefix in code-unit order, `limit` at a time (1 to 1000), with a cursor;
 * - tags are not part of the interface: the cache layer keeps its own tag index with plain keys, so every
 *   store works unchanged.
 *
 * @packageDocumentation
 */

/** Options of `set` and `increment`. @since 1.0.0 */
export interface KVWriteOptions {
  /** Seconds until the entry expires. Absent: no expiry. Must be a positive integer. */
  readonly ttlSeconds?: number | undefined;
}

/** Options of `list`. @since 1.0.0 */
export interface KVListOptions {
  /** Only keys starting with this text. Default `""`. */
  readonly prefix?: string | undefined;
  /** Keys per page, 1 to 1000. Default 100. */
  readonly limit?: number | undefined;
  /** The `cursor` of the previous page. */
  readonly cursor?: string | undefined;
}

/** One page of keys. @since 1.0.0 */
export interface KVListPage {
  readonly keys: readonly string[];
  /** Pass to the next `list` call; absent on the last page. */
  readonly cursor: string | undefined;
}

/**
 * The key-value store. Every method is asynchronous, so a store may live in another process.
 * @since 1.0.0
 */
export interface KVStore {
  /** The value under `key`, or `undefined` when there is none (or it expired). */
  get(key: string): Promise<unknown>;
  /** Stores `value` under `key`, replacing any value there. */
  set(key: string, value: unknown, options?: KVWriteOptions): Promise<void>;
  /** Removes `key`. A missing key is not an error. */
  delete(key: string): Promise<void>;
  /** The keys with a prefix, one page at a time. */
  list(options?: KVListOptions): Promise<KVListPage>;
  /** Adds `by` to the number under `key` and returns the new value. */
  increment(key: string, by?: number, options?: KVWriteOptions): Promise<number>;
}

/** Limits every store checks. @internal */
export const KV_LIMITS: {
  readonly maxKeyLength: number;
  readonly defaultListLimit: number;
  readonly maxListLimit: number;
  readonly defaultMaxValueBytes: number;
} = {
  maxKeyLength: 512,
  defaultListLimit: 100,
  maxListLimit: 1000,
  defaultMaxValueBytes: 1024 * 1024,
} as const;

/**
 * Checks a key. Throws for a key the contract does not allow.
 *
 * @param key The key.
 * @throws TypeError for a non-string or a NUL; RangeError for a length outside 1 to 512.
 * @internal
 */
export function checkKey(key: unknown): asserts key is string {
  if (typeof key !== "string") throw new TypeError("KVStore: a key must be a string.");
  if (key.length < 1 || key.length > KV_LIMITS.maxKeyLength) {
    throw new RangeError(`KVStore: a key must be 1 to ${KV_LIMITS.maxKeyLength} characters.`);
  }
  if (key.includes("\u0000")) throw new TypeError("KVStore: a key must not contain NUL.");
}

/**
 * Checks a TTL. Throws for anything but a positive integer.
 *
 * @param options The write options.
 * @returns The TTL in seconds, or `undefined`.
 * @throws RangeError for a TTL that is not a positive integer.
 * @internal
 */
export function checkTtl(options: KVWriteOptions | undefined): number | undefined {
  const ttl = options?.ttlSeconds;
  if (ttl === undefined) return undefined;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 315_360_000) {
    throw new RangeError("KVStore: ttlSeconds must be a positive integer (at most ten years).");
  }
  return ttl;
}

/**
 * The JSON text of a value, checked against the contract. Used by every implementation so they refuse
 * the same values.
 *
 * @param value The value.
 * @param maxBytes The largest text accepted.
 * @returns The JSON text.
 * @throws TypeError for a value with no JSON form; RangeError when it is larger than `maxBytes`.
 * @internal
 */
export function encodeValue(value: unknown, maxBytes: number): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new TypeError("KVStore: NaN and Infinity have no JSON form.");
      }
      return item;
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("KVStore: the value must be JSON data (a cycle or a bigint).");
  }
  if (typeof text !== "string") {
    throw new TypeError(
      "KVStore: the value must be JSON data (undefined, a function or a symbol has no JSON form).",
    );
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RangeError(`KVStore: a value is limited to ${maxBytes} bytes.`);
  }
  return text;
}

/**
 * Serializes the work done for one key: operations on the same key run one after another. Only the
 * operations in flight are kept, so the table is bounded by the concurrency.
 *
 * @returns A function that runs `work` after the previous work for `key`.
 * @internal
 */
export type KeyLock = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function createKeyLock(): KeyLock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** Options of {@link createMemoryKVStore}. @since 1.0.0 */
export interface MemoryKVStoreOptions {
  /** Most entries kept; the least recently used is evicted first. Default 10 000. */
  readonly maxEntries?: number;
  /** Largest value in bytes of JSON text. Default 1 MiB. */
  readonly maxValueBytes?: number;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * The in-process store: a bounded least-recently-used table of JSON text. It is the default for the page
 * cache, the data cache, sessions and rate limits of a single process.
 *
 * @param options The bounds and the clock.
 * @returns The store, with a `size` for tests and metrics.
 * @throws RangeError for a bound that is not a positive integer.
 * @example
 * const kv = createMemoryKVStore({ maxEntries: 5_000 });
 * await kv.set("greeting", { text: "hi" }, { ttlSeconds: 60 });
 * @since 1.0.0
 */
export function createMemoryKVStore(
  options: MemoryKVStoreOptions = {},
): KVStore & { readonly size: number } {
  const maxEntries = options.maxEntries ?? 10_000;
  const maxValueBytes = options.maxValueBytes ?? KV_LIMITS.defaultMaxValueBytes;
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new RangeError("createMemoryKVStore: maxEntries must be a positive integer.");
  if (!Number.isInteger(maxValueBytes) || maxValueBytes < 1)
    throw new RangeError("createMemoryKVStore: maxValueBytes must be a positive integer.");
  const now = options.now ?? Date.now;
  const entries = new Map<
    string,
    { readonly text: string; readonly expiresAt: number | undefined }
  >();

  /** The live entry of a key; an expired one is removed as it is found. */
  const live = (key: string) => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  /** Stores a text and moves the key to the most recently used end. */
  const put = (key: string, text: string, expiresAt: number | undefined): void => {
    entries.delete(key);
    entries.set(key, { text, expiresAt });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };

  return {
    get size(): number {
      for (const key of [...entries.keys()]) live(key);
      return entries.size;
    },
    async get(key) {
      checkKey(key);
      const entry = live(key);
      if (entry === undefined) return Promise.resolve(undefined);
      // A read is a use: the entry moves to the most recently used end.
      entries.delete(key);
      entries.set(key, entry);
      return Promise.resolve(JSON.parse(entry.text) as unknown);
    },
    async set(key, value, write) {
      checkKey(key);
      const ttl = checkTtl(write);
      const text = encodeValue(value, maxValueBytes);
      put(key, text, ttl === undefined ? undefined : now() + ttl * 1000);
      return Promise.resolve();
    },
    async delete(key) {
      checkKey(key);
      entries.delete(key);
      return Promise.resolve();
    },
    async list(page = {}) {
      const prefix = page.prefix ?? "";
      const limit = page.limit ?? KV_LIMITS.defaultListLimit;
      if (!Number.isInteger(limit) || limit < 1 || limit > KV_LIMITS.maxListLimit) {
        throw new RangeError(
          `KVStore.list: limit must be an integer from 1 to ${KV_LIMITS.maxListLimit}.`,
        );
      }
      const keys = [...entries.keys()]
        .filter(
          (key) =>
            key.startsWith(prefix) &&
            live(key) !== undefined &&
            (page.cursor === undefined || key > page.cursor),
        )
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const shown = keys.slice(0, limit);
      const more = keys.length > limit;
      return Promise.resolve({ keys: shown, cursor: more ? shown[shown.length - 1] : undefined });
    },
    async increment(key, by = 1, write) {
      checkKey(key);
      const ttl = checkTtl(write);
      if (typeof by !== "number" || !Number.isFinite(by))
        throw new TypeError("KVStore.increment: by must be a finite number.");
      const current = live(key);
      let base = 0;
      let expiresAt: number | undefined = ttl === undefined ? undefined : now() + ttl * 1000;
      if (current !== undefined) {
        const parsed = JSON.parse(current.text) as unknown;
        if (typeof parsed !== "number")
          return Promise.reject(new TypeError("KVStore.increment: the value is not a number."));
        base = parsed;
        expiresAt = current.expiresAt;
      }
      const next = base + by;
      if (!Number.isFinite(next))
        return Promise.reject(new RangeError("KVStore.increment: the result is not finite."));
      put(key, JSON.stringify(next), expiresAt);
      return Promise.resolve(next);
    },
  };
}
