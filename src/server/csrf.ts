/** Why a request was accepted or rejected. @since 1.0.0 */
export type CsrfReason =
  | "safe-method"
  | "same-origin"
  | "trusted-origin"
  | "origin-match"
  | "referer-match"
  | "missing-origin-allowed"
  | "cross-site"
  | "same-site"
  | "user-initiated-unsafe"
  | "origin-null"
  | "origin-mismatch"
  | "referer-mismatch"
  | "missing-origin";

/** Result of {@link checkCsrf}. @since 1.0.0 */
export interface CsrfDecision {
  readonly ok: boolean;
  readonly reason: CsrfReason;
}

/** Inputs of {@link checkCsrf} that do not come from the request. @since 1.0.0 */
export interface CsrfContext {
  /** Origin the request is addressed to (`https://example.com`). */
  readonly origin: string;
  /** Extra allowed origins, already normalized (see {@link normalizeOrigins}). */
  readonly trustedOrigins: ReadonlySet<string>;
  /** Accept requests with no `Sec-Fetch-Site`, `Origin` or `Referer`. */
  readonly allowMissingOrigin: boolean;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Normalizes origins to `scheme://host[:port]` form.
 *
 * @param origins Origins as configured.
 * @returns The set of normalized origins.
 * @throws TypeError when an entry is not a valid http(s) origin.
 * @example
 * normalizeOrigins(["https://App.example/path"]); // Set { "https://app.example" }
 * @since 1.0.0
 */
export function normalizeOrigins(origins: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const entry of origins) {
    const url = URL.canParse(entry) ? new URL(entry) : undefined;
    if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new TypeError(`trusted origin ${JSON.stringify(entry)} is not an http(s) origin.`);
    }
    result.add(url.origin);
  }
  return result;
}

/** The origin of a header value, or `undefined` when it is not a single http(s) URL. */
function originOf(value: string): string | undefined {
  if (value.includes(",") || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
}

/**
 * Decides whether a request may change state. Browsers label every request: the decision uses
 * `Sec-Fetch-Site` first, then `Origin`, then `Referer`, and rejects a request that carries none of
 * them unless `allowMissingOrigin` is set. Safe methods (`GET`, `HEAD`, `OPTIONS`) always pass.
 * A cross-site request passes only when its `Origin` is a trusted origin.
 *
 * @param request The request.
 * @param context Own origin and the allow-list.
 * @returns The decision and the reason, for tests and logs.
 * @example
 * checkCsrf(request, { origin: "https://app.test", trustedOrigins: new Set(), allowMissingOrigin: false });
 * @since 1.0.0
 */
export function checkCsrf(request: Request, context: CsrfContext): CsrfDecision {
  if (SAFE_METHODS.has(request.method)) return { ok: true, reason: "safe-method" };
  const allowed = (origin: string): boolean =>
    origin === context.origin || context.trustedOrigins.has(origin);
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (site === "same-origin") return { ok: true, reason: "same-origin" };
  if (site !== null) {
    const claimed = origin === null ? undefined : originOf(origin);
    if (claimed !== undefined && context.trustedOrigins.has(claimed)) {
      return { ok: true, reason: "trusted-origin" };
    }
    if (site === "same-site") return { ok: false, reason: "same-site" };
    if (site === "none") return { ok: false, reason: "user-initiated-unsafe" };
    return { ok: false, reason: "cross-site" };
  }
  if (origin !== null) {
    if (origin === "null") return { ok: false, reason: "origin-null" };
    const claimed = originOf(origin);
    return claimed !== undefined && allowed(claimed)
      ? { ok: true, reason: "origin-match" }
      : { ok: false, reason: "origin-mismatch" };
  }
  const referer = request.headers.get("referer");
  if (referer !== null) {
    const claimed = originOf(referer);
    return claimed !== undefined && allowed(claimed)
      ? { ok: true, reason: "referer-match" }
      : { ok: false, reason: "referer-mismatch" };
  }
  return context.allowMissingOrigin
    ? { ok: true, reason: "missing-origin-allowed" }
    : { ok: false, reason: "missing-origin" };
}
