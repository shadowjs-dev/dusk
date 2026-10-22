/**
 * The runtime of the generated service worker. The build bundles this module with the configuration of the app into
 * `sw.js` (see `pwa.ts`); it is never imported by app code. Every decision it makes comes from `pwa-core.ts`, which the
 * tests check without a browser; this file only connects them to the Cache API and `fetch`.
 * @packageDocumentation
 */

import {
  CACHED_AT_HEADER,
  type CacheNames,
  cacheNames,
  decideRequest,
  excessKeys,
  isCacheableResponse,
  isFresh,
  type PrecacheEntry,
  planPrecache,
  REVISION_HEADER,
  staleCaches,
  type WorkerConfig,
  type WorkerRule,
} from "./pwa-core";

/**
 * The message a page posts to a waiting worker to make it take over. The worker never skips waiting by itself: an
 * update is applied only when the page asks (`useServiceWorkerUpdate().update()`).
 * @since 1.0.0
 */
export const SKIP_WAITING_MESSAGE = "dusk:skip-waiting";

/** An event that can extend the life of the worker until a promise settles. */
interface ExtendableLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** A `fetch` event of the worker. */
interface FetchEventLike extends ExtendableLike {
  readonly request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

/** A `message` event of the worker. */
interface MessageEventLike {
  readonly data: unknown;
}

/** The part of `ServiceWorkerGlobalScope` this module uses. */
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableLike) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

