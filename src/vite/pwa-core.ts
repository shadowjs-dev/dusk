/**
 * The decisions of the generated service worker as pure functions of plain data: which requests it handles, which
 * responses it may keep, how long a kept response lives, and which caches a new version replaces. The worker
 * (`pwa-worker.ts`) calls them with real requests and responses; the build and the tests call them with plain objects, so
 * every rule is checked without a browser. Nothing here touches `self`, `caches` or `fetch`.
 * @packageDocumentation
 */

import { compileGlob } from "./glob";

/**
 * How a runtime rule answers a request.
 *
 * - `network-first`: ask the network, keep the answer, and fall back to the kept one when the network fails or is
 *   slower than `networkTimeoutSeconds`.
 * - `cache-first`: answer from the cache, and ask the network only on a miss (or when the kept answer is older than
 *   `maxAgeSeconds`).
 * - `stale-while-revalidate`: answer from the cache at once and refresh it in the background.
 * @since 1.0.0
 */
export type CacheStrategy = "network-first" | "cache-first" | "stale-while-revalidate";

/**
 * One precached file: its URL and a revision that changes when the content changes. @since 1.0.0
 */
export interface PrecacheEntry {
  /** The URL path of the file, with the mount base. */
  readonly url: string;
  /** A short hash of the file's content. */
  readonly revision: string;
}

/**
 * One runtime rule of the generated worker, with every default applied. Plain JSON: the worker is generated from it.
 * @since 1.0.0
 */
export interface WorkerRule {
  /** Globs of the path below the mount base (`/api/**`, `/images/*.png`). The first rule that matches wins. */
  readonly patterns: readonly string[];
  readonly strategy: CacheStrategy;
  /** The name of this rule's cache, without the prefix and the build id. */
  readonly cache: string;
  /** The most entries the cache keeps; the oldest go first. `0` is no limit. */
  readonly maxEntries: number;
  /** Seconds a kept answer is used. `0` is no limit. */
  readonly maxAgeSeconds: number;
  /** For `network-first`: seconds to wait for the network before the kept answer is used. `0` waits for the network. */
  readonly networkTimeoutSeconds: number;
}

/**
 * Everything the generated worker needs, as plain JSON.
 * @since 1.0.0
 */
export interface WorkerConfig {
  /** The prefix of every cache name. */
  readonly prefix: string;
  /** The id of this build; it versions the cache names, so a new build gets new caches and the old ones are deleted. */
  readonly buildId: string;
  /** The mount base path with a trailing slash (`/`, `/app/`). */
  readonly base: string;
  /** The files kept at install. */
  readonly precache: readonly PrecacheEntry[];
  /** The runtime rules, in order. */
  readonly rules: readonly WorkerRule[];
  /** Globs of the path below the mount base that the worker never touches. */
  readonly exclude: readonly string[];
  /** A precached document that answers a navigation the network cannot, before the offline page. */
  readonly appShell: string | undefined;
  /** The precached offline page. */
  readonly offline: string | undefined;
}

/** The part of a request that decides how it is handled. @since 1.0.0 */
export interface RequestFacts {
  readonly method: string;
  /** The absolute URL. */
  readonly url: string;
  /** `navigate` for a page load. */
  readonly mode: string;
  /** Whether the request carries an `Authorization` header. */
  readonly authorized: boolean;
  /** Whether the request asks for a byte range. */
  readonly ranged: boolean;
}

/** What the worker does with a request. @since 1.0.0 */
export type Decision =
  | { readonly kind: "bypass" }
  | { readonly kind: "precache"; readonly key: string }
  | { readonly kind: "rule"; readonly rule: WorkerRule; readonly navigation: boolean }
  | { readonly kind: "navigation" };

/** The headers of a response, as far as the policy reads them (a `Headers` fits). @since 1.0.0 */
export interface HeaderReader {
  get(name: string): string | null;
}

/** The part of a response that decides whether it may be kept. @since 1.0.0 */
export interface ResponseFacts {
  readonly status: number;
  readonly type: string;
  readonly headers: HeaderReader;
}

/** The header that records when a kept response was stored (milliseconds since the epoch). @internal */
export const CACHED_AT_HEADER = "x-dusk-cached-at";
/** The header that records the revision of a precached response. @internal */
export const REVISION_HEADER = "x-dusk-revision";

