import type { DuskFeature } from "../server/features";
import { handleRpc, rpcFailure } from "../server/rpc";
import type { RpcRuntime } from "../server/runtime";

/** Bounds of typed server-function streams. @since 1.0.0 */
export interface RpcStreamsOptions {
  /** Deadline in milliseconds: positive integer, at most 2,147,483,647. Default 30,000. */
  readonly maxDurationMs?: number;
  /** Maximum items sent, positive integer at most 10,000. Default 10,000. */
  readonly maxItems?: number;
}

/** Options of the RPC feature. @since 1.0.0 */
export interface RpcOptions {
  /** Enable typed AsyncIterable delivery. Absent: ordinary RPC only. */
  readonly streams?: RpcStreamsOptions;
}

/**
 * The `rpc()` feature: server functions. `POST` (and `GET` for the functions that declare it) to
 * `/_dusk/fn/<id>`, the batch endpoint `/_dusk/fn/_batch`, the deployment check, and the flash.
 *
 * A single-flight function (its answer refreshes the loaders of the page) also needs `pages()`: listed without
 * it, such a call is refused at run time with the factory to add. A handler with server functions and no pages
 * (an API that is only called) needs no `pages()`.
 *
 * @example
 * import { rpc } from the "@shadow-js/dusk/features/rpc" subpath;
 * const handler = createHandler({ manifest, features: [rpc()] });
 * @returns The feature.
 * @param options Optional typed streaming delivery and its bounds.
 * @since 1.0.0
 */
export function rpc(options: RpcOptions = {}): DuskFeature {
  const streams = options.streams;
  if (
    streams !== undefined &&
    (streams === null || typeof streams !== "object" || Array.isArray(streams))
  ) {
    throw new TypeError("rpc.streams must be an options object.");
  }
  const maxDurationMs = streams?.maxDurationMs ?? 30_000;
  const maxItems = streams?.maxItems ?? 10_000;
  if (
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > 2_147_483_647 ||
    !Number.isInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 10_000
  ) {
    throw new RangeError(
      "rpc.streams: duration and items must be positive integers within their bounds.",
    );
  }
  return {
    name: "rpc",
    install(host): void {
      // The page routes, when the pages feature is installed (single flight refreshes them); otherwise the core runtime.
      const pages = host.capabilities.pages;
      const runtime: RpcRuntime = pages === undefined ? host.runtime : pages.runtime;
      host.capabilities.rpc = {
        handle: (event, id) =>
          handleRpc(
            runtime,
            event,
            id,
            streams === undefined
              ? undefined
              : async (definition, request, input) =>
                  (await import("../server/rpc-stream")).rpcStreamResponse(
                    runtime,
                    request,
                    definition,
                    input,
                    { maxDurationMs, maxItems },
                  ),
          ),
        failure: (event, thrown) => rpcFailure(runtime, event, thrown),
      };
    },
  };
}
