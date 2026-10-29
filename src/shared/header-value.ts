/**
 * The header checks the declarative routing and `security.defaultCacheControl` share: a header name is a token, a
 * value has no line break or NUL, the framework's own headers cannot be set by a rule, and a value is bounded. Kept out
 * of `routing-config.ts` so the handler's always-loaded configuration does not carry the routing validators.
 *
 * @packageDocumentation
 */

import { isRecord } from "./check";

/** A header name: an RFC 9110 token. */
export const TOKEN: RegExp = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);
const MAX_HEADER_VALUE = 8192;

/** Validates a header object (`name: value`) and lowers the names. @internal */
export function headersOf(where: string, value: unknown): readonly (readonly [string, string])[] {
  if (!isRecord(value))
    throw new TypeError(
      __DEV__ ? `${where} must be an object of header names and values.` : `DUSK_HEADERS ${where}`,
    );
  return Object.entries(value).map(([name, text]) => {
    if (!TOKEN.test(name))
      throw new TypeError(
        __DEV__ ? `${where}: "${name}" is not a valid header name.` : `DUSK_HEADER_5 ${where}`,
      );
    const lowered = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lowered)) {
      throw new TypeError(
        __DEV__
          ? `${where}: "${name}" cannot be set here (use the cookies API or the framework).`
          : `DUSK_HEADER_3 ${where}`,
      );
    }
    if (typeof text !== "string")
      throw new TypeError(
        __DEV__ ? `${where}: the value of "${name}" must be a string.` : `DUSK_HEADER_6 ${where}`,
      );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters other than HTAB are what is refused (RFC 9110 field-value).
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(text))
      throw new TypeError(
        __DEV__
          ? `${where}: the value of "${name}" must not contain a line break, NUL or other control character.`
          : `DUSK_HEADER_1 ${where}`,
      );
    if (text.length > MAX_HEADER_VALUE)
      throw new TypeError(
        __DEV__
          ? `${where}: the value of "${name}" is longer than ${MAX_HEADER_VALUE} characters.`
          : `DUSK_HEADER_4 ${where}`,
      );
    return [lowered, text] as const;
  });
}

/**
 * A `cache-control` option (a route rule's `cacheControl`, or `security.defaultCacheControl`): a header value, or `false`.
 * Control characters are refused, so a value cannot inject a header.
 *
 * @param where The option's name, for the message.
 * @param value The option as written.
 * @returns The value, or `false`.
 * @throws TypeError when the value is neither `false` nor a non-empty header value.
 * @since 1.0.0
 */
export function cacheControlOf(where: string, value: unknown): string | false {
  if (value === false) return false;
  // The header rules check the value (a line break, a NUL, a type); an empty value is no cache-control at all.
  const [entry] = headersOf(where, { "cache-control": value });
  if (entry === undefined || entry[1] === "") {
    throw new TypeError(
      __DEV__ ? `${where} must be false or a non-empty header value.` : `DUSK_HEADER_2 ${where}`,
    );
  }
  return entry[1];
}
