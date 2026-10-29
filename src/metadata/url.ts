import { trailingSlashTarget } from "../shared/trailing-slash";
import type { MetadataUrl } from "./types";

/**
 * URL rules of the metadata API. Relative values resolve against `metadataBase` when one is set; without one they
 * are written as given (a path stays a path). A value with a scheme other than http or https is dropped, so a
 * `javascript:` or `data:` URL can never reach a `href` or `content` attribute. Custom schemes are allowed only where
 * the caller says so (app deep links).
 */

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** True for a C0 control character or DEL: no URL or header value may carry one. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Longest URL written into a tag. Longer values are dropped rather than truncated. */
export const MAX_METADATA_URL_LENGTH = 2048;

/** Schemes that run code or read local files: refused even where custom schemes are allowed. */
const DANGEROUS_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
]);

/**
 * The `metadataBase` of an app. It must be an absolute http(s) URL; anything else is a configuration error.
 *
 * @param value A URL, a string, or nothing.
 * @returns The parsed base, or undefined when none is set.
 * @throws TypeError when the value is not an absolute http(s) URL.
 * @example
 * resolveMetadataBase("https://example.com"); // URL
 * @since 1.0.0
 */
export function resolveMetadataBase(value: URL | string | null | undefined): URL | undefined {
  if (value === undefined || value === null) return undefined;
  const text = value instanceof URL ? value.href : value;
  const parsed = URL.canParse(text) ? new URL(text) : undefined;
  if (parsed === undefined || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new TypeError(
      __DEV__
        ? `metadataBase must be an absolute http(s) URL, got ${JSON.stringify(text)}.`
        : "DUSK_META_5",
    );
  }
  return parsed;
}

