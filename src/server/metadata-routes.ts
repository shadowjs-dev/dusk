import { applyTrailingSlash, type TrailingSlashPolicy } from "../metadata/url";
import type { ApiHandler, ApiResult, RequestEvent } from "./types";

/**
 * Metadata routes: `sitemap.xml`, `robots.txt` and `manifest.webmanifest` as typed values, serialized by pure
 * functions and served by small API-route helpers. A route file is an API route like any other:
 *
 * ```ts
 * // src/routes/sitemap.xml.ts
 * import { sitemapRoute } from "@shadow-js/dusk/server";
 * export const GET = sitemapRoute((event) => [{ url: "https://example.com/", changeFrequency: "daily" }]);
 * ```
 *
 * The function receives the request event, so it can answer per host (a status host, say).
 */

/** Largest sitemap a single file may hold (the protocol's limit). @since 1.0.0 */
export const MAX_SITEMAP_URLS: number = 50_000;
/** Largest sitemap file in UTF-8 bytes (the protocol's limit, 50 MiB). @since 1.0.0 */
export const MAX_SITEMAP_BYTES: number = 50 * 1024 * 1024;
/** Most images one sitemap URL may list (Google's limit). @since 1.0.0 */
export const MAX_SITEMAP_IMAGES: number = 1000;
/** Most `<video:tag>` elements one video may list (Google's limit). @since 1.0.0 */
export const MAX_SITEMAP_VIDEO_TAGS: number = 32;
/** Most language alternates one sitemap URL may list. @since 1.0.0 */
export const MAX_SITEMAP_ALTERNATES: number = 1000;
/** Longest title, caption, description, tag or language code, in characters. @since 1.0.0 */
export const MAX_SITEMAP_TEXT: number = 8192;
/** Longest video duration in seconds (Google's limit, 8 hours). @since 1.0.0 */
export const MAX_VIDEO_DURATION: number = 28_800;

/** `changefreq` values of the sitemap protocol. @since 1.0.0 */
export type ChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

/** An image of a sitemap entry (Google's image extension). @since 1.0.0 */
export interface SitemapImage {
  readonly loc: string | URL;
  readonly caption?: string;
  readonly title?: string;
  readonly license?: string | URL;
}

/** A video of a sitemap entry (Google's video extension). @since 1.0.0 */
export interface SitemapVideo {
  readonly thumbnailLoc: string | URL;
  readonly title: string;
  readonly description: string;
  readonly contentLoc?: string | URL;
  readonly playerLoc?: string | URL;
  readonly duration?: number;
  readonly publicationDate?: string | Date;
  readonly familyFriendly?: boolean;
  readonly tags?: readonly string[];
}

/**
 * One URL of a sitemap. `alternates.languages` lists the same page in other languages (`xhtml:link`), and the
 * entry itself is the default one, which the protocol expects to appear in its own list.
 * @since 1.0.0
 */
export interface SitemapEntry {
  readonly url: string | URL;
  readonly lastModified?: string | Date;
  readonly changeFrequency?: ChangeFrequency;
  /** 0 to 1, one decimal place is customary. */
  readonly priority?: number;
  readonly alternates?: { readonly languages?: Readonly<Record<string, string | URL>> };
  readonly images?: readonly (string | URL | SitemapImage)[];
  readonly videos?: readonly SitemapVideo[];
}

/** One sitemap of a site with several (`generateSitemaps`). @since 1.0.0 */
export interface SitemapIndexEntry {
  readonly url: string | URL;
  readonly lastModified?: string | Date;
}

const CHANGE_FREQUENCIES: ReadonlySet<string> = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

/**
 * Drops the characters XML 1.0 cannot hold at all (not even escaped): most C0 controls, U+FFFE and U+FFFF, and a
 * surrogate that is not half of a pair. A strict parser rejects the whole document at the first one, so a single bad
 * title would take a sitemap away from every crawler. Written as a scan, not a pattern, so no control character has to
 * be spelled in a regular expression.
 */
function stripInvalidXml(text: string): string {
  let out: string | undefined;
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let bad = false;
    if (code < 0x20) {
      bad = code !== 0x09 && code !== 0x0a && code !== 0x0d;
    } else if (code === 0xfffe || code === 0xffff) {
      bad = true;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else bad = true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bad = true;
    }
    if (bad) {
      out = (out ?? "") + text.slice(from, index);
      from = index + 1;
    }
  }
  return out === undefined ? text : out + text.slice(from);
}

