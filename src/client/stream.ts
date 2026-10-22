import {
  type Accessor,
  batch,
  getOwner,
  onCleanup,
  untrack,
  useEffect,
  useSignal,
} from "@shadow-js/core";
import { handleError } from "@shadow-js/core/extend";
import { deserialize, serialize } from "@shadow-js/web/server";
import { base64UrlEncode } from "../internal/encoding";
import type { CallArguments } from "../shared/call-arguments";
import type { ServerFnCallOptions } from "../shared/call-options";
import { RPC_HEADER, RPC_PREFIX, type ServerFnStubMeta } from "../shared/wire";
import { applyDeploymentHeader, noteDeploymentMismatch } from "./deployment";
import { ServerFnProtocolError } from "./errors";
import { asEnvelope, type ClientServerFn, decodeBody, outcomeOf } from "./fn";

const MAX_FRAME_BYTES = 65_536;
const MAX_CHUNK_BYTES = 1_048_576;
const MAX_ITEMS = 10_000;
const encoder = new TextEncoder();

function protocol(): ServerFnProtocolError {
  return new ServerFnProtocolError("invalid or incomplete server function stream", 200);
}

/** Keep the protocol failure identifiable while retaining a failed transport cleanup as evidence. */
async function failed(close: () => Promise<void>, error: unknown): Promise<never> {
  try {
    await close();
  } catch (cleanup) {
    const cause = new AggregateError([error, cleanup], "Server function stream cleanup failed.");
    if (error instanceof ServerFnProtocolError)
      throw new ServerFnProtocolError(error.message, error.status, cause);
    throw cause;
  }
  throw error;
}

