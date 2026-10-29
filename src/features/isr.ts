import { randomNonce } from "../internal/encoding";
import { warnToConsole } from "../server/config";
import { runWithEvent } from "../server/context";
import { EventState, visibilityOf } from "../server/event";
import { type DuskFeature, missingFeature } from "../server/features";
import {
  createIsr,
  type Isr,
  policyFromRule,
  policyOf,
  type RenderInput,
  resolveCache,
  validateRouteCache,
  watchHeaders,
} from "../server/isr";
import { hasPageMiddleware } from "../server/route-middleware";
import type { RequestEvent } from "../server/types";
import { NO_ROUTING } from "../shared/routing-empty";

/**
 * The `isr()` feature: incremental static regeneration. A page that exports `revalidate` (or a route rule
 * with `revalidate`) is answered from the page cache: fresh entries as they are, stale ones with one background
 * refresh, and misses shared between concurrent requests. `revalidatePath` and `revalidateTag` purge it, and
 * `cache` in the options sets the store and its bounds.
 *
 * It needs `pages()`: the cache stores what the pages render. Listed without it, the handler is refused at
 * creation.
 *
 * @example
 * import { isr } from the "@shadow-js/dusk/features/isr" subpath;
 * const handler = createHandler({ manifest, features: [pages(), isr()], cache: { maxEntries: 500 } });
 * @returns The feature.
 * @since 1.0.0
 */
export function isr(): DuskFeature {
  return {
    name: "isr",
    install(host): void {
      const { options, config, runtime } = host;
      const pages = host.capabilities.pages;
      if (pages === undefined) throw missingFeature("pages", "isr()");
      validateRouteCache(pages.runtime.specs);
      const resolved = {
        ...resolveCache(options.cache),
        base: config.base,
        caseSensitive: config.manifest.caseSensitive === true,
        chainOf: (pathname: string) => pages.runtime.pageMatcher.match(pathname, "all"),
      };
      /** Renders a page for a URL with an event of its own (a miss or a background refresh has no request). */
      const renderForCache = async (
        input: RenderInput,
      ): Promise<{
        readonly response: Response;
        readonly event: EventState;
        readonly read: ReadonlySet<string>;
      }> => {
        const { url, env, headers } = input;
        const event = new EventState({
          request: new Request(url, { headers }),
          url,
          // Aborts when every request waiting for this render left, or the render timed out (see `stores/single-flight.ts`).
          signal: input.signal ?? new AbortController().signal,
          id: crypto.randomUUID(),
          nonce: config.nonce ? randomNonce() : undefined,
          signer: config.signer,
          secureCookies: true,
          env,
          platform: undefined,
          clientAddress: undefined,
          dev: config.dev,
          // The mount point and the trailing-slash policy are the app's, as on the request's own event (the head and the
          // metadata routes build URLs from them).
          base: config.base,
          trailingSlash: config.trailingSlash,
          // The `<html lang dir>` a middleware chose for the request (a locale middleware): the entry is keyed by what
          // decided them (the URL, or the headers its Vary names), so every visitor of the entry gets them.
          lang: input.document?.lang ?? config.document.lang,
        });
        if (input.document !== undefined) event.document.dir = input.document.dir;
        event.route = { kind: "page", id: undefined, params: NO_PARAMS };
        // From here on the page's reads of the request headers are recorded (the cookie jar was built above, unwatched).
        const read = new Set<string>();
        event.request = watchHeaders(event.request, read);
        cache.adopt(event);
        host.capabilities.dataCache?.adopt(event);
        const response = await runWithEvent(event, () => pages.respond(event), config.asyncContext);
        return { response, event, read };
      };
      const cache: Isr = createIsr(resolved, {
        render: renderForCache,
        renderOwn: (event) => pages.respond(event),
        report: (error) => runtime.report(error, "cache", undefined),
        ...(config.dev ? { warn: options.onWarning ?? warnToConsole } : {}),
      });
      // GET and HEAD pages whose matched routes set `revalidate` are answered through the cache.
      pages.serve = async (event: EventState): Promise<Response> => {
        if (event.method !== "GET" && event.method !== "HEAD") return pages.respond(event);
        // Draft mode reads and writes nothing in the page cache.
        if (event.draft) return pages.respond(event);
        const chain = pages.runtime.pageMatcher.match(event.url.pathname, visibilityOf(event));
        // A page with server middleware is never answered from the cache: a cached answer would skip the check.
        if (hasPageMiddleware(config.manifest.middleware, chain)) return pages.respond(event);
        const currentPath = pages.runtime.pageMatcher.stripBase(event.url.pathname) ?? "/";
        // The page's own `revalidate` export wins; a route rule supplies the policy for pages that export none.
        const policy =
          policyOf(chain, pages.runtime.specs) ??
          policyFromRule(
            (await import("../server/routing")).effectiveRule(
              host.capabilities.routing?.rules ?? NO_ROUTING,
              currentPath,
            ),
          );
        return policy === undefined ? pages.respond(event) : cache.serve(event, policy);
      };
      host.capabilities.isr = {
        adopt: (event: RequestEvent): void => {
          cache.adopt(event);
        },
      };
    },
  };
}

const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});
