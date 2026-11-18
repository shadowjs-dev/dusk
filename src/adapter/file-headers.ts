import { matchPattern } from "../shared/path-match";
import type { ResolvedRouting } from "../shared/routing-config";
import { FILE_OWNED } from "./static-pages";

/**
 * The app's header rules for the files of the client folder (`public/` and the build output) on platforms whose CDN
 * answers files before any code runs (Vercel). The handler applies `headers` and `routeRules[...].headers` to what it
 * answers; a file the CDN serves never reaches it, so without this a rule such as `{ source: "/fonts/*", headers:
 * { "cache-control": "public, max-age=31536000, immutable" } }` would silently not apply to the fonts.
 *
 * Only rules with no conditions (`has`, `missing`) can be written for a file: a condition depends on the request. The
 * headers a file response owns (type, length, encoding, validators, cookies, the request id) are never written.
 * Prerendered pages are not files here: their headers are decided by `staticPagesOf`.
 *
 * This module is build-time code; it never runs in the server bundle.
 *
 * @packageDocumentation
 */

/**
 * A group of files that get the same headers.
 * @since 1.1.0
 */
export interface FileHeaders {
  /** URL paths of the files, relative to the app's base (`/fonts/a.woff2`), sorted. */
  readonly paths: readonly string[];
  /** The headers (lower-case name, value), in the order the rules set them. */
  readonly headers: readonly (readonly [string, string])[];
}

/**
 * The headers the app's rules give each file, grouped by identical header sets. A file no rule applies to is left out.
 * Header rules apply first (the last matching rule decides a name), then route-rule headers fill in what is absent,
 * least specific first, as the handler does for a static page.
 *
 * @param files URL paths of the files.
 * @param routing The resolved routing (header rules and route rules).
 * @param ignoreCase Whether the router matches without ASCII case.
 * @returns The groups, in the order of their first file.
 * @example fileHeadersOf(["/fonts/a.woff2"], routing, true); // [{ paths: ["/fonts/a.woff2"], headers: [["cache-control", "..."]] }]
 * @internal
 * @since 1.1.0
 */
export function fileHeadersOf(
  files: readonly string[],
  routing: ResolvedRouting,
  ignoreCase: boolean,
): FileHeaders[] {
  const groups = new Map<string, { paths: string[]; headers: (readonly [string, string])[] }>();
  for (const path of [...files].sort()) {
    const out = new Map<string, string>();
    for (const rule of routing.headers) {
      if (rule.has.length > 0 || rule.missing.length > 0) continue;
      if (matchPattern(rule.match, path, ignoreCase) === undefined) continue;
      for (const [name, value] of rule.headers) out.set(name.toLowerCase(), value);
    }
    const routeHeaders = new Map<string, string>();
    for (const entry of routing.routeRules) {
      if (matchPattern(entry.match, path, ignoreCase) === undefined) continue;
      for (const [name, value] of Object.entries(entry.rule.headers ?? {})) {
        routeHeaders.set(name.toLowerCase(), value);
      }
    }
    for (const [name, value] of routeHeaders) if (!out.has(name)) out.set(name, value);
    const headers = [...out.entries()].filter(([name]) => !FILE_OWNED.has(name));
    if (headers.length === 0) continue;
    const key = JSON.stringify(headers);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { paths: [path], headers });
    else group.paths.push(path);
  }
  return [...groups.values()];
}
