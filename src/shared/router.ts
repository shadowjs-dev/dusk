import type { RouterCacheOptions, RouterFeature } from "@shadow-js/router";
import { routeAnnouncer } from "@shadow-js/router/announcer";
import { blockers } from "@shadow-js/router/blockers";
import { errorBoundaries } from "@shadow-js/router/errors";
import { compileMatchFilter, matchFilters } from "@shadow-js/router/filters";
import { headManagement } from "@shadow-js/router/head";
import { loaderCache } from "@shadow-js/router/loaders";
import { notFoundUi } from "@shadow-js/router/not-found";
import { pendingUi } from "@shadow-js/router/pending";
import { relativeLinks } from "@shadow-js/router/relative";
import { scrollRestoration } from "@shadow-js/router/scroll";
import { searchValidation } from "@shadow-js/router/search";
import { viewTransitions } from "@shadow-js/router/transitions";
import { metadataFeature } from "../metadata/feature";

/**
 * The router features of a Dusk app. A Dusk app uses routes with loaders, heads, error components, match
 * filters, search validators, not-found and pending components, so every router takes them; it keeps the behavior it
 * had before the features were separate. View transitions are off unless the app asks for them (the feature being present is what
 * turns them on), and the loader cache takes the app's `router.cache` limits.
 *
 * The route announcer is on by default: after a client navigation the page title is announced and focus moves to the
 * new page. `announcer: false` leaves it out.
 *
 * @param options What the app set in `hydrateDusk({ router })`.
 * @returns The features to pass to `createRouter`.
 */
export function duskFeatures(
  options: {
    readonly cache?: RouterCacheOptions;
    readonly viewTransitions?: boolean;
    readonly announcer?: boolean;
  } = {},
): RouterFeature[] {
  return [
    scrollRestoration(),
    loaderCache(options.cache ?? {}),
    headManagement(),
    metadataFeature(),
    errorBoundaries(),
    matchFilters(),
    searchValidation(),
    notFoundUi(),
    pendingUi(),
    blockers(),
    relativeLinks(),
    ...(options.viewTransitions === true ? [viewTransitions()] : []),
    ...(options.announcer === false ? [] : [routeAnnouncer()]),
  ];
}

/**
 * The metadata feature of a server router. The server resolves metadata itself (`metadata/server.ts`, loaded only when
 * a route exports some), so the router only needs the feature named: its capability does nothing on the server.
 */
const SERVER_METADATA: RouterFeature = {
  id: "metadata",
  install(): void {
    // Nothing to install: see the note above.
  },
};

/**
 * The router features of a Dusk server's own router (a memory router rendering one request): the features every page
 * render uses, plus the ones the pages feature was given for its routes (`pages({ routerFeatures })`, which the
 * generated server entry sets from the exports of the routes). A feature a route uses and the list lacks is refused
 * when the handler is created.
 *
 * Not included, because a route opts in to them by its exports: `loaderCache()` (`loader`), `headManagement()` (`head`),
 * `errorBoundaries()` (`error`), `matchFilters()` (`matchFilters`), `searchValidation()` (`validateSearch`),
 * `notFoundUi()` (`notFound`) and `pendingUi()` (`pending`). `blockers()` and `relativeLinks()` stay: a component
 * can use them without any export. Scroll restoration is client-only and is not in a server router.
 *
 * @param extra The features given to `pages({ routerFeatures })`.
 */
export function duskServerFeatures(extra: readonly RouterFeature[] = []): RouterFeature[] {
  return [SERVER_METADATA, blockers(), relativeLinks(), ...extra];
}

/**
 * The options of every matcher a Dusk server builds: the match filters of its routes are compiled
 * with the router's own compiler, so a route that declares a filter matches the same way on the server
 * and in the browser.
 */
export const DUSK_MATCHER_OPTIONS: { readonly compileFilter: typeof compileMatchFilter } = {
  compileFilter: compileMatchFilter,
};
