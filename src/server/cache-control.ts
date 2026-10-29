/**
 * The `cache-control` of a server function's answer (`serverFn({ cacheControl })`). The default is
 * `no-store`: an answer is never kept unless the function says so. A `public` answer may be kept by any cache,
 * so it is only allowed for a GET function, and it becomes `private` for a request that carries cookies or
 * authorization (a shared cache must not keep one user's answer for another).
 *
 * @packageDocumentation
 */

import { type CacheLifeProfile, cacheLifeOf } from "../shared/cache-life";

/** The option, as written. @since 1.0.0 */
export type CacheControlOption =
  | "no-store"
  | {
      /** `public` (any cache) or `private` (the browser only). Default `private`. */
      readonly visibility?: "public" | "private";
      /** Seconds the answer is fresh. Default 0. */
      readonly maxAge?: number;
      /** Seconds a stale answer may be served while it is refreshed. */
      readonly staleWhileRevalidate?: number;
      /** Request headers the answer depends on (added as `Vary`). */
      readonly vary?: readonly string[];
      /** A `cacheLife` profile: `maxAge` is its `stale`, `staleWhileRevalidate` its `revalidate`. */
      readonly profile?: string;
    };

/** The validated option. @internal */
export type ResolvedCacheControl =
  | { readonly kind: "no-store" }
  | {
      readonly kind: "cache";
      readonly visibility: "public" | "private";
      readonly maxAge: number;
      readonly staleWhileRevalidate: number | undefined;
      readonly vary: readonly string[];
    };

const MAX_AGE = 31_536_000;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function seconds(where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_AGE) {
    throw new TypeError(
      __DEV__
        ? `${where} must be an integer number of seconds from 0 to ${MAX_AGE}.`
        : `DUSK_CC_3 ${where}`,
    );
  }
  return value;
}

/**
 * Validates the option of a server function.
 *
 * @param option The option as written (`undefined` is `no-store`).
 * @param method The function's method (`GET` or `POST`).
 * @param profiles The `cacheLife` profiles in force, for a `profile` option.
 * @returns The resolved option.
 * @throws TypeError for a public POST function, a bad number, a bad vary name or an unknown profile.
 * @since 1.0.0
 */
export function resolveCacheControl(
  option: CacheControlOption | undefined,
  method: "GET" | "POST",
  profiles: Readonly<Record<string, CacheLifeProfile>> = {},
): ResolvedCacheControl {
  if (option === undefined || option === "no-store") return { kind: "no-store" };
  if (typeof option !== "object" || option === null) {
    throw new TypeError(
      __DEV__
        ? 'cacheControl must be "no-store" or an object of visibility, maxAge, staleWhileRevalidate, vary.'
        : "DUSK_CC_1",
    );
  }
  const visibility = option.visibility ?? "private";
  if (visibility !== "public" && visibility !== "private")
    throw new TypeError(
      __DEV__ ? 'cacheControl.visibility must be "public" or "private".' : "DUSK_CC_5",
    );
  if (visibility === "public" && method === "POST") {
    throw new TypeError(
      __DEV__
        ? "cacheControl: a POST function cannot be public (a shared cache would answer a write); use private or no-store."
        : "DUSK_CC_2",
    );
  }
  let maxAge = option.maxAge === undefined ? 0 : seconds("cacheControl.maxAge", option.maxAge);
  let swr =
    option.staleWhileRevalidate === undefined
      ? undefined
      : seconds("cacheControl.staleWhileRevalidate", option.staleWhileRevalidate);
  if (option.profile !== undefined) {
    const profile = cacheLifeOf(profiles, option.profile);
    if (option.maxAge === undefined) maxAge = profile.stale;
    if (option.staleWhileRevalidate === undefined) swr = profile.revalidate;
  }
  const vary = (option.vary ?? []).map((name) => {
    if (typeof name !== "string" || !TOKEN.test(name))
      throw new TypeError(
        __DEV__ ? `cacheControl.vary: ${JSON.stringify(name)} is not a header name.` : "DUSK_CC_4",
      );
    return name.toLowerCase();
  });
  return { kind: "cache", visibility, maxAge, staleWhileRevalidate: swr, vary };
}

/**
 * The headers of a successful answer for a request.
 *
 * @param resolved The resolved option.
 * @param request The request the answer is for.
 * @returns The `cache-control` value, and `vary` when the answer depends on headers.
 * @since 1.0.0
 */
export function cacheControlHeader(
  resolved: ResolvedCacheControl,
  request: Request,
): { readonly value: string; readonly vary?: string } {
  if (resolved.kind === "no-store") return { value: "no-store" };
  const personal = request.headers.has("cookie") || request.headers.has("authorization");
  const visibility = resolved.visibility === "public" && personal ? "private" : resolved.visibility;
  let value = `${visibility}, max-age=${resolved.maxAge}`;
  if (resolved.staleWhileRevalidate !== undefined)
    value += `, stale-while-revalidate=${resolved.staleWhileRevalidate}`;
  return resolved.vary.length === 0 ? { value } : { value, vary: resolved.vary.join(", ") };
}