const GLOB_CACHE = new Map<string, (path: string) => boolean>();

/** A compiled glob, kept for the life of the worker (the same few patterns are asked for every request). */
function globOf(pattern: string): (path: string) => boolean {
  let match = GLOB_CACHE.get(pattern);
  if (match === undefined) {
    match = compileGlob(pattern);
    GLOB_CACHE.set(pattern, match);
  }
  return match;
}

/** True when any pattern matches the path. */
function matchesAnyPattern(patterns: readonly string[], path: string): boolean {
  for (const pattern of patterns) if (globOf(pattern)(path)) return true;
  return false;
}

/**
 * The path of a URL below the mount base, or `undefined` when the URL is outside the base.
 *
 * @param pathname The URL's path.
 * @param base The mount base with a trailing slash.
 * @returns A path that starts with `/`.
 * @example
 * pathBelowBase("/app/api/items", "/app/"); // "/api/items"
 * @since 1.0.0
 */
export function pathBelowBase(pathname: string, base: string): string | undefined {
  if (base === "/") return pathname;
  if (pathname === base.slice(0, -1)) return "/";
  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : undefined;
}

/**
 * The first rule whose patterns match a path.
 *
 * @param rules The rules, in order.
 * @param path A path below the mount base.
 * @returns The rule, or `undefined`.
 * @example
 * matchRule(rules, "/api/items")?.strategy; // "network-first"
 * @since 1.0.0
 */
export function matchRule(rules: readonly WorkerRule[], path: string): WorkerRule | undefined {
  return rules.find((rule) => matchesAnyPattern(rule.patterns, path));
}

/**
 * Decides what the worker does with a request.
 *
 * Only a same-origin GET inside the mount base is ever handled. A request with an `Authorization` header or a byte range,
 * and a path in `exclude`, goes straight to the network. A precached file is answered from the precache; then the first
 * matching rule; a navigation that no rule claims gets the network with the offline fallback.
 *
 * @param request The facts of the request.
 * @param config The worker configuration.
 * @param origin The worker's own origin.
 * @param precached The precached URLs as `origin + path` keys.
 * @returns The decision.
 * @example
 * decideRequest(facts, config, "https://example.test", new Set()).kind; // "navigation"
 * @since 1.0.0
 */
export function decideRequest(
  request: RequestFacts,
  config: WorkerConfig,
  origin: string,
  precached: ReadonlySet<string>,
): Decision {
  const bypass: Decision = { kind: "bypass" };
  if (request.method !== "GET" || request.ranged) return bypass;
  if (!URL.canParse(request.url)) return bypass;
  const url = new URL(request.url);
  if (url.origin !== origin) return bypass;
  const path = pathBelowBase(url.pathname, config.base);
  if (path === undefined || matchesAnyPattern(config.exclude, path)) return bypass;
  const key = `${url.origin}${url.pathname}`;
  if (url.search === "" && precached.has(key)) return { kind: "precache", key };
  // A request that names a user is never answered from a shared cache entry.
  if (request.authorized) return bypass;
  const navigation = request.mode === "navigate";
  const rule = matchRule(config.rules, path);
  if (rule !== undefined) return { kind: "rule", rule, navigation };
  return navigation ? { kind: "navigation" } : bypass;
}

/** The tokens of a `Cache-Control` or `Vary` value, lower case, without arguments. */
function tokens(value: string | null): readonly string[] {
  if (value === null) return [];
  return value.split(",").map((token) => (token.split("=")[0] ?? "").trim().toLowerCase());
}

/**
 * Whether a response may be kept. Only a complete, same-origin `200` is kept. These are never kept: a response with
 * `Cache-Control: no-store` or `private`, one that sets a cookie or varies on the cookie or on `*` (a session or
 * per-user answer), and one whose `Content-Security-Policy` carries a nonce (the nonce is for one response; replaying it
 * would defeat it).
 *
 * @param response The facts of the response.
 * @returns True when it may be put in a cache.
 * @example
 * isCacheableResponse({ status: 200, type: "basic", headers: new Headers({ "cache-control": "no-store" }) }); // false
 * @since 1.0.0
 */