function decodeUtf8(decoder: TextDecoder, bytes?: Uint8Array): string {
  try {
    return decoder.decode(bytes, { stream: bytes !== undefined });
  } catch (cause) {
    throw new ServerFnProtocolError("invalid server function stream encoding", 200, cause);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One single-consumer body; no item queue or background read can outrun its consumer. */
function items<Item>(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncIterable<Item> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let acquired = false;
  let closed = false;
  let terminal = false;
  let reading = false;
  let count = 0;
  let buffer = "";
  let chunk: Uint8Array | undefined;
  let offset = 0;
  let closeTask: Promise<void> | undefined;
  let cleanupError: unknown;
  const close = (): Promise<void> => {
    if (closeTask !== undefined) return closeTask;
    closed = true;
    signal?.removeEventListener("abort", abort);
    closeTask = reader.cancel().finally(() => reader.releaseLock());
    buffer = "";
    chunk = undefined;
    return closeTask;
  };
  const abort = (): void => {
    void close().catch((error: unknown) => {
      cleanupError = error;
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  const next = async (): Promise<IteratorResult<Item>> => {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (cleanupError !== undefined) throw cleanupError;
      if (closed) return { done: true, value: undefined };
      const boundary = /\r\n\r\n|\n\n/.exec(buffer);
      if (boundary !== null) {
        const text = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (encoder.encode(text + boundary[0]).byteLength > MAX_FRAME_BYTES) throw protocol();
        const lines = text.split(/\r?\n/);
        let name: string | undefined;
        const data: string[] = [];
        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:") && name === undefined) name = line.slice(6).trimStart();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else throw protocol();
        }
        if (name === undefined && data.length === 0) continue;
        if (terminal) throw protocol();
        let decoded: unknown;
        try {
          decoded = deserialize(data.join("\n"));
        } catch (cause) {
          throw new ServerFnProtocolError("invalid server function stream data", 200, cause);
        }
        if (!record(decoded)) throw protocol();
        if (name === "done" && Object.keys(decoded).length === 0) {
          terminal = true;
          continue;
        }
        if (name === "error") {
          const envelope = asEnvelope({ ok: false, error: decoded["error"] });
          if (envelope === undefined) throw protocol();
          outcomeOf(envelope, 200);
          throw protocol();
        }
        if (name !== "item" || !Object.hasOwn(decoded, "value") || ++count > MAX_ITEMS)
          throw protocol();
        return { done: false, value: decoded["value"] as Item };
      }
      if (encoder.encode(buffer).byteLength > MAX_FRAME_BYTES) throw protocol();
      if (chunk !== undefined && offset < chunk.byteLength) {
        const end = Math.min(chunk.byteLength, offset + 4096);
        buffer += decodeUtf8(decoder, chunk.subarray(offset, end));
        offset = end;
        continue;
      }
      const result = await reader.read();
      if (closed) continue;
      if (result.done) {
        buffer += decodeUtf8(decoder);
        if (!terminal || buffer.length > 0) throw protocol();
        await close();
        return { done: true, value: undefined };
      }
      if (result.value.byteLength > MAX_CHUNK_BYTES) throw protocol();
      chunk = result.value;
      offset = 0;
    }
  };
  return {
    [Symbol.asyncIterator]() {
      if (acquired) throw protocol();
      acquired = true;
      return {
        async next() {
          if (reading) throw protocol();
          reading = true;
          try {
            return await next();
          } catch (error) {
            return await failed(close, error);
          } finally {
            reading = false;
          }
        },
        async return() {
          await close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * Creates the browser stub for an AsyncIterable server function. The Dusk build emits this automatically.
 * Items retain serializer types; each call has one consumer and breaking iteration cancels the response.
 * @param id Stable function id.
 * @param meta Build-known method and mount base.
 * @returns A callable with id, url and with(options).
 * @throws ServerFnProtocolError for malformed, oversized or incomplete output.
 * @example const ticks = serverStreamStub<unknown, number>("ticks", { method: "POST", form: false, base: "" });
 * for await (const tick of await ticks()) console.log(tick);
 * @since 1.0.0
 */
export function serverStreamStub<Input = unknown, Item = unknown>(
  id: string,
  meta: ServerFnStubMeta,
): ClientServerFn<Input, AsyncIterable<Item>> {
  const url = `${meta.base}${RPC_PREFIX}${id}`;
  const invoke = async (
    input: unknown,
    options: ServerFnCallOptions,
  ): Promise<AsyncIterable<Item>> => {
    const headers = new Headers(options.headers);
    headers.set(RPC_HEADER, "1");
    headers.set("content-type", "application/json");
    headers.set("accept", "text/event-stream");
    applyDeploymentHeader(headers);
    const encoded = serialize([input]);
    const init: RequestInit = {
      method: meta.method,
      credentials: "same-origin",
      redirect: "manual",
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(meta.method === "POST" ? { body: encoded } : {}),
    };
    const target =
      meta.method === "GET" ? `${url}?p=${base64UrlEncode(encoder.encode(encoded))}` : url;
    const response = await untrack(() => (options.fetch ?? globalThis.fetch)(target, init));
    if (response.status === 409) noteDeploymentMismatch();
    const body = response.body;
    if (body === null) throw protocol();
    if (
      response.ok &&
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
        "text/event-stream"
    ) {
      return items<Item>(body, options.signal);
    }
    const reader = body.getReader();
    let closeTask: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closeTask === undefined) {
        options.signal?.removeEventListener("abort", abort);
        closeTask = reader.cancel().finally(() => reader.releaseLock());
      }
      return closeTask;
    };
    let cleanupError: unknown;
    const abort = (): void => {
      void close().catch((error) => {
        cleanupError = error;
      });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (cleanupError !== undefined) throw cleanupError;
        const part = await reader.read();
        if (options.signal?.aborted) throw options.signal.reason;
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_FRAME_BYTES) throw protocol();
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      const envelope = asEnvelope(decodeBody(text, response.status));
      if (envelope === undefined || ("ok" in envelope && envelope.ok)) throw protocol();
      outcomeOf(envelope, response.status);
      throw protocol();
    } catch (error) {
      return await failed(close, options.signal?.aborted ? options.signal.reason : error);
    }
  };
  const stub = (
    ...input: [...CallArguments<Input>, options?: ServerFnCallOptions]
  ): Promise<AsyncIterable<Item>> => invoke(input[0], record(input[1]) ? input[1] : {});
  return Object.assign(stub, {
    id,
    url,
    with:
      (options: ServerFnCallOptions) =>
      (...input: CallArguments<Input>) =>
        invoke(input[0], options),
  });
}

/** State of an owner-managed typed stream. @since 1.0.0 */
export interface StreamResult<Item> {
  /** Latest item only; undefined until the first item arrives. */
  readonly value: Accessor<Item | undefined>;
  /** Error of the current invocation, if any. */
  readonly error: Accessor<unknown>;
  /** State of the current invocation. */
  readonly status: Accessor<"pending" | "streaming" | "complete" | "error">;
  /** Abort the current invocation and start a fresh one. No automatic replay or retry. */
  reconnect(): void;
}

/**
 * Consumes a typed stream within the current owner, retaining only its latest item.
 * @param source Produces a stream; synchronous reads are tracked. Forward the signal to the server call.
 * @returns Reactive value, error, status and an explicit reconnect method.
 * @example const ticks = useStream(signal => getTicks(undefined, { signal }));
 * @since 1.0.0
 */
export function useStream<Item>(
  source: (signal: AbortSignal) => AsyncIterable<Item> | Promise<AsyncIterable<Item>>,
): StreamResult<Item> {
  const [value, setValue] = useSignal<Item | undefined>(undefined);
  const [error, setError] = useSignal<unknown>(undefined);
  const [status, setStatus] = useSignal<"pending" | "streaming" | "complete" | "error">("pending");
  const [retry, setRetry] = useSignal(false);
  useEffect(() => {
    retry();
    const abort = new AbortController();
    const owner = getOwner();
    let iterator: AsyncIterator<Item> | undefined;
    let returned = false;
    let done = false;
    const closeIterator = (): void => {
      if (returned || done || iterator === undefined) return;
      returned = true;
      try {
        void Promise.resolve(untrack(() => iterator?.return?.())).catch((failure) =>
          handleError(failure, owner),
        );
      } catch (failure) {
        handleError(failure, owner);
      }
    };
    onCleanup(() => {
      abort.abort();
      closeIterator();
    });
    batch(() => {
      setValue(undefined);
      setError(undefined);
      setStatus("pending");
    });
    const consume = async (
      result: AsyncIterable<Item> | Promise<AsyncIterable<Item>>,
    ): Promise<void> => {
      try {
        const stream = await result;
        iterator = untrack(() => stream[Symbol.asyncIterator]());
        if (abort.signal.aborted) {
          closeIterator();
          return;
        }
        while (!abort.signal.aborted) {
          const item = await untrack(() => iterator?.next());
          if (abort.signal.aborted) break;
          if (item === undefined) throw protocol();
          if (untrack(() => item.done)) {
            done = true;
            break;
          }
          const nextValue = untrack(() => item.value);
          batch(() => {
            setValue(() => nextValue);
            setStatus("streaming");
          });
        }
        if (!abort.signal.aborted) setStatus("complete");
      } catch (failure) {
        if (!abort.signal.aborted)
          batch(() => {
            setError(() => failure);
            setStatus("error");
          });
      } finally {
        closeIterator();
      }
    };
    try {
      void consume(source(abort.signal));
    } catch (failure) {
      setError(() => failure);
      setStatus("error");
    }
  });
  return { value, error, status, reconnect: () => setRetry((previous) => !previous) };
}
