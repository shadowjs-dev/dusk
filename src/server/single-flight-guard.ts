import { runMiddleware } from "./middleware-chain";
import { pageMiddlewareFor } from "./route-middleware";
import type { PageRuntime } from "./runtime";
import type { RequestEvent, RouteMiddlewareManifest } from "./types";

/**
 * Runs the middleware of the page at `pathname` around `final`, for a request that is not the page's own (a single-flight
 * answer reads the loader data of a page). Without the page matcher the chain cannot be found, so the answer is a refusal.
 *
 * @param manifest The middleware manifest.
 * @param matcher The matcher of the page routes, if the handler has pages.
 * @param pathname The path of the page (without the base).
 * @param event The event the middleware sees.
 * @param final Runs when every middleware let the request through.
 * @returns What the chain answered.
 * @internal
 */
export async function runPageMiddleware(
  manifest: RouteMiddlewareManifest,
  matcher: PageRuntime["pageMatcher"] | undefined,
  pathname: string,
  event: RequestEvent,
  final: () => Promise<Response>,
): Promise<Response> {
  if (matcher === undefined) return new Response(null, { status: 403 });
  const chain = await pageMiddlewareFor(manifest, matcher.match(pathname, "public"));
  return runMiddleware(chain, event, final);
}
