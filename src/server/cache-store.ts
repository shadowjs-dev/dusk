/**
 * Storage of the ISR cache (see `isr.ts`). A {@link CacheStore} keeps rendered pages by key and keeps
 * a tag index, so a purge by tag finds its keys. Two implementations ship: a bounded in-process LRU
 * ({@link createMemoryCacheStore}) and an adapter for any Redis-like key-value client
 * ({@link createKeyValueCacheStore}). Nothing here touches the network.
 */

/**
 * One cached page. Entries are immutable once stored; a store may keep them as objects or serialize
 * them (the key-value adapter does), so they hold only plain data.
 * @since 1.0.0
 */
export interface CacheEntry {
  /** Always 200: only successful answers are stored. */
  readonly status: number;
  /** The headers the entry keeps (content type and link hints); everything else is recomputed per answer. */
  readonly headers: readonly (readonly [string, string])[];
  /** The response body, as text. */
  readonly body: string;
  /** The CSP nonce the body was rendered with, if any; a hit rewrites it to the nonce of its own response. */
  readonly nonce: string | undefined;
  /** Strong validator of the body. */
  readonly etag: string;
  /** Epoch milliseconds the page was rendered. */
  readonly storedAt: number;
  /** Epoch milliseconds until which the entry is fresh; `null` when it has no time-based expiry. */
  readonly freshUntil: number | null;
  /** Epoch milliseconds until which a stale entry may still be served; `null` when it never expires. */
  readonly staleUntil: number | null;
  /** The tags the entry is indexed under (always includes its path). */
  readonly tags: readonly string[];
}

/**
 * The storage interface of the ISR cache. Every method may be asynchronous (a shared store is). A
 * `set` indexes the entry's tags, a `delete` removes the entry from every tag it was indexed under.
 * A store must never return an entry that was deleted, and must tolerate `delete` of a missing key.
 * @since 1.0.0
 */
export interface CacheStore {
  /** The entry stored under `key`, or `undefined`. */
  get(key: string): Promise<CacheEntry | undefined>;
  /** Stores `entry` under `key`, replacing any entry there, and indexes its tags. */
  set(key: string, entry: CacheEntry): Promise<void>;
  /** Removes the entry under `key` and its tag index entries. A missing key is not an error. */
  delete(key: string): Promise<void>;
  /** The keys indexed under `tag`, in no particular order. */
  tags(tag: string): Promise<readonly string[]>;
  /**
   * Removes every entry indexed under `tag` and the tag's index, as one operation of the store. Optional: a
   * store that has none is purged by the cache with `tags` and `delete`. A shared store implements it so that an
   * entry written while the purge runs stays indexed (and so purgeable) and no index is lost.
   */
  purgeTag?(tag: string): Promise<void>;
}

/** Options of {@link createMemoryCacheStore}. @since 1.0.0 */
export interface MemoryCacheStoreOptions {
  /** Most entries kept at once; the least recently used one is evicted first. Default 500. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 500;

/**
 * An in-process cache store: a Map kept in least-recently-used order, bounded by `maxEntries`.
 * Entries are kept as objects, so it is only as shared as the process; use a shared store behind
 * several instances.
 *
 * @param options The bound.
 * @returns A store.
 * @throws RangeError when `maxEntries` is not a positive integer.
 * @example
 * const store = createMemoryCacheStore({ maxEntries: 1000 });
 * @since 1.0.0
 */
export function createMemoryCacheStore(options: MemoryCacheStoreOptions = {}): CacheStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("createMemoryCacheStore: maxEntries must be a positive integer.");
  }
  const entries = new Map<string, CacheEntry>();
  const index = new Map<string, Set<string>>();

  const unindex = (key: string, tags: readonly string[]): void => {
    for (const tag of tags) {
      const keys = index.get(tag);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) index.delete(tag);
    }
  };

  return {
    get(key) {
      const found = entries.get(key);
      if (found !== undefined) {
        // Move to the end: the most recently used entry is the last one in the Map.
        entries.delete(key);
        entries.set(key, found);
      }
      return Promise.resolve(found);
    },
    set(key, entry) {
      const previous = entries.get(key);
      if (previous !== undefined) {
        unindex(key, previous.tags);
        entries.delete(key);
      }
      entries.set(key, entry);
      for (const tag of entry.tags) {
        const keys = index.get(tag) ?? new Set<string>();
        keys.add(key);
        index.set(tag, keys);
      }
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        const evicted = entries.get(oldest.value);
        entries.delete(oldest.value);
        if (evicted !== undefined) unindex(oldest.value, evicted.tags);
      }
      return Promise.resolve();
    },
    delete(key) {
      const previous = entries.get(key);
      if (previous !== undefined) {
        entries.delete(key);
        unindex(key, previous.tags);
      }
      return Promise.resolve();
    },
    tags(tag) {
      return Promise.resolve([...(index.get(tag) ?? [])]);
    },
  };
}

