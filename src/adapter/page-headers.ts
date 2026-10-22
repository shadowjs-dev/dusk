import type { StaticPage } from "../shared/static-page";

/**
 * The `_headers` block of a static page (Netlify and Cloudflare Workers static assets read the same format): its path,
 * then its headers (the app's policy and, over https, HSTS). A page the handler renders has no block: the handler sends
 * its headers itself, and a second copy would duplicate them.
 *
 * @packageDocumentation
 */

/**
 * The lines of a page's `_headers` block.
 * @param page How the page is answered.
 * @returns The lines (empty for a page the handler renders, or one with no headers).
 * @throws Error when a header name or value contains a line break (it would break the file).
 * @internal
 */
export function pageHeaderBlock(page: StaticPage): string[] {
  if (page.mode !== "static") return [];
  const headers = [...page.headers, ...page.httpsHeaders];
  if (headers.length === 0) return [];
  const lines = [page.path];
  for (const [name, value] of headers) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`the header "${name}" of ${page.path} has a line break`);
    }
    lines.push(`  ${name}: ${value}`);
  }
  return lines;
}
