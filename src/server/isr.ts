import { hashKey } from "@shadow-js/query";
import {
  canonicalizePathname,
  type PatternSegment,
  parsePattern,
  type RouteMatch,
} from "@shadow-js/router/core";
import type { RouteRule } from "../shared/routing-config";
import { markProcessLocalStore } from "../shared/worker-info";
import { type CacheEntry, type CacheStore, createMemoryCacheStore } from "./cache-store";
import { getRequestEvent } from "./context";
import { parseCookies } from "./cookies";
import { purgeDataTag } from "./data-cache";
import type { EventState } from "./event";
import { createKvCacheStore } from "./kv-adapters";
import type { KVStore } from "./kv-store";
import type { RouteSpec } from "./runtime";
import { createPurgeGuard, createRefreshBackoff, keepAlive } from "./stores/revalidation";
import { createSingleFlight } from "./stores/single-flight";
import type { DocumentAttributes, RequestEvent } from "./types";

/**
 * Incremental static regeneration: a page with `export const revalidate = <seconds>` (or `false`) is
 * rendered once and served from a {@link CacheStore} until it is stale. Only GET and HEAD answers
 * without `Authorization` and without cookies the page does not declare are cacheable, and only a
 * `200` without `Set-Cookie` is stored. A stale answer is served at once while one background render
 * refreshes it (kept alive through the platform's `waitUntil` when it has one, and backed off after a
 * failure); concurrent misses for a key share one render (single flight, see `stores/single-flight.ts`).
 * `revalidatePath` and `revalidateTag` purge entries, so the next request renders again.
 */

/** Handler options of the cache. @since 1.0.0 */
export interface CacheOptions {
  /** Where pages are kept. Default: a bounded in-process store (`maxEntries`). */
  readonly store?: CacheStore;
  /** A key-value store for the pages (see `kv-store.ts`); used when `store` is absent. */
  readonly kv?: KVStore;
  /** Entries of the default store. Default 500. Ignored when `store` is given. */
  readonly maxEntries?: number;
  /** Largest stored body in bytes; a larger page is answered but not kept. Default 1 MiB. */
  readonly maxEntryBytes?: number;
  /**
   * Keys with a render in flight at once (the bound of coalescing). Past it a request renders on its own, uncoalesced,
   * as it would without the cache. Default 10 000.
   */
  readonly maxInFlight?: number;
  /**
   * Requests that share one render. The request past it renders on its own instead of waiting (nothing is refused).
   * Default 1 000.
   */
  readonly maxWaiters?: number;
  /**
   * Milliseconds after which a render is abandoned: the requests waiting for it fail, its signal aborts and the key is
   * free for a new render. `0` turns the limit off. Default 30 000.
   */
  readonly renderTimeoutMs?: number;
  /** Wait after the first failed background refresh of a key, in milliseconds; each failure doubles it. Default 1 000. */
  readonly backoffBaseMs?: number;
  /** Longest wait between two background refreshes of a key that keeps failing, in milliseconds. Default 60 000. */
  readonly backoffMaxMs?: number;
  /** Clock, in epoch milliseconds. Default `Date.now`; tests pass their own. */
  readonly now?: () => number;
  /**
   * A buffered page that a cache may keep (its `cache-control` is not `no-store`) gets a weak ETag computed from its body,
   * so a repeat request with `If-None-Match` gets a 304. Default `true`. `false` turns it off for pages. API answers never
   * get one unless the route asks (`event.etag(true)`), and a route's own `ETag` is kept either way.
   */
  readonly etag?: boolean;
}

/** The cache options after validation. @internal */
export interface ResolvedCache {
  readonly store: CacheStore;
  readonly maxEntryBytes: number;
  readonly maxInFlight: number;
  readonly maxWaiters: number;
  readonly renderTimeoutMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly now: () => number;
  /** Mount base without a trailing slash; tags use the path below it. */
  readonly base: string;
  /** The router's `caseSensitive`: whether `/About` and `/about` are two pages (and so two entries). */
  readonly caseSensitive: boolean;
  /**
   * The matched route chain of a full pathname (with the base). The key folds the case of the static segments the router
   * ignores and keeps the case of the values of params, which two pages can differ by. Absent: the whole path folds.
   */
  readonly chainOf?: (pathname: string) => readonly RouteMatch[];
}

/** What the matched page chain asks of the cache. @internal */
export interface CachePolicy {
  /** Seconds a response is fresh, or `false` when it never goes stale. */
  readonly fresh: number | false;
  /** Seconds a stale response may still be served while it regenerates. */
  readonly stale: number;
  /** Cookies the page declares (sorted); a request with others is not cacheable. */
  readonly cookies: readonly string[];
  /** Query parameters that take part in the key, or `undefined` for all. */
  readonly searchParams: readonly string[] | undefined;
  /** The route rule asks for `CDN-Cache-Control` (and `Surrogate-Control` with `surrogate`). */
  readonly cdn?: { readonly surrogate: boolean };
}