/** XML text escaping for element content and attribute values. Characters XML cannot hold are dropped. */
export function xmlEscape(text: string): string {
  return stripInvalidXml(text).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

/** A text value of the sitemap (a title, a caption, a tag): a string of bounded length, escaped. */
function xmlText(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string.`);
  if (value.length > MAX_SITEMAP_TEXT)
    throw new RangeError(`${what} is longer than ${MAX_SITEMAP_TEXT} characters.`);
  return xmlEscape(value);
}

/** The number of bytes `text` takes in UTF-8 (it holds no lone surrogate once escaped). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** True for a C0 control character or DEL. */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * An absolute http(s) URL, as the sitemap protocol requires. Anything else is a configuration error. An absolute
 * string is written as given (a bare origin keeps no trailing slash, as Next writes it); a relative one resolves
 * against `base`, and a `URL` object is written as its `href`.
 */
function absoluteUrl(value: string | URL, what: string, base: URL | undefined): string {
  const text = value instanceof URL ? value.href : value;
  if (typeof text !== "string") throw new TypeError(`${what} must be a string or a URL.`);
  // Written as given, so nothing a URL parser would strip or ignore may be in it: a line break, a tab, a NUL or a
  // space at either end would be in the file but not in the URL the crawler reads.
  if (hasControlChar(text) || text.startsWith(" ") || text.endsWith(" ")) {
    throw new TypeError(`${what} must not contain control characters or surrounding spaces.`);
  }
  const absolute = URL.canParse(text);
  const parsed = absolute ? new URL(text) : base === undefined ? undefined : new URL(text, base);
  if (parsed === undefined || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new TypeError(`${what} must be an absolute http(s) URL, got ${JSON.stringify(text)}.`);
  }
  // `https:host` reads as a path on an https page and as a host elsewhere: only `scheme://` is a URL here.
  if (absolute && !/^https?:\/\//i.test(text)) {
    throw new TypeError(
      `${what} must be written with "//" after the scheme, got ${JSON.stringify(text)}.`,
    );
  }
  // A relative value belongs to the site the sitemap is for. `//host/x` and `/\host/x` are other sites' addresses
  // spelled as paths, so a value taken from a request cannot make the sitemap point elsewhere.
  if (!absolute && base !== undefined && parsed.origin !== base.origin) {
    throw new TypeError(`${what} ${JSON.stringify(text)} is relative but names another origin.`);
  }
  const written = absolute ? text : parsed.href;
  if (written.length > 2048) throw new RangeError(`${what} is longer than 2048 characters.`);
  return written;
}

/** A date as the protocol's W3C form: a `YYYY-MM-DD` or a full timestamp. */
function dateText(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError("a sitemap date is an invalid Date.");
    return value.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.+\-Z]+)?$/.test(value)) {
    throw new RangeError(`a sitemap date must be W3C format, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Priority, between 0 and 1. */
function priorityText(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`a sitemap priority must be between 0 and 1, got ${String(value)}.`);
  }
  return String(value);
}

/**
 * The XML of one sitemap file, written as Next writes it: one element per line, the namespaces in Next's order, a
 * final newline. Every URL is absolute (relative values resolve against `base`); dates, priorities and change
 * frequencies are checked; the file is refused past 50 000 URLs or 50 MiB. The children of a `url` follow the
 * sitemaps.org order (loc, lastmod, changefreq, priority), then the extensions.
 *
 * With `localize` (opt-in), the entries are rewritten first: `localizedSitemap(i18n.routing)` from the
 * `@shadow-js/dusk/i18n` subpath lists each app path once per locale, every copy with its
 * `xhtml:link rel="alternate" hreflang` links. What it returns is checked like any entry, and counts toward the limits.
 *
 * @param entries The URLs.
 * @param options `base`: the origin relative URLs resolve against. `localize`: rewrites the entries (locale copies).
 * @returns The XML document.
 * @throws TypeError, RangeError for a value the protocol does not accept, or a file over its limits.
 * @example
 * sitemapXml([{ url: "/", changeFrequency: "daily", priority: 1 }], { base: new URL("https://example.com") });
 * sitemapXml([{ url: "about" }], { base: new URL("https://example.com"), localize: localizedSitemap(i18n.routing) });
 * @since 1.0.0
 */
export function sitemapXml(
  entries: readonly SitemapEntry[],
  options: {
    readonly base?: URL | undefined;
    /** The app's trailing-slash policy: entries on the base's origin follow it (`preserve` when omitted). */
    readonly trailingSlash?: TrailingSlashPolicy | undefined;
    /** Largest file in UTF-8 bytes. Default {@link MAX_SITEMAP_BYTES}; a lower value is for a smaller budget or a test. */
    readonly maxBytes?: number | undefined;
    /**
     * Rewrites the entries before they are written (opt-in), with the base and the trailing-slash policy:
     * `localizedSitemap(i18n.routing)` lists each app path once per locale with its `hreflang` alternates. Absent: the
     * entries are written as given.
     */
    readonly localize?:
      | ((
          entries: readonly SitemapEntry[],
          context: { readonly base: URL | undefined; readonly trailingSlash: TrailingSlashPolicy },
        ) => readonly SitemapEntry[])
      | undefined;
  } = {},
): string {
  const tooMany = (count: number): void => {
    if (count > MAX_SITEMAP_URLS) {
      throw new RangeError(
        `a sitemap holds at most ${MAX_SITEMAP_URLS} URLs; use generateSitemaps for more.`,
      );
    }
  };
  tooMany(entries.length);
  const list =
    options.localize === undefined
      ? entries
      : options.localize(entries, {
          base: options.base,
          trailingSlash: options.trailingSlash ?? "preserve",
        });
  tooMany(list.length);
  const base = options.base;
  const maxBytes = options.maxBytes ?? MAX_SITEMAP_BYTES;
  let hasLanguages = false;
  let hasImages = false;
  let hasVideos = false;
  const body: string[] = [];
  // The size is counted as the file is written: a request that makes the list huge stops at the limit, not after
  // the whole document is in memory.
  let bytes = 512;
  for (const entry of list) {
    const parts: string[] = ["<url>\n"];
    const written = absoluteUrl(entry.url, "a sitemap url", base);
    const loc = applyTrailingSlash(written, base, options.trailingSlash ?? "preserve") ?? written;
    parts.push(`<loc>${xmlEscape(loc)}</loc>\n`);
    if (entry.lastModified !== undefined)
      parts.push(`<lastmod>${dateText(entry.lastModified)}</lastmod>\n`);
    if (entry.changeFrequency !== undefined) {
      if (!CHANGE_FREQUENCIES.has(entry.changeFrequency)) {
        throw new RangeError(
          `changeFrequency ${JSON.stringify(entry.changeFrequency)} is not a sitemap value.`,
        );
      }
      parts.push(`<changefreq>${entry.changeFrequency}</changefreq>\n`);
    }
    if (entry.priority !== undefined)
      parts.push(`<priority>${priorityText(entry.priority)}</priority>\n`);
    const languages = Object.entries(entry.alternates?.languages ?? {});
    if (entry.alternates?.languages !== undefined) hasLanguages = true;
    if (languages.length > MAX_SITEMAP_ALTERNATES) {
      throw new RangeError(`a sitemap url lists at most ${MAX_SITEMAP_ALTERNATES} alternates.`);
    }
    for (const [language, href] of languages) {
      parts.push(
        `<xhtml:link rel="alternate" hreflang="${xmlText(language, "a language code")}" href="${xmlEscape(absoluteUrl(href, "an alternate url", base))}" />\n`,
      );
    }
    const images = entry.images ?? [];
    if (images.length > MAX_SITEMAP_IMAGES) {
      throw new RangeError(`a sitemap url lists at most ${MAX_SITEMAP_IMAGES} images.`);
    }
    if (images.length > 0) hasImages = true;
    for (const image of images) {
      const descriptor = typeof image === "string" || image instanceof URL ? { loc: image } : image;
      parts.push("<image:image>\n");
      parts.push(
        `<image:loc>${xmlEscape(absoluteUrl(descriptor.loc, "an image url", base))}</image:loc>\n`,
      );
      if (descriptor.caption !== undefined)
        parts.push(
          `<image:caption>${xmlText(descriptor.caption, "an image caption")}</image:caption>\n`,
        );
      if (descriptor.title !== undefined)
        parts.push(`<image:title>${xmlText(descriptor.title, "an image title")}</image:title>\n`);
      if (descriptor.license !== undefined) {
        parts.push(
          `<image:license>${xmlEscape(absoluteUrl(descriptor.license, "a license url", base))}</image:license>\n`,
        );
      }
      parts.push("</image:image>\n");
    }
    const videos = entry.videos ?? [];
    if (videos.length > 0) hasVideos = true;
    for (const video of videos) {
      parts.push("<video:video>\n");
      parts.push(
        `<video:thumbnail_loc>${xmlEscape(absoluteUrl(video.thumbnailLoc, "a thumbnail url", base))}</video:thumbnail_loc>\n`,
      );
      parts.push(`<video:title>${xmlText(video.title, "a video title")}</video:title>\n`);
      parts.push(
        `<video:description>${xmlText(video.description, "a video description")}</video:description>\n`,
      );
      if (video.contentLoc !== undefined) {
        parts.push(
          `<video:content_loc>${xmlEscape(absoluteUrl(video.contentLoc, "a content url", base))}</video:content_loc>\n`,
        );
      }
      if (video.playerLoc !== undefined) {
        parts.push(
          `<video:player_loc>${xmlEscape(absoluteUrl(video.playerLoc, "a player url", base))}</video:player_loc>\n`,
        );
      }
      if (video.duration !== undefined) {
        if (
          !Number.isFinite(video.duration) ||
          video.duration < 0 ||
          video.duration > MAX_VIDEO_DURATION
        ) {
          throw new RangeError(
            `a video duration must be from 0 to ${MAX_VIDEO_DURATION} seconds, got ${String(video.duration)}.`,
          );
        }
        parts.push(`<video:duration>${Math.trunc(video.duration)}</video:duration>\n`);
      }
      if (video.publicationDate !== undefined) {
        parts.push(
          `<video:publication_date>${dateText(video.publicationDate)}</video:publication_date>\n`,
        );
      }
      if (video.familyFriendly !== undefined) {
        parts.push(
          `<video:family_friendly>${video.familyFriendly ? "yes" : "no"}</video:family_friendly>\n`,
        );
      }
      const tags = video.tags ?? [];
      if (tags.length > MAX_SITEMAP_VIDEO_TAGS) {
        throw new RangeError(`a video lists at most ${MAX_SITEMAP_VIDEO_TAGS} tags.`);
      }
      for (const tag of tags) parts.push(`<video:tag>${xmlText(tag, "a video tag")}</video:tag>\n`);
      parts.push("</video:video>\n");
    }
    parts.push("</url>\n");
    const chunk = parts.join("");
    bytes += utf8Length(chunk);
    if (bytes > maxBytes) throw new RangeError(`a sitemap file is larger than ${maxBytes} bytes.`);
    body.push(chunk);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${hasImages ? ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"' : ""}${hasVideos ? ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"' : ""}${hasLanguages ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ""}>\n`,
    ...body,
    "</urlset>\n",
  ].join("");
}

