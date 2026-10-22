import { describe, expect, it } from "vitest";
import { base64UrlDecode, percentDecode } from "../src/internal/encoding";
import { safeHref } from "../src/metadata/url";
import { normalizeIp } from "../src/server/client-address";
import { parseCookies } from "../src/server/cookies";
import { dispositionOf } from "../src/server/file";
import { compileHostRules } from "../src/server/hosts";
import { isRefusedImageHost } from "../src/server/image-hosts";
import { canonicalPath, varyNames } from "../src/server/isr";
import { checkRedirectTarget } from "../src/server/redirect-target";
import { formatSseEvent } from "../src/server/sse";
import { checkHandshake } from "../src/server/websocket";
import { compilePattern, matchPattern } from "../src/shared/path-pattern";
import { trailingSlashTarget } from "../src/shared/trailing-slash";
import { internalLinks } from "../src/static/crawl";

/**
 * Every regular expression that the framework applies to text a client controls (a path, a host, a header, a cookie, a query,
 * an address, a markup string the app rendered) is exercised here through the function that owns it. A pattern with
 * a nested quantifier, or one that retries from each start position (`/x+$/` on `xxxx...y`), takes time quadratic in
 * the input. Each family below is run at a small and a 32 times larger size: linear code takes about 32 times
 * longer, quadratic code about 1,000 times longer. The bound is 64 times, twice the linear ratio.
 */

/** Best of `runs` wall-clock times in milliseconds; the minimum drops scheduler and GC noise. */
function best(task: () => void, runs = 5): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    task();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

const SMALL = 4_000;
const LARGE = SMALL * 32;
/** Families that fail on the first characters take constant time; this floor keeps noise out of the ratio. */
const FLOOR_MS = 0.25;

/** Runs `use` (which swallows the function's own refusals) on one adversarial text. */
type Use = (text: string) => void;

const swallow =
  (use: (text: string) => unknown): Use =>
  (text) => {
    try {
      use(text);
    } catch {
      // A refusal is a fast answer; only the time matters here.
    }
  };

const POLICY = { origin: "https://app.test", trustedOrigins: new Set<string>() };
const PAGE = new URL("https://app.test/");
const PATTERN = compilePattern("/a/:id/*rest");
const HOSTS = compileHostRules(["*.app.test", "app.test", "[::1]"]);

const FAMILIES: ReadonlyArray<
  readonly [id: string, name: string, use: Use, build: (size: number) => string]
