import { parsePattern } from "@shadow-js/router/core";
import { distance } from "../shared/check";

/**
 * Which route a prerender path belongs to, and which route it was probably meant to be. Used to explain a listed
 * path that answers 404 (the route was removed or renamed): the build names the path, where it was listed, and the
 * closest route, instead of a bare status.
 */

type Segment = ReturnType<typeof parsePattern>["segments"][number];

/** The decoded segments of a path, or `undefined` for a path with an empty segment inside (`/a//b`) or a malformed escape. */
function partsOf(path: string): string[] | undefined {
  const parts = path.split("/").slice(1);
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.some((part) => part === "")) return undefined;
  const decoded: string[] = [];
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      // A malformed escape is no path of any route (prerenderFile refuses it with its own message).
      return undefined;
    }
  }
  return decoded;
}

function matchesSegments(segments: readonly Segment[], parts: readonly string[]): boolean {
  // reachable[j]: the segments so far can consume exactly the first j parts.
  let reachable = Array.from({ length: parts.length + 1 }, (_, index) => index === 0);
  for (const segment of segments) {
    const next = Array.from({ length: parts.length + 1 }, () => false);
    for (let used = 0; used <= parts.length; used += 1) {
      if (!reachable[used]) continue;
      const part = parts[used];
      if (segment.kind === "static") {
        if (part === segment.text) next[used + 1] = true;
      } else if (segment.kind === "param") {
        if (part !== undefined) next[used + 1] = true;
      } else if (segment.kind === "optional") {
        next[used] = true;
        if (part !== undefined) next[used + 1] = true;
      } else {
        // A splat takes the rest: one part or more, or none when it is optional.
        for (let end = segment.optional === true ? used : used + 1; end <= parts.length; end += 1) {
          next[end] = true;
        }
      }
    }
    reachable = next;
  }
  return reachable[parts.length] === true;
}

/**
 * Whether one of the route patterns matches a path. A pattern is the router's own (`/posts/:id`, `/docs/*`,
 * `/blog/:slug?`). With `locales`, a path whose first segment is one of them is also tried without it, because
 * locale routing serves `/ar/about` from the route `/about`.
 *
 * @param patterns The route patterns of the app (pages, API routes and streams).
 * @param path An app path (no base, no query).
 * @param locales The locales of the app's i18n settings, if any.
 * @returns True when some route answers the path.
 * @example routeMatches(["/posts/:id"], "/posts/7"); // true
 * @internal
 */
export function routeMatches(
  patterns: readonly string[],
  path: string,
  locales: readonly string[] = [],
): boolean {
  const parts = partsOf(path);
  if (parts === undefined) return false;
  const first = parts[0];
  const withoutLocale = first !== undefined && locales.includes(first) ? parts.slice(1) : undefined;
  return patterns.some((pattern) => {
    const segments = parsePattern(pattern).segments;
    return (
      matchesSegments(segments, parts) ||
      (withoutLocale !== undefined && matchesSegments(segments, withoutLocale))
    );
  });
}

/** A param costs a little, so a literal route beats a param route that fits equally well. */
const PARAM_COST = 0.25;

/** How far a path is from a pattern: the edit distance of the literal segments, with a small cost for params. */
function costOf(segments: readonly Segment[], parts: readonly string[]): number {
  let cost = 0;
  const length = Math.max(segments.length, parts.length);
  for (let index = 0; index < length; index += 1) {
    const segment = segments[index];
    const part = parts[index];
    if (segment === undefined) {
      cost += (part ?? "").length;
    } else if (segment.kind === "splat") {
      return cost + PARAM_COST;
    } else if (part === undefined) {
      // A route longer than the path: its literal parts are missing, an optional one is free.
      if (segment.kind === "static") cost += segment.text.length;
      else if (segment.kind === "param") cost += 1;
    } else if (segment.kind === "static") {
      cost += distance(part.toLowerCase(), segment.text.toLowerCase());
    } else {
      cost += PARAM_COST;
    }
  }
  return cost;
}

/**
 * The route a path was probably meant to be: the pattern with the fewest edits of its literal segments, when it is
 * close enough to be a typo or a rename (at most half of the path's characters, and fewer than all of them).
 * Ties go to the pattern with fewer params, then to the smaller text, so the answer does not depend on the order
 * of the routes.
 *
 * @param patterns The route patterns of the app.
 * @param path An app path that no pattern matches.
 * @returns The pattern as written, or `undefined` when none is close.
 * @example closestRoute(["/about", "/pricing"], "/aboot"); // "/about"
 * @internal
 */
export function closestRoute(patterns: readonly string[], path: string): string | undefined {
  const parts = partsOf(path);
  if (parts === undefined) return undefined;
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total === 0) return undefined;
  const allowed = Math.max(3, Math.floor(total / 2));
  let best: { pattern: string; cost: number; params: number } | undefined;
  for (const pattern of patterns) {
    const segments = parsePattern(pattern).segments;
    const cost = costOf(segments, parts);
    const params = segments.filter((segment) => segment.kind !== "static").length;
    if (cost > allowed || cost >= total) continue;
    if (
      best === undefined ||
      cost < best.cost ||
      (cost === best.cost &&
        (params < best.params || (params === best.params && pattern < best.pattern)))
    ) {
      best = { pattern, cost, params };
    }
  }
  return best?.pattern;
}
