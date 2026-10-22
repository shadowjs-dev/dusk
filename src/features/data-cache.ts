import { adoptDataCache, createDataCache } from "../server/data-cache";
import type { DuskFeature } from "../server/features";
import { createMemoryKVStore } from "../server/kv-store";
import { markProcessLocalStore } from "../shared/worker-info";

/**
 * The `dataCache()` feature: `cacheData` and `cachedFetch` keep their values for the handler of the request.
 * The values are JSON in a key-value store (`cache.kv`, or an in-memory store bounded to 10 000 entries),
 * tagged so `revalidateTag` purges them with the pages. Draft mode runs the functions every time.
 *
 * Without it, `cacheData` and `cachedFetch` throw `DATA_CACHE_NO_STORE` inside a request.
 *
 * @example
 * import { dataCache } from the "@shadow-js/dusk/features/data-cache" subpath;
 * const handler = createHandler({ manifest, features: [pages(), dataCache()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function dataCache(): DuskFeature {
  return {
    name: "dataCache",
    install(host): void {
      const { options, config, runtime } = host;
      if (options.cache?.kv === undefined) markProcessLocalStore("data cache");
      const cache = createDataCache({
        kv: options.cache?.kv ?? createMemoryKVStore({ maxEntries: 10_000 }),
        profiles: config.cacheLife,
        report: (error) => runtime.report(error, "cache", undefined),
      });
      host.capabilities.dataCache = {
        adopt: (event) => adoptDataCache(event, cache),
      };
    },
  };
}
