import type { RateLimiter } from "./rate-limit";
import type { RequestEvent } from "./types";

// Kept apart from `rate-limit.ts` so that defining a server function does not pull the limiter (and the address
// parser it uses) into a bundle that only calls `serverFn`.

/**
 * The rate limit of one server function, applied to every call that reaches the function over HTTP,
 * whether it came alone or inside a batch. Direct calls from server code (`fn()`, `fn.invoke()`) are
 * not network calls and are not charged.
 * @since 1.0.0
 */
export interface ServerFnRateLimit {
  /** The limiter whose bucket is taken from. The bucket is per function and per caller. */
  readonly limiter: RateLimiter;
  /** The caller. Default: the client address (IPv6 by /64); requests without one share one bucket. */
  readonly key?: (event: RequestEvent) => string | Promise<string>;
  /** Tokens one call costs. Default 1. */
  readonly cost?: number;
}

/** What `serverFn({ rateLimit })` accepts: a limiter, or a limiter with a caller key and a cost. @since 1.0.0 */
export type ServerFnRateLimitOption = RateLimiter | ServerFnRateLimit;

function isRateLimiter(value: unknown): value is RateLimiter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "check") === "function" &&
    typeof Reflect.get(value, "middleware") === "function"
  );
}

/** Checks and normalizes the `rateLimit` option of `serverFn`; a bad shape is a `TypeError` at definition time. @internal */
export function normalizeServerFnRateLimit(option: ServerFnRateLimitOption): ServerFnRateLimit {
  if (isRateLimiter(option)) return { limiter: option };
  const { limiter, key, cost } = typeof option === "object" && option !== null ? option : {};
  if (!isRateLimiter(limiter)) {
    throw new TypeError(
      "serverFn: `rateLimit` must be a rate limiter or { limiter, key?, cost? }.",
    );
  }
  if (key !== undefined && typeof key !== "function") {
    throw new TypeError("serverFn: `rateLimit.key` must be a function.");
  }
  if (cost !== undefined && (typeof cost !== "number" || !(cost > 0) || !Number.isFinite(cost))) {
    throw new TypeError("serverFn: `rateLimit.cost` must be a positive finite number.");
  }
  return {
    limiter,
    ...(key === undefined ? {} : { key }),
    ...(cost === undefined ? {} : { cost }),
  };
}
