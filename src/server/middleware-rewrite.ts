import type { EventState } from "./event";
import type { RewriteInstruction } from "./rewrite";

/** What the handler does with a rewritten request: move its URL, then answer it. @internal */
export interface RewriteSteps {
  /** Moves the URL to the target (see the handler's `rewriteEvent`). */
  readonly move: (event: EventState, hit: RewriteInstruction) => void;
  /** Resolves the moved request and answers it, without the app-wide middleware. */
  readonly answer: (event: EventState) => Promise<Response>;
}

/**
 * Serves a request a middleware rewrote (see `rewrite()`): the URL and the request move to the target, the target is
 * resolved and answered, and the app-wide middleware does not run again. A second rewrite is an error. The handler
 * loads this module on the first rewrite only.
 *
 * @internal
 */
export async function rewriteTarget(
  event: EventState,
  moved: RewriteInstruction,
  steps: RewriteSteps,
): Promise<Response> {
  if (event.rewritten) {
    throw new TypeError("MIDDLEWARE_REWRITE_TWICE: a rewritten request cannot be rewritten again.");
  }
  event.rewritten = true;
  steps.move(event, moved);
  const headers = new Headers(event.request.headers);
  for (const [name, value] of moved.headers) headers.set(name, value);
  const init: RequestInit & { duplex?: "half" } = {
    method: event.request.method,
    headers,
    signal: event.request.signal,
  };
  // A body is a stream: it moves with the request (the middleware has not read it).
  if (event.request.body !== null) {
    init.body = event.request.body;
    init.duplex = "half";
  }
  event.request = new Request(event.url, init);
  return steps.answer(event);
}
