import { createMemoryHistory, createRouter, type RouterFeature } from "@shadow-js/router";
import { createMatcher, type RouteVisibility } from "@shadow-js/router/core";
import { HttpError } from "../internal/http-error";
import type * as MetadataServer from "../metadata/server";
import type * as ParamsModule from "../server/dynamic-params";
import type { ParamsGate } from "../server/dynamic-params";
import { type EventState, visibilityOf } from "../server/event";
import { failureResponseFor } from "../server/failure";
import type { DuskFeature, PagesCapability } from "../server/features";
import { json, readJson } from "../server/json";
import { runMiddleware } from "../server/middleware-chain";
import { renderPage, renderShellPage } from "../server/page";
import { gateTargetOf, pageMiddlewareFor } from "../server/route-middleware";
import { wrapRoutes } from "../server/route-wrap";
import type { PageRuntime, RouteSpec } from "../server/runtime";
import { DUSK_MATCHER_OPTIONS, duskServerFeatures } from "../shared/router";
import { NAV_GATE_ALLOWED, NAV_GATE_HEADER, NAV_GATE_REFUSED } from "../shared/wire";

/**
 * Options of {@link pages}. @since 1.0.0
 */
export interface PagesOptions {
  /**
   * Loads the module of the `dynamicParams = false` check (`@shadow-js/dusk/features/dynamic-params`). The generated
   * server entry passes it only when some page sets that export, so an app without one never has the check in its
   * bundle. A page that sets the export with no loader is refused when the handler is created.
   * @internal
   */
  readonly dynamicParams?: () => Promise<typeof ParamsModule>;
  /**
   * Loads the metadata engine (`@shadow-js/dusk/features/metadata`): the tags, JSON-LD and route headers of the
   * `metadata`, `generateMetadata`, `viewport`, `links`, `meta`, `headers` and file-image exports. Loaded on the first
   * render that needs it. The generated server entry passes it only when a route exports one, so an app without
   * metadata never has the engine in its bundle. A route with one of these exports is refused when the handler is
   * created without it.
   * @internal
   */
  readonly metadata?: () => Promise<typeof MetadataServer>;
  /**
   * The router features the page routes need beyond the core set, each from its own `@shadow-js/router` subpath:
   * `loaderCache()` (`loader` exports, `@shadow-js/router/loaders`), `headManagement()` (`head`, `.../head`),
   * `errorBoundaries()` (`error`, `.../errors`), `matchFilters()` (`matchFilters`, `.../filters`),
   * `searchValidation()` (`validateSearch`, `.../search`), `notFoundUi()` (`notFound`, `.../not-found`) and
   * `pendingUi()` (`pending`, `.../pending`). The generated server entry passes the ones the routes use. A hand-written
   * handler lists the ones its routes export. A route whose export needs a missing feature is refused when the handler is
   * created, naming the factory to add.
   * @internal
   */
  readonly routerFeatures?: readonly RouterFeature[];
}

/** The router feature a route export needs, the factory that provides it, and whether a spec uses it. */
const ROUTER_NEEDS: readonly {
  readonly option: string;
  readonly feature: string;
  readonly factory: string;
  readonly used: (spec: RouteSpec) => boolean;
}[] = [
  {
    option: "loader",
    feature: "loaders",
    factory: __DEV__ ? "loaderCache() from @shadow-js/router/loaders" : "",
    used: (spec) => spec.loader !== undefined,
  },
  {
    option: "head",
    feature: "head",
    factory: __DEV__ ? "headManagement() from @shadow-js/router/head" : "",
    used: (spec) => spec.head !== undefined,
  },
  {
    option: "error",
    feature: "errors",
    factory: __DEV__ ? "errorBoundaries() from @shadow-js/router/errors" : "",
    used: (spec) => spec.error !== undefined,
  },
  {
    option: "matchFilters",
    feature: "filters",
    factory: __DEV__ ? "matchFilters() from @shadow-js/router/filters" : "",
    used: (spec) => spec.matchFilters !== undefined,
  },
  {
    option: "validateSearch",
    feature: "search",
    factory: __DEV__ ? "searchValidation() from @shadow-js/router/search" : "",
    used: (spec) => spec.validateSearch !== undefined,
  },
  {
    option: "notFound",
    feature: "not-found",
    factory: __DEV__ ? "notFoundUi() from @shadow-js/router/not-found" : "",
    used: (spec) => spec.notFound !== undefined,
  },
  {
    option: "pending",
    feature: "pending",
    factory: __DEV__ ? "pendingUi() from @shadow-js/router/pending" : "",
    used: (spec) => spec.pending !== undefined,
  },
];