/**
 * The index file of several sitemaps (`generateSitemaps`): one `<sitemap>` per file, laid out like `sitemapXml`. The
 * same limits apply: 50 000 files and 50 MiB.
 *
 * @param entries The sitemap files, with their absolute URLs.
 * @param options `base`: the origin relative URLs resolve against.
 * @returns The XML document.
 * @throws RangeError past the limits.
 * @since 1.0.0
 */
export function sitemapIndexXml(
  entries: readonly SitemapIndexEntry[],
  options: {
    readonly base?: URL | undefined;
    /** Largest file in UTF-8 bytes. Default {@link MAX_SITEMAP_BYTES}. */
    readonly maxBytes?: number | undefined;
  } = {},
): string {
  if (entries.length > MAX_SITEMAP_URLS) {
    throw new RangeError(`a sitemap index holds at most ${MAX_SITEMAP_URLS} sitemaps.`);
  }
  const maxBytes = options.maxBytes ?? MAX_SITEMAP_BYTES;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
  ];
  let bytes = 512;
  for (const entry of entries) {
    const chunk = [
      "<sitemap>\n",
      `<loc>${xmlEscape(absoluteUrl(entry.url, "a sitemap file url", options.base))}</loc>\n`,
      entry.lastModified === undefined
        ? ""
        : `<lastmod>${dateText(entry.lastModified)}</lastmod>\n`,
      "</sitemap>\n",
    ].join("");
    bytes += utf8Length(chunk);
    if (bytes > maxBytes) throw new RangeError(`a sitemap index is larger than ${maxBytes} bytes.`);
    parts.push(chunk);
  }
  parts.push("</sitemapindex>\n");
  return parts.join("");
}

