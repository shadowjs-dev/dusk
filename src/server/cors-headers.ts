import type { ResolvedCors } from "./cors";

/**
 * The CORS headers for a request to an API route, or `undefined` when the origin is not listed.
 * A preflight (`OPTIONS` with `Access-Control-Request-Method`) from a listed origin is answered by the
 * caller with 204 and these headers; it never reaches the route.
 *
 * This is the per-request half of `security.cors`. The handler imports it on the first request of a
 * handler that sets `security.cors`, so a handler without CORS never loads it (see `cors.ts` for the
 * validation, which runs at start-up).
 *
 * @param cors The resolved rule.
 * @param origin The request's `Origin` header.
 * @param preflight Whether the request is a preflight.
 * @returns The headers to add, or `undefined`.
 * @internal
 */
export function corsHeadersFor(
  cors: ResolvedCors,
  origin: string | null,
  preflight: boolean,
): Readonly<Record<string, string>> | undefined {
  if (origin === null || !cors.origins.has(origin)) return undefined;
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    vary: "origin",
  };
  if (cors.credentials) headers["access-control-allow-credentials"] = "true";
  if (preflight) {
    headers["access-control-allow-methods"] = cors.methods;
    if (cors.headers !== "") headers["access-control-allow-headers"] = cors.headers;
    headers["access-control-max-age"] = String(cors.maxAge);
  }
  return headers;
}
