import type { RouteDefinition, RouterFeature } from "@shadow-js/router";
import type { RouteMatcher } from "@shadow-js/router/core";
import type * as MetadataServer from "../metadata/server";
import type { ResolvedConfig } from "./config";
import type { ParamsGate } from "./dynamic-params";
import type { RedirectPolicy } from "./redirect-target";
import type { ErrorPhase, RequestEvent } from "./types";

/** Erased options of a route, as the router stores them. */
export type RouteSpec = RouteDefinition["spec"];

/**
 * What the request code shares: the resolved configuration and the error channel. It holds no per-request
 * state, and every feature gets it (see `FeatureHost`).
 * @internal
 */
export interface Runtime {
  readonly config: ResolvedConfig;
  /** Redirect rules for a request. */
  policyFor(event: RequestEvent): RedirectPolicy;
  /** Sends an unexpected error to the configured sink, never throwing. */
  report(error: unknown, phase: ErrorPhase, event: RequestEvent | undefined): void;
  /** Marks an error object as already reported, so a later report of it is dropped. */
  markReported(value: unknown): void;
}

/**
 * The runtime of the server functions: the core runtime, plus the page routes when the pages feature is installed
 * (a single-flight answer refreshes their loaders; without them such a call is refused with the factory to add).
 * @internal
 */
export interface RpcRuntime extends Runtime {
  /** The wrapped page routes, when `pages()` is installed. */
  readonly pageRoutes?: PageRuntime["pageRoutes"];
  /** The router features of the page routes, with `pageRoutes` (see `PageRuntime.routerFeatures`). */
  readonly routerFeatures?: PageRuntime["routerFeatures"];
  /**
   * The matcher of the page routes, with `pageRoutes`: a single-flight answer finds the page chain with it, to run the
   * middleware of the page before its loaders.
   */
  readonly pageMatcher?: PageRuntime["pageMatcher"];
}

/**
 * The runtime of the pages feature: the core runtime plus the page routes, wrapped so redirects and loader
 * errors reach the request (see `route-wrap`), their specs and the matcher of page paths.
 * @internal
 */
export interface PageRuntime extends Runtime {
  /** Page routes wrapped so redirects and loader errors reach the request (see `route-wrap`). */
  readonly pageRoutes: readonly RouteDefinition[];
  /** Spec of every page route by id. */
  readonly specs: ReadonlyMap<string, RouteSpec>;
  /** Matches page paths (without the base) to tell "no such page" from "page, wrong method". */
  readonly pageMatcher: RouteMatcher;
  /**
   * The gate of the pages that set `dynamicParams = false` (see `dynamic-params.ts`). Present only when some page sets
   * it.
   */
  readonly paramsGate?: () => Promise<ParamsGate>;
  /** The router features every page render's router takes (see `duskServerFeatures`). */
  readonly routerFeatures: readonly RouterFeature[];
  /**
   * Loads the metadata engine (see `metadata/server.ts`). Present only when some route or the global error exports
   * metadata: a page without any never loads it.
   */
  readonly metadata?: () => Promise<typeof MetadataServer>;
}
