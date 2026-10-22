import { HttpError } from "../internal/http-error";
import { RPC_BATCH_ID } from "../shared/wire";
import { addressKey } from "./client-address";
import type { ServerFnRateLimit } from "./rate-limit-option";
import type { Middleware, RequestEvent } from "./types";

/** Parameters of one token bucket. @since 1.0.0 */
export interface BucketSpec {
  /** Most tokens the bucket holds (the burst size). */
  readonly capacity: number;
  /** Tokens added per second. */
  readonly refillPerSecond: number;
}

/** Result of taking tokens from a bucket. @since 1.0.0 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Tokens left after this request (rounded down). */
  readonly remaining: number;
  /** Milliseconds until `cost` tokens are available; 0 when allowed. */
  readonly retryAfterMs: number;
  /** Milliseconds until the bucket is full again. */
  readonly resetMs: number;
}

/**
 * Where bucket state lives. The in-memory store is for one process; implement this interface on a
 * shared store (Redis, a database) for several. `take` must be atomic.
 * @since 1.0.0
 */
export interface RateLimitStore {
  take(
    key: string,
    spec: BucketSpec,
    cost: number,
    now: number,
  ): RateLimitDecision | Promise<RateLimitDecision>;
}

/** Options of {@link createMemoryRateLimitStore}. @since 1.0.0 */
export interface MemoryRateLimitStoreOptions {
  /** Most buckets kept; the least recently used is dropped beyond it. Default 10 000. */
  readonly maxKeys?: number;
}

/** The decision for one take on a bucket in state `(tokens, updatedAt)`. Pure, shared by stores. @internal */
export function takeFromBucket(
  state: { readonly tokens: number; readonly updatedAt: number } | undefined,
  spec: BucketSpec,
  cost: number,
  now: number,
): { readonly decision: RateLimitDecision; readonly tokens: number } {
  const elapsedSeconds = state === undefined ? 0 : Math.max(0, now - state.updatedAt) / 1000;
  const available = Math.min(
    spec.capacity,
    (state === undefined ? spec.capacity : state.tokens) + elapsedSeconds * spec.refillPerSecond,
  );
  const allowed = available >= cost;
  const tokens = allowed ? available - cost : available;
  const retryAfterMs = allowed ? 0 : Math.ceil(((cost - available) / spec.refillPerSecond) * 1000);
  const resetMs = Math.ceil(((spec.capacity - tokens) / spec.refillPerSecond) * 1000);
  return { decision: { allowed, remaining: Math.floor(tokens), retryAfterMs, resetMs }, tokens };
}

/**
 * A bounded in-memory store: at most `maxKeys` buckets, least recently used evicted first, so a
 * flood of distinct keys cannot grow memory.
 *
 * @param options Bound.
 * @returns The store, with a `size` for tests and metrics.
 * @example
 * const store = createMemoryRateLimitStore({ maxKeys: 5_000 });
 * @since 1.0.0
 */
export function createMemoryRateLimitStore(
  options: MemoryRateLimitStoreOptions = {},
): RateLimitStore & { readonly size: number } {
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isInteger(maxKeys) || maxKeys < 1)
    throw new RangeError("maxKeys must be a positive integer.");
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  return {
    get size() {
      return buckets.size;
    },
    take(key, spec, cost, now) {
      const { decision, tokens } = takeFromBucket(buckets.get(key), spec, cost, now);
      // Re-insert so Map order is recency order; the first key is the least recently used.
      buckets.delete(key);
      buckets.set(key, { tokens, updatedAt: now });
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next();
        if (oldest.done !== true) buckets.delete(oldest.value);
      }
      return decision;
    },
  };
}

/** Options of {@link createRateLimiter}. @since 1.0.0 */
export interface RateLimiterOptions extends BucketSpec {
  /** Bucket storage. Default: a bounded in-memory store. */
  readonly store?: RateLimitStore;
  /** Time source in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Prefix of every key, so several limiters can share a store. Default `""`. */
  readonly name?: string;
}

/** Options of the rate limit middleware. @since 1.0.0 */
export interface RateLimitMiddlewareOptions {
  /** The key to limit by. Default: the client address (IPv6 by /64); requests without one share one bucket. */
  readonly key?: (event: RequestEvent) => string | Promise<string>;
  /** Tokens one request costs. Default 1. */
  readonly cost?: number;
}

/**
 * A token-bucket rate limiter.
 * @since 1.0.0
 */
export interface RateLimiter {
  /** Takes `cost` tokens from the bucket of `key`. */
  check(key: string, cost?: number): Promise<RateLimitDecision>;
  /** Middleware that answers 429 with `Retry-After` when the bucket is empty. */
  middleware(options?: RateLimitMiddlewareOptions): Middleware;
  readonly spec: BucketSpec;
}

/** The `ratelimit-*` headers that tell a client where its bucket stands. */
function rateLimitHeaders(spec: BucketSpec, decision: RateLimitDecision): Record<string, string> {
  return {
    "ratelimit-limit": String(spec.capacity),
    "ratelimit-remaining": String(decision.remaining),
    "ratelimit-reset": String(Math.ceil(decision.resetMs / 1000)),
  };
}