/** The exports the metadata engine reads: a route with one of them needs `pages({ metadata })`. */
const METADATA_EXPORTS = [
  "metadata",
  "generateMetadata",
  "fileImages",
  "notFoundMetadata",
  "errorMetadata",
  "viewport",
  "generateViewport",
  "links",
  "meta",
  "headers",
] as const;

/** True when a route spec carries one of the metadata exports (see {@link METADATA_EXPORTS}). */
function usesMetadata(spec: RouteSpec): boolean {
  const record = spec as unknown as Readonly<Record<string, unknown>>;
  return METADATA_EXPORTS.some((key) => record[key] !== undefined);
}

/**
 * The `pages()` feature: server rendering of the page routes, the document shell and the SPA shell, the
 * navigation gate (`POST {base}/_dusk/nav`), and the checks that the page routes are valid (duplicate ids,
 * ambiguous paths) at startup.
 *
 * A handler without this feature has no page: a request for a page is a 404, and a manifest with page routes
 * is refused at creation with the factory to add.
 *
 * @example
 * import { pages } from the "@shadow-js/dusk/features/pages" subpath;
 * import { loaderCache } from the "@shadow-js/router/loaders" subpath, for the routes that export `loader`;
 * const handler = createHandler({ manifest, features: [pages({ routerFeatures: [loaderCache()] })] });
 * @returns The feature.
 * @since 1.0.0
 */