> = [
  [
    "01",
    "trailing-slash trim: many slashes before a last segment",
    swallow((text) => trailingSlashTarget(text, "never")),
    (n) => `${"/".repeat(n)}a/`,
  ],
  [
    "02",
    "image host: a run of dots before a last label",
    swallow(isRefusedImageHost),
    (n) => `${".".repeat(n)}a`,
  ],
  [
    "03",
    "image host: a run of opening brackets",
    swallow(isRefusedImageHost),
    (n) => "[".repeat(n),
  ],
  [
    "04",
    "image host: a run of percent signs in a zone id",
    swallow(isRefusedImageHost),
    (n) => `fe80::1%${"%".repeat(n)}`,
  ],
  ["05", "client address: a run of colons", swallow(normalizeIp), (n) => ":".repeat(n)],
  ["06", "client address: a run of hex groups", swallow(normalizeIp), (n) => "1:".repeat(n / 2)],
  ["07", "client address: a run of digits", swallow(normalizeIp), (n) => "1".repeat(n)],
  ["08", "client address: dots and digits", swallow(normalizeIp), (n) => "1.".repeat(n / 2)],
  ["09", "cookie header: a run of separators", swallow(parseCookies), (n) => "; ".repeat(n / 2)],
  ["10", "cookie header: pairs without a value", swallow(parseCookies), (n) => "a=".repeat(n / 2)],
  [
    "11",
    "cookie header: percent escapes that never end",
    swallow(parseCookies),
    (n) => `a=${"%".repeat(n)}`,
  ],
  [
    "12",
    "redirect target: a run of spaces before a letter",
    swallow((text) => checkRedirectTarget(text, POLICY)),
    (n) => `${" ".repeat(n)}a`,
  ],
  [
    "13",
    "redirect target: a run of spaces after a letter",
    swallow((text) => checkRedirectTarget(text, POLICY)),
    (n) => `a${" ".repeat(n)}`,
  ],
  [
    "14",
    "redirect target: a scheme that never ends",
    swallow((text) => checkRedirectTarget(text, POLICY)),
    (n) => `${"a".repeat(n)}://`,
  ],
  ["15", "host rules: a long host", swallow(HOSTS), (n) => `${"a".repeat(n)}.app.test`],
  ["16", "host rules: dots", swallow(HOSTS), (n) => ".".repeat(n)],
  [
    "17",
    "path pattern: slashes between segments",
    swallow((text) => matchPattern(PATTERN, text)),
    (n) => `/a/${"/".repeat(n)}`,
  ],
  [
    "18",
    "path pattern: percent escapes",
    swallow((text) => matchPattern(PATTERN, text)),
    (n) => `/a/${"%41".repeat(n / 3)}/x`,
  ],
  [
    "19",
    "path pattern: a broken escape at the end",
    swallow((text) => matchPattern(PATTERN, text)),
    (n) => `/a/${"a".repeat(n)}%`,
  ],
  [
    "20",
    "canonical cache path: runs of capital letters",
    swallow((text) => canonicalPath(text, false)),
    (n) => `/${"Ab".repeat(n / 2)}`,
  ],
  [
    "21",
    "canonical cache path: capital letters in escapes",
    swallow((text) => canonicalPath(text, false)),
    (n) => `/${"%C3%A9A".repeat(n / 7)}`,
  ],
  ["22", "Vary header: commas", swallow(varyNames), (n) => ",".repeat(n)],
  ["23", "Vary header: spaces around names", swallow(varyNames), (n) => `${" ".repeat(n)}a`],
  [
    "24",
    "Content-Disposition name: marks that are removed",
    swallow(dispositionOf),
    (n) => "é".repeat(n / 2),
  ],
  [
    "25",
    "Content-Disposition name: quotes and backslashes",
    swallow(dispositionOf),
    (n) => '"\\'.repeat(n / 2),
  ],
  ["26", "Content-Disposition name: non-ASCII text", swallow(dispositionOf), (n) => "é".repeat(n)],
  [
    "27",
    "Server-Sent Events payload: carriage returns",
    swallow(formatSseEvent),
    (n) => "\r".repeat(n),
  ],
  [
    "28",
    "Server-Sent Events payload: CR LF pairs",
    swallow(formatSseEvent),
    (n) => "\r\n".repeat(n / 2),
  ],
  [
    "29",
    "WebSocket handshake: a key that never ends",
    swallow((text) =>
      checkHandshake(
        new Headers({
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": text,
        }),
      ),
    ),
    (n) => "A".repeat(n),
  ],
  ["30", "percent decoding: escapes that never end", swallow(percentDecode), (n) => "%".repeat(n)],
  ["31", "percent decoding: broken UTF-8", swallow(percentDecode), (n) => "%C3".repeat(n / 3)],
  ["32", "base64url: a long text", swallow(base64UrlDecode), (n) => `${"A".repeat(n)}!`],
  [
    "33",
    "metadata link: a scheme that never ends",
    swallow((text) => safeHref(text)),
    (n) => "a".repeat(n),
  ],
  [
    "34",
    "metadata data link: a long data image",
    swallow((text) => safeHref(text, { dataImage: true })),
    (n) => `data:image/png;base64,${"A".repeat(n)}`,
  ],
  [
    "35",
    "crawl: opening anchors that never close",
    swallow((text) => internalLinks(text, PAGE, PAGE.origin, "/")),
    (n) => "<a ".repeat(n / 3),
  ],
  [
    "36",
    "crawl: anchors with an attribute name that is not href",
    swallow((text) => internalLinks(text, PAGE, PAGE.origin, "/")),
    (n) => "<a href".repeat(n / 7),
  ],
  [
    "37",
    "crawl: white space after href",
    swallow((text) => internalLinks(text, PAGE, PAGE.origin, "/")),
    (n) => `<a href${" ".repeat(n)}`,
  ],
  [
    "38",
    "crawl: unterminated quoted values",
    swallow((text) => internalLinks(text, PAGE, PAGE.origin, "/")),
    (n) => '<a href="'.repeat(n / 9),
  ],
];

describe("regular expressions on client-controlled text are linear", () => {
  for (const [id, name, use, build] of FAMILIES) {
    it(`[DUSK-REDOS-${id}] ${name}: 32x the input stays under 64x the time`, () => {
      const little = build(SMALL);
      const big = build(LARGE);
      use(little);
      const small = Math.max(
        best(() => use(little)),
        FLOOR_MS,
      );
      // Both sizes run once before they are timed, so neither measures a cold function (compilation, first allocation).
      use(big);
      const large = best(() => use(big), 7);
      expect(large).toBeLessThan(small * 64);
    });
  }
});
