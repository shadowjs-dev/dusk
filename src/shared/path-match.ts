/**
 * Matching of a request path against a compiled pattern (see `path-pattern.ts` for the grammar). Kept apart from the
 * compiler: it runs when a request meets a rule, not when the configuration is read at start-up.
 *
 * @packageDocumentation
 */

import type { CompiledPattern, PathParams } from "./path-pattern";

/** Splits a path into segments; `undefined` for a path with an empty segment (`//`). */
function splitPath(pathname: string): string[] | undefined {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (trimmed === "/" || trimmed === "") return [];
  const parts = trimmed.slice(1).split("/");
  if (parts.some((part) => part === "")) return undefined;
  return parts;
}

/** ASCII-only lower case, the fold the router uses for static segments (non-ASCII text is never folded). */
function fold(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * Whether a captured rest holds a segment that would climb or empty a path once it is filled into a destination: a
 * piece that decoded to `/` (a `%2F`) splits into more segments, and `.`, `..` or an empty one is a dot segment or
 * an empty segment the URL parser then resolves (`..%2F_private` would leave the destination's folder, and an empty
 * first piece would make `//host`).
 */
function climbs(rest: readonly string[]): boolean {
  for (const piece of rest) {
    for (const segment of piece.split("/")) {
      if (segment === "" || segment === "." || segment === "..") return true;
    }
  }
  return false;
}

/** Matches one non-empty segment against a glob: `*` is any run of characters within the segment. */
function globMatches(pieces: readonly string[], text: string): boolean {
  const first = pieces[0] ?? "";
  const last = pieces[pieces.length - 1] ?? "";
  if (text.length === 0 || text.length < first.length + last.length) return false;
  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  const end = text.length - last.length;
  let position = first.length;
  for (let index = 1; index < pieces.length - 1; index += 1) {
    const piece = pieces[index] ?? "";
    const found = text.indexOf(piece, position);
    if (found === -1 || found + piece.length > end) return false;
    position = found + piece.length;
  }
  return position <= end;
}

/**
 * Matches a path against a compiled pattern.
 *
 * @param pattern The compiled pattern.
 * @param pathname The path to test (no query string). Percent-encoding is decoded per segment.
 * @param ignoreCase Compare the literal parts of the pattern without ASCII case, as the router does when
 *   `router.caseSensitive` is off (captured values keep their case). Default `false`.
 * @returns The captured parameters, or `undefined` when the path does not match. A rest (`*name`) that would
 *   put a `.`, `..` or empty segment into a destination never matches.
 * @example matchPattern(compilePattern("/posts/:id"), "/posts/7"); // { id: "7" }
 * @since 1.0.0
 */
export function matchPattern(
  pattern: CompiledPattern,
  pathname: string,
  ignoreCase = false,
): PathParams | undefined {
  const raw = splitPath(pathname);
  if (raw === undefined) return undefined;
  const parts: string[] = [];
  for (const piece of raw) {
    try {
      parts.push(decodeURIComponent(piece));
    } catch {
      return undefined;
    }
  }
  const { segments } = pattern;
  if (pattern.rest === "none") {
    if (parts.length !== segments.length) return undefined;
  } else if (pattern.rest === "splat") {
    if (parts.length < segments.length + 1) return undefined;
  } else if (parts.length < segments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const text = parts[index] ?? "";
    if (segment === undefined || text === "") return undefined;
    switch (segment.kind) {
      case "literal":
        if (ignoreCase ? fold(text) !== fold(segment.text) : text !== segment.text)
          return undefined;
        break;
      case "glob":
        if (
          ignoreCase
            ? !globMatches(segment.pieces.map(fold), fold(text))
            : !globMatches(segment.pieces, text)
        )
          return undefined;
        break;
      case "param":
        params[segment.name] = text;
        break;
    }
  }
  if (pattern.rest === "splat") {
    const rest = parts.slice(segments.length);
    if (climbs(rest)) return undefined;
    params[pattern.restName ?? "*"] = rest.join("/");
  }
  return params;
}
