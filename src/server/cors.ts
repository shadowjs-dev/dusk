/**
 * Cross-origin access to API routes (`security.cors`). Only the listed origins are answered; an origin
 * that is not listed gets no `Access-Control-*` header, so the browser refuses to read the response. The
 * rule is per origin and explicit: there is no `*`, and credentials are only allowed for listed origins.
 * A listed origin is also trusted by the CSRF check of API routes for the methods the rule allows, so a request that
 * passed its preflight is not refused afterward. Server functions are not covered: they are same-origin and protected
 * by CSRF checks.
 *
 * @packageDocumentation
 */

import { expectKeys } from "../shared/check";

/** Options of `security.cors`. @since 1.0.0 */
export interface CorsOptions {
  /** Origins that may read API responses, as `https://app.example`. */
  readonly origins: readonly string[];
  /** Methods a preflight may ask for. Default `GET, HEAD, POST, PUT, PATCH, DELETE`. */
  readonly methods?: readonly string[];
  /** Request headers a preflight may send. Default: none beyond the simple headers. */
  readonly headers?: readonly string[];
  /** Whether listed origins may send credentials (cookies, authorization). Default false. */
  readonly credentials?: boolean;
  /** Seconds a browser may cache a preflight answer. Default 600. */
  readonly maxAgeSeconds?: number;
}

/** A validated {@link CorsOptions}. @internal */
export interface ResolvedCors {
  readonly origins: ReadonlySet<string>;
  readonly methods: string;
  readonly headers: string;
  readonly credentials: boolean;
  readonly maxAge: number;
}

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const KEYS = ["origins", "methods", "headers", "credentials", "maxAgeSeconds"] as const;
const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Validates the CORS options. Throws at server start.
 *
 * @param options The options as given.
 * @returns The resolved rule.
 * @throws TypeError for a wildcard, a non-origin, an invalid method or header name.
 * @since 1.0.0
 */
export function resolveCors(options: CorsOptions | undefined): ResolvedCors | undefined {
  if (options === undefined) return undefined;
  expectKeys("security.cors", options, KEYS);
  const origins = new Set<string>();
  for (const origin of options.origins) {
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
      throw new TypeError(
        __DEV__
          ? `security.cors.origins: ${JSON.stringify(origin)} must be an origin such as https://app.example (no * and no path).`
          : "DUSK_CORS_4",
      );
    }
    origins.add(origin);
  }
  const methods = (options.methods ?? DEFAULT_METHODS).map((method) => {
    if (!TOKEN.test(method))
      throw new TypeError(
        __DEV__
          ? `security.cors.methods: ${JSON.stringify(method)} is not a method.`
          : "DUSK_CORS_3",
      );
    return method.toUpperCase();
  });
  const headers = (options.headers ?? []).map((name) => {
    if (!TOKEN.test(name))
      throw new TypeError(
        __DEV__
          ? `security.cors.headers: ${JSON.stringify(name)} is not a header name.`
          : "DUSK_CORS_1",
      );
    return name;
  });
  const maxAge = options.maxAgeSeconds ?? 600;
  if (!Number.isInteger(maxAge) || maxAge < 0)
    throw new TypeError(
      __DEV__ ? "security.cors.maxAgeSeconds must be an integer, 0 or more." : "DUSK_CORS_2",
    );
  return {
    origins,
    methods: methods.join(", "),
    headers: headers.join(", "),
    credentials: options.credentials === true,
    maxAge,
  };
}
