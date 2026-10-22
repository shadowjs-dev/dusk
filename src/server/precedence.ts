import { comparePatterns, type RouteMatch } from "@shadow-js/router/core";

/**
 * The precedence between the kinds of route that can answer one request path: stream routes (`SSE`/`WS`), API routes
 * and pages. The rule:
 *
 * 1. The most specific pattern answers, whatever its kind: at the first segment where two patterns differ, a static
 *    segment beats a param, a param beats an optional param, an optional param beats a splat (`comparePatterns`). So a
 *    page `/f/:id/preview` answers before an API route `/f/:id/:name`, and an API route `/f/:id/special` answers before
 *    a page `/f/:id/:name`.
 * 2. Two routes of one shape (the same path) are told apart by the method: an API route that exports the method
 *    answers it, a page answers GET, HEAD and OPTIONS. Otherwise the page answers (and refuses the method with 405,
 *    as a page always does).
 * 3. A stream route wins a tie: the scanner refuses a stream route beside a page or an API route on one path, so this
 *    only fixes the order.
 *
 * A more specific route answers even for a method it does not handle (the answer is its 405); the less specific one is
 * not tried. This is the Next.js rule: a static page is not shadowed by a dynamic route handler.
 */

/** A route kind that matched the request path. */
export type CandidateKind = "stream" | "api" | "page";

/** One matched route. `claims` is true when the kind answers the request method (see the rule above). */
export interface RouteCandidate {
  readonly kind: CandidateKind;
  /** The URL pattern of the matched route (`/f/:id/preview`). */
  readonly pattern: string;
  readonly claims: boolean;
}

/** Ranks a tie between two candidates of the same shape: a stream first, then a claiming API route or page. */
function tieRank(candidate: RouteCandidate): number {
  if (candidate.kind === "stream") return 0;
  return candidate.claims ? 1 : 2;
}

/**
 * The candidate that answers. The input may be empty (no route matched: the caller answers not found).
 *
 * @param candidates The matched routes, one per kind at most.
 * @returns The winner, or undefined when the list is empty.
 * @internal
 */
export function pickCandidate(candidates: readonly RouteCandidate[]): RouteCandidate | undefined {
  let best: RouteCandidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const order = comparePatterns(candidate.pattern, best.pattern);
    if (order < 0 || (order === 0 && tieRank(candidate) < tieRank(best))) best = candidate;
  }
  return best;
}

/**
 * The URL pattern a page chain answers: the patterns of its routes, outermost first, joined. A layout contributes its
 * own path segments; a pathless layout contributes nothing.
 *
 * @param chain The matched chain of a page (root to leaf).
 * @returns The pattern, starting with `/`.
 * @internal
 */
export function patternOfChain(chain: readonly RouteMatch[]): string {
  const joined = chain.map((match) => match.pattern).join("");
  return joined === "" ? "/" : joined;
}
