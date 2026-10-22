/**
 * Automatic locale routing (`@shadow-js/dusk/i18n`): what the generated server entry wires when `dusk.config.ts`
 * declares `i18n.routing`. A global middleware built from `createI18nMiddleware` decides the locale of each page
 * request (the URL prefix, else the cookie, else `Accept-Language`, else the default locale), redirects GET and HEAD
 * requests to the locale's canonical URL, sets `<html lang dir>`, `Content-Language`, `Vary` and the locale cookie, and
 * the document head gets the `hreflang` alternates and the canonical link.
 *
 * Only an app that declares locale routing imports this module: the entry of every other app names nothing of it, so
 * it pays no byte for it.
 *
 * @packageDocumentation
 */

import {
  createI18nMiddleware,
  detectLocale,
  type I18nBase,
  type I18nMiddlewareOptions,
  type I18nRequestEvent,
  i18nHeadTags,
} from "@shadow-js/i18n";
import { createMatcher } from "@shadow-js/router/core";
import { checkRedirectTarget } from "../server/redirect-target";
import type {
  DuskRuntimeManifest,
  HandlerOptions,
  Middleware,
  Next,
  RequestEvent,
} from "../server/types";
import { trailingSlashTarget } from "../shared/trailing-slash";
import {
  checkLocales,
  DEFAULT_LOCALE_COOKIE,
  type LocaleDetectionSource,
  type LocaleRoutingConfig,
  type LocaleRoutingSettings,
  resolveLocaleRouting,
} from "./settings";

export type {
  DuskI18nRoutingConfig,
  LocaleDetectionSource,
  LocaleInstanceConfig,
  LocalePrefixMode,
  LocaleRoutingConfig,
  LocaleRoutingSettings,
} from "./settings";
export {
  localizedSitemap,
  type SitemapLocaleRouting,
  type SitemapLocalizeContext,
} from "./sitemap";

/**
 * The i18n instance locale routing works with: what `createI18n` and `createI18nWithIcu` return (its locales, its
 * `routing`, `load` and `fork`, which gives every request its own instance).
 *
 * @example
 * // createI18n and localeRouting from the "@shadow-js/i18n" package (the routing feature gives `prefix`)
 * const instance: LocaleRoutingInstance = createI18n({
 *   defaultLocale: "en",
 *   locales: ["en", "fr"],
 *   prefix: "as-needed",
 *   features: [localeRouting],
 * });
 * @since 1.0.0
 */
export type LocaleRoutingInstance = I18nBase<string> & {
  fork(locale?: string): I18nBase<string>;
};

/**
 * Where the locale middleware runs: the app's mount point and the routes that are not pages. Both come from the handler
 * options when {@link withLocaleRouting} builds it.
 *
 * @example
 * const context: LocaleRoutingContext = { base: "/app" };
 * @since 1.0.0
 */
export interface LocaleRoutingContext {
  /** The mount point (`""` or `/app`), as `HandlerOptions.base`. Default `""`. */
  readonly base?: string;
  /**
   * The manifest of the handler: a request for one of its API or stream routes is never localized nor redirected,
   * wherever the route lives. `caseSensitive` is read for the mount point.
   */
  readonly manifest?: Pick<DuskRuntimeManifest, "apiRoutes" | "streams" | "caseSensitive">;
}

/** The detection order of a request whose URL names the locale. */
const URL_ONLY: readonly ["url"] = Object.freeze(["url"] as const);

/** The validated configuration and the instance, after the start-time checks. */
interface Resolved {
  readonly i18n: LocaleRoutingInstance;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly settings: LocaleRoutingSettings;
}

/**
 * Validates the configuration with the same rules as the build, then checks that the instance matches it: the same
 * locales, default locale and URL prefix (a mismatch would send the middleware and the app's links different ways).
 */
