import type { RequestEvent } from "./types";

/** Turns a thrown value into the response a client gets. */
type FailureMapper = (thrown: unknown) => Response;

/**
 * The mapper of each request, set by the handler. A WeakMap keyed by the event keeps the mapping
 * out of the public `RequestEvent` shape and lets it disappear with the request.
 */
const mappers = new WeakMap<object, FailureMapper>();

/**
 * Registers how failures of one request are turned into responses (redirect, JSON or HTML error,
 * RPC envelope). Called once per request by the handler.
 *
 * @param event The request event.
 * @param map The mapper.
 * @internal
 */
export function bindFailureMapper(event: RequestEvent, map: FailureMapper): void {
  mappers.set(event, map);
}

/**
 * The response for something thrown inside the middleware chain, or `undefined` when the event has
 * no mapper (an event built by hand in a unit test); the caller then rethrows.
 *
 * @param event The request event.
 * @param thrown Whatever was thrown.
 * @returns The response, or `undefined`.
 * @internal
 */
export function failureResponseFor(event: RequestEvent, thrown: unknown): Response | undefined {
  const map = mappers.get(event);
  return map === undefined ? undefined : map(thrown);
}
