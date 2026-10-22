import { percentDecode } from "../internal/encoding";

/** One cookie held by a {@link TestCookieJar}. @since 1.0.0 */
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  /** True when no `Domain` attribute was sent (the cookie matches only the exact host). */
  readonly hostOnly: boolean;
  readonly path: string;
  /** Milliseconds since epoch, or `undefined` for a session cookie. */
  readonly expires: number | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "lax" | "strict" | "none" | undefined;
}

/**
 * A cookie jar that behaves like a browser's for one test: it stores what `Set-Cookie` sends,
 * honors `Max-Age`, `Expires`, `Path`, `Domain` and `Secure`, and builds the `Cookie` header.
 * The values are percent-decoded the same way the server decodes them.
 * @since 1.0.0
 */
export interface TestCookieJar {
  /** Stores the cookies of a response's `Set-Cookie` headers. */
  ingest(url: URL, setCookies: readonly string[]): void;
  /** The `Cookie` header value for a request to `url`, or `undefined`. */
  header(url: URL): string | undefined;
  /** The value of a cookie that would be sent to `url`. */
  get(name: string, url: URL): string | undefined;
  /** Stores a cookie directly, for example a tampered one. */
  set(
    url: URL,
    name: string,
    value: string,
    options?: Partial<Pick<StoredCookie, "path" | "secure">>,
  ): void;
  /** Every stored cookie. */
  all(): readonly StoredCookie[];
  clear(): void;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

function domainMatches(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/**
 * Creates a jar.
 *
 * @param now Time source in milliseconds. Default `Date.now`.
 * @returns The jar.
 * @example
 * const jar = createTestCookieJar();
 * jar.ingest(new URL("https://app.test/"), ["sid=1; Path=/; Max-Age=60"]);
 * jar.header(new URL("https://app.test/x")); // "sid=1"
 * @since 1.0.0
 */
export function createTestCookieJar(now: () => number = Date.now): TestCookieJar {
  let cookies: StoredCookie[] = [];
  const identity = (cookie: StoredCookie): string =>
    `${cookie.name};${cookie.domain};${cookie.path}`;
  const store = (cookie: StoredCookie): void => {
    cookies = cookies.filter((existing) => identity(existing) !== identity(cookie));
    if (cookie.expires === undefined || cookie.expires > now()) cookies.push(cookie);
  };
  const eligible = (url: URL): StoredCookie[] => {
    cookies = cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now());
    const secureContext = url.protocol === "https:" || LOOPBACK.has(url.hostname);
    return cookies
      .filter(
        (cookie) =>
          domainMatches(url.hostname, cookie) &&
          pathMatches(url.pathname, cookie.path) &&
          (!cookie.secure || secureContext),
      )
      .sort((a, b) => b.path.length - a.path.length);
  };
  return {
    ingest(url, setCookies) {
      for (const line of setCookies) {
        const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
        const equals = pair.indexOf("=");
        if (equals <= 0) continue;
        const name = pair.slice(0, equals);
        const value = percentDecode(pair.slice(equals + 1));
        let domain = url.hostname;
        let hostOnly = true;
        let path = "/";
        let expires: number | undefined;
        let secure = false;
        let httpOnly = false;
        let sameSite: StoredCookie["sameSite"];
        for (const attribute of attributes) {
          const [key = "", raw = ""] = attribute.split("=");
          const lower = key.toLowerCase();
          if (lower === "domain" && raw !== "") {
            domain = raw.replace(/^\./, "").toLowerCase();
            hostOnly = false;
          } else if (lower === "path" && raw.startsWith("/")) path = raw;
          else if (lower === "max-age") expires = now() + Number(raw) * 1000;
          else if (lower === "expires" && expires === undefined) {
            const time = Date.parse(raw);
            if (!Number.isNaN(time)) expires = time;
          } else if (lower === "secure") secure = true;
          else if (lower === "httponly") httpOnly = true;
          else if (lower === "samesite") {
            const mode = raw.toLowerCase();
            if (mode === "lax" || mode === "strict" || mode === "none") sameSite = mode;
          }
        }
        // A browser refuses a Secure cookie from an insecure origin (localhost excepted).
        if (secure && url.protocol !== "https:" && !LOOPBACK.has(url.hostname)) continue;
        if (!hostOnly && !(url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
          continue;
        store({ name, value, domain, hostOnly, path, expires, secure, httpOnly, sameSite });
      }
    },
    header(url) {
      const list = eligible(url);
      return list.length === 0
        ? undefined
        : list.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
    },
    get(name, url) {
      return eligible(url).find((cookie) => cookie.name === name)?.value;
    },
    set(url, name, value, options = {}) {
      store({
        name,
        value,
        domain: url.hostname,
        hostOnly: true,
        path: options.path ?? "/",
        expires: undefined,
        secure: options.secure ?? false,
        httpOnly: false,
        sameSite: undefined,
      });
    },
    all: () => cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now()),
    clear() {
      cookies = [];
    },
  };
}
