import type { RouteMatcher, RouteVisibility } from "@shadow-js/router/core";
import type { ResolvedRouting } from "../shared/routing-config";
import type { ResolvedConfig } from "./config";
import type { EventState } from "./event";
import type { PageRuntime, Runtime } from "./runtime";
import type {
  ApiModule,
  HandlerOptions,
  RequestEvent,
  StreamModule,
  UpgradeDecision,
} from "./types";

/**
 * The optional parts of a handler. `createHandler` has none by default: each one is a feature object
 * (`pages()`, `isr()`, ...) imported from its own subpath (`@shadow-js/dusk/features/<name>`) and listed in
 * `features`. A feature the handler does not list is not in its bundle: the core refers to a feature only
 * through the capability it fills, never to the code of the feature.
 *
 * The request pipeline (guards, CSRF, middleware, headers, redirects, error mapping) is the core and always
 * present. Its stores are injected by the features that own them.
 * @since 1.0.0
 */

/** The names of the features. @since 1.0.0 */
export type FeatureName =
  | "routing"
  | "pages"
  | "dataCache"
  | "isr"
  | "rpc"
  | "apiRoutes"
  | "streams"
  | "images"
  | "draftMode";

/**
 * Install order. A feature may read the capabilities of the features before it (ISR wraps the pages, server
 * functions revalidate the pages), so the order is fixed here and not taken from the order of `features`.
 */
export const FEATURE_ORDER: readonly FeatureName[] = [
  "routing",
  "pages",
  "dataCache",
  "isr",
  "rpc",
  "apiRoutes",
  "streams",
  "images",
  "draftMode",
];

/** The factory of each feature and the subpath it is imported from, named in refusals. */
export const FEATURE_FACTORY: Readonly<
  Record<FeatureName, { readonly call: string; readonly from: string }>
