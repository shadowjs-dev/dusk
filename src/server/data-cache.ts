/**
 * The data cache: `cacheData(fn, { key, tags, revalidate | cacheLife })` and `cachedFetch(url, init, options)`.
 * A value is stored in the app's {@link KVStore} under the query key format (`hashKey` from
 * `@shadow-js/query`, the one key model every ShadowJS cache uses), so `["posts", { page: 2 }]` names the
 * same entry in a loader, a query and here.
 *
 * Rules:
 * - a lifetime is always explicit: `revalidate` (seconds, or `false`) or a named `cacheLife` profile. There
 *   is no implicit cache;
 * - a fresh value is served without running the function; a stale value (past `revalidate`, before the
 *   expiry) is served at once while one background run refreshes it; past the expiry the function runs;
 * - concurrent misses for a key share one run (single flight, see `stores/single-flight.ts`): every caller gets its own
 *   copy of the value, a failure is shared by the callers that waited and forgotten, a caller whose `signal` aborts
 *   stops waiting without stopping the run (unless every caller left), and the table is bounded by `maxInFlight` keys
 *   and `maxWaiters` callers per key;
 * - a background refresh that fails keeps the stale value, goes to `report`, and backs off (1 s, doubling to 60 s);
 *   it is handed to the platform's `waitUntil` when the request has one;
 * - a run that began before a purge of one of its tags does not store its value after it;
 * - an error is never cached; a value that is not JSON is a TypeError; a value over `maxValueBytes` is
 *   returned and not stored;
 * - tags index the entries, so `revalidateTag(tag)` (and `purgeTag`) removes them;
 * - during draft mode (or `bypass: true`) the function runs and nothing is read or written.
 *
 * For a plain `revalidate` of N seconds the stale window is N more seconds (expiry at 2 N), the same as the
 * page cache. A `cacheLife` profile sets `revalidate` and `expire` directly (see `cache-life.ts`).
 *
 * @packageDocumentation
 */

import { hashKey, type QueryKey } from "@shadow-js/query";
import { type CacheLifeProfile, cacheLifeOf, resolveCacheLife } from "../shared/cache-life";
import { DuskError, getRequestEvent, tryGetRequestEvent } from "./context";
import { createKeyLock, encodeValue, type KVStore } from "./kv-store";
import { createPurgeGuard, createRefreshBackoff, keepAlive } from "./stores/revalidation";
import { createSingleFlight } from "./stores/single-flight";
import type { RequestEvent } from "./types";

/** Options of {@link createDataCache}. @since 1.0.0 */
export interface DataCacheOptions {
  /** Where the values are kept (any {@link KVStore}). */
  readonly kv: KVStore;
  /** Named lifetimes that add to or replace the presets (see `cache-life.ts`). */
  readonly profiles?: Readonly<
    Record<
      string,
      Partial<CacheLifeProfile> & Pick<CacheLifeProfile, "stale" | "revalidate" | "expire">
    >
  >;
  /** Keys with a run in flight at once; past it a call runs on its own, uncoalesced. Default 10 000. */
  readonly maxInFlight?: number;
  /** Callers that share one run; the caller past it runs on its own (nothing is refused). Default 1 000. */
  readonly maxWaiters?: number;
  /** Milliseconds after which a run is abandoned: its callers fail with a `TimeoutError`. `0`: never. Default 30 000. */
  readonly timeoutMs?: number;
  /** Wait after the first failed background refresh of a key, in milliseconds; each failure doubles it. Default 1 000. */
  readonly backoffBaseMs?: number;
  /** Longest wait between two refreshes of a key that keeps failing, in milliseconds. Default 60 000. */
  readonly backoffMaxMs?: number;
  /** Largest stored value in bytes of JSON. Default 1 MiB. */
  readonly maxValueBytes?: number;
  /** Keys a tag indexes; the oldest leaves the index past it. Default 10 000. */
  readonly maxKeysPerTag?: number;
  /** Key prefix. Default `"dusk:data:"`. */
  readonly prefix?: string;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Receives a background refresh that failed. Default: `console.error`. */
  readonly report?: (error: unknown) => void;
}

