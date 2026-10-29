import { failureResponseFor } from "./failure";
import type { Middleware, RequestEvent } from "./types";

/**
 * Runs a middleware list around `final`.
 *
 * `next()` always settles with a `Response`: whatever the rest of the chain throws (a route error,
 * an `HttpError`, a redirect, a validation failure, an error of an inner middleware) is turned into
 * the response the client would get, so an outer middleware can set headers on it, log its status or
 * replace it. A middleware that wants the failure to propagate throws its own error. Calling `next`
 * twice is a programming error and stays a rejection. Outside a request (an event built by hand)
 * there is no failure mapper and errors propagate unchanged.
 *
 * @internal
 */
export async function runMiddleware(
  chain: readonly Middleware[],
  event: RequestEvent,
  final: () => Promise<Response>,
): Promise<Response> {
  let called = -1;
  // async: a middleware that throws synchronously rejects instead of unwinding through `next()`.
  const dispatch = async (index: number): Promise<Response> => {
    called = index;
    const middleware = chain[index];
    if (middleware === undefined) return final();
    return middleware(event, () => {
      if (index + 1 <= called) {
        return Promise.reject(
          new Error("MIDDLEWARE_NEXT_TWICE: next() was called more than once."),
        );
      }
      return settle(event, dispatch(index + 1));
    });
  };
  return dispatch(0);
}

/** Awaits `pending`; a rejection becomes the failure response of the request, when there is a mapper. */
async function settle(event: RequestEvent, pending: Promise<Response>): Promise<Response> {
  try {
    return await pending;
  } catch (thrown) {
    const response = failureResponseFor(event, thrown);
    if (response === undefined) throw thrown;
    return response;
  }
}