/**
 * The subset of a Redis-like client the key-value adapter uses. A node-redis or ioredis client
 * satisfies it with thin wrappers (`sAdd`, `sRem`, `sMembers`, `del`, `get`, and `set` with a
 * millisecond expiry). {@link createFakeKeyValue} is a test double with the same semantics.
 * @since 1.0.0
 */
export interface KeyValueClient {
  /** The string at `key`, or `null`. */
  get(key: string): Promise<string | null>;
  /** Stores a string; `pxExpire` is the lifetime in milliseconds. */
  set(key: string, value: string, options?: { readonly pxExpire?: number }): Promise<unknown>;
  /** Removes keys; returns how many existed. */
  del(key: string): Promise<number>;
  /** Adds a member to a set; returns 1 when it was new. */
  sAdd(key: string, member: string): Promise<number>;
  /** Removes a member from a set; returns 1 when it was there. */
  sRem(key: string, member: string): Promise<number>;
  /** The members of a set (empty when the key is missing). */
  sMembers(key: string): Promise<string[]>;
}

/** Options of {@link createKeyValueCacheStore}. @since 1.0.0 */
export interface KeyValueCacheStoreOptions {
  /** Prefix of every key the store writes. Default `"shadow:isr:"`. */
  readonly prefix?: string;
  /** Epoch milliseconds now; used to turn an entry's `staleUntil` into a key lifetime. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A {@link CacheStore} over a Redis-like client. Each entry is one JSON string with a millisecond
 * expiry at the end of its stale window; each tag is a set of keys. The adapter never reads the
 * client's internals, so any client with the {@link KeyValueClient} methods works.
 *
 * @param client The key-value client.
 * @param options Prefix and clock.
 * @returns A store.
 * @example
 * const store = createKeyValueCacheStore(redisClient, { prefix: "app:isr:" });
 * @since 1.0.0
 */
export function createKeyValueCacheStore(
  client: KeyValueClient,
  options: KeyValueCacheStoreOptions = {},
): CacheStore {
  const prefix = options.prefix ?? "shadow:isr:";
  const now = options.now ?? Date.now;
  const entryKey = (key: string): string => `${prefix}entry:${key}`;
  const tagKey = (tag: string): string => `${prefix}tag:${tag}`;

  const parse = (text: string): CacheEntry | undefined => {
    const value: unknown = JSON.parse(text);
    return isCacheEntry(value) ? value : undefined;
  };

  return {
    async get(key) {
      const text = await client.get(entryKey(key));
      if (text === null) return undefined;
      return parse(text);
    },
    async set(key, entry) {
      const previousText = await client.get(entryKey(key));
      const previous = previousText === null ? undefined : parse(previousText);
      const next = new Set(entry.tags);
      for (const tag of previous?.tags ?? []) {
        if (!next.has(tag)) await client.sRem(tagKey(tag), key);
      }
      for (const tag of next) await client.sAdd(tagKey(tag), key);
      const pxExpire =
        entry.staleUntil === null ? undefined : Math.max(1, entry.staleUntil - now());
      await client.set(
        entryKey(key),
        JSON.stringify(entry),
        pxExpire === undefined ? undefined : { pxExpire },
      );
    },
    async delete(key) {
      const text = await client.get(entryKey(key));
      if (text !== null) {
        const previous = parse(text);
        for (const tag of previous?.tags ?? []) await client.sRem(tagKey(tag), key);
      }
      await client.del(entryKey(key));
    },
    async tags(tag) {
      // A member whose entry expired (or was replaced by one without the tag) is not listed, and leaves the index.
      const live: string[] = [];
      for (const member of await client.sMembers(tagKey(tag))) {
        const text = await client.get(entryKey(member));
        const entry = text === null ? undefined : parse(text);
        if (entry?.tags.includes(tag) === true) live.push(member);
        else await client.sRem(tagKey(tag), member);
      }
      return live;
    },
  };
}

/**
 * Whether a parsed value has the shape of a {@link CacheEntry}. Shared stores check what they read, because
 * another version of the app (or anyone with access to the store) may have written it.
 * @internal
 */
export function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const record: Readonly<Record<string, unknown>> = value as Readonly<Record<string, unknown>>;
  return (
    typeof record["status"] === "number" &&
    Array.isArray(record["headers"]) &&
    typeof record["body"] === "string" &&
    (record["nonce"] === undefined || typeof record["nonce"] === "string") &&
    typeof record["etag"] === "string" &&
    typeof record["storedAt"] === "number" &&
    (record["freshUntil"] === null || typeof record["freshUntil"] === "number") &&
    (record["staleUntil"] === null || typeof record["staleUntil"] === "number") &&
    Array.isArray(record["tags"])
  );
}
