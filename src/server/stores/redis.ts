/**
 * The page cache over Redis (or anything that speaks the few commands below): {@link redisStore}. It is a
 * {@link CacheStore} for `createHandler({ cache: { store } })`, shared by every instance that reaches the same
 * server. There is no dependency on a Redis package: the store is written against {@link RedisClient}, five
 * commands that ioredis, node-redis, Upstash and the Redis-compatible services all have (the guide shows the few
 * lines that adapt each of them).
 *
 * What is stored, and where (`<prefix>` defaults to `dusk:isr:`):
 * - `<prefix>e:<key>`: one string per page, `{"v":1,"e":<entry>}`. The version tag lets a later format coexist: an
 *   entry of a version this code does not know is a miss, never an error. The string expires with the end of the
 *   page's stale window (`PX`), so Redis drops pages by itself.
 * - `<prefix>t:<tag>`: a set of the keys indexed under the tag. No `SCAN`, no `KEYS`: a purge reads one set.
 *
 * Atomicity, in the terms a client with single-key commands can offer (see the guide for the full list):
 * - a tag is indexed before the page is written and again after it, so a purge that overlaps a write either removes
 *   the new page or leaves it indexed; it never leaves a page that a later purge cannot find;
 * - a purge deletes a page first and removes its index member after, and puts the member back when a new page
 *   appeared in between;
 * - a purge never reads a value it did not write: entries are checked (version, shape, and that they still carry the
 *   tag) before they are deleted.
 *
 * @packageDocumentation
 */

import {
  type CacheEntry,
  type CacheStore,
  isCacheEntry,
  type KeyValueClient,
} from "../cache-store";

/**
 * The commands the store uses. Everything {@link KeyValueClient} has, plus `pExpire` when the index of a tag should
 * expire (see {@link RedisStoreOptions.tagTtlSeconds}). Values are strings; a missing key reads `null`.
 * @since 1.0.0
 */
export interface RedisClient extends KeyValueClient {
  /** Sets the lifetime of a key in milliseconds. Needed only with `tagTtlSeconds`. */
  pExpire?(key: string, milliseconds: number): Promise<unknown>;
}

/** Options of {@link redisStore}. @since 1.0.0 */
export interface RedisStoreOptions {
  /** Prefix of every key the store writes. Default `"dusk:isr:"`. */
  readonly prefix?: string;
  /** Largest stored entry in bytes of its serialized form; a larger one is refused with a RangeError. Default 1 MiB. */
  readonly maxEntryBytes?: number;
  /**
   * Seconds after which the index of a tag expires when it is not written to again (each write renews it). Without
   * it an index lives until its tag is purged or its members are found dead, which is right for a few tags (`posts`)
   * but lets one index per URL accumulate when the URLs are unbounded (a query string no one controls). Set it to at
   * least the longest stale window of your pages. A page that would outlive it (including a page that never goes stale)
   * is refused with a RangeError, because its index could expire before it does. Needs a client with `pExpire`.
   */
  readonly tagTtlSeconds?: number;
  /** Epoch milliseconds now, for the lifetime of an entry. Default `Date.now`. */
  readonly now?: () => number;
}

/** A {@link CacheStore} that purges a tag by itself. @since 1.0.0 */
export interface RedisCacheStore extends CacheStore {
  /** Removes every entry that carries `tag` and the tag's index. */
  purgeTag(tag: string): Promise<void>;
}

/** The format version written in front of every entry. */
const FORMAT_VERSION = 1;
const DEFAULT_PREFIX = "dusk:isr:";
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
/** Commands in flight at once while a tag is purged or checked. */
const BATCH = 32;

/** Runs `work` for every item, `BATCH` at a time. */
async function inBatches<T>(
  items: readonly T[],
  work: (item: T) => Promise<unknown>,
): Promise<void> {
  for (let from = 0; from < items.length; from += BATCH) {
    await Promise.all(items.slice(from, from + BATCH).map(work));
  }
}

/**
 * The parsed entry of a stored string, or `undefined` for anything this version does not understand (not JSON, no
 * version tag, another version, a malformed entry).
 */