/** Options of `cacheData`. @since 1.0.0 */
export interface CacheDataOptions {
  /** The key: an array of plain data (the query key format). */
  readonly key: QueryKey;
  /** Tags of the entry, for `revalidateTag`. Up to 16, each 1 to 256 characters. */
  readonly tags?: readonly string[];
  /** Seconds the value is fresh, or `false` for never. The stale window is as long again. */
  readonly revalidate?: number | false;
  /** The name of a profile: `"seconds"`, `"minutes"`, `"hours"`, `"days"`, `"weeks"`, `"max"` or one from `cacheLife`. */
  readonly cacheLife?: string;
  /** Runs the function and stores nothing (draft mode sets this for every call). */
  readonly bypass?: boolean;
  /**
   * The caller's own signal. When it aborts the call rejects with its reason at once; a run that other callers share
   * keeps going, and the function's own signal (its parameter) aborts only when every caller left.
   */
  readonly signal?: AbortSignal;
}

/** Options of `cachedFetch`: the same lifetimes and tags. @since 1.0.0 */
export interface CachedFetchOptions {
  readonly tags?: readonly string[];
  readonly revalidate?: number | false;
  readonly cacheLife?: string;
}

/** The data cache of one handler. @since 1.0.0 */
export interface DataCache {
  /**
   * Returns the cached value for the key, or runs `fn` and stores its result. `fn` receives the signal of the shared
   * run (see `CacheDataOptions.signal`); a function that ignores it is fine.
   */
  cacheData<T>(fn: (signal: AbortSignal) => Promise<T>, options: CacheDataOptions): Promise<T>;
  /** Fetches a GET URL through the cache; a JSON answer is parsed. Public data only (see the guide). */
  cachedFetch<T = unknown>(
    input: string | URL,
    init: CachedFetchInit | undefined,
    options: CachedFetchOptions,
  ): Promise<T>;
  /** Removes every entry indexed under the tag. */
  purgeTag(tag: string): Promise<void>;
  /** Runs in flight (for tests and diagnostics). */
  readonly inFlight: number;
}

/** The parts of `RequestInit` that `cachedFetch` accepts (no body, no credentials). @since 1.0.0 */
export interface CachedFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** What a stored entry holds. @internal */
interface Stored {
  readonly value: unknown;
  readonly storedAt: number;
  readonly freshUntil: number | null;
  readonly staleUntil: number | null;
  readonly tags: readonly string[];
}

/** The lifetimes of one call, in seconds (`false`: never). @internal */
interface Life {
  readonly revalidate: number | false;
  readonly expire: number | false;
}

const MAX_SECONDS = 315_360_000;
const MAX_TAGS = 16;
const MAX_TAG_LENGTH = 256;
const FETCH_HEADER_REFUSED = new Set(["authorization", "cookie", "proxy-authorization"]);

/** SHA-256 of a text, as hex. */
async function digestOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record["storedAt"] === "number" &&
    (record["freshUntil"] === null || typeof record["freshUntil"] === "number") &&
    (record["staleUntil"] === null || typeof record["staleUntil"] === "number") &&
    Array.isArray(record["tags"])
  );
}

function lifeOf(
  options: { readonly revalidate?: number | false; readonly cacheLife?: string },
  profiles: Readonly<Record<string, CacheLifeProfile>>,
): Life {
  const hasRevalidate = options.revalidate !== undefined;
  const hasProfile = options.cacheLife !== undefined;
  if (hasRevalidate && hasProfile)
    throw new TypeError("cacheData: give either revalidate or cacheLife, not both.");
  if (hasProfile) {
    const profile = cacheLifeOf(profiles, options.cacheLife ?? "");
    return { revalidate: profile.revalidate, expire: profile.expire };
  }
  if (!hasRevalidate)
    throw new TypeError(
      "cacheData: give revalidate or cacheLife (an explicit lifetime is required).",
    );
  const seconds = options.revalidate;
  if (seconds === false) return { revalidate: false, expire: false };
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > MAX_SECONDS
  ) {
    throw new TypeError(
      `cacheData: revalidate must be false or a whole number of seconds from 1 to ${MAX_SECONDS}.`,
    );
  }
  return { revalidate: seconds, expire: seconds * 2 };
}

