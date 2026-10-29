import { deserialize, serialize } from "@shadow-js/web/server";
import { base64UrlDecode, base64UrlEncode } from "../internal/encoding";
import {
  FLASH_COOKIE,
  FLASH_MAX_CHARS,
  type FlashPayload,
  type WireSubmission,
} from "../shared/action";
import type { RequestEvent } from "./types";

/**
 * One-time flash values: a signed cookie that carries a submission outcome, or a value set with
 * {@link setFlash}, to the page the browser is sent to next. The page that renders it reads the value
 * and clears the cookie, so the value is shown once. The cookie is signed with `security.cookieSecrets`;
 * without secrets nothing is carried (and a page renders with no flash).
 */

/** The cookie jar of a request. Only what the flash needs. */
type Jar = Pick<RequestEvent, "cookies">["cookies"];

/** What each request has written so far: writes merge, so a submission and a `setFlash` value share one cookie. */
const written = new WeakMap<Jar, FlashPayload>();

/** Cookie attributes of a flash: a page-wide, short-lived, HTTP-only cookie. */
const FLASH_OPTIONS = { path: "/", maxAge: 300, sameSite: "lax" } as const;

/**
 * True when the error says the app configured no cookie secrets (the signed cookie of a flash cannot be
 * written or read). @internal
 */
export function isNoSecrets(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("COOKIE_SECRET_MISSING");
}

/**
 * Writes the flash of this response: merges `patch` into what the request already wrote and signs
 * the cookie again. A payload over {@link FLASH_MAX_CHARS} keeps only the status of its submission.
 *
 * @internal
 */
export async function writeFlash(
  event: Pick<RequestEvent, "cookies">,
  patch: FlashPayload,
): Promise<void> {
  const merged: FlashPayload = { ...written.get(event.cookies), ...patch };
  written.set(event.cookies, merged);
  let text = base64UrlEncode(new TextEncoder().encode(serialize(merged)));
  if (text.length > FLASH_MAX_CHARS) {
    const submission = merged.submission;
    const status: FlashPayload = {
      ...(submission === undefined ? {} : { submission: summary(submission) }),
    };
    text = base64UrlEncode(new TextEncoder().encode(serialize(status)));
  }
  await event.cookies.setSigned(FLASH_COOKIE, text, FLASH_OPTIONS);
}

/** The status-only form of a submission: what is kept when the full outcome is too large. */
function summary(submission: WireSubmission): WireSubmission {
  return {
    key: submission.key,
    status: submission.status,
    ...(submission.error === undefined
      ? {}
      : { error: { status: submission.error.status, message: submission.error.message } }),
  };
}

/**
 * Reads the flash of the request and clears its cookie. A forged, tampered or malformed cookie reads as
 * no flash. Called when a page renders.
 *
 * @param event The request.
 * @param report Receives the error of a signed value that does not decode (the page renders without a flash).
 * @returns The payload, or `undefined` when there is none.
 * @internal
 */
export async function takeFlash(
  event: Pick<RequestEvent, "cookies">,
  report: (error: unknown) => void,
): Promise<FlashPayload | undefined> {
  if (event.cookies.get(FLASH_COOKIE) === undefined) return undefined;
  let value: string | undefined;
  try {
    value = await event.cookies.getSigned(FLASH_COOKIE);
  } catch (error) {
    if (!isNoSecrets(error)) throw error;
  }
  event.cookies.delete(FLASH_COOKIE, { path: "/" });
  if (value === undefined) return undefined;
  const bytes = base64UrlDecode(value);
  if (bytes === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = deserialize(new TextDecoder().decode(bytes));
  } catch (error) {
    // A signed value that does not decode was written by another version (or another codec): it reads as no flash. It is
    // reported, because the signature says this server wrote it.
    report(error);
    return undefined;
  }
  return typeof decoded === "object" && decoded !== null ? (decoded as FlashPayload) : undefined;
}

/**
 * Sets a value that the next page shows once, read with `useFlash()` on the page. Use it for a message
 * that must survive a redirect (for example "Saved."). The value must be serializable (the wire codec:
 * dates, maps, sets, bigints and plain data). Needs `security.cookieSecrets`.
 *
 * @param event The request event of the function or the route.
 * @param value What the page reads. Keep it small: payloads over 3000 characters keep only the status.
 * @returns A promise that resolves when the cookie is set.
 * @throws COOKIE_SECRET_MISSING error when no cookie secrets are configured.
 * @example
 * export const archive = serverFn({ form: true }, async (input, event) => {
 *   await archiveNote(input.id);
 *   await setFlash(event, { notice: "Archived." });
 *   return { ok: true };
 * });
 * @since 1.0.0
 */
export async function setFlash(event: RequestEvent, value: unknown): Promise<void> {
  await writeFlash(event, { flash: value });
}