function resolve(i18n: unknown, config: unknown): Resolved {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError(
      "withLocaleRouting: the configuration must be the i18n object of dusk.config.ts.",
    );
  }
  const record = config as Readonly<Record<string, unknown>>;
  const { locales, defaultLocale } = checkLocales(record, "i18n");
  const settings = resolveLocaleRouting(record["routing"], "i18n.routing", false);
  const instance = i18n as Partial<LocaleRoutingInstance> | null | undefined;
  if (
    typeof instance !== "object" ||
    instance === null ||
    typeof instance.fork !== "function" ||
    typeof instance.load !== "function" ||
    typeof instance.routing !== "object" ||
    !Array.isArray(instance.locales)
  ) {
    throw new TypeError(
      "i18n.routing.instance: the module's export is not an i18n instance (the value createI18n or createI18nWithIcu returns).",
    );
  }
  const own = [...instance.locales].sort().join(", ");
  if (own !== [...locales].sort().join(", ") || instance.defaultLocale !== defaultLocale) {
    throw new TypeError(
      `i18n.routing.instance: the instance has the locales ${instance.locales.join(", ")} (default ${String(instance.defaultLocale)}), and dusk.config.ts declares ${locales.join(", ")} (default ${defaultLocale}). Declare the same locales in both.`,
    );
  }
  if (instance.routing.prefix !== settings.prefix) {
    throw new TypeError(
      `i18n.routing.instance: the instance was created with prefix "${instance.routing.prefix}", and dusk.config.ts declares prefix "${settings.prefix}". Pass the same prefix to createI18n.`,
    );
  }
  return { i18n: instance as LocaleRoutingInstance, locales, defaultLocale, settings };
}

/** The mount point without trailing slashes (`""` at the root). */
function normalizeBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The path below the mount point (`/app/fr` is `/fr`), or `undefined` for a path outside it. */
function belowBase(pathname: string, base: string, caseSensitive: boolean): string | undefined {
  if (base === "") return pathname;
  const head = pathname.slice(0, base.length);
  const same = caseSensitive ? head === base : head.toLowerCase() === base.toLowerCase();
  if (!same) return undefined;
  const rest = pathname.slice(base.length);
  if (rest === "") return "/";
  return rest.startsWith("/") ? rest : undefined;
}

/** A path under `prefix` (`/api`, `/api/users`, not `/apiary`). */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Paths that are never pages: `/api`, Dusk's own `/_dusk` endpoints, and a path whose last segment has a file extension
 * (`/favicon.ico`, `/sitemap.xml`). The same rule as `createI18nMiddleware`'s default `exclude`.
 */
function notAPage(path: string): boolean {
  if (under(path, "/api") || under(path, "/_dusk")) return true;
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 && dot < last.length - 1;
}

/** True for a request path that one of the manifest's API or stream routes answers (filters aside: conservative). */
function endpointMatcher(
  context: LocaleRoutingContext,
  base: string,
): (pathname: string) => boolean {
  const caseSensitive = context.manifest?.caseSensitive === true;
  const lists = [context.manifest?.apiRoutes ?? [], context.manifest?.streams ?? []]
    .filter((routes) => routes.length > 0)
    .map((routes) =>
      createMatcher(
        routes.map((route) => ({ id: route.id, path: route.path })),
        { basePath: base, caseSensitive },
      ),
    );
  return (pathname) => lists.some((matcher) => matcher.match(pathname, "all").length > 0);
}

/**
 * True when the URL decides the locale: a supported locale prefix, or (under `"as-needed"`) any unprefixed path but the
 * root, which is the default locale's page. The root under `"as-needed"`, an unprefixed path under `"always"` and every
 * path under `"never"` are decided by the cookie and `Accept-Language`, so their answers vary on them.
 */
function decidedByUrl(
  prefix: LocaleRoutingSettings["prefix"],
  parsedLocale: string | undefined,
  path: string,
): boolean {
  if (prefix === "never") return false;
  if (parsedLocale !== undefined) return true;
  return prefix === "as-needed" && path !== "/";
}

/** The path of the app under its mount point: `/` at the mount point itself is the mount point. */
function joinBase(base: string, path: string): string {
  if (base === "") return path;
  return path === "/" ? base : `${base}${path}`;
}