function tagsOf(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return [];
  if (tags.length > MAX_TAGS)
    throw new RangeError(`cacheData: an entry carries at most ${MAX_TAGS} tags.`);
  for (const tag of tags) {
    if (typeof tag !== "string" || tag === "" || tag.length > MAX_TAG_LENGTH) {
      throw new RangeError(`cacheData: a tag is 1 to ${MAX_TAG_LENGTH} characters.`);
    }
  }
  return [...new Set(tags)];
}

/**
 * Creates a data cache over a store. The request-bound functions {@link cacheData} and {@link cachedFetch}
 * use the cache of the handler that serves the request; this function is for a store of your own (a
 * script, a test, a worker).
 *
 * @param options The store and the settings.
 * @returns The cache.
 * @throws RangeError / TypeError for a bad bound or profile.
 * @example
 * const cache = createDataCache({ kv: createMemoryKVStore() });
 * await cache.cacheData(() => loadPosts(), { key: ["posts"], revalidate: 60, tags: ["posts"] });
 * @since 1.0.0
 */
export function createDataCache(options: DataCacheOptions): DataCache {
  const kv = options.kv;
  const profiles = resolveCacheLife(options.profiles);
  const prefix = options.prefix ?? "dusk:data:";
  const now = options.now ?? Date.now;
  const maxInFlight = options.maxInFlight ?? 10_000;
  const maxWaiters = options.maxWaiters ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxValueBytes = options.maxValueBytes ?? 1024 * 1024;
  const maxKeys = options.maxKeysPerTag ?? 10_000;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1)
    throw new RangeError("createDataCache: maxInFlight must be a positive integer.");
  if (!Number.isInteger(maxKeys) || maxKeys < 1)
    throw new RangeError("createDataCache: maxKeysPerTag must be a positive integer.");
  // maxWaiters, timeoutMs and the backoff delays are checked by the parts that use them.
  const flights = createSingleFlight({ maxKeys: maxInFlight, maxWaiters, timeoutMs });
  const backoff = createRefreshBackoff({
    baseMs: options.backoffBaseMs ?? 1_000,
    maxMs: options.backoffMaxMs ?? 60_000,
    maxKeys: maxInFlight,
  });
  const guard = createPurgeGuard();
  const report =
    options.report ??
    ((error: unknown) => console.error("[dusk] data cache refresh failed", error));
  const lock = createKeyLock();

  const storeKeyOf = (key: QueryKey): string => `${prefix}${hashKey(key)}`;
  const tagKeyOf = (tag: string): string => `${prefix}tag:${tag}`;

  /** Adds or removes a store key from a tag's list, under the lock of that tag. */
  const index = (tag: string, storeKey: string, present: boolean): Promise<void> =>
    lock(tagKeyOf(tag), async () => {
      const raw = await kv.get(tagKeyOf(tag));
      const keys = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string")
        : [];
      const next = keys.filter((item) => item !== storeKey);
      if (present) {
        next.push(storeKey);
        while (next.length > maxKeys) next.shift();
      }
      if (next.length === 0) await kv.delete(tagKeyOf(tag));
      else await kv.set(tagKeyOf(tag), next);
    });

  /** Runs the function for a key and stores the result. A value over the bound is returned, not stored. */
  const compute = async <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    storeKey: string,
    life: Life,
    tags: readonly string[],
  ): Promise<T> => {
    const mark = guard.mark();
    const value = await fn(signal);
    const storedAt = now();
    const freshUntil = life.revalidate === false ? null : storedAt + life.revalidate * 1000;
    const staleUntil = life.expire === false ? null : storedAt + life.expire * 1000;
    const data: Stored = { value, storedAt, freshUntil, staleUntil, tags };
    // The value itself must be JSON: inside the record an `undefined` would silently disappear.
    encodeValue(value, Number.MAX_SAFE_INTEGER);
    try {
      encodeValue(data, maxValueBytes);
    } catch (error) {
      if (error instanceof RangeError) return value;
      throw error;
    }
    // A purge of one of the tags began while the function ran: its value may be what the purge removed.
    if (guard.touched(mark, tags)) return value;
    const ttl =
      staleUntil === null ? undefined : Math.max(1, Math.ceil((staleUntil - now()) / 1000));
    await kv.set(storeKey, data, ttl === undefined ? undefined : { ttlSeconds: ttl });
    for (const tag of tags) await index(tag, storeKey, true);
    return value;
  };

  /**
   * A background refresh is optional: it starts only when no run for the key is in flight, the key is not backing off
   * after failures, and the table has room. The platform's `waitUntil` keeps it alive when the request has one.
   */
  const refresh = <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    storeKey: string,
    life: Life,
    tags: readonly string[],
  ): void => {
    if (flights.has(storeKey) || flights.size >= maxInFlight) return;
    if (backoff.waiting(storeKey, now())) return;
    const background = flights
      .run(storeKey, (signal) => compute(fn, signal, storeKey, life, tags), { detached: true })
      .then(
        () => backoff.succeeded(storeKey),
        (error: unknown) => {
          backoff.failed(storeKey, now());
          report(error);
        },
      );
    keepAlive(tryGetRequestEvent()?.platform, background, report);
  };

  const cache: DataCache = {
    get inFlight() {
      return flights.size;
    },
    async cacheData<T>(
      fn: (signal: AbortSignal) => Promise<T>,
      call: CacheDataOptions,
    ): Promise<T> {
      if (call.key === undefined || !Array.isArray(call.key)) {
        throw new TypeError("cacheData: options.key is required (an array of plain data).");
      }
      const life = lifeOf(call, profiles);
      const tags = tagsOf(call.tags);
      const storeKey = storeKeyOf(call.key);
      if (call.bypass === true) return fn(call.signal ?? new AbortController().signal);
      const found = await kv.get(storeKey);
      const at = now();
      if (isStored(found)) {
        if (found.freshUntil === null || at < found.freshUntil) return found.value as T;
        if (found.staleUntil === null || at < found.staleUntil) {
          // Stale: answer now, refresh once in the background.
          refresh(fn, storeKey, life, tags);
          return found.value as T;
        }
      }
      // Every caller after the first gets a copy: the value is JSON, so a caller changing its own cannot reach the others.
      return flights.run(storeKey, (signal) => compute(fn, signal, storeKey, life, tags), {
        signal: call.signal,
        clone: (value) => structuredClone(value),
      });
    },
    async cachedFetch<T>(
      input: string | URL,
      init: CachedFetchInit | undefined,
      call: CachedFetchOptions,
    ): Promise<T> {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET")
        throw new TypeError(`cachedFetch caches GET requests only (got ${method}).`);
      for (const name of Object.keys(init?.headers ?? {})) {
        if (FETCH_HEADER_REFUSED.has(name.toLowerCase())) {
          throw new TypeError(
            `cachedFetch: the header "${name}" would make the cached answer private to one user; fetch private data in a loader or a server function instead.`,
          );
        }
      }
      const target = new URL(String(input));
      // The URL is part of the store key, and a store key reaches logs and dumps: no credentials in it.
      if (target.username !== "" || target.password !== "") {
        throw new TypeError(
          "cachedFetch: a URL with a user name or password would be written into the store key; send credentials from a loader or a server function instead.",
        );
      }
      const url = target.href;
      // The answer can depend on the headers (an API key picks a tenant, a language picks a text), so they are part of
      // the key, as a digest: the values are not written to the store.
      const headers = Object.entries(init?.headers ?? {})
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const key: QueryKey =
        headers.length === 0
          ? ["fetch", url]
          : ["fetch", url, await digestOf(JSON.stringify(headers))];
      // The fetch uses the signal of the shared run, not the caller's: one caller giving up must not cancel the answer the
      // others wait for (the caller's own signal only ends its wait).
      const stored = await cache.cacheData(
        async (signal) => {
          const response = await fetch(url, {
            method: "GET",
            ...(init?.headers === undefined ? {} : { headers: init.headers }),
            signal,
          });
          if (!response.ok) throw new Error(`cachedFetch: ${url} answered ${response.status}.`);
          const body = await response.text();
          return { body, type: response.headers.get("content-type") ?? "" };
        },
        {
          key,
          ...(init?.signal === undefined ? {} : { signal: init.signal }),
          ...(call.tags === undefined ? {} : { tags: call.tags }),
          ...(call.revalidate === undefined ? {} : { revalidate: call.revalidate }),
          ...(call.cacheLife === undefined ? {} : { cacheLife: call.cacheLife }),
        },
      );
      return (stored.type.includes("json") ? JSON.parse(stored.body) : stored.body) as T;
    },
    async purgeTag(tag: string): Promise<void> {
      // Recorded first: a run that began before this call must not store its value after the entries are gone.
      guard.purged(tag);
      await lock(tagKeyOf(tag), async () => {
        const raw = await kv.get(tagKeyOf(tag));
        const keys = Array.isArray(raw) ? raw : [];
        for (const key of keys) if (typeof key === "string") await kv.delete(key);
        await kv.delete(tagKeyOf(tag));
      });
    },
  };
  return cache;
}

