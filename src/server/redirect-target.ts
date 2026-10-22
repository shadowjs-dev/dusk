/**
 * Thrown when a redirect target is not allowed (an open-redirect attempt or a misconfiguration).
 * The handler reports it and answers 500; the target never reaches a `Location` header.
 * @example
 * checkRedirectTarget("//evil.example", policy) instanceof RedirectBlockedError; // true
 * @since 1.0.0
 */
export class RedirectBlockedError extends Error {
  readonly code = "REDIRECT_TARGET_BLOCKED" as const;

  /** @param target The rejected target (kept for the report, never sent to the client). */
  constructor(target: string) {
    super(
      `REDIRECT_TARGET_BLOCKED: ${JSON.stringify(target.slice(0, 200))} is not an allowed redirect target.`,
    );
    this.name = "RedirectBlockedError";
  }
}

/** What decides which redirects are allowed. @since 1.0.0 */
export interface RedirectPolicy {
  /** Origin of the request (`https://example.com`). */
  readonly origin: string;
  /** Other origins a redirect may point to. */
  readonly trustedOrigins: ReadonlySet<string>;
}

// Control characters and backslashes make browsers read a different target than a parser does.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const UNSAFE = /[\u0000-\u001f\u007f\\]/;
// The URL parser drops leading and trailing spaces, and a header value loses them too: " //evil.example" would
// become "//evil.example" on the wire. A target with a space at either end is refused, not trimmed.
const EDGE_SPACE = /^\s|\s$/;

/**
 * Validates a redirect target and returns the string to put in `Location`, or the error that
 * explains why it is not allowed. Allowed: a path on this site (`/a`, not `//host` and not
 * `/\\host`), a path relative to the current URL, or an absolute http(s) URL of this origin or a
 * trusted origin.
 *
 * @param target The target.
 * @param policy Own origin and trusted origins.
 * @returns The target, or a {@link RedirectBlockedError} (returned, not thrown).
 * @example
 * checkRedirectTarget("//evil.test", policy) instanceof RedirectBlockedError; // true
 * @since 1.0.0
 */
export function checkRedirectTarget(
  target: string,
  policy: RedirectPolicy,
): string | RedirectBlockedError {
  if (UNSAFE.test(target) || EDGE_SPACE.test(target)) return new RedirectBlockedError(target);
  if (target.startsWith("//")) return new RedirectBlockedError(target);
  if (target.startsWith("/")) return target;
  // Anything that parses as an absolute URL has a scheme: it must be http(s) with a known origin.
  // "javascript:alert(1)" and "http:evil.test" both parse, and both fail here.
  if (URL.canParse(target)) {
    const url = new URL(target);
    const known = url.origin === policy.origin || policy.trustedOrigins.has(url.origin);
    // User info in a redirect target is only ever used to disguise the real host.
    const plain = url.username === "" && url.password === "";
    if ((url.protocol === "http:" || url.protocol === "https:") && known && plain) return url.href;
    return new RedirectBlockedError(target);
  }
  return target;
}

/**
 * Like {@link checkRedirectTarget}, but throws.
 *
 * @param target The target.
 * @param policy Own origin and trusted origins.
 * @returns The same target, safe for `Location`.
 * @throws RedirectBlockedError for a target that is not allowed.
 * @example
 * resolveRedirectTarget("/login", { origin: "https://app.example", trustedOrigins: new Set() });
 * @since 1.0.0
 */
export function resolveRedirectTarget(target: string, policy: RedirectPolicy): string {
  const checked = checkRedirectTarget(target, policy);
  if (checked instanceof RedirectBlockedError) throw checked;
  return checked;
}