/** A path with the app's trailing-slash policy applied. */
function withPolicy(path: string, policy: RequestEvent["trailingSlash"]): string {
  return trailingSlashTarget(path, policy) ?? path;
}

/**
 * The event as the i18n middleware reads it: the URL without the mount point, so `/app/fr/about` is read as `/fr/about`.
 * Everything else is the request's own (its cookies, headers, document and context).
 */
function localView(event: RequestEvent, path: string): I18nRequestEvent {
  const url = new URL(event.url.href);
  url.pathname = path;
  return {
    request: event.request,
    url,
    cookies: event.cookies,
    responseHeaders: event.responseHeaders,
    document: event.document,
    set<T>(key: { readonly name: string; readonly type?: T }, value: T): void {
      event.set(key, value);
    },
    tryGet<T>(key: { readonly name: string; readonly type?: T }): T | undefined {
      return event.tryGet(key);
    },
  };
}

/** The `Vary` names of an answer the detection sources decided. */
function varyOf(detection: readonly LocaleDetectionSource[]): string[] {
  const names: string[] = [];
  if (detection.includes("accept-language")) names.push("Accept-Language");
  if (detection.includes("cookie")) names.push("Cookie");
  return names;
}

/**
 * Builds the locale middleware of an app: the global middleware the generated server entry installs when
 * `dusk.config.ts` declares `i18n.routing`. For every page request (never `/api`, `/_dusk`, a file, an API or stream
 * route, or the browser's navigation check):
 *
 * - The locale is the URL prefix, else the sources of `detection` in order (the cookie, then `Accept-Language` with its
 *   q-values), else the default locale. Under `"as-needed"` an unprefixed path is the default locale's page, except
 *   the root, which follows the visitor's preference.
 * - A GET or HEAD request whose URL is not the canonical URL of that locale is redirected there (307, same origin, the
 *   query kept): `/` to `/fr` for a French visitor, `/about` to `/fr/about` under `"always"`, `/en/about` to `/about`
 *   under `"as-needed"`. Other methods are never redirected.
 * - Otherwise `createI18nMiddleware` gives the request its own instance in that locale, sets `<html lang dir>` and
 *   `Content-Language`, and remembers a locale the URL chose in the cookie (`SameSite=Lax`, `Path=/`, `Secure` on
 *   https). An answer the cookie or `Accept-Language` decided (a redirect included) gets `Vary` on them; an answer the
 *   URL decided does not, so a shared cache keeps one copy per URL.
 *
 * @param i18n The app's instance (`createI18n` or `createI18nWithIcu`), with the same locales, default locale and
 *   prefix as `config`.
 * @param config The `i18n` object of `dusk.config.ts` as the server bundle holds it (see {@link LocaleRoutingConfig}).
 * @param context The mount point and the manifest of the handler.
 * @returns A middleware for `createHandler({ middleware: [...] })`.
 * @throws TypeError at creation for an invalid configuration or an instance that does not match it.
 * @example
 * import { localeRoutingMiddleware } from the "@shadow-js/dusk/i18n" subpath;
 * const localize = localeRoutingMiddleware(i18n, {
 *   locales: ["en", "fr"],
 *   defaultLocale: "en",
 *   routing: { prefix: "as-needed", detection: ["cookie", "accept-language"], cookie: { name: "locale", maxAge: 31536000 }, alternates: true },
 * });
 * export const options = { middleware: [localize] };
 * @since 1.0.0
 */