/** The `s-maxage` of a page that never goes stale (`revalidate: false`): a year, the longest a shared cache is told. */
const NEVER_STALE_SHARED_AGE = 31_536_000;

/** Entries removed at once by a purge of a store that has no purge of its own. */
const PURGE_BATCH = 32;

/** Most tags one response may carry. */
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 256;
/**
 * Headers a stored entry keeps; everything else is computed for each answer. `vary` is kept: a page that varies on a
 * request header (a locale negotiated from `Accept-Language`, say) is stored once per value of that header.
 */
const KEPT_HEADERS: ReadonlySet<string> = new Set(["content-type", "link", "vary"]);
/**
 * Marks the index entry of a page that varies on request headers. It is stored at the base key (the key without
 * header values), holds the names in its body and is never answered: a lookup reads it first, then the variant.
 */
const VARY_INDEX = "x-dusk-vary-index";

/**
 * The request headers a Vary value names, lowercased and sorted. `cookie` is left out (the key already holds the
 * cookies the page declares, and a request with any other cookie is not cached). `*` means the answer depends on
 * everything, so it is not stored.
 * @internal
 */
export function varyNames(value: string | null): {
  readonly names: readonly string[];
  readonly any: boolean;
} {
  const names = new Set<string>();
  let any = false;
  for (const part of (value ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") continue;
    if (name === "*") any = true;
    else if (name !== "cookie") names.add(name);
  }
  return { names: [...names].sort(), any };
}

/**
 * The key of one variant: the base key plus the request's values of the headers the page varies on. Two requests that
 * differ only in such a header (two `Accept-Language` values) get two entries.
 * @internal
 */
export function variantKeyOf(base: string, request: Request, names: readonly string[]): string {
  if (names.length === 0) return base;
  const values = names.map(
    (name) => `${name}=${encodeURIComponent(request.headers.get(name) ?? "")}`,
  );
  return `${base}#vary:${values.join("&")}`;
}

const owners = new WeakMap<RequestEvent, Isr>();
const tagsOf = new WeakMap<RequestEvent, Set<string>>();

/** Validates the cache options of the handler. @internal */
export function resolveCache(
  options: CacheOptions | undefined,
): Omit<ResolvedCache, "base" | "caseSensitive"> {
  const maxEntryBytes = options?.maxEntryBytes ?? 1024 * 1024;
  const maxInFlight = options?.maxInFlight ?? 10_000;
  const maxWaiters = options?.maxWaiters ?? 1_000;
  const renderTimeoutMs = options?.renderTimeoutMs ?? 30_000;
  const backoffBaseMs = options?.backoffBaseMs ?? 1_000;
  const backoffMaxMs = options?.backoffMaxMs ?? 60_000;
  if (!Number.isInteger(maxEntryBytes) || maxEntryBytes < 1) {
    throw new RangeError("cache.maxEntryBytes must be a positive integer.");
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new RangeError("cache.maxInFlight must be a positive integer.");
  }
  if (!Number.isInteger(maxWaiters) || maxWaiters < 1) {
    throw new RangeError("cache.maxWaiters must be a positive integer.");
  }
  if (!Number.isInteger(renderTimeoutMs) || renderTimeoutMs < 0) {
    throw new RangeError(
      "cache.renderTimeoutMs must be a whole number of milliseconds, 0 or more.",
    );
  }
  for (const [name, value] of [
    ["backoffBaseMs", backoffBaseMs],
    ["backoffMaxMs", backoffMaxMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`cache.${name} must be a positive integer.`);
    }
  }
  if (backoffMaxMs < backoffBaseMs) {
    throw new RangeError("cache.backoffMaxMs must not be below cache.backoffBaseMs.");
  }
  return {
    store:
      options?.store ??
      (options?.kv === undefined
        ? createProcessLocalStore(
            options?.maxEntries === undefined ? {} : { maxEntries: options.maxEntries },
          )
        : createKvCacheStore(options.kv)),
    maxEntryBytes,
    maxInFlight,
    maxWaiters,
    renderTimeoutMs,
    backoffBaseMs,
    backoffMaxMs,
    now: options?.now ?? Date.now,
  };
}

/**
 * Reads the revalidate options of the routes. Throws at startup for a value that is neither `false`
 * nor a positive number, or for a malformed `cache` option.
 * @internal
 */
export function validateRouteCache(specs: ReadonlyMap<string, RouteSpec>): void {
  for (const [id, spec] of specs) {
    const { revalidate, cache } = spec;
    if (revalidate !== undefined && revalidate !== false) {
      if (typeof revalidate !== "number" || !Number.isFinite(revalidate) || revalidate <= 0) {
        throw new TypeError(
          `route "${id}": revalidate must be false or a positive number of seconds.`,
        );
      }
    }
    if (cache === undefined) continue;
    if (cache.staleSeconds !== undefined) {
      if (!Number.isFinite(cache.staleSeconds) || cache.staleSeconds < 0) {
        throw new TypeError(
          `route "${id}": cache.staleSeconds must be a number of seconds, 0 or more.`,
        );
      }
    }
    for (const name of cache.cookies ?? []) {
      if (typeof name !== "string" || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        throw new TypeError(`route "${id}": cache.cookies holds an invalid cookie name.`);
      }
    }
  }
}

/**
 * The cache policy of the page chain matched by a path: the shortest `revalidate` among the routes
 * that set one, the shortest `staleSeconds`, and the union of the declared cookies. `undefined` when
 * no matched route opts in.
 * @internal
 */
export function policyOf(
  matches: readonly { readonly id: string }[],
  specs: ReadonlyMap<string, RouteSpec>,
): CachePolicy | undefined {
  let fresh: number | false | undefined;
  let stale: number | undefined;
  const cookies = new Set<string>();
  let searchParams: Set<string> | undefined;
  let any = false;
  for (const match of matches) {
    const spec = specs.get(match.id);
    if (spec === undefined) continue;
    if (spec.revalidate !== undefined) {
      any = true;
      if (spec.revalidate === false) fresh ??= false;
      else if (fresh === undefined || fresh === false || spec.revalidate < fresh)
        fresh = spec.revalidate;
    }
    if (spec.cache?.staleSeconds !== undefined) {
      stale =
        stale === undefined ? spec.cache.staleSeconds : Math.min(stale, spec.cache.staleSeconds);
    }
    for (const name of spec.cache?.cookies ?? []) cookies.add(name);
    if (spec.cache?.searchParams !== undefined) {
      searchParams ??= new Set<string>();
      for (const name of spec.cache.searchParams) searchParams.add(name);
    }
  }
  if (!any || fresh === undefined) return undefined;
  const staleSeconds = stale ?? (fresh === false ? 0 : fresh);
  return {
    fresh,
    stale: staleSeconds,
    cookies: [...cookies].sort(),
    searchParams: searchParams === undefined ? undefined : [...searchParams].sort(),
  };
}

/**
 * Whether a request may be answered from the cache: no `Authorization`, and every cookie it carries is
 * one the page declares.
 * @internal
 */
export function cacheableRequest(request: Request, policy: CachePolicy): boolean {
  if (request.headers.has("authorization")) return false;
  const header = request.headers.get("cookie");
  if (header === null) return true;
  for (const name of parseCookies(header).keys()) {
    if (!policy.cookies.includes(name)) return false;
  }
  return true;
}

/**
 * The path as the router reads it, for keys and tags: each segment decoded once and encoded again (`/%61bout` is
 * `/about`), and without ASCII case unless the router is case-sensitive. The router serves every one of these spellings
 * with the same page, so they must be one cache entry, and `revalidatePath` must reach it whichever spelling filled it.
 * @internal
 */
export function canonicalPath(
  pathname: string,
  caseSensitive: boolean,
  chainOf?: ResolvedCache["chainOf"],
  base = "",
): string {
  const canonical = canonicalizePathname(pathname, "preserve") ?? pathname;
  if (caseSensitive) return canonical;
  const chain = chainOf?.(pathname) ?? [];
  return chain.length === 0 ? fold(canonical) : foldStatic(canonical, base, chain);
}

const STATIC: PatternSegment = { kind: "static", text: "", canonical: "" };

const fold = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/**
 * Folds the case of the base and of the static segments of the matched routes. A param keeps the case of its value (and a
 * splat of its rest): `/p/AbC` and `/p/abc` are two pages, not one.
 */
function foldStatic(canonical: string, base: string, chain: readonly RouteMatch[]): string {
  const parts = canonical.split("/");
  const params = chain[chain.length - 1]?.params ?? {};
  // The segments the path is made of, in order. The mount point is matched without case, like a static segment.
  const segments: PatternSegment[] = [
    ...base.split("/").flatMap((piece): PatternSegment[] => (piece === "" ? [] : [STATIC])),
    ...chain.flatMap(({ pattern }) =>
      pattern === "" || pattern === "/" ? [] : parsePattern(pattern).segments,
    ),
  ];
  let at = 1;
  for (const segment of segments) {
    if (at >= parts.length || segment.kind === "splat") break;
    if (segment.kind === "static") parts[at] = fold(parts[at] ?? "");
    else if (segment.kind === "optional" && params[segment.name] === undefined) continue;
    at += 1;
  }
  return parts.join("/");
}

/**
 * The cache key: the query key (see the Dusk guide on caching) `[host, canonical path, query, cookies]` as its
 * canonical text (`hashKey`). The query is the pairs of the parameters the policy names, sorted by name and value; the
 * cookies are the pairs of the declared cookies, sorted by name. Two requests with the same key get the same page, and
 * no two different tuples share a key: the text is not a digest, so there is nothing to collide.
 * @internal
 */
export function keyOf(
  url: URL,
  request: Request,
  policy: CachePolicy,
  caseSensitive = false,
  pathKey: (pathname: string) => string = (pathname) => canonicalPath(pathname, caseSensitive),
): string {
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (policy.searchParams === undefined || policy.searchParams.includes(name)) {
      pairs.push([name, value]);
    }
  }
  pairs.sort(([aName, aValue], [bName, bValue]) =>
    aName !== bName ? (aName < bName ? -1 : 1) : aValue < bValue ? -1 : aValue > bValue ? 1 : 0,
  );
  const jar = parseCookies(request.headers.get("cookie"));
  const cookies = policy.cookies.map((name): [string, string] => [name, jar.get(name) ?? ""]);
  return hashKey([url.host, pathKey(url.pathname), pairs, cookies]);
}

