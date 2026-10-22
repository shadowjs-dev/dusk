/**
 * A prerendered page as a static server answers it (B2). It is plain data written into the build manifest and read by
 * the Node, Bun and Deno static layers, the Vercel config and `dusk start`. The build decides it (see
 * `adapter/static-pages.ts`); the request path that names the page is read here.
 *
 * @packageDocumentation
 */

/** Whether a page's file answers the request (`static`) or the handler renders it per request (`handler`). @since 1.0.0 */
export type StaticPageMode = "static" | "handler";

/** One prerendered page and how it is answered. @since 1.0.0 */
export interface StaticPage {
  /** The URL path of the page, relative to the app's base: `/` or `/about`. */
  readonly path: string;
  readonly mode: StaticPageMode;
  /** Headers a static page's file is sent with (name, value). Empty for `handler`. */
  readonly headers: readonly (readonly [string, string])[];
  /** Headers only an https response may carry (HSTS). Empty for `handler`. */
  readonly httpsHeaders: readonly (readonly [string, string])[];
  /** Why the page is handler-rendered. `undefined` for a static page. */
  readonly reason: string | undefined;
}

/**
 * The page a request path names, as the static layers key it: `/about/`, `/about/index.html` and `/about.html` are
 * `/about`; `/` stays `/`. Pure string work, so it runs in every runtime.
 *
 * @param pathname The request path, without a query, relative to the app's base.
 * @returns The page key.
 * @example pageKeyOf("/about/index.html"); // "/about"
 * @since 1.0.0
 */
export function pageKeyOf(pathname: string): string {
  let path = pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"/index.html".length);
  else if (path.endsWith(".html")) path = path.slice(0, -".html".length);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path === "" ? "/" : path;
}