/** The refusal every limiter gives: 429 with the headers above and `retry-after` in whole seconds (at least 1). */
function tooManyRequests(spec: BucketSpec, decision: RateLimitDecision): HttpError {
  return new HttpError(429, "Too Many Requests", {
    headers: {
      ...rateLimitHeaders(spec, decision),
      "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
    },
  });
}

/** The key a limiter uses when none is given: the client address (IPv6 by /64), or one shared bucket without one. */
function clientKey(event: RequestEvent): string {
  return event.clientAddress === undefined ? "unknown" : addressKey(event.clientAddress);
}

/**
 * What a rate limit middleware that already ran leaves for the batch endpoint: a function that charges
 * the further calls of the batch to the same bucket. The batch endpoint reads its body after the
 * middleware chain, so the number of calls is only known then. Keyed by the request event, so it
 * lives and dies with the request; at most one entry per limiter middleware of the app's chain.
 */
const batchCharges = new WeakMap<object, Array<(extraCalls: number) => Promise<void>>>();

/**
 * Charges the further calls of a batch to every rate limit middleware that ran for the request: a
 * batch of N calls costs N times what one call costs, and when a bucket cannot pay, the whole batch
 * is refused with the 429 a single call would get, before any call runs. The first call is already
 * paid for by the middleware; a request of one call (or none) charges nothing more.
 *
 * @param event The event of the batch request.
 * @param calls The number of calls in the batch.
 * @throws HttpError 429 with `retry-after` and the `ratelimit-*` headers.
 * @internal
 */
export async function chargeBatchCalls(event: RequestEvent, calls: number): Promise<void> {
  if (calls < 2) return;
  for (const charge of batchCharges.get(event) ?? []) await charge(calls - 1);
}

/**
 * Takes the cost of one call to a server function from its bucket. The bucket is named after the
 * function and the caller, so one function's calls never use another's, and one client's never use
 * another's. Throws the same 429 the middleware throws.
 *
 * @param limit The function's rate limit.
 * @param fnId The function's id.
 * @param event The request event.
 * @returns The headers to add to a single call's answer.
 * @throws HttpError 429 when the bucket is empty.
 * @internal
 */
export async function chargeServerFnCall(
  limit: ServerFnRateLimit,
  fnId: string,
  event: RequestEvent,
): Promise<Record<string, string>> {
  const caller = limit.key === undefined ? clientKey(event) : await limit.key(event);
  const decision = await limit.limiter.check(`fn:${fnId}:${caller}`, limit.cost ?? 1);
  if (!decision.allowed) throw tooManyRequests(limit.limiter.spec, decision);
  return rateLimitHeaders(limit.limiter.spec, decision);
}

/**
 * Creates a rate limiter. A client may make `capacity` requests at once and then
 * `refillPerSecond` per second on average.
 *
 * @param options Bucket parameters, store and clock.
 * @returns The limiter.
 * @throws RangeError for non-positive parameters.
 * @example
 * const limiter = createRateLimiter({ capacity: 20, refillPerSecond: 5 });
 * createHandler({ manifest, features: [pages()], middleware: [limiter.middleware()] });
 * @since 1.0.0
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!(options.capacity >= 1) || !Number.isFinite(options.capacity)) {
    throw new RangeError("capacity must be a finite number of at least 1.");
  }
  if (!(options.refillPerSecond > 0) || !Number.isFinite(options.refillPerSecond)) {
    throw new RangeError("refillPerSecond must be a positive finite number.");
  }
  const store = options.store ?? createMemoryRateLimitStore();
  const now = options.now ?? Date.now;
  const prefix = options.name === undefined ? "" : `${options.name}:`;
  const spec: BucketSpec = { capacity: options.capacity, refillPerSecond: options.refillPerSecond };
  const check = async (key: string, cost = 1): Promise<RateLimitDecision> =>
    store.take(`${prefix}${key}`, spec, cost, now());
  return {
    spec,
    check,
    middleware(middlewareOptions = {}) {
      return async (event, next) => {
        const key =
          middlewareOptions.key === undefined
            ? clientKey(event)
            : await middlewareOptions.key(event);
        const cost = middlewareOptions.cost ?? 1;
        const decision = await check(key, cost);
        if (!decision.allowed) throw tooManyRequests(spec, decision);
        for (const [name, value] of Object.entries(rateLimitHeaders(spec, decision))) {
          event.responseHeaders.set(name, value);
        }
        // A batch of N calls costs N times `cost`: the batch endpoint settles the other N - 1 once it knows N.
        if (event.route.kind === "rpc" && event.route.id === RPC_BATCH_ID) {
          const charges = batchCharges.get(event) ?? [];
          charges.push(async (extraCalls) => {
            const more = await check(key, cost * extraCalls);
            if (!more.allowed) throw tooManyRequests(spec, more);
            for (const [name, value] of Object.entries(rateLimitHeaders(spec, more))) {
              event.responseHeaders.set(name, value);
            }
          });
          batchCharges.set(event, charges);
        }
        return next();
      };
    },
  };
}