export function pages(options: PagesOptions = {}): DuskFeature {
  return {
    name: "pages",
    install(host): void {
      const { config, runtime } = host;
      // A page that sets `dynamicParams = false` asks the gate. Its module is loaded by the caller's loader, so an app
      // without such a page never has the check in its bundle (see `PagesOptions`).
      const loadParams = options.dynamicParams;
      let paramsGate: Promise<ParamsGate> | undefined;
      const gateOf =
        loadParams === undefined
          ? undefined
          : (): Promise<ParamsGate> =>
              (paramsGate ??= loadParams().then((module) =>
                module.createParamsGate(wrapped, pageMatcher, config),
              ));
      const wrapped = wrapRoutes(config.manifest.routes, {
        dev: config.dev,
        report: (error, event, shown) => {
          runtime.report(error, "loader", event);
          runtime.markReported(shown);
        },
        ...(gateOf === undefined ? {} : { paramsGate: gateOf }),
      });
      // Fails closed: a page that lists its params but has no loader would otherwise answer every param.
      if (
        loadParams === undefined &&
        [...wrapped.specs.values()].some((spec) => spec.dynamicParams === false)
      ) {
        throw new TypeError("dynamicParams = false needs pages({ dynamicParams }).");
      }
      // Fails closed: a route export that needs a router feature or the metadata engine the pages feature was not given
      // is refused now. Without this check the export would be dropped on the server, silently.
      const serverFeatures = duskServerFeatures(options.routerFeatures ?? []);
      const givenFeatures = new Set<string>(serverFeatures.map((feature) => feature.id));
      for (const spec of wrapped.specs.values()) {
        for (const need of ROUTER_NEEDS) {
          if (need.used(spec) && !givenFeatures.has(need.feature)) {
            throw new TypeError(
              __DEV__
                ? `pages(): route "${spec.id}" uses ${need.option}, which needs the "${need.feature}" feature; pass ${need.factory} in pages({ routerFeatures })`
                : "SHADOW_FEATURE_MISSING",
            );
          }
        }
      }
      const globalUsesMetadata = config.globalError?.metadata !== undefined;
      const metadataOwner = [...wrapped.specs.values()].find(usesMetadata);
      const needsMetadata = globalUsesMetadata || metadataOwner !== undefined;
      if (needsMetadata && options.metadata === undefined) {
        throw new TypeError(
          `pages(): ${metadataOwner === undefined ? "the global error" : `route "${metadataOwner.id}"`} exports metadata, which needs the metadata engine; pass pages({ metadata: () => import("@shadow-js/dusk/features/metadata") })`,
        );
      }
      // Surfaces duplicate ids and ambiguous paths now, not on the first request.
      const caseSensitive = config.manifest.caseSensitive === true;
      createRouter({
        routes: wrapped.routes,
        features: serverFeatures,
        history: createMemoryHistory({ initialEntries: ["/"] }),
        base: config.base,
        trailingSlash: config.trailingSlash,
        caseSensitive,
      }).dispose();
      const pageMatcher = createMatcher(wrapped.tree, {
        ...DUSK_MATCHER_OPTIONS,
        basePath: config.base,
        caseSensitive,
      });
      const pageRuntime: PageRuntime = {
        ...runtime,
        pageRoutes: wrapped.routes,
        specs: wrapped.specs,
        pageMatcher,
        routerFeatures: serverFeatures,
        ...(gateOf === undefined ? {} : { paramsGate: gateOf }),
        ...(needsMetadata && options.metadata !== undefined ? { metadata: options.metadata } : {}),
      };

      /** Runs the route middleware of the page chain around `final`; a page with none runs `final` directly. */
      const withPageMiddleware = async (
        event: EventState,
        final: () => Promise<Response>,
      ): Promise<Response> => {
        const chain = pageMatcher.match(event.url.pathname, visibilityOf(event));
        const middleware = await pageMiddlewareFor(config.manifest.middleware, chain);
        return runMiddleware(middleware, event, final);
      };

      /** Every method without the cache. Pages answer GET and HEAD only; a path that matches no page is a 404. */
      const respond = async (event: EventState): Promise<Response> => {
        const method = event.method;
        if (method === "GET" || method === "HEAD") {
          return withPageMiddleware(event, () => renderPage(pageRuntime, event));
        }
        const appPath = pageMatcher.stripBase(event.url.pathname);
        const matches =
          appPath !== undefined &&
          pageMatcher.match(event.url.pathname, visibilityOf(event)).length > 0;
        if (!matches) throw new HttpError(404, "Not Found");
        if (method === "OPTIONS")
          return new Response(null, { status: 204, headers: { allow: "GET, HEAD, OPTIONS" } });
        throw new HttpError(405, "Method Not Allowed", {
          headers: { allow: "GET, HEAD, OPTIONS" },
        });
      };

      /**
       * `POST {base}/_dusk/nav`: the browser asks before it navigates into a route whose chain runs server
       * middleware. The chain of the path runs with a final step that answers 204 `x-dusk-gate: allowed`. Any
       * other outcome (a redirect, a refusal, an error the middleware did not catch) is reported as a 200 JSON
       * body `{ status, redirect? }` with `x-dusk-gate: refused`, so the browser can read it. Nothing of the
       * page is rendered and no loader runs. It runs after CSRF, like any state-changing request.
       */
      const gate = async (event: EventState): Promise<Response> => {
        if (event.method !== "POST") {
          throw new HttpError(405, "Method Not Allowed", { headers: { allow: "POST" } });
        }
        const { path, search } = gateTargetOf(await readJson(event.request));
        // The gate checks the middleware of the target, private routes included: the browser may render them next.
        const chain = pageMatcher.match(`${config.base}${path}`, "all");
        const middleware = await pageMiddlewareFor(config.manifest.middleware, chain);
        // The chain sees the TARGET as `event.url` (path and search) and `isNavigationCheck`, so a redirect
        // from it can carry `redirect_url` = the target, exactly as for a document request.
        const target = new URL(`${config.base}${path}${search}`, event.url.origin);
        const outcome = await event.asNavigationCheck(target, () =>
          runMiddleware(middleware, event, async () => {
            return new Response(null, {
              status: 204,
              headers: { [NAV_GATE_HEADER]: NAV_GATE_ALLOWED },
            });
          }).catch((thrown: unknown) => {
            // A redirect or error thrown by the first middleware is an answer of the gate, not a failed request.
            const mapped = failureResponseFor(event, thrown);
            if (mapped === undefined) throw thrown;
            return mapped;
          }),
        );
        if (outcome.headers.get(NAV_GATE_HEADER) === NAV_GATE_ALLOWED) return outcome;
        const location = outcome.headers.get("location");
        const body =
          location === null
            ? { status: outcome.status }
            : { status: outcome.status, redirect: location };
        return json(body, { headers: { [NAV_GATE_HEADER]: NAV_GATE_REFUSED } });
      };

      const capability: PagesCapability = {
        runtime: pageRuntime,
        revalidates: [...wrapped.specs.values()].some((spec) => spec.revalidate !== undefined),
        match: (pathname: string, visibility: RouteVisibility = "public") =>
          pageMatcher.match(pathname, visibility),
        respond,
        serve: respond,
        shell: (event) => renderShellPage(pageRuntime, event),
        gate,
      };
      host.capabilities.pages = capability;
    },
  };
}