function decode(text: string | null): CacheEntry | undefined {
  if (text === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (Reflect.get(parsed, "v") !== FORMAT_VERSION) return undefined;
  const entry: unknown = Reflect.get(parsed, "e");
  return isCacheEntry(entry) ? entry : undefined;
}

/**
 * Creates a page cache store over a Redis client.
 *
 * @param client The client, adapted to {@link RedisClient}.
 * @param options Prefix, the entry size cap, the tag index lifetime and the clock.
 * @returns The store.
 * @throws RangeError for a cap or lifetime that is not a positive integer; TypeError when `tagTtlSeconds` is set and the
 *   client has no `pExpire`.
 * @example
 * import { redisStore } from "@shadow-js/dusk/stores/redis";
 * const store = redisStore(client, { prefix: "myapp:isr:" });
 * // createHandler({ manifest, features, cache: { store } })
 * @since 1.0.0
 */
export function redisStore(client: RedisClient, options: RedisStoreOptions = {}): RedisCacheStore {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(maxEntryBytes) || maxEntryBytes < 1) {
    throw new RangeError("redisStore: maxEntryBytes must be a positive integer.");
  }
  const tagTtlMs = options.tagTtlSeconds === undefined ? undefined : options.tagTtlSeconds * 1000;
  if (tagTtlMs !== undefined) {
    if (!Number.isInteger(options.tagTtlSeconds) || (options.tagTtlSeconds ?? 0) < 1) {
      throw new RangeError("redisStore: tagTtlSeconds must be a positive integer.");
    }
    if (client.pExpire === undefined) {
      throw new TypeError("redisStore: tagTtlSeconds needs a client with pExpire.");
    }
  }
  const entryKey = (key: string): string => `${prefix}e:${key}`;
  const tagKey = (tag: string): string => `${prefix}t:${tag}`;

  /**
   * Takes `key` out of the index of `tag`, unless a page that carries the tag exists for it by now (a write that
   * overlapped: it indexed the tag, and this removal must not undo that).
   */
  const unindex = async (tag: string, key: string): Promise<void> => {
    await client.sRem(tagKey(tag), key);
    const again = decode(await client.get(entryKey(key)));
    if (again?.tags.includes(tag) === true) await client.sAdd(tagKey(tag), key);
  };

  const store: RedisCacheStore = {
    async get(key) {
      return decode(await client.get(entryKey(key)));
    },
    async set(key, entry) {
      const text = JSON.stringify({ v: FORMAT_VERSION, e: entry });
      if (new TextEncoder().encode(text).byteLength > maxEntryBytes) {
        throw new RangeError(`redisStore: an entry is limited to ${maxEntryBytes} bytes.`);
      }
      const lifetime =
        entry.staleUntil === null ? undefined : Math.max(1, entry.staleUntil - now());
      if (tagTtlMs !== undefined && (lifetime === undefined || lifetime > tagTtlMs)) {
        throw new RangeError(
          "redisStore: the entry outlives tagTtlSeconds, so its tag index could expire first; raise tagTtlSeconds.",
        );
      }
      const tags = [...new Set(entry.tags)];
      const index = (tag: string): Promise<unknown> =>
        client.sAdd(tagKey(tag), key).then(() => {
          if (tagTtlMs !== undefined) return client.pExpire?.(tagKey(tag), tagTtlMs);
          return undefined;
        });
      // Index first (a crash after the write must not leave a page no purge can find), write, index again (a purge that
      // overlapped the write may have removed the member).
      await Promise.all(tags.map(index));
      await client.set(
        entryKey(key),
        text,
        lifetime === undefined ? undefined : { pxExpire: lifetime },
      );
      await Promise.all(tags.map((tag) => client.sAdd(tagKey(tag), key)));
    },
    async delete(key) {
      const previous = decode(await client.get(entryKey(key)));
      await client.del(entryKey(key));
      if (previous !== undefined) await Promise.all(previous.tags.map((tag) => unindex(tag, key)));
    },
    async tags(tag) {
      const members = await client.sMembers(tagKey(tag));
      const live: string[] = [];
      await inBatches(members, async (member) => {
        const entry = decode(await client.get(entryKey(member)));
        if (entry?.tags.includes(tag) === true) live.push(member);
        else await unindex(tag, member);
      });
      return live;
    },
    async purgeTag(tag) {
      const members = await client.sMembers(tagKey(tag));
      await inBatches(members, async (member) => {
        const entry = decode(await client.get(entryKey(member)));
        if (entry?.tags.includes(tag) === true) await client.del(entryKey(member));
        await unindex(tag, member);
      });
    },
  };
  return store;
}
