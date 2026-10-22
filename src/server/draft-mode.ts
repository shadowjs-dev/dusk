/**
 * Draft (preview) mode: a signed cookie that makes a request see unpublished content. The cookie is set by a
 * POST to the enable endpoint with the secret (from the environment, never from the config file); while it is
 * set, the page cache, the data cache and the route rules' caching are bypassed, and loaders read
 * `draftMode().enabled`. The disable endpoint clears it.
 *
 * The secret goes in a form or JSON body, not in the URL: a URL is written to logs and browser history.
 * The cookie is signed with a signer of the secret, so it cannot be made without the secret. It carries its own expiry
 * (signed, {@link DRAFT_MAX_AGE_SECONDS}) and is sent with the same `Max-Age`; changing the secret ends every draft cookie.
 *
 * @packageDocumentation
 */

import { getRequestEvent } from "./context";
import { createCookieSigner, parseCookies } from "./cookies";

/** The settings of draft mode, after validation. @internal */
export interface DraftModeSettings {
  readonly secretEnv: string;
  readonly cookieName: string;
  readonly enablePath: string;
  readonly disablePath: string;
}

/** The defaults. @since 1.0.0 */
export const DRAFT_DEFAULTS: DraftModeSettings = Object.freeze({
  secretEnv: "DUSK_DRAFT_SECRET",
  cookieName: "__dusk_draft",
  enablePath: "/_dusk/draft/enable",
  disablePath: "/_dusk/draft/disable",
});

/** The shortest draft secret. @since 1.0.0 */
export const MIN_DRAFT_SECRET = 32;

/**
 * Whether draft mode is on for the current request (its cookie verifies with the secret).
 *
 * @returns `{ enabled }`.
 * @throws DuskError outside a request.
 * @example
 * export const load = async () => { const { enabled } = draftMode(); return loadPost({ drafts: enabled }); };
 * @since 1.0.0
 */
export function draftMode(): { readonly enabled: boolean } {
  return { enabled: getRequestEvent().draft };
}

/**
 * Compares two secrets by content, in time that does not depend on where they differ or on their lengths: both are
 * hashed (SHA-256) and the two fixed-length digests are compared without stopping at the first difference.
 *
 * @param a One secret.
 * @param b The other.
 * @returns Whether they are equal.
 * @internal
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= (x[index] ?? 0) ^ (y[index] ?? 0);
  return difference === 0;
}

/** How long a draft cookie works, in seconds: the cookie's `Max-Age` and the lifetime inside its signed value. @since 1.0.0 */
export const DRAFT_MAX_AGE_SECONDS: number = 8 * 3600;

/**
 * Whether the request's draft cookie verifies with the draft secret and has not expired. The signed value is the expiry
 * (epoch seconds), so a cookie that was copied stops working when its time is up, whatever the browser does with its
 * `Max-Age`.
 *
 * @param cookieHeader The request's `Cookie` header.
 * @param cookieName The cookie name.
 * @param secret The draft secret.
 * @returns Whether draft mode is on.
 * @internal
 */
export async function draftCookieOn(
  cookieHeader: string | null,
  cookieName: string,
  secret: string,
): Promise<boolean> {
  const raw = parseCookies(cookieHeader).get(cookieName);
  if (raw === undefined) return false;
  const value = await createCookieSigner([secret]).unsign(cookieName, raw);
  if (value === undefined || !/^\d{1,12}$/.test(value)) return false;
  return Number(value) * 1000 > Date.now();
}

/**
 * The signed draft cookie value for a secret: the expiry, signed.
 *
 * @param cookieName The cookie name.
 * @param secret The draft secret.
 * @returns The value to set.
 * @internal
 */
export function signedDraftValue(cookieName: string, secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + DRAFT_MAX_AGE_SECONDS;
  return createCookieSigner([secret]).sign(cookieName, String(expires));
}

/**
 * Whether a secret is usable: a string of at least {@link MIN_DRAFT_SECRET} characters.
 *
 * @param secret The secret (possibly undefined).
 * @returns Whether draft mode may be enabled.
 * @internal
 */
export function usableDraftSecret(secret: string | undefined): secret is string {
  return secret !== undefined && secret.length >= MIN_DRAFT_SECRET;
}
