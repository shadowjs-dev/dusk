import { percentDecode } from "../internal/encoding";

/** Attributes of a cookie. Secure defaults apply when omitted. @since 1.0.0 */
export interface CookieOptions {
  /** `Domain`. Omit for a host-only cookie (recommended; required by `__Host-`). */
  readonly domain?: string;
  /** `Path`. Default `"/"`. */
  readonly path?: string;
  /** `Max-Age` in seconds. Omit for a session cookie. */
  readonly maxAge?: number;
  /** `Expires`. Prefer `maxAge`. */
  readonly expires?: Date;
  /** Default `true`: scripts cannot read the cookie. */
  readonly httpOnly?: boolean;
  /** Default `true`: only sent over https (and to localhost in browsers). */
  readonly secure?: boolean;
  /** Default `"lax"`. */
  readonly sameSite?: "lax" | "strict" | "none";
  /** `Partitioned` (CHIPS). */
  readonly partitioned?: boolean;
}

/** The cookies of one request: what arrived and what to send back. @since 1.0.0 */
export interface CookieJar {
  /** Value of an incoming (or already set) cookie. */
  get(name: string): string | undefined;
  /** All cookies, name to value. */
  getAll(): ReadonlyMap<string, string>;
  /** Queues a `Set-Cookie`. Defaults: `Path=/; HttpOnly; Secure; SameSite=Lax`. */
  set(name: string, value: string, options?: CookieOptions): void;
  /** Queues a `Set-Cookie` that removes the cookie. Pass the `path` and `domain` it was set with. */
  delete(
    name: string,
    options?: Pick<CookieOptions, "domain" | "path" | "secure" | "sameSite">,
  ): void;
  /** Value of a signed cookie, or `undefined` when missing or when the signature does not verify. */
  getSigned(name: string): Promise<string | undefined>;
  /** Queues a signed cookie (HMAC-SHA-256 with the first configured secret). */
  setSigned(name: string, value: string, options?: CookieOptions): Promise<void>;
  /** The `Set-Cookie` header values queued so far. */
  serialized(): readonly string[];
  /**
   * Whether a cookie that does not set `secure` is written with `Secure` on this request: true
   * except in development over plain http on localhost. Code that picks a `__Host-` name reads it.
   */
  readonly secure: boolean;
}

/** Limits of the cookie code. Documented in the security guide. @since 1.0.0 */
export const COOKIE_LIMITS: Readonly<{
  maxHeaderLength: number;
  maxCookies: number;
  maxNameValueLength: number;
  maxOutgoing: number;
}> = Object.freeze({
  maxHeaderLength: 8192,
  maxCookies: 50,
  maxNameValueLength: 4096,
  maxOutgoing: 50,
});

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DOMAIN =
  /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const PATH = /^\/[\x21\x23-\x3a\x3c-\x7e]*$/;

/**
 * Parses a `Cookie` header. At most 50 cookies are read, a header over 8 KiB is ignored, names that
 * are not tokens are skipped, and the first occurrence of a name wins. The result is a `Map`, so a
 * cookie named `__proto__` is plain data.
 *
 * @param header The raw header value, or `null`.
 * @returns Name to value, values percent-decoded.
 * @example
 * parseCookies("a=1; b=hello%20world").get("b"); // "hello world"
 * @since 1.0.0
 */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === null || header.length > COOKIE_LIMITS.maxHeaderLength) return cookies;
  for (const part of header.split(";")) {
    if (cookies.size >= COOKIE_LIMITS.maxCookies) break;
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim();
    if (!TOKEN.test(name) || cookies.has(name)) continue;
    let value = part.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    cookies.set(name, percentDecode(value));
  }
  return cookies;
}

