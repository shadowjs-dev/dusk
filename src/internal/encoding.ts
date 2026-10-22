/**
 * Small byte and text helpers shared by the cookie, session and request code. They use only Web
 * APIs (`btoa`, `crypto`, `TextEncoder`), so they run on every host.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Base64url (RFC 4648 §5, no padding) of some bytes. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  // Chunked, so a large input does not exceed the argument limit of fromCharCode.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Decodes base64url. Returns `undefined` for text that is not base64url, so callers can treat a
 * tampered value as invalid without a try/catch.
 */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  const padded = text
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A random token of `size` bytes as base64url. */
export function randomToken(size: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(size)));
}

/** Standard base64 of random bytes, the alphabet CSP nonces use. */
export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decodes percent-escapes without ever throwing: a malformed sequence is kept literally and
 * invalid UTF-8 becomes U+FFFD. `+` stays `+` (this is not form decoding).
 */
export function percentDecode(raw: string): string {
  if (!raw.includes("%")) return raw;
  const decoded = new URLSearchParams(
    `v=${raw.replaceAll("+", "%2B").replaceAll("&", "%26").replaceAll("#", "%23")}`,
  ).get("v");
  return decoded ?? raw;
}
