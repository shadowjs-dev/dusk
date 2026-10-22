import type { RequestEvent } from "./types";

/**
 * Server-sent events (`text/event-stream`). A stream route exports `SSE(event, stream)`; the runtime
 * turns it into a streamed response with a heartbeat, a bounded buffer per connection and an abort
 * when the client goes away. The wire format is the WHATWG one: `retry`, `id`, `event` and one `data`
 * line per line of data, closed by a blank line.
 */

/** Largest single message, in bytes, after formatting. Larger is refused before it is sent. */
export const SSE_MAX_EVENT_BYTES: number = 64 * 1024;

/** Longest comment text `comment()` writes, in characters; the rest is cut off. */
const SSE_MAX_COMMENT_CHARS = 1024;

/** One event to send. A string is the `data` of an unnamed event. @since 1.0.0 */
export interface SseMessage {
  /** The payload. A string is sent as is; anything else as JSON. Omitted: no data line. */
  readonly data?: unknown;
  /** The event name (the browser's `addEventListener` name). Default: `message`. */
  readonly event?: string;
  /** The event id, sent back as `Last-Event-ID` after a reconnect. */
  readonly id?: string;
  /** Reconnect delay the browser uses, in milliseconds. */
  readonly retry?: number;
}

/**
 * What a stream handler gets: the way to send, the request's `Last-Event-ID`, and the signal that
 * aborts when the client disconnects or the stream is closed.
 * @since 1.0.0
 */
export interface SseStream {
  /**
   * Sends one event. Resolves when the consumer has taken it (backpressure). Rejects with
   * {@link SseOverflowError} when too many events wait for a consumer that does not read; the stream
   * is closed then. A send after the stream closed does nothing.
   */
  send(message: SseMessage | string): Promise<void>;
  /**
   * Writes a comment line (a keep-alive the browser ignores). At most 1 KiB of text, and nothing is written while an
   * earlier chunk still waits for the consumer.
   */
  comment(text?: string): void;
  /** Ends the response. The handler may still run; its sends are ignored. */
  close(): void;
  /** Aborted when the client disconnects, the stream is closed or the stream fails. */
  readonly signal: AbortSignal;
  /** The `Last-Event-ID` the client sent when it reconnected, if any. */
  readonly lastEventId: string | undefined;
  /** True once the stream has closed (by close, disconnect or failure). */
  readonly closed: boolean;
}

/**
 * A stream route's handler: `export function SSE(event, stream) { ... }`. It may return a promise; a
 * failure is reported and ends the stream.
 * @since 1.0.0
 */
export type SseHandler = (event: RequestEvent, stream: SseStream) => void | Promise<void>;

/** Limits of the event stream, from the handler's `streams` options. @internal */
export interface SseOptions {
  /** Milliseconds between heartbeat comments. */
  readonly heartbeatMs: number;
  /** Sends that may wait at once for a consumer. */
  readonly maxBufferedEvents: number;
}

/** A consumer fell so far behind that the stream was closed. @since 1.0.0 */
export class SseOverflowError extends Error {
  readonly code = "SSE_OVERFLOW";

  constructor() {
    super("the event stream was closed: the client did not read the events it was sent.");
    this.name = "SseOverflowError";
  }
}

const encoder = new TextEncoder();
const NEWLINE = /[\r\n]/;

/** A field value that cannot be written on one line: a line break or a NUL. */
function checkedField(name: string, value: string): string {
  if (NEWLINE.test(value) || value.includes("\u0000")) {
    throw new TypeError(`SSE ${name} must not contain a line break or a NUL character.`);
  }
  return value;
}

/**
 * Formats one event as the bytes of the stream: `retry`, `id`, `event`, then one `data` line per line
 * of the payload, then the blank line that ends the event.
 *
 * @param message The event, or a string for an unnamed event with that data.
 * @returns The text to write.
 * @throws TypeError for an id or event name with a line break or NUL, or a payload that is not JSON.
 * @throws RangeError for a `retry` that is not a non-negative integer, or an event over 64 KiB.
 * @example
 * formatSseEvent({ id: "7", event: "tick", data: "a\nb" }); // "id: 7\nevent: tick\ndata: a\ndata: b\n\n"
 * @since 1.0.0
 */
