import { getRequestEvent } from "../internal/request-context";

/**
 * Measures `fn` under `name` for the request that is running (`getRequestEvent().timing.measure`): the same as
 * `event.timing.measure`, for code that has no event at hand. With `serverTiming` off it only runs `fn`.
 *
 * @param name A metric name: a token of 1 to 64 characters that is not `total`, `route`, `loaders` or `render`.
 * @param fn The work. A promise is measured until it settles.
 * @param description An optional label.
 * @returns What `fn` returns.
 * @throws Error outside a request; TypeError for an invalid name.
 * @example
 * import { timing } from "@shadow-js/dusk/server";
 * const user = await timing("db", () => loadUser(id), "load user");
 * @since 1.0.0
 */
export function timing<T>(name: string, fn: () => T, description?: string): T {
  return getRequestEvent().timing.measure(name, fn, description);
}
