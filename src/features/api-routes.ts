import { createMatcher, type RouteVisibility } from "@shadow-js/router/core";
import { dispatchApi } from "../server/api";
import type { DuskFeature } from "../server/features";
import type { ApiModule } from "../server/types";
import { DUSK_MATCHER_OPTIONS } from "../shared/router";

/** HTTP methods an API route module may export. */
const METHODS: readonly string[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "ALL",
];

/** True for an object that exports at least one HTTP method handler. */
function isApiModule(value: unknown): value is ApiModule {
  return (
    typeof value === "object" &&
    value !== null &&
    METHODS.some((name) => typeof Reflect.get(value, name) === "function")
  );
}

/** Unwraps a loaded API module: the namespace itself, or its default export. */
function methodsOf(loaded: unknown): ApiModule {
  if (isApiModule(loaded)) return loaded;
  const fallback: unknown =
    typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (isApiModule(fallback)) return fallback;
  throw new TypeError("an API route module must export HTTP method handlers (GET, POST, ...).");
}

/**
 * The `apiRoutes()` feature: file-based API routes (`app/api/...`), each a module of HTTP-method exports
 * (`GET`, `POST`, ...), matched before the pages. The route's own `middleware`, the folders' `_middleware`,
 * CSRF (`csrf: false` opts a webhook out) and CORS run around the method.
 *
 * Without it, an API path is a page path (a 404 when no page matches). A manifest with API routes is refused
 * at creation with the factory to add.
 *
 * @example
 * import { apiRoutes } from the "@shadow-js/dusk/features/api-routes" subpath;
 * const handler = createHandler({ manifest, features: [apiRoutes()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function apiRoutes(): DuskFeature {
  return {
    name: "apiRoutes",
    install(host): void {
      const { config } = host;
      const routes = config.manifest.apiRoutes;
      const entries = new Map(routes.map((route) => [route.id, route]));
      if (entries.size !== routes.length) throw new TypeError("two API routes share an id.");
      // The route's `matchFilters` (from the manifest) apply here, as they do to pages: a value that fails is not a match.
      const matcher = createMatcher(
        routes.map((route) => ({
          id: route.id,
          path: route.path,
          ...(route.matchFilters === undefined ? {} : { matchFilters: route.matchFilters }),
        })),
        {
          ...DUSK_MATCHER_OPTIONS,
          basePath: config.base,
          caseSensitive: config.manifest.caseSensitive === true,
        },
      );
      host.capabilities.apiRoutes = {
        // A private route (a `_`-prefixed path) answers only a rewrite target: the request from outside passes "public".
        match: async (pathname, visibility: RouteVisibility = "public") => {
          const chain = matcher.match(pathname, visibility);
          const leaf = chain[chain.length - 1];
          if (leaf === undefined) return undefined;
          const entry = entries.get(leaf.id);
          if (entry === undefined) return undefined;
          return {
            id: leaf.id,
            pattern: leaf.pattern,
            params: leaf.params,
            module: methodsOf(await entry.load()),
          };
        },
        dispatch: (event, hit, extra) => dispatchApi(event, hit.module, extra),
      };
    },
  };
}
