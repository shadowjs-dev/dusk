import type { ResolvedRouting } from "./routing-config";

/**
 * The routing of an app that declares none: no redirect, rewrite, header or route rule. The handler reads it until the
 * `routing()` feature installs the validated rules, so the core never loads the routing validators for an app without
 * routing. Type-only import: this module adds no code to the bundle.
 *
 * @internal
 */
export const NO_ROUTING: ResolvedRouting = {
  redirects: [],
  rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
  headers: [],
  routeRules: [],
};
