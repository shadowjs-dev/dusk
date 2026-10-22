import { untrack } from "@shadow-js/core";
import { serialize } from "@shadow-js/web/server";
import { runWithEvent } from "./context";
import { describeError, errorBody, RequestTimeoutError } from "./errors";
import type { EventState } from "./event";
import type { RpcRuntime } from "./runtime";
import { executeServerFn } from "./server-fn";
import { formatSseEvent } from "./sse";
import type { ServerFnDefinition } from "./types";

/** Obtains an iterator before the response commits, so malformed results use the normal RPC failure mapper. */
function iteratorOf(value: unknown): AsyncIterator<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("a streaming server function must return an AsyncIterable.");
  }
  const factory: unknown = Reflect.get(value, Symbol.asyncIterator);
  if (typeof factory !== "function") {
    throw new TypeError("a streaming server function must return an AsyncIterable.");
  }
  const iterator: unknown = Reflect.apply(factory, value, []);
  if (
    typeof iterator !== "object" ||
    iterator === null ||
    typeof Reflect.get(iterator, "next") !== "function"
  ) {
    throw new TypeError("a streaming server function returned an invalid async iterator.");
  }
  return iterator as AsyncIterator<unknown>;
}

/**
 * Delivers one typed server-function invocation as bounded, consumer-paced RPC codec frames.
 * Initial errors propagate to the ordinary RPC failure mapper; committed errors become safe terminal frames.
 *
 * @param rt The RPC runtime and its error sink.
 * @param event The original request event.
 * @param definition The streaming server function.
 * @param input The untrusted call input.
 * @param options Validated duration and item bounds from the RPC feature.
 * @returns An SSE response after validation, middleware, handler execution and iterator acquisition succeed.
 * @internal
 */
export async function rpcStreamResponse(
  rt: RpcRuntime,
  event: EventState,
  definition: ServerFnDefinition,
  input: unknown,
  options: { readonly maxDurationMs: number; readonly maxItems: number },
): Promise<Response> {
  if (event.signal.aborted) throw event.signal.reason;
  const abort = new AbortController();
  // EventState's private-field accessors and methods require the original receiver. Only the signal is replaced;
  // context, cookies, response headers and locals remain the same request's objects.
  const linkedEvent = new Proxy(event, {
    get(target, key) {
      if (key === "signal") return abort.signal;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const invoke = <T>(callback: () => T): T =>
    runWithEvent(linkedEvent, () => untrack(callback), rt.config.asyncContext);
  const checked = <T>(callback: () => T): T => {
    if (abort.signal.aborted) throw abort.signal.reason;
    return invoke(callback);
  };
  const inputSchema = definition.input;
  // Middleware and validation can resume after an initial abort wins the race. Guard every user callback
  // independently so such a continuation cannot reach a later callback or invoke the handler after cancellation.
  const guardedDefinition: ServerFnDefinition = {
    ...definition,
    input:
      inputSchema === undefined
        ? undefined
        : {
            get "~standard"() {
              return checked(() => {
                const schema = inputSchema["~standard"];
                return {
                  version: schema.version,
                  vendor: schema.vendor,
                  validate: (value: unknown) => checked(() => schema.validate(value)),
                };
              });
            },
          },
    ...(definition.guard === undefined
      ? {}
      : {
          guard: definition.guard.map((guard) => (current) => checked(() => guard(current))),
        }),
    middleware: definition.middleware.map(
      (middleware) => (context, next) => checked(() => middleware(context, next)),
    ),
    handler: (value, current) => checked(() => definition.handler(value, current)),
  };
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<{ readonly aborted: true }>((resolve) => {
    resolveAbort = () => resolve({ aborted: true });
  });
  const onLinkedAbort = (): void => {
    resolveAbort?.();
  };
  abort.signal.addEventListener("abort", onLinkedAbort, { once: true });
  let iterator: AsyncIterator<unknown> | undefined;
  let returned = false;
  let iteratorDone = false;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();

  const returnIterator = (): void => {
    if (returned || iteratorDone || iterator === undefined) return;
    returned = true;
    try {
      const result = invoke(() => iterator?.return?.());
      // A generator blocked on external work can queue return behind next. Its cooperative cleanup must observe
      // the linked signal; waiting for return here would keep framework timers/listeners alive after cancellation.
      void Promise.resolve(result).catch((error: unknown) => {
        rt.report(error, "rpc", event);
      });
    } catch (error) {
      rt.report(error, "rpc", event);
    }
  };
  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    event.signal.removeEventListener("abort", onRequestAbort);
    abort.signal.removeEventListener("abort", onLinkedAbort);
    if (!abort.signal.aborted) abort.abort();
    returnIterator();
  };
  const onRequestAbort = (): void => {
    if (finished) return;
    abort.abort(event.signal.reason);
    cleanup();
    controller?.close();
  };
  event.signal.addEventListener("abort", onRequestAbort, { once: true });
  const frame = (name: string, payload: unknown): Uint8Array =>
    invoke(() => encoder.encode(formatSseEvent({ event: name, data: serialize(payload) })));
  const fail = (error: unknown): void => {
    if (finished) return;
    const description = describeError(error, event.dev);
    if (description.report) rt.report(error, "rpc", event);
    let bytes: Uint8Array;
    try {
      bytes = frame("error", { error: errorBody(description, event.id) });
    } catch (formatError) {
      // App-provided public error data and development messages can exceed the frame budget or fail serialization.
      // The client still receives a bounded terminal refusal rather than an unexplained truncated body.
      rt.report(formatError, "rpc", event);
      bytes = frame("error", { error: errorBody(describeError(formatError, false), event.id) });
    }
    controller?.enqueue(bytes);
    cleanup();
    controller?.close();
  };
  const deadline = setTimeout(() => {
    if (finished) return;
    const error = new RequestTimeoutError(options.maxDurationMs);
    abort.abort(error);
    // Before commit the invocation's abort race propagates this through the ordinary RPC failure mapper.
    if (controller !== undefined) fail(error);
  }, options.maxDurationMs);
  const wait = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await Promise.race([
      operation.then((value) => ({ aborted: false as const, value })),
      aborted,
    ]);
    if (result.aborted || abort.signal.aborted) throw abort.signal.reason;
    return result.value;
  };

  try {
    const value = await wait(invoke(() => executeServerFn(guardedDefinition, input, linkedEvent)));
    iterator = invoke(() => iteratorOf(value));
    if (abort.signal.aborted) throw abort.signal.reason;
    let count = 0;
    // A zero-size queue starts next only for consumer demand. It also lets a deadline replace a pending next
    // with one terminal frame without stacking that error behind an unread item or a heartbeat timer.
    const body = new ReadableStream<Uint8Array>(
      {
        start(created) {
          controller = created;
        },
        async pull(created) {
          if (finished) return;
          try {
            const current = iterator;
            if (current === undefined) throw new TypeError("missing server function iterator.");
            const result = await wait(invoke(() => Promise.resolve(current.next())));
            if (finished) return;
            if (typeof result !== "object" || result === null) {
              throw new TypeError(
                "a streaming server function returned an invalid iterator result.",
              );
            }
            if (invoke(() => result.done === true)) {
              iteratorDone = true;
              created.enqueue(frame("done", {}));
              cleanup();
              created.close();
            } else {
              if (count >= options.maxItems) throw new RangeError("SERVER_FN_STREAM_ITEM_LIMIT");
              count += 1;
              created.enqueue(frame("item", { value: invoke(() => result.value) }));
            }
          } catch (error) {
            if (!finished) fail(error);
          }
        },
        cancel(reason: unknown) {
          abort.abort(reason);
          cleanup();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
