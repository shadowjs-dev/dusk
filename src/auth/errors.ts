import { HttpError } from "../internal/http-error";

/**
 * Stable codes of {@link OidcError}. Each one names one way sign-in can fail; the HTTP status of the error follows the
 * code (a bad request from the browser is 4xx, a failing identity provider is 5xx).
 * @since 1.0.0
 */
export type OidcErrorCode =
  | "OIDC_STATE_MISSING"
  | "OIDC_STATE_INVALID"
  | "OIDC_STATE_EXPIRED"
  | "OIDC_ISSUER_MISMATCH"
  | "OIDC_AUTHORIZATION_ERROR"
  | "OIDC_TOKEN_ERROR"
  | "OIDC_ID_TOKEN_INVALID"
  | "OIDC_USERINFO_INVALID"
  | "OIDC_NOT_SIGNED_IN"
  | "OIDC_REFRESH_FAILED"
  | "OIDC_DISCOVERY_FAILED"
  | "OIDC_JWKS_FAILED"
  | "OIDC_UPSTREAM_ERROR"
  | "OIDC_TIMEOUT"
  | "OIDC_RESPONSE_TOO_LARGE"
  | "OIDC_INSECURE_URL"
  | "OIDC_UNSUPPORTED";

const STATUS: Readonly<Record<OidcErrorCode, number>> = {
  OIDC_STATE_MISSING: 400,
  OIDC_STATE_INVALID: 400,
  OIDC_STATE_EXPIRED: 400,
  OIDC_ISSUER_MISMATCH: 400,
  OIDC_AUTHORIZATION_ERROR: 400,
  OIDC_TOKEN_ERROR: 400,
  OIDC_ID_TOKEN_INVALID: 401,
  OIDC_USERINFO_INVALID: 401,
  OIDC_NOT_SIGNED_IN: 401,
  OIDC_REFRESH_FAILED: 401,
  OIDC_DISCOVERY_FAILED: 502,
  OIDC_JWKS_FAILED: 502,
  OIDC_UPSTREAM_ERROR: 502,
  OIDC_TIMEOUT: 504,
  OIDC_RESPONSE_TOO_LARGE: 502,
  OIDC_INSECURE_URL: 500,
  OIDC_UNSUPPORTED: 500,
};

const BRAND: unique symbol = Symbol.for("shadowjs.dusk.oidc-error");

/** What the identity provider reported, kept apart from the message so it is never shown by accident. @since 1.0.0 */
export interface OidcErrorOptions {
  /** The underlying error. Never sent to the client. */
  readonly cause?: unknown;
  /** The `error` value of the provider (RFC 6749 section 5.2), already restricted to a safe alphabet. */
  readonly providerError?: string;
  /** The `error_description` of the provider, cut to 200 characters. Text from outside: escape it before showing it. */
  readonly providerDescription?: string;
}

/**
 * The error of every failed sign-in step. It is an {@link HttpError}, so a route that lets it escape answers with its
 * status (the handler hides the message of a 5xx in production). The message never contains text the identity provider
 * or the browser sent; the provider's own words are in `providerError` and `providerDescription`.
 *
 * @example
 * try {
 *   await oidc.callback(event);
 * } catch (error) {
 *   if (isOidcError(error) && error.code === "OIDC_STATE_EXPIRED") return redirect("/login");
 *   throw error;
 * }
 * @since 1.0.0
 */
export class OidcError extends HttpError {
  /** Which step failed. */
  readonly code: OidcErrorCode;
  /** The provider's `error` value, when it sent one. */
  readonly providerError: string | undefined;
  /** The provider's `error_description`, when it sent one. Untrusted text. */
  readonly providerDescription: string | undefined;

  /**
   * @param code The failure.
   * @param detail A fixed sentence for the log, written by this package.
   * @param options Cause and the provider's own error.
   */
  constructor(code: OidcErrorCode, detail: string, options: OidcErrorOptions = {}) {
    super(STATUS[code], `${code}: ${detail}`, { cause: options.cause });
    this.name = "OidcError";
    this.code = code;
    this.providerError = options.providerError;
    this.providerDescription = options.providerDescription;
    Object.defineProperty(this, BRAND, { value: true });
  }
}

/**
 * True for an {@link OidcError}, also across two copies of this package.
 *
 * @param value Any thrown value.
 * @returns Whether `value` is an OIDC error.
 * @example
 * if (isOidcError(error)) console.warn(error.code);
 * @since 1.0.0
 */
export function isOidcError(value: unknown): value is OidcError {
  return (
    value instanceof OidcError ||
    (typeof value === "object" && value !== null && Reflect.get(value, BRAND) === true)
  );
}

/** Keeps a provider `error` value to the RFC 6749 alphabet and 64 characters, or drops it. @internal */
export function safeProviderError(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

/** Cuts a provider `error_description` to 200 characters. @internal */
export function safeProviderDescription(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 200) : undefined;
}