/** Next's `./` rule: `path.posix.resolve(pathname, value)`, as a path with no trailing slash (the root is "/"). */
function pagePath(value: string, pathname: string): string {
  const segments: string[] = [];
  for (const part of `${pathname}/${value}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
}

/**
 * A canonical, alternate or `og:url` value, resolved as Next resolves it (`resolveAbsoluteUrlWithPathname`). A `./`
 * value is the page's own path. With `metadataBase` set, a root URL (`/`, no query) is written as the bare origin,
 * without its slash; without a base the value is written as the path.
 *
 * @param value The URL or string as the author wrote it.
 * @param base The `metadataBase`, or undefined.
 * @param pathname The page's pathname (`/` when unknown).
 * @returns The URL, or undefined where {@link resolveMetadataUrl} returns undefined.
 * @example
 * resolvePageUrl("./", new URL("https://example.com"), "/sign-in"); // "https://example.com/sign-in"
 * resolvePageUrl("/", new URL("https://example.com"), "/"); // "https://example.com"
 * @since 1.0.0
 */
export function resolvePageUrl(
  value: MetadataUrl | null | undefined,
  base: URL | undefined,
  pathname: string,
  trailingSlash: TrailingSlashPolicy = "preserve",
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const page =
    typeof value === "string" && value.startsWith("./") ? pagePath(value, pathname) : value;
  const href = applyTrailingSlash(resolveMetadataUrl(page, base), base, trailingSlash);
  if (href === undefined || base === undefined || !URL.canParse(href)) return href;
  const url = new URL(href);
  return url.pathname === "/" && url.search === "" ? url.origin : href;
}

/** The app's trailing-slash policy (`trailingSlash` in the handler options). @since 1.0.0 */
export type TrailingSlashPolicy = "never" | "always" | "preserve";

/**
 * A resolved URL with the app's trailing-slash policy applied to its path: `always` adds the slash, `never`
 * removes it, `preserve` keeps the value. Only a URL on the app's own origin (or a bare path, when there is no base)
 * is changed: another host's URL keeps its own form. The root is never changed, and a query or fragment stays.
 *
 * @param href The URL written into a tag or sitemap, or undefined.
 * @param base The `metadataBase`, or undefined.
 * @param policy The trailing-slash policy.
 * @returns The URL with the policy applied.
 * @example
 * applyTrailingSlash("https://example.com/about", new URL("https://example.com"), "always"); // "https://example.com/about/"
 * @since 1.0.0
 */
export function applyTrailingSlash(
  href: string | undefined,
  base: URL | undefined,
  policy: TrailingSlashPolicy,
): string | undefined {
  if (href === undefined || policy === "preserve") return href;
  if (base !== undefined && URL.canParse(href)) {
    const url = new URL(href);
    if (url.origin !== base.origin) return href;
    const target = trailingSlashTarget(url.pathname, policy);
    if (target === undefined) return href;
    url.pathname = target;
    return url.href;
  }
  const at = href.search(/[?#]/);
  const path = at === -1 ? href : href.slice(0, at);
  if (!path.startsWith("/") || path.startsWith("//")) return href;
  const target = trailingSlashTarget(path, policy);
  return target === undefined ? href : `${target}${at === -1 ? "" : href.slice(at)}`;
}

/**
 * Resolves one metadata URL to the string written into a tag.
 *
 * @param value The URL or string as the author wrote it.
 * @param base The `metadataBase`, or undefined.
 * @param options `customSchemes`: allow any scheme but the dangerous ones (app deep links such as `myapp://`).
 * @returns The URL, or undefined when it is empty, too long, has control characters, or uses a refused scheme.
 * @example
 * resolveMetadataUrl("/og.png", new URL("https://example.com")); // "https://example.com/og.png"
 * resolveMetadataUrl("javascript:alert(1)", undefined); // undefined
 * @since 1.0.0
 */
export function resolveMetadataUrl(
  value: MetadataUrl | null | undefined,
  base: URL | undefined,
  options: { readonly customSchemes?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = value instanceof URL ? value.href : value;
  // A leading or trailing space is stripped by every URL parser, so ` javascript:x` would pass a scheme check on the
  // text and still be a script URL once parsed.
  if (
    text === "" ||
    text.length > MAX_METADATA_URL_LENGTH ||
    hasControl(text) ||
    text.startsWith(" ") ||
    text.endsWith(" ")
  )
    return undefined;
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    const web = scheme === "http" || scheme === "https";
    const allowed = web || (options.customSchemes === true && !DANGEROUS_SCHEMES.has(scheme));
    if (!allowed) return undefined;
    // `https:evil.example` is a path on an https page and a host on an http page: only the `//` form is unambiguous.
    if (web && !/^https?:\/\//i.test(text)) return undefined;
    return text;
  }
  // A protocol-relative value (`//host/x`) names another host, and a backslash is a slash to a browser (`/\host`):
  // both are refused, not resolved.
  if (text.startsWith("//") || text.startsWith("\\") || text.startsWith("/\\")) return undefined;
  if (base === undefined) return text;
  const resolved = URL.canParse(text, base) ? new URL(text, base) : undefined;
  // A relative value stays on the base's origin, whatever tricks it uses to say otherwise.
  if (resolved === undefined || resolved.origin !== base.origin) return undefined;
  return resolved.href.length > MAX_METADATA_URL_LENGTH ? undefined : resolved.href;
}

/** The images a `data:` URI may carry in an icon. */
const DATA_IMAGE_HREF =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i;

/** Longest `data:` icon accepted, in characters. */
export const MAX_DATA_ICON_LENGTH: number = 32 * 1024;

/**
 * Checks an address that is written as given (an icon, the manifest link, a `link` descriptor of the `meta` export): no
 * `metadataBase` resolution, so a relative path and a protocol-relative CDN address stay as they are. A scheme other than
 * http(s) is refused (`javascript:`, `vbscript:`, `file:`, `blob:`, a `data:` that is not an image), and so is an http(s)
 * value without `//`, a control character and surrounding spaces.
 *
 * @param value The address as the author wrote it.
 * @param options `dataImage`: also accept a `data:image/...` URI (for icons).
 * @returns The address unchanged, or undefined when it must not be written.
 * @example
 * safeHref("/favicon.ico"); // "/favicon.ico"
 * safeHref("javascript:alert(1)"); // undefined
 * @since 1.0.0
 */
export function safeHref(
  value: string,
  options: { readonly dataImage?: boolean } = {},
): string | undefined {
  if (value === "" || hasControl(value) || value.startsWith(" ") || value.endsWith(" "))
    return undefined;
  const scheme = SCHEME.exec(value)?.[1]?.toLowerCase();
  if (scheme === "data") {
    return options.dataImage === true &&
      DATA_IMAGE_HREF.test(value) &&
      value.length <= MAX_DATA_ICON_LENGTH
      ? value
      : undefined;
  }
  if (value.length > MAX_METADATA_URL_LENGTH) return undefined;
  if (scheme === undefined) {
    return value.startsWith("\\") || value.startsWith("/\\") ? undefined : value;
  }
  return (scheme === "http" || scheme === "https") && /^https?:\/\//i.test(value)
    ? value
    : undefined;
}
