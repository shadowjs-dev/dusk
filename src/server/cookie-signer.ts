import { base64UrlDecode, base64UrlEncode, utf8 } from "../internal/encoding";
import type { CookieSigner } from "./cookies";

/**
 * The HMAC-SHA-256 signer behind `createCookieSigner` (see `cookies.ts`). It is loaded on the first signed cookie, not at
 * start-up, so an app that never signs a cookie does not carry it. The caller has checked the secrets.
 *
 * @internal
 */
export function createHmacSigner(secrets: readonly string[]): CookieSigner {
  const keys: Promise<CryptoKey>[] = [];
  const keyAt = (index: number): Promise<CryptoKey> => {
    const known = keys[index];
    if (known !== undefined) return known;
    const secret = secrets[index];
    if (secret === undefined) throw new RangeError("no such secret");
    const created = crypto.subtle.importKey(
      "raw",
      utf8(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keys[index] = created;
    return created;
  };
  const message = (name: string, value: string): Uint8Array<ArrayBuffer> =>
    utf8(`${name}=${value}`);
  return {
    async sign(name, value) {
      const key = await keyAt(0);
      const signature = await crypto.subtle.sign("HMAC", key, message(name, value));
      return `${value}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
    async unsign(name, signed) {
      const dot = signed.lastIndexOf(".");
      if (dot === -1) return undefined;
      const value = signed.slice(0, dot);
      const encoded = signed.slice(dot + 1);
      const signature = base64UrlDecode(encoded);
      if (signature === undefined || signature.length !== 32) return undefined;
      // One spelling per signature: base64 lets the last character carry bits that are not part of the 32 bytes, so
      // four strings would decode to the same signature and a value could be replayed under four spellings.
      if (base64UrlEncode(signature) !== encoded) return undefined;
      for (let index = 0; index < secrets.length; index += 1) {
        const key = await keyAt(index);
        // verify() compares in constant time.
        if (await crypto.subtle.verify("HMAC", key, signature, message(name, value))) return value;
      }
      return undefined;
    },
  };
}