> = Object.fromEntries(
  FEATURE_ORDER.map((name) => [
    name,
    {
      call: `${name}()`,
      // The subpath is the kebab-case name: `dataCache` is `data-cache`, `draftMode` is `draft-mode`.
      from: `@shadow-js/dusk/features/${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    },
  ]),
) as Readonly<Record<FeatureName, { readonly call: string; readonly from: string }>>;

/** A feature object. Built by the factory functions of `@shadow-js/dusk/features/*`. @since 1.0.0 */
export interface DuskFeature {
  /** Which feature this is; the core installs at most one of each. */
  readonly name: FeatureName;
  /**
   * Fills this feature's capability. Runs once per handler, in {@link FEATURE_ORDER}. A feature that needs
   * another one reads `host.capabilities` and calls `host.need` when that one is missing.
   * @internal
   */
  install(host: FeatureHost): void;
}

/** A pipeline helper the core shares with the features. @internal */
export interface FeatureHost {
  /** The options as given to `createHandler` (validated by the feature that reads them). */
  readonly options: HandlerOptions;
  /** The resolved core configuration. */
  readonly config: ResolvedConfig;
  /** Reports errors, redirect policy and the config of the request code. */
  readonly runtime: Runtime;
  /** The capabilities installed so far, and the one this feature fills. */
  readonly capabilities: Capabilities;
  /**
   * Throws a TypeError naming the feature that a `reason` needs and the factory to add to `features`.
   * @param name The missing feature.
   * @param reason What needs it, for example `the option "images"`.
   */
  need(name: FeatureName, reason: string): never;
  /** Adds the response headers, cookies and the security headers of a request (see `finalize`). */
  finalize(event: EventState, response: Response): Promise<Response>;
  /** Maps a thrown value to the response of a request (see `failureResponse`). */
  failureResponse(event: EventState, thrown: unknown): Response;
  /** The validated environment of a request (see `envFor`). */
  envFor(platform: unknown): Readonly<Record<string, unknown>>;
}

/** A route the streams feature matched: its id, its URL pattern, params and module. @internal */
export interface StreamHit {
  readonly id: string;
  /** The URL pattern of the route (`/live/:room`), the value precedence compares. */
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
  readonly module: StreamModule;
}

/** An API route the apiRoutes feature matched: its id, its URL pattern, params and module. @internal */
export interface ApiHit {
  readonly id: string;
  /** The URL pattern of the route (`/api/posts/:id`), the value precedence compares. */
  readonly pattern: string;
  readonly params: Readonly<Record<string, string>>;
  readonly module: ApiModule;
}

/** The pages feature: rendering and page-level routing. @internal */
export interface PagesCapability {
  /** The runtime of the pages: the wrapped page routes, their specs and the page matcher. */
  readonly runtime: PageRuntime;
  /** True when a page exports `revalidate`; such a handler needs `isr()`. */
  readonly revalidates: boolean;
  /** Matches a page path (without the base): the route chain, outermost first. A private route needs `"all"`. */
  match(pathname: string, visibility?: RouteVisibility): ReturnType<RouteMatcher["match"]>;
  /**
   * Answers a page request for any method without the cache: GET and HEAD render, other methods are
   * refused or answered for OPTIONS. Route middleware runs around the render.
   */
  respond(event: EventState): Promise<Response>;
  /** Answers a GET or HEAD page request. `isr()` replaces it with a cache-aware version. */
  serve(event: EventState): Promise<Response>;
  /** Answers the SPA shell: the document without route content (no loaders, no route middleware). */
  shell(event: EventState): Promise<Response>;
  /** `POST {base}/_dusk/nav`: the navigation gate of a route whose chain runs middleware. */
  gate(event: EventState): Promise<Response>;
}

/** The routing feature: the validated redirects, rewrites, headers and route rules. @internal */
export interface RoutingCapability {
  /** The rules of the handler after validation (the `routing` option); the core reads them per request. */
  readonly rules: ResolvedRouting;
}

/** The data cache feature: a request adopts the cache of its handler. @internal */
export interface DataCacheCapability {
  adopt(event: RequestEvent): void;
}

/** The ISR feature: a request adopts the page cache of its handler. @internal */
export interface IsrCapability {
  adopt(event: RequestEvent): void;
}

/** The server functions feature. @internal */
export interface RpcCapability {
  /** Answers `POST`/`GET` to `/_dusk/fn/<id>` (and the batch id). */
  handle(event: EventState, id: string): Promise<Response>;
  /** The response of a failure on a server function route. */
  failure(event: EventState, thrown: unknown): Response;
}

/** The API routes feature. @internal */
export interface ApiRoutesCapability {
  /** Matches an API route path (without the base). A private route answers only with `"all"` (a rewrite target). */
  match(pathname: string, visibility?: RouteVisibility): Promise<ApiHit | undefined>;
  /**
   * Runs the method handler of a matched module for the request. `extra` are the methods of the other routes on the
   * same path, which the `Allow` list of a refusal or an OPTIONS answer includes.
   */
  dispatch(event: EventState, hit: ApiHit, extra?: readonly string[]): Promise<Response>;
}

/** The stream routes feature (SSE and WebSocket). @internal */
export interface StreamsCapability {
  readonly limits: import("./websocket").WebSocketLimits;
  /** Matches a stream route path (without the base) and loads its module. A private route answers only with `"all"`. */
  match(pathname: string, visibility?: RouteVisibility): Promise<StreamHit | undefined>;
  /** Answers a GET to a stream route: its SSE stream, or 426 for a WebSocket-only route. */
  answer(event: EventState, hit: StreamHit): Response;
  /** Decides a WebSocket upgrade (see `Handler.upgrade`). */
  upgrade(request: Request, platform: unknown): Promise<UpgradeDecision>;
}

/** The image endpoint feature. @internal */
export interface ImagesCapability {
  handle(event: EventState): Promise<Response>;
}

/** The draft mode feature. @internal */
export interface DraftCapability {
  /** The endpoint a path names (`draft.enablePath` / `draft.disablePath`), or undefined. */
  match(appPath: string): { readonly enable: boolean } | undefined;
  /** Whether draft mode is on for a request (a valid signed cookie). */
  enabledFor(request: Request, platform: unknown): Promise<boolean>;
  /** The enable or disable endpoint. */
  endpoint(event: EventState, enable: boolean): Promise<Response>;
}

/**
 * The optional parts of one handler, filled by the features while the handler is built. A capability is
 * absent when its feature is not listed.
 * @internal
 */
export interface Capabilities {
  routing?: RoutingCapability;
  pages?: PagesCapability;
  dataCache?: DataCacheCapability;
  isr?: IsrCapability;
  rpc?: RpcCapability;
  apiRoutes?: ApiRoutesCapability;
  streams?: StreamsCapability;
  images?: ImagesCapability;
  draftMode?: DraftCapability;
}

/** The feature names a `features` list may hold. */
const KNOWN: ReadonlySet<string> = new Set(FEATURE_ORDER);

/**
 * Checks a `features` list and sorts it into {@link FEATURE_ORDER}: each entry is a feature object, a name
 * is known, and no feature is listed twice.
 * @param features The list given to `createHandler`.
 * @returns The features in install order.
 * @throws TypeError for a value that is not a feature, an unknown or duplicate feature.
 * @internal
 */
export function sortFeatures(features: readonly DuskFeature[] | undefined): DuskFeature[] {
  if (features === undefined) return [];
  if (!Array.isArray(features))
    throw new TypeError(__DEV__ ? "createHandler: features must be an array." : "DUSK_FEATURES");
  const byName = new Map<FeatureName, DuskFeature>();
  for (const feature of features) {
    const name: unknown =
      typeof feature === "object" && feature !== null ? feature.name : undefined;
    if (typeof name !== "string" || !KNOWN.has(name)) {
      throw new TypeError(
        __DEV__
          ? "createHandler: features must hold feature objects from @shadow-js/dusk/features/<name> (for example pages())."
          : "DUSK_FEATURE_1",
      );
    }
    const key = name as FeatureName;
    if (byName.has(key)) {
      throw new TypeError(
        __DEV__
          ? `createHandler: ${FEATURE_FACTORY[key].call} is listed twice in features.`
          : `DUSK_FEATURE_3 ${key}`,
      );
    }
    byName.set(key, feature);
  }
  return FEATURE_ORDER.flatMap((name) => {
    const feature = byName.get(name);
    return feature === undefined ? [] : [feature];
  });
}

/** The refusal of a missing feature: names the option or route that needs it and the factory to add. @internal */
export function missingFeature(name: FeatureName, reason: string): TypeError {
  if (!__DEV__) return new TypeError(`DUSK_FEATURE_2 ${name}`);
  const { call, from } = FEATURE_FACTORY[name];
  return new TypeError(
    `createHandler: ${reason} needs ${call}. Import it from the "${from}" subpath and add it to features.`,
  );
}