export function formatSseEvent(message: SseMessage | string): string {
  const fields = typeof message === "string" ? { data: message } : message;
  let out = "";
  if (fields.retry !== undefined) {
    if (!Number.isInteger(fields.retry) || fields.retry < 0) {
      throw new RangeError("SSE retry must be a non-negative integer of milliseconds.");
    }
    out += `retry: ${fields.retry}\n`;
  }
  if (fields.id !== undefined) out += `id: ${checkedField("id", fields.id)}\n`;
  if (fields.event !== undefined) out += `event: ${checkedField("event", fields.event)}\n`;
  if (fields.data !== undefined) {
    const payload = typeof fields.data === "string" ? fields.data : JSON.stringify(fields.data);
    if (payload === undefined)
      throw new TypeError("SSE data must be a string or JSON-serializable.");
    for (const line of payload.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  }
  out += "\n";
  if (encoder.encode(out).byteLength > SSE_MAX_EVENT_BYTES) {
    throw new RangeError(`an SSE event may be at most ${SSE_MAX_EVENT_BYTES} bytes.`);
  }
  return out;
}

/** One event kept by an {@link EventLog}. @since 1.0.0 */
export interface LoggedEvent {
  readonly id: string;
  readonly event?: string;
  readonly data: unknown;
}

/** A bounded log of sent events, for replaying what a reconnecting client missed. @since 1.0.0 */
export interface EventLog {
  /** Records an event; returns the id it was given (1, 2, 3, ...). */
  append(message: { readonly event?: string; readonly data: unknown }): string;
  /**
   * The events after `lastEventId`, in order. `undefined` when the id is one the log no longer keeps
   * (so events were lost and the client must resync) or is not an id the log has given.
   */
  since(lastEventId: string | undefined): readonly LoggedEvent[] | undefined;
  /** How many events the log holds (never more than its capacity). */
  readonly size: number;
}

/**
 * Creates a bounded event log. Use it in a stream handler to keep the last events and replay them to a
 * client that reconnects with `Last-Event-ID`: `log.since(stream.lastEventId)`.
 *
 * @param options The capacity (events kept). Default 1000.
 * @returns A log.
 * @throws RangeError when the capacity is not a positive integer.
 * @example
 * const log = createEventLog({ capacity: 500 });
 * export function SSE(event, stream) {
 *   for (const missed of log.since(stream.lastEventId) ?? []) void stream.send({ id: missed.id, data: missed.data });
 * }
 * @since 1.0.0
 */
export function createEventLog(options: { readonly capacity?: number } = {}): EventLog {
  const capacity = options.capacity ?? 1000;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError("createEventLog: capacity must be a positive integer.");
  }
  let next = 1;
  const kept: { readonly n: number; readonly entry: LoggedEvent }[] = [];
  return {
    append(message) {
      const n = next;
      next += 1;
      const entry: LoggedEvent =
        message.event === undefined
          ? { id: String(n), data: message.data }
          : { id: String(n), event: message.event, data: message.data };
      kept.push({ n, entry });
      if (kept.length > capacity) kept.shift();
      return entry.id;
    },
    since(lastEventId) {
      if (lastEventId === undefined) return [];
      if (!/^\d+$/.test(lastEventId)) return undefined;
      const after = Number(lastEventId);
      if (!Number.isSafeInteger(after) || after >= next) return undefined;
      const oldest = kept[0]?.n ?? next;
      if (after + 1 < oldest) return undefined;
      return kept.filter((item) => item.n > after).map((item) => item.entry);
    },
    get size() {
      return kept.length;
    },
  };
}

/**
 * Builds the streamed response of a stream route: the headers, the body the handler writes to, the
 * heartbeat, the abort on disconnect and the bounded buffer. The handler starts after the response
 * exists; its failure is reported and ends the body.
 *
 * @internal
 */
export function sseResponse(
  event: RequestEvent,
  handler: SseHandler,
  options: SseOptions,
  report: (error: unknown) => void,
): Response {
  const lastEventId = event.request.headers.get("last-event-id") ?? undefined;
  const abort = new AbortController();
  const waiters: (() => void)[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const wakeWaiters = (): void => {
    for (const wake of waiters.splice(0)) wake();
  };
  /** Marks the stream closed and releases what it holds. Does not touch the body stream. */
  const teardown = (): void => {
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    event.signal.removeEventListener("abort", onAbort);
    wakeWaiters();
    abort.abort();
  };
  const onAbort = (): void => {
    if (closed) return;
    teardown();
    controller?.close();
  };
  /** Ends the stream from the server side: the body is closed after the queued events. */
  const finish = (): void => {
    if (closed) return;
    teardown();
    controller?.close();
  };
  /**
   * Queues text for the consumer. A `droppable` write (a comment, a heartbeat) is skipped while a chunk already waits to be
   * read: they carry nothing, and a consumer that never reads would otherwise make them pile up for as long as it stays
   * connected. Events are not droppable; `send` bounds them with `maxBufferedEvents`.
   */
  const write = (text: string, droppable = false): void => {
    if (closed || controller === undefined) return;
    if (droppable && controller.desiredSize !== null && controller.desiredSize <= 0) return;
    controller.enqueue(encoder.encode(text));
  };

  const stream: SseStream = {
    async send(message) {
      if (closed) return;
      write(formatSseEvent(message));
      if (closed || controller === undefined) return;
      // The chunk is queued: wait until the consumer has taken it, so a slow reader slows the handler.
      if (controller.desiredSize !== null && controller.desiredSize > 0) return;
      if (waiters.length >= options.maxBufferedEvents) {
        const overflow = new SseOverflowError();
        finish();
        throw overflow;
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    comment(text = "") {
      // At most 1 KiB: a comment is a keep-alive, not a channel (a large text would be an unbounded write).
      write(`:${text.slice(0, SSE_MAX_COMMENT_CHARS).replace(/[\r\n]/g, " ")}\n\n`, true);
    },
    close: finish,
    signal: abort.signal,
    lastEventId,
    get closed() {
      return closed;
    },
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(created) {
        controller = created;
        heartbeat = setInterval(() => write(": ping\n\n", true), options.heartbeatMs);
        event.signal.addEventListener("abort", onAbort, { once: true });
        if (event.signal.aborted) finish();
      },
      pull() {
        wakeWaiters();
      },
      cancel() {
        // The consumer went away: the body is already closed on its side, so only the server side ends.
        if (!closed) teardown();
      },
    },
    { highWaterMark: 1 },
  );

  // The handler runs after the response is returned: nothing it does can delay the head.
  queueMicrotask(() => {
    if (closed) return;
    Promise.resolve()
      .then(() => handler(event, stream))
      .catch((error: unknown) => {
        // A client that went away is not a fault; anything else the handler threw is reported.
        if (!event.signal.aborted) report(error);
        finish();
      });
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