/**
 * The URL a render sees: the request's, with only the query parameters the key holds. A parameter outside the key would
 * change the page without changing its entry, so one visitor could plant text in the page everyone else is served.
 * @internal
 */
export function renderUrlOf(url: URL, policy: CachePolicy): URL {
  if (policy.searchParams === undefined) return url;
  const kept = new URL(url);
  kept.search = "";
  for (const [name, value] of url.searchParams) {
    if (policy.searchParams.includes(name)) kept.searchParams.append(name, value);
  }
  return kept;
}

/**
 * Request headers a render may read without the page being uncacheable: `cookie` (the key holds the cookies the page
 * declares, and a request with any other is not cached) and what the framework itself reads to answer.
 */
const FRAMEWORK_READS: ReadonlySet<string> = new Set(["cookie"]);

/**
 * The request with its headers watched: every name read from `request.headers` is added to `seen` (`*` when the
 * headers are listed whole). Used for a cache render, to find out which headers the page depends on.
 *
 * @param request The request of the render.
 * @param seen Receives the lower-case names.
 * @returns A request that behaves like `request`.
 * @internal
 */
export function watchHeaders(request: Request, seen: Set<string>): Request {
  const headers = new Proxy(request.headers, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (property === "get" || property === "has") seen.add(String(args[0]).toLowerCase());
        else if (property !== "set" && property !== "append" && property !== "delete")
          seen.add("*");
        return Reflect.apply(value, target, args);
      };
    },
  });
  return new Proxy(request, {
    get(target, property) {
      if (property === "headers") return headers;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The app path of a full pathname (with the mount base): below the base, canonical, with no trailing slash, folded as
 * the key is.
 */
function appPathOf(pathname: string, config: ResolvedCache): string {
  const { base, caseSensitive, chainOf } = config;
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const full = canonicalPath(trimmed, caseSensitive, chainOf, base);
  const prefix = base === "" ? "" : canonicalPath(base, caseSensitive);
  const inner = full.startsWith(prefix) ? full.slice(prefix.length) : full;
  return inner === "" ? "/" : inner;
}

/** Strong validator of a body. */
async function etagOf(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex.slice(0, 32)}"`;
}

/** The nonce attribute of an inline element, `nonce="…"`, for rewriting a cached body. */
function rewriteNonce(body: string, from: string | undefined, to: string | undefined): string {
  if (from === undefined || to === undefined || from === to) return body;
  return body.split(`nonce="${from}"`).join(`nonce="${to}"`);
}

/** A copy of a response with extra headers. Works for any response, whatever its headers are. */
function withHeaders(response: Response, extra: Readonly<Record<string, string>>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** An answer that could not be stored, as plain data: every request that shared the render builds its own `Response`. */
interface Unstored {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly text: string;
}

/** The outcome of one render: the stored entry, or the answer that could not be stored. */
type Regeneration =
  | { readonly kind: "entry"; readonly entry: CacheEntry }
  | { readonly kind: "response"; readonly answer: Unstored; readonly source: EventState };

/** What a render of the cache needs from the request it stands for. */
export interface RenderInput {
  readonly url: URL;
  readonly env: Readonly<Record<string, unknown>>;
  /**
   * The request's headers, so the page sees the request it answers (a locale from `Accept-Language`, say). Its cookies
   * are all declared by the page: a request with any other cookie is not cached.
   */
  readonly headers: Headers;
  /**
   * The `<html lang dir>` a middleware set on the request before the cache (a locale middleware). The render starts
   * from them, and the entry is keyed by what decided them: the URL, or the request headers its `Vary` names.
   */
  readonly document?: DocumentAttributes;
  /**
   * Aborts when every request waiting for the render left, or the render timed out. The render's event carries it as
   * `event.signal`, so a loader that passes it to `fetch` stops with the render.
   */
  readonly signal?: AbortSignal;
}

/** What the handler provides: a render with an event of its own. @internal */
export interface IsrDeps {
  /**
   * Renders a page for a URL with a fresh event and returns the response with that event, and the lower-case names of the
   * request headers the render read (`*` when it read them all). A page that read a header its `Vary` does not name is
   * not stored: the key could not tell two visitors of that header apart.
   */
  render(
    input: RenderInput,
  ): Promise<{ response: Response; event: EventState; read: ReadonlySet<string> }>;
  /** Renders a page for the request's own event (a bypassed request, which may carry cookies). */
  renderOwn(event: EventState): Promise<Response>;
  /** Receives a failure no caller awaits (a background refresh) or a store failure. */
  report(error: unknown): void;
  /** Receives the development warning about a page that is not cached because of the headers it reads. */
  warn?(message: string): void;
}

/** One cache instance per handler. @internal */
export interface Isr {
  /**
   * Answers a GET or HEAD request for a page with a policy: from the cache when fresh, the stale entry
   * (and one background refresh) within the stale window, otherwise a render shared with the concurrent
   * requests for the same key.
   */
  serve(event: EventState, policy: CachePolicy): Promise<Response>;
  /** Makes the event a cache owner: `revalidatePath` / `revalidateTag` called inside it reach this cache. */
  adopt(event: RequestEvent): void;
  /** Purges every entry indexed under `tag`. */
  purgeTag(tag: string): Promise<void>;
  /** Purges the entries of one page (its app path). */
  purgePath(path: string): Promise<void>;
  /** The number of renders in flight (for tests and diagnostics). */
  readonly inFlight: number;
}

/**
 * Creates the cache of one handler.
 * @internal
 */
export function createIsr(config: ResolvedCache, deps: IsrDeps): Isr {
  const { store, now } = config;
  const flights = createSingleFlight({
    maxKeys: config.maxInFlight,
    maxWaiters: config.maxWaiters,
    timeoutMs: config.renderTimeoutMs,
  });
  const backoff = createRefreshBackoff({
    baseMs: config.backoffBaseMs,
    maxMs: config.backoffMaxMs,
    maxKeys: config.maxInFlight,
  });
  const guard = createPurgeGuard();
  const pathKey = (pathname: string): string =>
    canonicalPath(pathname, config.caseSensitive, config.chainOf, config.base);
  /** Pages already warned about, so a busy page does not repeat the message (bounded). */
  const warned = new Set<string>();
  const warnUnkeyed = (path: string, names: readonly string[]): void => {
    if (deps.warn === undefined) return;
    const message = `ISR: ${path} reads the request header${names.length === 1 ? "" : "s"} ${names.join(", ")}, which its Vary header does not name, so it is rendered for each request and not cached (the page cache keys on the path, the query and the declared cookies only). Name the header in Vary (event.responseHeaders.set("vary", "…")), or read it in a route that is not cached.`;
    if (warned.has(message)) return;
    if (warned.size >= 64) warned.clear();
    warned.add(message);
    deps.warn(message);
  };

  /**
   * A background refresh is optional: it starts only when no render for the key runs, the key is not backing off
   * after failures, and the table of renders has room. It is handed to the platform's `waitUntil` when there is one
   * (a serverless instance stays alive until it ends); otherwise it runs on in the process, bounded by the table and
   * the render timeout. A failure keeps the stale entry, is reported, and delays the next attempt for the key.
   */
  const refresh = (key: string, request: EventState, policy: CachePolicy): void => {
    if (flights.has(key) || flights.size >= config.maxInFlight) return;
    if (backoff.waiting(key, now())) return;
    const background = flights
      .run(key, (signal) => regenerate(key, request, policy, signal), { detached: true })
      .then(
        (made) => {
          // A render the cache could not store (an error page, a cookie) did not refresh the entry either.
          if (made.kind === "entry") backoff.succeeded(key);
          else backoff.failed(key, now());
        },
        (error: unknown) => {
          backoff.failed(key, now());
          deps.report(error);
        },
      );
    keepAlive(request.platform, background, deps.report);
  };

  const storeSafely = async (key: string, entry: CacheEntry): Promise<void> => {
    try {
      await store.set(key, entry);
    } catch (error) {
      deps.report(error);
    }
  };

  const respond = (
    entry: CacheEntry,
    state: "HIT" | "STALE" | "MISS",
    policy: CachePolicy,
    nonce: string | undefined,
    method: string,
    at: number,
  ): Response => {
    const body = rewriteNonce(entry.body, entry.nonce, nonce);
    const headers = new Headers();
    for (const [name, value] of entry.headers) headers.append(name, value);
    headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
    headers.set("etag", entry.etag);
    headers.set("x-dusk-cache", state);
    // Age is measured from the start of the render that made the page, so a shared cache in front adds what it holds.
    headers.set("age", String(Math.max(0, Math.floor((at - entry.storedAt) / 1000))));
    if (policy.cookies.length > 0) {
      headers.set("cache-control", "private, max-age=0");
      // The page's own Vary names stay; `cookie` is added to them.
      const kept = headers.get("vary") ?? "";
      headers.set(
        "vary",
        /(^|,)\s*cookie\s*(,|$)/i.test(kept)
          ? kept
          : [kept, "cookie"].filter((v) => v !== "").join(", "),
      );
    } else {
      // The browser revalidates (max-age=0) and a shared cache keeps the page for its fresh window: `s-maxage` is the
      // page's whole lifetime and `Age` says how much of it is used, so the cache in front counts down to the same
      // moment this one does (an entry in its stale window has `Age` past `s-maxage`, and the cache may serve it for
      // `stale-while-revalidate` seconds past that). A page that never goes stale (`revalidate: false`) gets a long
      // s-maxage, so a CDN keeps it until a purge or a new build.
      const shared =
        entry.freshUntil === null
          ? `public, max-age=0, s-maxage=${NEVER_STALE_SHARED_AGE}`
          : `public, max-age=0, s-maxage=${Math.max(0, Math.round((entry.freshUntil - entry.storedAt) / 1000))}, stale-while-revalidate=${entry.staleUntil === null ? policy.stale : Math.max(0, Math.round((entry.staleUntil - entry.freshUntil) / 1000))}`;
      headers.set("cache-control", shared);
      if (policy.cdn !== undefined) {
        // The route rule asked for the CDN's copy of the policy: the same directives, under the CDN's own names.
        headers.set("cdn-cache-control", shared);
        if (policy.cdn.surrogate) headers.set("surrogate-control", shared);
      }
    }
    return new Response(method === "HEAD" ? null : body, { status: entry.status, headers });
  };

  /** Renders a page for the key, stores it when it may be stored. */
  const regenerate = async (
    key: string,
    request: EventState,
    policy: CachePolicy,
    signal: AbortSignal,
  ): Promise<Regeneration> => {
    // A render that finished while this caller waited for the coalescing slot is used, not repeated.
    const current = await store.get(key).catch((error: unknown) => {
      deps.report(error);
      return undefined;
    });
    const at = now();
    if (current !== undefined && (current.freshUntil === null || at < current.freshUntil)) {
      return { kind: "entry", entry: current };
    }
    // The page is as old as the moment its render began (RFC 9111 measures age from the request time), and a purge
    // after this mark is a purge of what the render may have read.
    const mark = guard.mark();
    const startedAt = now();
    const {
      response: raw,
      event,
      read,
    } = await deps.render({
      url: renderUrlOf(request.url, policy),
      env: request.env,
      headers: request.request.headers,
      document: { lang: request.document.lang, dir: request.document.dir },
      signal,
    });
    const text = await raw.text();
    // A cookie the render set lives on the render's own event: it is part of the answer, so the answer is not stored.
    const cookiesSet =
      raw.headers.getSetCookie().length > 0 ||
      event.responseHeaders.getSetCookie().length > 0 ||
      event.cookies.serialized().length > 0;
    const bytes = new TextEncoder().encode(text).byteLength;
    // The page's Vary: the render's response, the headers its event set (the loaders set them there; the top-level
    // handler merges them into the response only after the cache has stored it), and the request's own, which a global
    // middleware set before the cache (the locale middleware names the headers that chose the locale the render got).
    const varyValue = [
      raw.headers.get("vary"),
      event.responseHeaders.get("vary"),
      request.responseHeaders.get("vary"),
    ]
      .filter((value): value is string => value !== null && value !== "")
      .join(", ");
    const vary = varyNames(varyValue === "" ? null : varyValue);
    // A header the page read and its Vary does not name decided the page without being part of the key.
    const unkeyed = [...read].filter(
      (name) => name === "*" || !(FRAMEWORK_READS.has(name) || vary.names.includes(name)),
    );
    if (unkeyed.length > 0) warnUnkeyed(request.url.pathname, unkeyed);
    const storable =
      raw.status === 200 &&
      !cookiesSet &&
      bytes <= config.maxEntryBytes &&
      !vary.any &&
      unkeyed.length === 0;
    if (!storable) {
      const answer: Unstored = {
        status: raw.status,
        statusText: raw.statusText,
        headers: [...raw.headers],
        text,
      };
      return { kind: "response", answer, source: event };
    }
    const kept: [string, string][] = [];
    for (const [name, value] of raw.headers) if (KEPT_HEADERS.has(name)) kept.push([name, value]);
    if (varyValue !== "") {
      const index = kept.findIndex(([name]) => name === "vary");
      if (index === -1) kept.push(["vary", varyValue]);
      else kept[index] = ["vary", varyValue];
    }
    const storedAt = startedAt;
    const tags = [`path:${appPathOf(request.url.pathname, config)}`, ...(tagsOf.get(event) ?? [])];
    const entry: CacheEntry = {
      status: 200,
      headers: kept,
      body: text,
      nonce: event.nonce,
      etag: await etagOf(text),
      storedAt,
      freshUntil: policy.fresh === false ? null : storedAt + policy.fresh * 1000,
      staleUntil: policy.fresh === false ? null : storedAt + (policy.fresh + policy.stale) * 1000,
      tags: [...new Set(tags)],
    };
    // A purge of one of its tags began while the page rendered: the page may show what the purge removed, so it
    // answers the requests that waited for it and is not kept.
    if (guard.touched(mark, entry.tags)) return { kind: "entry", entry };
    // The entry is stored under the key of its own variant (its Vary values), and the base key indexes the names.
    const base = keyOf(request.url, request.request, policy, config.caseSensitive, pathKey);
    if (vary.names.length > 0) {
      await storeSafely(base, {
        status: 200,
        headers: [[VARY_INDEX, "1"]],
        body: vary.names.join(","),
        nonce: undefined,
        etag: "",
        storedAt,
        // It lives as long as the variants it indexes: every render of a variant writes it again.
        freshUntil: entry.freshUntil,
        staleUntil: entry.staleUntil,
        tags: entry.tags,
      });
    }
    await storeSafely(variantKeyOf(base, request.request, vary.names), entry);
    return { kind: "entry", entry };
  };

  const isr: Isr = {
    get inFlight() {
      return flights.size;
    },
    adopt(event: RequestEvent): void {
      owners.set(event, isr);
    },
    async serve(event: EventState, policy: CachePolicy): Promise<Response> {
      if (!cacheableRequest(event.request, policy)) {
        const response = await deps.renderOwn(event);
        return withHeaders(response, { "x-dusk-cache": "BYPASS" });
      }
      const base = keyOf(event.url, event.request, policy, config.caseSensitive, pathKey);
      const first = await store.get(base).catch((error: unknown) => {
        deps.report(error);
        return undefined;
      });
      // A page that varies on request headers keeps an index at the base key: the variant for this request is read instead.
      const indexed = first?.headers.some(([name]) => name === VARY_INDEX)
        ? first.body.split(",").filter((name) => name !== "")
        : undefined;
      const key = indexed === undefined ? base : variantKeyOf(base, event.request, indexed);
      const found =
        indexed === undefined
          ? first
          : await store.get(key).catch((error: unknown) => {
              deps.report(error);
              return undefined;
            });
      const at = now();
      if (found !== undefined) {
        if (found.freshUntil === null || at < found.freshUntil) {
          return respond(found, "HIT", policy, event.nonce, event.method, at);
        }
        if (found.staleUntil === null || at < found.staleUntil) {
          // Stale: answer now, refresh once in the background.
          refresh(key, event, policy);
          return respond(found, "STALE", policy, event.nonce, event.method, at);
        }
      }
      let made: Regeneration;
      try {
        // The request leaves the render when the client goes away; the render stops only when every request left.
        made = await flights.run(key, (signal) => regenerate(key, event, policy, signal), {
          signal: event.signal,
        });
      } catch (error) {
        if (event.signal.aborted) return new Response(null, { status: 499 });
        throw error;
      }
      if (made.kind === "entry")
        return respond(made.entry, "MISS", policy, event.nonce, event.method, now());
      // The answer is not stored, so the headers and cookies its own render set go to this request.
      for (const [name, value] of made.source.responseHeaders) {
        if (name !== "set-cookie" && !event.responseHeaders.has(name))
          event.responseHeaders.set(name, value);
      }
      for (const cookie of made.source.responseHeaders.getSetCookie())
        event.responseHeaders.append("set-cookie", cookie);
      for (const cookie of made.source.cookies.serialized())
        event.responseHeaders.append("set-cookie", cookie);
      const { answer } = made;
      return withHeaders(
        new Response(event.method === "HEAD" ? null : answer.text, {
          status: answer.status,
          statusText: answer.statusText,
          headers: answer.headers.map(([name, value]) => [name, value]),
        }),
        { "x-dusk-cache": "MISS" },
      );
    },
    async purgeTag(tag: string): Promise<void> {
      // Recorded first: a render that began before this call must not store its page after the entries are gone.
      guard.purged(tag);
      if (store.purgeTag !== undefined) {
        await store.purgeTag(tag);
        return;
      }
      const keys = await store.tags(tag);
      for (let from = 0; from < keys.length; from += PURGE_BATCH) {
        await Promise.all(keys.slice(from, from + PURGE_BATCH).map((key) => store.delete(key)));
      }
    },
    async purgePath(path: string): Promise<void> {
      await isr.purgeTag(`path:${appPathOf(`${config.base}${path}`, config)}`);
    },
  };
  return isr;
}

/**
 * The page cache of the current request's handler, or `undefined` when that handler has no `isr()` feature. Such a
 * handler caches no page, so a purge has nothing to discard. Outside a request `getRequestEvent` throws.
 */
function ownerOf(): Isr | undefined {
  return owners.get(getRequestEvent());
}

/**
 * Discards the cached page at a path, so the next request renders it again. Call it from a server
 * function or a loader after a change. Pages are matched by their app path (without the mount base).
 *
 * @param path App path, for example `"/posts/7"`.
 * @returns A promise that resolves when the entries are removed. A handler without `isr()` has no cached page: the call
 * resolves and does nothing.
 * @throws DuskError `SERVER_NO_REQUEST_EVENT` outside a request.
 * @example
 * export const savePost = serverFn({}, async (input) => { await db.save(input); await revalidatePath(`/posts/${input.id}`); });
 * @since 1.0.0
 */
export async function revalidatePath(path: string): Promise<void> {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("revalidatePath: the path must start with /.");
  }
  await ownerOf()?.purgePath(path);
}

/**
 * Discards every cached page indexed under a tag. Tags come from {@link cacheTags} (called while a page
 * renders) and from the path of each page, which `revalidatePath` also uses.
 *
 * @param tag The tag.
 * @returns A promise that resolves when the entries are removed.
 * @throws TypeError for an empty tag; DuskError outside a request.
 * @example
 * await revalidateTag("posts");
 * @since 1.0.0
 */
export async function revalidateTag(tag: string): Promise<void> {
  if (typeof tag !== "string" || tag === "")
    throw new TypeError("revalidateTag: the tag must be a non-empty string.");
  await ownerOf()?.purgeTag(tag);
  // The data cache (`cacheData`, `cachedFetch`) is indexed by the same tags.
  await purgeDataTag(tag);
}

/**
 * Tags the page that is being rendered, so a later {@link revalidateTag} with one of the tags discards
 * it. Call it from a loader or a component during a render. Tags of a response are kept with it, up to
 * 64 of them of at most 256 characters.
 *
 * @param tags The tags.
 * @returns Nothing.
 * @throws RangeError when a tag is empty or too long, or when the response would carry more than 64.
 * @example
 * loader: ({ params }) => { cacheTags(`post:${params.id}`); return loadPost(params.id); }
 * @since 1.0.0
 */
export function cacheTags(...tags: string[]): void {
  const event = getRequestEvent();
  let set = tagsOf.get(event);
  if (set === undefined) {
    set = new Set<string>();
    tagsOf.set(event, set);
  }
  for (const tag of tags) {
    if (tag === "" || tag.length > MAX_TAG_LENGTH) {
      throw new RangeError(`cacheTags: a tag must be 1 to ${MAX_TAG_LENGTH} characters.`);
    }
    set.add(tag);
  }
  if (set.size > MAX_TAGS)
    throw new RangeError(`cacheTags: a page carries at most ${MAX_TAGS} tags.`);
}

/**
 * The cache policy a route rule gives a path, for the pages whose route exports no `revalidate` of their own.
 * `revalidate` is the fresh window (or `false`); `cache.staleSeconds` the stale one (default: as long as the
 * fresh window); `cache.cookies` and `cache.searchParams` shape the key. `cache: false` turns caching off.
 *
 * @param rule The merged route rule of the path (see `effectiveRule`).
 * @returns The policy, or `undefined` when the rule does not cache the path.
 * @internal
 */
export function policyFromRule(rule: RouteRule): CachePolicy | undefined {
  if (rule.cache === false || rule.revalidate === undefined) return undefined;
  const fresh = rule.revalidate;
  const options = rule.cache === undefined ? {} : rule.cache;
  const stale = options.staleSeconds ?? (fresh === false ? 0 : fresh);
  const cdn =
    options.cdn === undefined || options.cdn === false
      ? undefined
      : { surrogate: typeof options.cdn === "object" && options.cdn.surrogate === true };
  return {
    fresh,
    stale,
    cookies: [...new Set(options.cookies ?? [])].sort(),
    searchParams:
      options.searchParams === undefined ? undefined : [...new Set(options.searchParams)].sort(),
    ...(cdn === undefined ? {} : { cdn }),
  };
}

/** The default page cache: in the memory of this process, which a multi-worker server reports once at startup. */
function createProcessLocalStore(
  options: Parameters<typeof createMemoryCacheStore>[0],
): CacheStore {
  markProcessLocalStore("isr page cache");
  return createMemoryCacheStore(options);
}