/** One robots group: the agents it applies to, and its rules. @since 1.0.0 */
export interface RobotsRule {
  readonly userAgent: string | readonly string[];
  readonly allow?: string | readonly string[];
  readonly disallow?: string | readonly string[];
  readonly crawlDelay?: number;
}

/** The robots file. @since 1.0.0 */
export interface RobotsConfig {
  readonly rules: RobotsRule | readonly RobotsRule[];
  /** The sitemap files, absolute URLs. */
  readonly sitemap?: string | readonly string[];
  /** The preferred host (a non-standard directive some crawlers read). */
  readonly host?: string;
}

/**
 * Characters that end a line for some parser or cannot be in a line at all: every C0 control but tab, DEL, NEL (U+0085)
 * and the Unicode line and paragraph separators. A value holding one could begin a directive of its own.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the forbidden control characters is the point.
const ROBOTS_FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/;

/** A path or agent value that cannot break a line of the robots file. */
function robotsValue(value: unknown, what: string): string {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string.`);
  if (ROBOTS_FORBIDDEN.test(value)) {
    throw new TypeError(`${what} must not contain line breaks or control characters.`);
  }
  return value;
}

/**
 * The text of `robots.txt`, written as Next writes it: `User-Agent` lines, the rules, a blank line after each group,
 * then the `Host` line and one `Sitemap` line per file. Every line ends with a newline.
 *
 * @param config The groups, the sitemaps and the host.
 * @returns The file text.
 * @throws TypeError for a value with a line break, a sitemap that is not an absolute http(s) URL, or no rules.
 * @example
 * robotsTxt({ rules: { userAgent: "*", allow: "/", disallow: ["/api/"] }, sitemap: "https://example.com/sitemap.xml" });
 * @since 1.0.0
 */
export function robotsTxt(config: RobotsConfig): string {
  const rules = Array.isArray(config.rules)
    ? (config.rules as readonly RobotsRule[])
    : [config.rules as RobotsRule];
  if (rules.length === 0) throw new TypeError("robots.txt needs at least one rule group.");
  let text = "";
  for (const rule of rules) {
    const agents = [rule.userAgent].flat();
    if (agents.length === 0) throw new TypeError("a robots rule needs a user agent.");
    for (const agent of agents) {
      if (agent === "") throw new TypeError("a user agent must not be empty.");
      text += `User-Agent: ${robotsValue(agent, "a user agent")}\n`;
    }
    for (const path of [rule.allow ?? []].flat())
      text += `Allow: ${robotsValue(path, "an allow path")}\n`;
    for (const path of [rule.disallow ?? []].flat())
      text += `Disallow: ${robotsValue(path, "a disallow path")}\n`;
    if (rule.crawlDelay !== undefined) {
      if (!Number.isFinite(rule.crawlDelay) || rule.crawlDelay < 0)
        throw new RangeError("crawlDelay must be 0 or more.");
      text += `Crawl-delay: ${rule.crawlDelay}\n`;
    }
    text += "\n";
  }
  if (config.host !== undefined) text += `Host: ${robotsValue(config.host, "the host")}\n`;
  for (const sitemap of [config.sitemap ?? []].flat()) {
    text += `Sitemap: ${robotsValue(absoluteUrl(sitemap, "a sitemap url", undefined), "a sitemap url")}\n`;
  }
  return text;
}

/** An icon of the web app manifest. @since 1.0.0 */
export interface ManifestIcon {
  readonly src: string;
  readonly sizes?: string;
  readonly type?: string;
  readonly purpose?: "any" | "maskable" | "monochrome" | "any maskable";
}

/**
 * The web app manifest. The fields follow the W3C manifest; `display` is one of its modes.
 * @since 1.0.0
 */
export interface Manifest {
  readonly name?: string;
  readonly short_name?: string;
  readonly description?: string;
  readonly id?: string;
  readonly start_url?: string;
  readonly scope?: string;
  readonly display?: "fullscreen" | "standalone" | "minimal-ui" | "browser";
  readonly display_override?: readonly string[];
  readonly orientation?: string;
  readonly theme_color?: string;
  readonly background_color?: string;
  readonly lang?: string;
  readonly dir?: "ltr" | "rtl" | "auto";
  readonly icons?: readonly ManifestIcon[];
  readonly categories?: readonly string[];
  readonly shortcuts?: readonly {
    readonly name: string;
    readonly url: string;
    readonly short_name?: string;
    readonly description?: string;
    readonly icons?: readonly ManifestIcon[];
  }[];
  readonly screenshots?: readonly {
    readonly src: string;
    readonly sizes?: string;
    readonly type?: string;
    readonly form_factor?: "narrow" | "wide";
    readonly label?: string;
  }[];
  readonly related_applications?: readonly {
    readonly platform: string;
    readonly url?: string;
    readonly id?: string;
  }[];
  readonly prefer_related_applications?: boolean;
}

const DISPLAY_MODES: ReadonlySet<string> = new Set([
  "fullscreen",
  "standalone",
  "minimal-ui",
  "browser",
]);

/** The keys of a manifest whose value is an address (at any depth), and the one top-level key that is one too. */
const MANIFEST_URL_KEY = /(?:^|_)(?:url|src|action|href|scope)$/i;
/** Keys whose address may also be an inline image. */
const MANIFEST_IMAGE_KEY = /(?:^|_)src$/i;
const MANIFEST_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;
const MANIFEST_MAX_DEPTH = 8;

/** Checks one address of the manifest: relative, http(s), or (for an image) an inline image. */
function checkManifestUrl(value: unknown, path: string, image: boolean): void {
  if (typeof value !== "string") return;
  if (value.length > 2048 && !(image && MANIFEST_DATA_IMAGE.test(value))) {
    throw new RangeError(`manifest ${path} is longer than 2048 characters.`);
  }
  if (hasControlChar(value) || value.startsWith(" ") || value.endsWith(" ")) {
    throw new TypeError(
      `manifest ${path} must not contain control characters or surrounding spaces.`,
    );
  }
  if (image && MANIFEST_DATA_IMAGE.test(value)) return;
  // `//host` and `\host` name another site in a place that must be this one (or an explicit http(s) URL).
  if (value.startsWith("//") || value.startsWith("\\") || value.startsWith("/\\")) {
    throw new TypeError(
      `manifest ${path} must not be protocol-relative or start with a backslash.`,
    );
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme === undefined) return;
  if ((scheme !== "http" && scheme !== "https") || !/^https?:\/\//i.test(value)) {
    throw new TypeError(`manifest ${path} must be a relative path or an http(s) URL.`);
  }
}