export function isCacheableResponse(response: ResponseFacts): boolean {
  if (response.status !== 200 || response.type !== "basic") return false;
  const { headers } = response;
  const control = tokens(headers.get("cache-control"));
  if (control.includes("no-store") || control.includes("private")) return false;
  if (headers.get("set-cookie") !== null) return false;
  const vary = tokens(headers.get("vary"));
  if (vary.includes("*") || vary.includes("cookie")) return false;
  const csp = headers.get("content-security-policy");
  return !(csp !== null && /'nonce-/i.test(csp));
}

/**
 * Whether a kept response is still within its maximum age.
 *
 * @param cachedAt When it was stored (milliseconds since the epoch), or `undefined` for an unknown time.
 * @param maxAgeSeconds The rule's maximum age; `0` is no limit.
 * @param now The current time (milliseconds since the epoch).
 * @returns False when it is too old, or when a limit applies and the time it was stored is unknown.
 * @example
 * isFresh(Date.now() - 5_000, 60, Date.now()); // true
 * @since 1.0.0
 */
export function isFresh(cachedAt: number | undefined, maxAgeSeconds: number, now: number): boolean {
  if (maxAgeSeconds === 0) return true;
  if (cachedAt === undefined || !Number.isFinite(cachedAt)) return false;
  return now - cachedAt <= maxAgeSeconds * 1000;
}

/**
 * The entries to delete so that a cache keeps at most `maxEntries`. The keys of a cache come oldest first.
 *
 * @param keys The cache's keys, oldest first.
 * @param maxEntries The limit; `0` is no limit.
 * @returns The keys to delete (the oldest).
 * @example
 * excessKeys(["a", "b", "c"], 2); // ["a"]
 * @since 1.0.0
 */
export function excessKeys<T>(keys: readonly T[], maxEntries: number): readonly T[] {
  if (maxEntries === 0 || keys.length <= maxEntries) return [];
  return keys.slice(0, keys.length - maxEntries);
}

/** The names of the caches of one build. @since 1.0.0 */
export interface CacheNames {
  readonly precache: string;
  /** The name of a rule's runtime cache. */
  runtime(rule: string): string;
}

/**
 * The cache names of a build: `<prefix>-precache-<id>` and `<prefix>-runtime-<rule>-<id>`.
 *
 * @param config The worker configuration.
 * @returns The names.
 * @example
 * cacheNames(config).precache; // "dusk-precache-1a2b3c"
 * @since 1.0.0
 */
export function cacheNames(config: Pick<WorkerConfig, "prefix" | "buildId">): CacheNames {
  const { prefix, buildId } = config;
  return {
    precache: `${prefix}-precache-${buildId}`,
    runtime: (rule) => `${prefix}-runtime-${rule}-${buildId}`,
  };
}

/**
 * The caches an activated worker deletes: the ones this app made (they carry its prefix) for another build.
 *
 * @param existing Every cache name of the origin.
 * @param config The worker configuration.
 * @returns The names to delete. A cache of another app on the same origin (another prefix) is never listed.
 * @example
 * staleCaches(["dusk-precache-old", "dusk-precache-new", "other"], { prefix: "dusk", buildId: "new" }); // ["dusk-precache-old"]
 * @since 1.0.0
 */
export function staleCaches(
  existing: readonly string[],
  config: Pick<WorkerConfig, "prefix" | "buildId">,
): readonly string[] {
  return existing.filter(
    (name) => name.startsWith(`${config.prefix}-`) && !name.endsWith(`-${config.buildId}`),
  );
}

/** What install does with the precache. @since 1.0.0 */
export interface PrecachePlan {
  /** Files whose kept copy (from an older build) has the same revision: copied, not downloaded. */
  readonly reuse: readonly PrecacheEntry[];
  /** Files to download. */
  readonly fetch: readonly PrecacheEntry[];
}

/**
 * Splits the precache into the files an older build already holds with the same revision and the files to download.
 *
 * @param entries The precache of this build.
 * @param kept The revision an older cache holds for a URL, or `undefined`.
 * @returns The plan.
 * @example
 * planPrecache([{ url: "/a.js", revision: "1" }], () => "1").reuse.length; // 1
 * @since 1.0.0
 */
export function planPrecache(
  entries: readonly PrecacheEntry[],
  kept: (url: string) => string | undefined,
): PrecachePlan {
  const reuse: PrecacheEntry[] = [];
  const fetch: PrecacheEntry[] = [];
  for (const entry of entries) (kept(entry.url) === entry.revision ? reuse : fetch).push(entry);
  return { reuse, fetch };
}
