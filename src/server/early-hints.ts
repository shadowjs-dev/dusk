import { buildLinkHeader, collectAssets } from "./document";
import { type EventState, visibilityOf } from "./event";
import type { PageRuntime } from "./runtime";

/** The part of the platform's host object this module uses. */
interface Hinting {
  earlyHints?: unknown;
}

/**
 * Offers the browser the assets of a page before its data loads: when the platform's host object has an
 * `earlyHints(links)` method, it is called once with the `Link` header values of the stylesheets, the entry script and
 * the preloads of the matched routes. The links come from the build manifest, never from the request; only same-origin
 * paths are sent, and at most 8. The final response carries the same `Link` header whether or not this ran. A page
 * whose route rule sets `csr: false` is not hinted.
 *
 * @param rt The page runtime: its matcher finds the route chain without running any route code.
 * @param event The request. Whether the client takes a `103` at all is the platform's call: the Node server offers the
 *   hook only to a browser navigation.
 * @internal
 */
export function sendEarlyHints(rt: PageRuntime, event: EventState): void {
  const host = event.platform as Hinting | null | undefined;
  if (typeof host?.earlyHints !== "function" || event.noClient) return;
  const { entry, stylesheets, preloads } = collectAssets(
    rt.config.manifest.assets,
    rt.pageMatcher.match(event.url.pathname, visibilityOf(event)).map((match) => match.id),
  );
  // `buildLinkHeader` validates and formats; a URL cannot hold ", ", so the parts split back exactly.
  const links = buildLinkHeader(entry, stylesheets, preloads)
    ?.split(", ")
    .filter((link) => link.startsWith("</"))
    .slice(0, 8);
  if (links !== undefined && links.length > 0) host.earlyHints(links);
}