/** The data cache of each request's handler, by request event. @internal */
const owners = new WeakMap<RequestEvent, DataCache>();

/**
 * Makes the event's handler cache the answer of `cacheData` and `cachedFetch` for this request. Called by the
 * handler for every request it serves.
 *
 * @param event The request event.
 * @param cache The handler's data cache.
 * @internal
 */
export function adoptDataCache(event: RequestEvent, cache: DataCache): void {
  owners.set(event, cache);
}

function ownerOf(): { readonly event: RequestEvent; readonly cache: DataCache } {
  const event = getRequestEvent();
  const cache = owners.get(event);
  if (cache === undefined) {
    throw new DuskError(
      "DATA_CACHE_NO_STORE",
      "cacheData and cachedFetch run inside a request handled by createHandler (or use createDataCache).",
    );
  }
  return { event, cache };
}

/**
 * Removes the data-cache entries of a tag for the handler that serves the current request. `revalidateTag`
 * calls it, so one tag covers the page cache and the data cache.
 *
 * @param tag The tag.
 * @internal
 */
export async function purgeDataTag(tag: string): Promise<void> {
  const event = getRequestEvent();
  const cache = owners.get(event);
  if (cache !== undefined) await cache.purgeTag(tag);
}

/**
 * Caches the result of an async function under a key, for the handler of the current request. See the file
 * comment for the rules. During draft mode the function runs every time.
 *
 * @param fn The work (a database read, an API call). It receives the signal of the run that concurrent callers share:
 *   pass it to `fetch` or a driver to stop the work when every caller left or the run timed out.
 * @param options The key, the tags and the lifetime (`revalidate` or `cacheLife`), and the caller's own `signal`.
 * @returns The value (cached or fresh).
 * @throws DuskError `DATA_CACHE_NO_STORE` outside a handler; TypeError for a bad key or lifetime.
 * @example
 * const post = await cacheData(() => db.post(id), { key: ["post", id], cacheLife: "hours", tags: [`post:${id}`] });
 * @since 1.0.0
 */