/** A copy of a response with one more header (the body is moved, not read). */
function stamped(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** When a kept response was stored, or `undefined`. */
function storedAt(response: Response): number | undefined {
  const value = response.headers.get(CACHED_AT_HEADER);
  return value === null ? undefined : Number(value);
}

/**
 * Starts the worker: precaches at install, deletes the caches of other builds at activate, answers requests by the
 * rules of `config`, and applies an update only when a page sends {@link SKIP_WAITING_MESSAGE}.
 *
 * @param config The worker configuration.
 * @param scope The worker's global scope. Default: `self`.
 * @since 1.0.0
 */
export function installServiceWorker(
  config: WorkerConfig,
  scope: WorkerScope = globalThis as unknown as WorkerScope,
): void {
  const { origin } = scope.location;
  const names: CacheNames = cacheNames(config);
  const precached = new Set(config.precache.map((entry) => `${origin}${entry.url}`));
  const { caches } = scope;

  /** The caches of this app that belong to another build, oldest first. */
  async function olderPrecaches(): Promise<readonly Cache[]> {
    const all = await caches.keys();
    const older = staleCaches(all, config).filter((name) =>
      name.startsWith(`${config.prefix}-precache-`),
    );
    return Promise.all(older.map((name) => caches.open(name)));
  }

  /** The copy of each file that older builds hold, by URL path. */
  async function heldCopies(): Promise<Map<string, Response>> {
    const held = new Map<string, Response>();
    for (const cache of await olderPrecaches()) {
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response !== undefined) held.set(new URL(request.url).pathname, response);
      }
    }
    return held;
  }

  /** Downloads one file for the precache. A failure fails the install, so the old worker keeps serving. */
  async function download(entry: PrecacheEntry): Promise<Response> {
    const response = await fetch(entry.url, { cache: "reload" });
    if (!response.ok) {
      throw new Error(`precache: ${entry.url} answered ${response.status}`);
    }
    return stamped(response, REVISION_HEADER, entry.revision);
  }

  async function precache(): Promise<void> {
    const cache = await caches.open(names.precache);
    const held = await heldCopies();
    const plan = planPrecache(
      config.precache,
      (url) => held.get(url)?.headers.get(REVISION_HEADER) ?? undefined,
    );
    await Promise.all([
      ...plan.reuse.map(async (entry) => {
        const copy = held.get(entry.url);
        if (copy !== undefined) await cache.put(entry.url, copy);
      }),
      ...plan.fetch.map(async (entry) => cache.put(entry.url, await download(entry))),
    ]);
  }

  async function activate(): Promise<void> {
    const stale = staleCaches(await caches.keys(), config);
    await Promise.all(stale.map((name) => caches.delete(name)));
    await scope.clients.claim();
  }

  /** Keeps a response when the policy allows it, then trims the cache to the rule's limit. */
  async function keep(
    cache: Cache,
    request: Request,
    response: Response,
    rule: WorkerRule,
  ): Promise<void> {
    if (!isCacheableResponse(response)) return;
    await cache.put(request, stamped(response, CACHED_AT_HEADER, String(Date.now())));
    for (const key of excessKeys(await cache.keys(), rule.maxEntries)) await cache.delete(key);
  }

  /** A kept answer that is still within the rule's maximum age. */
  async function fresh(
    cache: Cache,
    request: Request,
    rule: WorkerRule,
  ): Promise<Response | undefined> {
    const hit = await cache.match(request);
    return hit !== undefined && isFresh(storedAt(hit), rule.maxAgeSeconds, Date.now())
      ? hit
      : undefined;
  }

  /** Asks the network and keeps the answer, in the background of the response that is returned. */
  function refresh(event: FetchEventLike, cache: Cache, rule: WorkerRule): Promise<Response> {
    const request = event.request;
    const answer = fetch(request).then(async (response) => {
      await keep(cache, request, response.clone(), rule).catch(() => undefined);
      return response;
    });
    event.waitUntil(answer.catch(() => undefined));
    return answer;
  }

  async function networkFirst(
    event: FetchEventLike,
    cache: Cache,
    rule: WorkerRule,
  ): Promise<Response> {
    const network = refresh(event, cache, rule);
    if (rule.networkTimeoutSeconds === 0) {
      try {
        return await network;
      } catch (error) {
        const hit = await fresh(cache, event.request, rule);
        if (hit !== undefined) return hit;
        throw error;
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<Response | undefined>((resolve) => {
      timer = setTimeout(
        () => resolve(fresh(cache, event.request, rule)),
        rule.networkTimeoutSeconds * 1000,
      );
    });
    try {
      return (await Promise.race([network, slow])) ?? (await network);
    } catch (error) {
      const hit = await fresh(cache, event.request, rule);
      if (hit !== undefined) return hit;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function cacheFirst(
    event: FetchEventLike,
    cache: Cache,
    rule: WorkerRule,
  ): Promise<Response> {
    const hit = await fresh(cache, event.request, rule);
    if (hit !== undefined) return hit;
    try {
      return await refresh(event, cache, rule);
    } catch (error) {
      // Offline: an answer past its maximum age is still better than none.
      const stale = await cache.match(event.request);
      if (stale !== undefined) return stale;
      throw error;
    }
  }

  async function staleWhileRevalidate(
    event: FetchEventLike,
    cache: Cache,
    rule: WorkerRule,
  ): Promise<Response> {
    const hit = await fresh(cache, event.request, rule);
    const network = refresh(event, cache, rule);
    if (hit !== undefined) {
      network.catch(() => undefined);
      return hit;
    }
    try {
      return await network;
    } catch (error) {
      const stale = await cache.match(event.request);
      if (stale !== undefined) return stale;
      throw error;
    }
  }

  async function runRule(event: FetchEventLike, rule: WorkerRule): Promise<Response> {
    const cache = await caches.open(names.runtime(rule.cache));
    if (rule.strategy === "cache-first") return cacheFirst(event, cache, rule);
    if (rule.strategy === "stale-while-revalidate") return staleWhileRevalidate(event, cache, rule);
    return networkFirst(event, cache, rule);
  }

  /** The answer for a page load the network cannot give: the app shell, then the offline page. */
  async function fallbackDocument(): Promise<Response> {
    const cache = await caches.open(names.precache);
    for (const url of [config.appShell, config.offline]) {
      if (url === undefined) continue;
      const hit = await cache.match(url);
      if (hit !== undefined) return hit;
    }
    return Response.error();
  }

  async function withFallback(answer: () => Promise<Response>): Promise<Response> {
    try {
      return await answer();
    } catch {
      return fallbackDocument();
    }
  }

  function respond(event: FetchEventLike): Promise<Response> | undefined {
    const { request } = event;
    const decision = decideRequest(
      {
        method: request.method,
        url: request.url,
        mode: request.mode,
        authorized: request.headers.has("authorization"),
        ranged: request.headers.has("range"),
      },
      config,
      origin,
      precached,
    );
    if (decision.kind === "bypass") return undefined;
    if (decision.kind === "precache") {
      return caches
        .open(names.precache)
        .then((cache) => cache.match(new URL(request.url).pathname))
        .then((hit) => hit ?? fetch(request));
    }
    if (decision.kind === "rule") {
      return decision.navigation
        ? withFallback(() => runRule(event, decision.rule))
        : runRule(event, decision.rule);
    }
    return withFallback(() => fetch(request));
  }

  scope.addEventListener("install", (event) => event.waitUntil(precache()));
  scope.addEventListener("activate", (event) => event.waitUntil(activate()));
  scope.addEventListener("fetch", (event) => {
    const answer = respond(event);
    if (answer !== undefined) event.respondWith(answer);
  });
  scope.addEventListener("message", (event) => {
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      Reflect.get(data, "type") === SKIP_WAITING_MESSAGE
    ) {
      void scope.skipWaiting();
    }
  });
}
