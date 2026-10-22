/**
 * Multilingual sitemaps: the `localize` option of `sitemapXml` and `sitemapRoute` for an app with locale routing.
 * It lives here, in the locale routing subpath, so the sitemap helpers of an app without i18n carry none of it.
 *
 * @packageDocumentation
 */

import type { TrailingSlashPolicy } from "../metadata/url";
import { MAX_SITEMAP_URLS, type SitemapEntry } from "../server/metadata-routes";
import { trailingSlashTarget } from "../shared/trailing-slash";

/**
 * The part of a locale routing a multilingual sitemap reads: `i18n.routing` of an `@shadow-js/i18n` instance, or what
 * `createLocaleRouting` returns.
 *
 * @example
 * // createLocaleRouting from the "@shadow-js/i18n" package
 * const routing: SitemapLocaleRouting = createLocaleRouting({ locales: ["en", "fr"], defaultLocale: "en" });
 * @since 1.0.0
 */
export interface SitemapLocaleRouting {
  /** The supported locales. */
  readonly locales: readonly string[];
  /** Splits a path into its locale prefix and the rest. */
  parse(pathname: string): { readonly locale?: string | undefined };
  /** The URL of a path in every locale (one per locale, then `x-default`), on `origin`. */
  alternates(
    path: string,
    origin: string,
  ): readonly { readonly hreflang: string; readonly href: string }[];
}

/**
 * What `localize` receives from the sitemap: the base relative entries resolve against (the request's origin and
 * mount point under `sitemapRoute`) and the app's trailing-slash policy.
 *
 * @example
 * const context: SitemapLocalizeContext = { base: new URL("https://example.com/"), trailingSlash: "never" };
 * @since 1.0.0
 */
export interface SitemapLocalizeContext {
  readonly base: URL | undefined;
  readonly trailingSlash: TrailingSlashPolicy;
}

/**
 * True for text the sitemap would take as written: no control character, no space at either end, and an absolute
 * value spelled `scheme://`. Anything else is passed on unchanged, so the sitemap refuses it with its own message
 * (a URL parser would drop a line break or read `https:host` as a host, and the copies would hide the mistake).
 */
function plainUrlText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  if (text.trim() !== text) return false;
  return !URL.canParse(text) || /^https?:\/\//i.test(text);
}

/** The path below the mount point (`/app/fr` is `/fr` under `/app`), or `undefined` outside it. */
function belowMount(pathname: string, mount: string): string | undefined {
  if (mount === "") return pathname;
  if (pathname === mount || pathname === `${mount}/`) return "/";
  return pathname.startsWith(`${mount}/`) ? pathname.slice(mount.length) : undefined;
}

/**
 * The `localize` option of a multilingual sitemap. Each entry written as an app path of this site without a locale
 * prefix (`about`, or an absolute URL under the mount point) is listed once per locale (the URL of that locale), and
 * every copy carries the whole set of `xhtml:link rel="alternate" hreflang` links (each locale, then `x-default`), as
 * the multilingual sitemap protocol asks. The URLs keep the mount point, the trailing-slash policy and the query; the
 * other fields of the entry (dates, priority, images) are copied. An entry that sets its own `alternates.languages`,
 * one on another origin or outside the mount point, one whose path already names a locale, and one that is not a URL
 * are passed on as written (the sitemap checks them).
 *
 * @param routing The app's locale routing (`i18n.routing`).
 * @returns The function to pass as `localize` to `sitemapRoute` or `sitemapXml`.
 * @throws RangeError (from the returned function) past `MAX_SITEMAP_URLS` URLs, the copies of every locale counted.
 * @example
 * // src/routes/sitemap.xml.ts: sitemapRoute from the "@shadow-js/dusk/server" subpath, localizedSitemap from the
 * // "@shadow-js/dusk/i18n" subpath, and the app's instance from its own module.
 * export const GET = sitemapRoute(() => [{ url: "about" }], { localize: localizedSitemap(i18n.routing) });
 * @since 1.0.0
 */
export function localizedSitemap(
  routing: SitemapLocaleRouting,
): (entries: readonly SitemapEntry[], context: SitemapLocalizeContext) => SitemapEntry[] {
  return (entries, context) => {
    const out: SitemapEntry[] = [];
    const add = (entry: SitemapEntry): void => {
      if (out.length >= MAX_SITEMAP_URLS) {
        throw new RangeError(
          `a sitemap holds at most ${MAX_SITEMAP_URLS} URLs; use generateSitemaps for more.`,
        );
      }
      out.push(entry);
    };
    const { base, trailingSlash } = context;
    // The mount point: `https://example.com/app/` is `/app`.
    const mount = base === undefined ? "" : base.pathname.replace(/\/+$/, "");
    for (const entry of entries) {
      const text = entry.url instanceof URL ? entry.url.href : entry.url;
      const url =
        typeof text === "string" && plainUrlText(text) && URL.canParse(text, base)
          ? new URL(text, base)
          : undefined;
      const path =
        url === undefined ||
        entry.alternates?.languages !== undefined ||
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        (base !== undefined && url.origin !== base.origin)
          ? undefined
          : belowMount(url.pathname, mount);
      if (url === undefined || path === undefined || routing.parse(path).locale !== undefined) {
        add(entry);
        continue;
      }
      // Each alternate's path (the routing writes it on the origin) goes under the mount point, with the app's policy.
      const links = routing.alternates(path, url.origin).map(({ hreflang, href }) => {
        const own = href.slice(url.origin.length);
        const mounted = mount === "" ? own : own === "/" ? mount : `${mount}${own}`;
        return {
          hreflang,
          href: `${url.origin}${trailingSlashTarget(mounted, trailingSlash) ?? mounted}${url.search}`,
        };
      });
      const languages = Object.fromEntries(links.map((link) => [link.hreflang, link.href]));
      for (const link of links) {
        if (link.hreflang !== "x-default")
          add({ ...entry, url: link.href, alternates: { languages } });
      }
    }
    return out;
  };
}