/** Walks the manifest (no recursion) and checks every address in it. */
function checkManifestUrls(manifest: Manifest): void {
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value: manifest, path: "", depth: 0 },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item.value !== "object" || item.value === null) continue;
    if (item.depth > MANIFEST_MAX_DEPTH) {
      throw new RangeError(
        `manifest ${item.path || "value"} is nested deeper than ${MANIFEST_MAX_DEPTH} levels.`,
      );
    }
    for (const [key, inner] of Object.entries(item.value)) {
      const path = item.path === "" ? key : `${item.path}.${key}`;
      if (typeof inner === "string") {
        if (MANIFEST_URL_KEY.test(key) || (item.depth === 0 && key === "id")) {
          checkManifestUrl(inner, path, MANIFEST_IMAGE_KEY.test(key));
        }
      } else {
        stack.push({ value: inner, path, depth: item.depth + 1 });
      }
    }
  }
}

/** JSON text that is also safe inside a `<script>` element and in any line-based reader: `<`, `>`, `&`, U+2028, U+2029. */
function escapeJsonText(json: string): string {
  return json.replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The text of a web app manifest: compact JSON (as Next writes it) with the display mode and every address checked. An
 * address (`start_url`, `scope`, `id`, and any `url`, `src`, `action` or `href` below) is a relative path or an http(s)
 * URL, and an image `src` may be an inline `data:image/...`; `javascript:`, `vbscript:`, `file:`, other `data:` URLs, a
 * protocol-relative `//host` and a backslash start are refused. `<`, `>`, `&`, U+2028 and U+2029 are written as `\uXXXX`
 * escapes (the same value in JSON), so the text is safe wherever it is embedded.
 *
 * @param manifest The manifest.
 * @returns The JSON text.
 * @throws RangeError for an unknown display mode, or a manifest nested past 8 levels.
 * @throws TypeError for an address that is not allowed.
 * @since 1.0.0
 */
export function manifestJson(manifest: Manifest): string {
  if (manifest.display !== undefined && !DISPLAY_MODES.has(manifest.display)) {
    throw new RangeError(
      `display ${JSON.stringify(manifest.display)} is not a manifest display mode.`,
    );
  }
  checkManifestUrls(manifest);
  return escapeJsonText(JSON.stringify(manifest));
}

/** Options of the response helpers. @since 1.0.0 */
export interface MetadataResponseOptions {
  /** `Cache-Control` of the answer. Default `public, max-age=3600, stale-while-revalidate=86400`. */
  readonly cacheControl?: string;
  /**
   * `Content-Type` of the answer, replacing the helper's own (`text/plain; charset=utf-8` and so on). Next writes some
   * of these without a charset (`text/plain`, `application/xml`); set this to match them exactly.
   */
  readonly contentType?: string;
}

const DEFAULT_CACHE = "public, max-age=3600, stale-while-revalidate=86400";

/** The base URL of a request: its origin and the app's mount path, for relative values (`about` is `/app/about`). */
function originOf(event: RequestEvent): URL {
  return new URL(`${event.url.origin}${event.base}/`);
}

function textResponse(
  event: RequestEvent,
  body: string,
  type: string,
  options: MetadataResponseOptions,
): Response {
  const headers = new Headers({
    "content-type": type,
    "cache-control": options.cacheControl ?? DEFAULT_CACHE,
    "x-content-type-options": "nosniff",
  });
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  return new Response(event.method === "HEAD" ? null : body, { status: 200, headers });
}

/**
 * An API route handler that serves `sitemap.xml` from a function of the request event.
 *
 * @param build Returns the entries; it may depend on the request (the host, a header).
 * @param options The response options, and `localize` (opt-in): rewrites the entries with the request's base and policy
 *   (`localizedSitemap(i18n.routing)` lists each app path once per locale with its `hreflang` alternates; see
 *   {@link sitemapXml}).
 * @returns A handler, for `export const GET = sitemapRoute(...)`.
 * @example
 * export const GET = sitemapRoute(() => [{ url: "about" }], { localize: localizedSitemap(i18n.routing) });
 * @since 1.0.0
 */
export function sitemapRoute(
  build: (event: RequestEvent) => readonly SitemapEntry[] | Promise<readonly SitemapEntry[]>,
  options: MetadataResponseOptions & {
    readonly localize?: NonNullable<Parameters<typeof sitemapXml>[1]>["localize"];
  } = {},
): ApiHandler {
  return async (event): Promise<ApiResult> => {
    const entries = await build(event);
    return textResponse(
      event,
      sitemapXml(entries, {
        base: originOf(event),
        trailingSlash: event.trailingSlash,
        localize: options.localize,
      }),
      "application/xml; charset=utf-8",
      options,
    );
  };
}

/**
 * An API route handler that serves the sitemap index of several sitemaps.
 *
 * @param build Returns the sitemap files.
 * @param options The response options.
 * @returns A handler.
 * @since 1.0.0
 */
export function sitemapIndexRoute(
  build: (
    event: RequestEvent,
  ) => readonly SitemapIndexEntry[] | Promise<readonly SitemapIndexEntry[]>,
  options: MetadataResponseOptions = {},
): ApiHandler {
  return async (event): Promise<ApiResult> => {
    const entries = await build(event);
    return textResponse(
      event,
      sitemapIndexXml(entries, { base: originOf(event) }),
      "application/xml; charset=utf-8",
      options,
    );
  };
}

/**
 * An API route handler that serves `robots.txt`. The rules may depend on the request (a staging host can disallow
 * everything).
 *
 * @param build Returns the robots configuration.
 * @param options The response options.
 * @returns A handler.
 * @since 1.0.0
 */
export function robotsRoute(
  build: (event: RequestEvent) => RobotsConfig | Promise<RobotsConfig>,
  options: MetadataResponseOptions = {},
): ApiHandler {
  return async (event): Promise<ApiResult> => {
    const config = await build(event);
    return textResponse(event, robotsTxt(config), "text/plain; charset=utf-8", options);
  };
}

/**
 * An API route handler that serves the web app manifest.
 *
 * @param build Returns the manifest.
 * @param options The response options.
 * @returns A handler.
 * @since 1.0.0
 */
export function manifestRoute(
  build: (event: RequestEvent) => Manifest | Promise<Manifest>,
  options: MetadataResponseOptions = {},
): ApiHandler {
  return async (event): Promise<ApiResult> => {
    const manifest = await build(event);
    return textResponse(
      event,
      manifestJson(manifest),
      "application/manifest+json; charset=utf-8",
      options,
    );
  };
}
