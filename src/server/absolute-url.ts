import { resolveMetadataBase } from "../metadata/url";
import { trailingSlashTarget } from "./trailing-slash";
import type { RequestEvent } from "./types";

/** Options of {@link absoluteUrl}. @since 1.0.0 */
export interface AbsoluteUrlOptions {
  /**
   * The app's `metadataBase` (an absolute http(s) origin). Used first; without it the request's origin is the base.
   */
  readonly metadataBase?: string | URL | undefined;
  /** The app's `trailingSlash` policy. `preserve` (the default) leaves the path as it is; the root is never changed. */
  readonly trailingSlash?: "never" | "always" | "preserve" | undefined;
}

/**
 * A full, absolute URL for a path: the base is `metadataBase` when given, else the origin of the request (or of the
 * origin string or URL passed). A path starting with `/` is taken from the origin, as in the URL standard. A query
 * string stays; a fragment is dropped, because a canonical or a shared link carries none. The trailing slash follows
 * `trailingSlash`, and the bare root is written as the origin (no slash), as the canonical is.
 *
 * @param path A path (`/about`), a relative path, or an absolute http(s) URL (returned with the same rules).
 * @param source The request event, or an origin string or URL, used when there is no `metadataBase`.
 * @param options `metadataBase` and `trailingSlash`.
 * @returns The absolute URL, on the base's scheme (https for a production origin).
 * @throws TypeError when the base or the result is not an absolute http(s) URL.
 * @example
 * absoluteUrl("/about", event); // "https://example.com/about" when the request is for example.com
 * absoluteUrl("/about", event, { metadataBase: "https://example.com", trailingSlash: "always" }); // "https://example.com/about/"
 * @since 1.0.0
 */
export function absoluteUrl(
  path: string,
  source: RequestEvent | string | URL,
  options: AbsoluteUrlOptions = {},
): string {
  const configured = resolveMetadataBase(options.metadataBase);
  let base: URL;
  if (configured !== undefined) base = configured;
  else if (typeof source === "string") base = new URL(source);
  else if (source instanceof URL) base = source;
  else base = new URL(source.url.origin);
  const url = new URL(path, base);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`absoluteUrl: ${JSON.stringify(path)} is not an absolute http(s) URL.`);
  }
  url.hash = "";
  const target = trailingSlashTarget(url.pathname, options.trailingSlash ?? "preserve");
  if (target !== undefined) url.pathname = target;
  return url.pathname === "/" && url.search === "" ? url.origin : url.href;
}