export async function cacheData<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: CacheDataOptions,
): Promise<T> {
  const { event, cache } = ownerOf();
  return cache.cacheData(fn, event.draft ? { ...options, bypass: true } : options);
}

/**
 * Fetches a public GET URL through the data cache (see the file comment). Private data (headers that name a
 * user) is refused: the cache is shared, so an answer for one user must never reach another.
 *
 * @param input The URL.
 * @param init Method (GET only), extra headers (not `authorization`, `cookie` or `proxy-authorization`; the other headers are
 *   part of the cache key), signal.
 * @param options The tags and the lifetime.
 * @returns The parsed JSON answer, or the text.
 * @throws TypeError for a non-GET method, a private header or a URL with credentials; an Error for a non-OK answer (not cached).
 * @example
 * const rates = await cachedFetch("https://api.example/rates", undefined, { revalidate: 300 });
 * @since 1.0.0
 */
export async function cachedFetch<T = unknown>(
  input: string | URL,
  init: CachedFetchInit | undefined,
  options: CachedFetchOptions,
): Promise<T> {
  const { event, cache } = ownerOf();
  if (event.draft) {
    const response = await fetch(new URL(String(input)).href, {
      ...(init === undefined ? {} : init),
    } as RequestInit);
    return (await response.json()) as T;
  }
  return cache.cachedFetch<T>(input, init, options);
}