/**
 * Builds a `Set-Cookie` value. Secure by default: `HttpOnly; Secure; SameSite=Lax; Path=/`. Names,
 * domains and paths are validated, so no attribute can inject another or a header line.
 *
 * @param name Cookie name (an RFC 6265 token).
 * @param value Any string; it is percent-encoded.
 * @param options Attributes.
 * @returns The header value.
 * @throws TypeError for an invalid name, domain, path or a prefix rule violation (`__Host-`,
 *   `__Secure-`, `SameSite=None` without `Secure`). RangeError for a cookie over 4096 bytes.
 * @example
 * serializeCookie("theme", "dark", { maxAge: 31_536_000, httpOnly: false });
 * @since 1.0.0
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!TOKEN.test(name))
    throw new TypeError(`cookie name ${JSON.stringify(name)} is not a valid token.`);
  const encoded = encodeURIComponent(value);
  if (name.length + encoded.length > COOKIE_LIMITS.maxNameValueLength) {
    throw new RangeError(
      `COOKIE_TOO_LARGE: "${name}" exceeds ${COOKIE_LIMITS.maxNameValueLength} bytes.`,
    );
  }
  const secure = options.secure ?? true;
  const path = options.path ?? "/";
  const sameSite = options.sameSite ?? "lax";
  if (!PATH.test(path))
    throw new TypeError("cookie path must start with / and contain no ; or controls.");
  if (
    options.domain !== undefined &&
    (options.domain.length > 253 || !DOMAIN.test(options.domain))
  ) {
    throw new TypeError("cookie domain is not a valid host name.");
  }
  if (name.startsWith("__Host-") && (!secure || path !== "/" || options.domain !== undefined)) {
    throw new TypeError("a __Host- cookie must be Secure, have Path=/ and no Domain.");
  }
  if (name.startsWith("__Secure-") && !secure)
    throw new TypeError("a __Secure- cookie must be Secure.");
  if (sameSite === "none" && !secure) throw new TypeError("SameSite=None requires Secure.");
  const parts = [`${name}=${encoded}`, `Path=${path}`];
  if (options.domain !== undefined) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined) {
    if (!Number.isInteger(options.maxAge)) throw new TypeError("cookie maxAge must be an integer.");
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.expires !== undefined) {
    if (Number.isNaN(options.expires.getTime()))
      throw new TypeError("cookie expires is an invalid date.");
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  parts.push(`SameSite=${sameSite === "lax" ? "Lax" : sameSite === "strict" ? "Strict" : "None"}`);
  if (options.partitioned === true) parts.push("Partitioned");
  return parts.join("; ");
}

/** Signs and verifies cookie values with HMAC-SHA-256. @since 1.0.0 */
export interface CookieSigner {
  /** `value.signature`, bound to the cookie name. */
  sign(name: string, value: string): Promise<string>;
  /** The value when the signature verifies with any configured secret, else `undefined`. */
  unsign(name: string, signed: string): Promise<string | undefined>;
}

/** Shortest accepted signing secret, in characters. @since 1.0.0 */
export const MIN_SECRET_LENGTH = 32;

/**
 * Creates a signer. The first secret signs; every secret verifies, so a secret can be rotated by
 * putting the new one first and keeping the old one until its cookies expire. The signature covers
 * the cookie name too, so a value cannot be moved to another cookie.
 *
 * @param secrets One or more secrets of at least 32 characters.
 * @returns The signer.
 * @throws Error with code `COOKIE_SECRET_MISSING` or `COOKIE_SECRET_WEAK`.
 * @example
 * const signer = createCookieSigner([process.env.COOKIE_SECRET]);
 * const cookie = await signer.sign("sid", "abc");
 * @since 1.0.0
 */
export function createCookieSigner(secrets: readonly string[]): CookieSigner {
  if (secrets.length === 0)
    throw new Error("COOKIE_SECRET_MISSING: at least one cookie secret is required.");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `COOKIE_SECRET_WEAK: cookie secrets need at least ${MIN_SECRET_LENGTH} characters.`,
      );
    }
  }
  // The HMAC code loads with the first signature (`./cookie-signer`); the checks above run at start-up.
  let signer: Promise<CookieSigner> | undefined;
  const loaded = (): Promise<CookieSigner> => {
    signer ??= import("./cookie-signer").then((module) => module.createHmacSigner(secrets));
    return signer;
  };
  return {
    async sign(name, value) {
      return (await loaded()).sign(name, value);
    },
    async unsign(name, signed) {
      return (await loaded()).unsign(name, signed);
    },
  };
}

/** Settings of the jar that belong to the request, not to a single cookie. @internal */
export interface JarSettings {
  readonly header: string | null;
  readonly signer: CookieSigner | undefined;
  /** Default of `Secure` for cookies that do not set it. */
  readonly secure: boolean;
}

/**
 * Creates the cookie jar of one request.
 * @internal
 */
export function createCookieJar(settings: JarSettings): CookieJar {
  const incoming = parseCookies(settings.header);
  const outgoing = new Map<string, string>();
  const queue = (name: string, value: string, options: CookieOptions): void => {
    const effective: CookieOptions = { secure: settings.secure, ...options };
    const header = serializeCookie(name, value, effective);
    const identity = `${name};${effective.domain ?? ""};${effective.path ?? "/"}`;
    if (!outgoing.has(identity) && outgoing.size >= COOKIE_LIMITS.maxOutgoing) {
      throw new RangeError(`a response may set at most ${COOKIE_LIMITS.maxOutgoing} cookies.`);
    }
    outgoing.set(identity, header);
  };
  const requireSigner = (): CookieSigner => {
    if (settings.signer === undefined) {
      throw new Error(
        "COOKIE_SECRET_MISSING: configure security.cookieSecrets to use signed cookies.",
      );
    }
    return settings.signer;
  };
  return {
    get: (name) => incoming.get(name),
    getAll: () => incoming,
    set(name, value, options = {}) {
      queue(name, value, options);
      incoming.set(name, value);
    },
    delete(name, options = {}) {
      queue(name, "", { ...options, maxAge: 0, expires: new Date(0) });
      incoming.delete(name);
    },
    async getSigned(name) {
      const raw = incoming.get(name);
      if (raw === undefined) return undefined;
      return requireSigner().unsign(name, raw);
    },
    async setSigned(name, value, options = {}) {
      const signed = await requireSigner().sign(name, value);
      queue(name, signed, options);
      incoming.set(name, signed);
    },
    serialized: () => [...outgoing.values()],
    secure: settings.secure,
  };
}