export function localeRoutingMiddleware(
  i18n: LocaleRoutingInstance,
  config: LocaleRoutingConfig,
  context: LocaleRoutingContext = {},
): Middleware {
  const resolved = resolve(i18n, config);
  const { settings } = resolved;
  const instance = resolved.i18n;
  const routing = instance.routing;
  const base = normalizeBase(context.base ?? "");
  const caseSensitive = context.manifest?.caseSensitive === true;
  const isEndpoint = endpointMatcher(context, base);
  const cookieName = settings.cookie === false ? DEFAULT_LOCALE_COOKIE : settings.cookie.name;
  const cookieOf = (secure: boolean): NonNullable<I18nMiddlewareOptions["cookie"]> =>
    settings.cookie === false
      ? false
      : {
          name: settings.cookie.name,
          maxAge: settings.cookie.maxAge,
          // On http the cookie jar's own default applies: `Secure` in production, none on a local dev server.
          ...(secure ? { secure: true } : {}),
        };
  // The paths were filtered above (`exclude: []`), and the redirects are decided here, with the mount point.
  const byUrl = createI18nMiddleware(instance, {
    strategy: URL_ONLY,
    cookie: cookieOf(false),
    exclude: [],
  });
  const byUrlSecure = createI18nMiddleware(instance, {
    strategy: URL_ONLY,
    cookie: cookieOf(true),
    exclude: [],
  });
  const byRequest = createI18nMiddleware(instance, {
    strategy: settings.detection,
    cookie: cookieOf(false),
    exclude: [],
  });
  const vary = varyOf(settings.detection);
  return async (event: RequestEvent, next: Next): Promise<Response> => {
    if (event.isNavigationCheck) return next();
    const path = belowBase(event.url.pathname, base, caseSensitive);
    if (path === undefined || notAPage(path) || isEndpoint(event.url.pathname)) return next();
    const parsed = routing.parse(path);
    const fromUrl = decidedByUrl(settings.prefix, parsed.locale, path);
    const stored = event.cookies.get(cookieName);
    // The same detection, with the same inputs, as the i18n middleware the request is handed to below.
    const found = detectLocale(
      {
        pathname: path,
        cookie: stored === undefined ? undefined : `${cookieName}=${encodeURIComponent(stored)}`,
        acceptLanguage: event.request.headers.get("accept-language"),
      },
      {
        locales: instance.locales,
        order: fromUrl ? URL_ONLY : settings.detection,
        cookieName,
        routing,
        unprefixedIsDefault: settings.prefix === "as-needed",
      },
    );
    const locale = found?.locale ?? instance.defaultLocale;
    if ((event.method === "GET" || event.method === "HEAD") && settings.prefix !== "never") {
      const target = routing.canonical(path, locale);
      if (target !== undefined) {
        const location = `${withPolicy(joinBase(base, target), event.trailingSlash)}${event.url.search}`;
        // The target is a path this module built (one leading slash, no backslash or control character); the shared
        // check is the last word on what reaches `Location`.
        const checked = checkRedirectTarget(location, {
          origin: event.url.origin,
          trustedOrigins: new Set(),
        });
        if (typeof checked !== "string") throw checked;
        const headers = new Headers({ location: checked });
        if (!fromUrl) for (const name of vary) headers.append("vary", name);
        return new Response(null, { status: 307, headers });
      }
    }
    const handler = fromUrl ? (event.url.protocol === "https:" ? byUrlSecure : byUrl) : byRequest;
    return handler(base === "" ? event : localView(event, path), next);
  };
}

