/**
 * Adapters from a {@link KVStore} to the storage interfaces the framework already has: the ISR page cache
 * (`CacheStore`), sessions (`SessionStore`) and rate limits (`RateLimitStore`). Each adapter keeps its
 * semantics whatever the store is; the memory and file stores give the same answers (see the tests).
 *
 * The adapters serialize their own read-modify-write steps (a tag index, a token bucket) per key inside one
 * process. Across processes the usual limit applies: a store that is shared by several processes must make
 * those steps atomic itself, which the KV contract does not promise (documented in `dusk-config.md`).
 *
 * @packageDocumentation
 */

import { type CacheStore, isCacheEntry } from "./cache-store";
import { createKeyLock, KV_LIMITS, type KVStore } from "./kv-store";
import {
  type BucketSpec,
  type RateLimitDecision,
  type RateLimitStore,
  takeFromBucket,
} from "./rate-limit";
import type { SessionRecord, SessionStore } from "./session";

/** Options of {@link createKvCacheStore}. @since 1.0.0 */
export interface KvCacheStoreOptions {
  /** Prefix of every key. Default `"dusk:isr:"`. */
  readonly prefix?: string;
  /** Keys a tag indexes; the oldest leaves the index past it. Default 10 000. */
  readonly maxKeysPerTag?: number;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** SHA-256 of a text, as hex. */
async function digestHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The text of a tag index: the keys, oldest first. */
function asKeyList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The ISR page cache over a KV store. The entry is stored under `<prefix>entry:<key>` with a TTL that ends
 * at its stale window; each tag is a list of keys under `<prefix>tag:<tag>`.
 *
 * @param kv The store.
 * @param options Prefix, the bound of a tag, and the clock.
 * @returns A {@link CacheStore}.
 * @example
 * const cache = createKvCacheStore(createMemoryKVStore(), { prefix: "app:isr:" });
 * @since 1.0.0
 */
export function createKvCacheStore(kv: KVStore, options: KvCacheStoreOptions = {}): CacheStore {
  const prefix = options.prefix ?? "dusk:isr:";
  const maxKeys = options.maxKeysPerTag ?? 10_000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1)
    throw new RangeError("maxKeysPerTag must be a positive integer.");
  const now = options.now ?? Date.now;
  const lock = createKeyLock();
  /**
   * The store key of an entry or a tag index. A page key holds the whole query (and the declared cookies) and a path tag
   * the whole path, so either can be longer than a KV key may be: such a name is stored under its digest, and the
   * index keeps the page key itself.
   */
  const storeKey = async (kind: "entry" | "tag", name: string): Promise<string> => {
    const plain = `${prefix}${kind}:${name}`;
    return plain.length <= KV_LIMITS.maxKeyLength
      ? plain
      : `${prefix}${kind}-sha256:${await digestHex(name)}`;
  };
  const entryKey = (key: string): Promise<string> => storeKey("entry", key);

  /** Adds or removes a key from a tag's list, under the lock of that tag. */
  const index = (tag: string, key: string, present: boolean): Promise<void> =>
    lock(`${prefix}tag:${tag}`, async () => {
      const listKey = await storeKey("tag", tag);
      const keys = asKeyList(await kv.get(listKey)).filter((item) => item !== key);
      if (present) {
        keys.push(key);
        while (keys.length > maxKeys) keys.shift();
      }
      if (keys.length === 0) await kv.delete(listKey);
      else await kv.set(listKey, keys);
    });

  return {
    async get(key) {
      const value = await kv.get(await entryKey(key));
      return isCacheEntry(value) ? value : undefined;
    },
    async set(key, entry) {
      const stored = await entryKey(key);
      const previous = await kv.get(stored);
      const before = isCacheEntry(previous) ? previous.tags : [];
      await kv.set(
        stored,
        entry,
        entry.staleUntil === null
          ? undefined
          : { ttlSeconds: Math.max(1, Math.ceil((entry.staleUntil - now()) / 1000)) },
      );
      for (const tag of before) if (!entry.tags.includes(tag)) await index(tag, key, false);
      for (const tag of entry.tags) await index(tag, key, true);
    },
    async delete(key) {
      const stored = await entryKey(key);
      const previous = await kv.get(stored);
      if (isCacheEntry(previous)) for (const tag of previous.tags) await index(tag, key, false);
      await kv.delete(stored);
    },
    async tags(tag) {
      const keys = asKeyList(await kv.get(await storeKey("tag", tag)));
      const live: string[] = [];
      for (const key of keys) if (isCacheEntry(await kv.get(await entryKey(key)))) live.push(key);
      return live;
    },
  };
}

/**
 * Sessions over a KV store. The record is stored as JSON under `<prefix><id>` with the session's time to
 * live. Session data must be JSON (the memory session store copies with `structuredClone`; this adapter
 * requires JSON, which the store contract checks).
 *
 * @param kv The store.
 * @param options The prefix.
 * @returns A {@link SessionStore}.
 * @since 1.0.0
 */
export function createKvSessionStore(
  kv: KVStore,
  options: { readonly prefix?: string } = {},
): SessionStore {
  const prefix = options.prefix ?? "dusk:session:";
  return {
    async get(id) {
      const value = await kv.get(`${prefix}${id}`);
      if (typeof value !== "object" || value === null) return undefined;
      return value as SessionRecord;
    },
    async set(id, record, ttlSeconds) {
      await kv.set(`${prefix}${id}`, record, { ttlSeconds });
    },
    async delete(id) {
      await kv.delete(`${prefix}${id}`);
    },
  };
}

/** The stored state of a token bucket. */
interface BucketState {
  readonly tokens: number;
  readonly updatedAt: number;
}

function isBucket(value: unknown): value is BucketState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record["tokens"] === "number" && typeof record["updatedAt"] === "number";
}

/**
 * Token buckets over a KV store. A take reads the bucket, decides with the same arithmetic as the memory
 * store, and writes it back under a per-key lock (so concurrent takes in one process cannot overdraw). The
 * entry expires when the bucket would be full again, because a full bucket is the same as no bucket.
 *
 * @param kv The store.
 * @param options The prefix.
 * @returns A {@link RateLimitStore}.
 * @since 1.0.0
 */
export function createKvRateLimitStore(
  kv: KVStore,
  options: { readonly prefix?: string } = {},
): RateLimitStore {
  const prefix = options.prefix ?? "dusk:ratelimit:";
  const lock = createKeyLock();
  return {
    take(key: string, spec: BucketSpec, cost: number, now: number): Promise<RateLimitDecision> {
      const name = `${prefix}${key}`;
      return lock(name, async () => {
        const stored = await kv.get(name);
        const state = isBucket(stored) ? stored : undefined;
        const { decision, tokens } = takeFromBucket(state, spec, cost, now);
        const fullIn = Math.ceil(decision.resetMs / 1000) + 1;
        await kv.set(name, { tokens, updatedAt: now }, { ttlSeconds: Math.max(1, fullIn) });
        return decision;
      });
    },
  };
}
