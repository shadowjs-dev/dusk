import type { DuskFeature } from "../server/features";
import { validateRouting } from "../shared/routing-config";

/**
 * The `routing()` feature: the declarative routing of the handler, the `routing` option (redirects, rewrites,
 * headers and route rules; the same shape `dusk.config.ts` declares). The rules are validated when the handler is
 * created, so an invalid rule throws at startup, not on the first request. The routing validators load only with this
 * feature.
 *
 * Without it, a `routing` option is refused at creation with the factory to add, and every request runs with no rule.
 *
 * @example
 * import { routing } from the "@shadow-js/dusk/features/routing" subpath;
 * const handler = createHandler({ manifest, features: [pages(), routing()], routing: { redirects: [{ source: "/old", destination: "/new" }] } });
 * @returns The feature.
 * @since 1.0.0
 */
export function routing(): DuskFeature {
  return {
    name: "routing",
    install(host): void {
      host.capabilities.routing = {
        rules: validateRouting(host.options.routing ?? {}, {
          trustedOrigins: host.config.trustedOrigins,
          ignoreCase: host.config.manifest.caseSensitive !== true,
        }),
      };
    },
  };
}