/** Escapes a value for a double-quoted HTML attribute. */
function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The `hreflang` alternate links and the canonical link of the page a request renders, as HTML for the document head:
 * one `<link rel="alternate" hreflang>` per locale, one for `x-default` (the default locale's URL), then
 * `<link rel="canonical">` to the page in its own locale. The URLs are absolute (the configured `origin`, else the
 * request's), include the mount point and follow the app's trailing-slash policy; the query is left out.
 *
 * Nothing is written when `alternates` is `false`, under `prefix: "never"` (every locale shares one URL), for a path that
 * is not a page (`/api`, `/_dusk`, a file), for a first segment shaped like an unsupported locale (`/xx/about`), or for
 * an unprefixed path under `"always"` (it has no locale until it is redirected).
 *
 * @param event The request event of the page.
 * @param i18n The app's instance.
 * @param config The `i18n` object of `dusk.config.ts` as the server bundle holds it.
 * @returns The links, or `""`.
 * @throws TypeError for an invalid configuration or an instance that does not match it.
 * @example
 * // document: { head: (event) => localeLinksHtml(event, i18n, config) }
 * localeLinksHtml(event, i18n, config);
 * // <link rel="alternate" hreflang="en" href="https://example.com/about">…<link rel="canonical" href="https://example.com/fr/about">
 * @since 1.0.0
 */
export function localeLinksHtml(
  event: RequestEvent,
  i18n: LocaleRoutingInstance,
  config: LocaleRoutingConfig,
): string {
  return linksFor(resolve(i18n, config), event);
}

function linksFor(resolved: Resolved, event: RequestEvent): string {
  const { settings, i18n } = resolved;
  if (!settings.alternates || settings.prefix === "never") return "";
  const base = normalizeBase(event.base);
  const path = belowBase(event.url.pathname, base, false);
  if (path === undefined || notAPage(path)) return "";
  const parsed = i18n.routing.parse(path);
  if (parsed.unsupported !== undefined) return "";
  const locale =
    parsed.locale ?? (settings.prefix === "as-needed" ? resolved.defaultLocale : undefined);
  if (locale === undefined) return "";
  const origin = settings.origin ?? event.url.origin;
  const root = new URL(origin).origin;
  return i18nHeadTags(i18n, { path: parsed.path, origin, locale })
    .map((tag) => {
      const props = { ...tag.props };
      const href = props["href"];
      if (href?.startsWith(root)) {
        props["href"] =
          `${root}${withPolicy(joinBase(base, href.slice(root.length)), event.trailingSlash)}`;
      }
      const attributes = Object.entries(props)
        .map(([name, value]) => ` ${name}="${attribute(value)}"`)
        .join("");
      return `<${tag.tag}${attributes}>`;
    })
    .join("");
}

/**
 * The handler options of an app with locale routing: what the generated server entry passes to `createHandler` when
 * `dusk.config.ts` declares `i18n.routing`. It puts the locale middleware ({@link localeRoutingMiddleware}) first in
 * `middleware` (before the app's own, which can then read `getEventI18n(event)`), adds the `hreflang` and canonical
 * links ({@link localeLinksHtml}) after the app's `document.head`, and sets `i18n` (the default `<html lang>` of
 * documents no request decided, such as the single-page shell) when the options have none.
 *
 * The page cache stays correct: a page the URL localizes is cached per URL, and one the cookie or `Accept-Language`
 * localizes varies on them, so a French and an English visitor never get each other's page.
 *
 * @param options The handler options (the entry's, merged with the file's).
 * @param i18n The app's instance (the export `i18n.routing.instance` names).
 * @param config The `i18n` object of `dusk.config.ts` as the server bundle holds it.
 * @returns New options; `options` is not changed.
 * @throws TypeError for an invalid configuration or an instance whose locales, default locale or prefix differ from it.
 * @example
 * import { withLocaleRouting } from the "@shadow-js/dusk/i18n" subpath;
 * export const handler = createHandler(withLocaleRouting({ manifest, features }, i18n, {
 *   locales: ["en", "fr"],
 *   defaultLocale: "en",
 *   routing: { prefix: "as-needed", detection: ["cookie", "accept-language"], cookie: { name: "locale", maxAge: 31536000 }, alternates: true },
 * }));
 * @since 1.0.0
 */
export function withLocaleRouting(
  options: HandlerOptions,
  i18n: LocaleRoutingInstance,
  config: LocaleRoutingConfig,
): HandlerOptions {
  const resolved = resolve(i18n, config);
  const middleware = localeRoutingMiddleware(i18n, config, {
    base: options.base ?? "",
    manifest: options.manifest,
  });
  const own = options.document?.head;
  const head = (event: RequestEvent): string => {
    const extra = typeof own === "function" ? own(event) : (own ?? "");
    if (typeof extra !== "string")
      throw new TypeError("document.head must return a string of HTML.");
    return `${extra}${linksFor(resolved, event)}`;
  };
  return {
    ...options,
    middleware: [middleware, ...(options.middleware ?? [])],
    document: { ...options.document, head },
    i18n: options.i18n ?? { locales: resolved.locales, defaultLocale: resolved.defaultLocale },
  };
}
