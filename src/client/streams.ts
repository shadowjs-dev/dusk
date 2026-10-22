import type { Accessor } from "@shadow-js/core";
import { onCleanup, useSignal } from "@shadow-js/core";

/**
 * Browser clients of the stream routes: `createSseClient` and `createWebSocketClient` are plain objects
 * (no reactivity) with reconnection and exponential backoff; `useSSE` and `useWebSocket` wrap them in
 * signals and close them when the owning component is disposed. The SSE client reads the stream with
 * `fetch`, so it sends `Last-Event-ID` on a reconnect and can carry headers, and it runs in any runtime
 * with `fetch` (Node included).
 */

/** Where a stream is. @since 1.0.0 */
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Reconnection policy: the delay doubles from `minDelayMs` up to `maxDelayMs`; the server's `retry`
 * field (SSE) replaces the first delay. `maxAttempts` bounds the attempts in a row (default: no bound).
 * @since 1.0.0
 */
export interface ReconnectOptions {
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

/** One event of an SSE stream, as the client hands it over. @since 1.0.0 */
export interface SseEvent<T> {
  /** The event name (`message` when the server named none). */
  readonly event: string;
  /** The payload, parsed by the client's `parse`. */
  readonly data: T;
  /** The event id, when the server sent one. */
  readonly id: string | undefined;
}

/** Options of {@link createSseClient}. @since 1.0.0 */
export interface SseClientOptions<T> {
  /** The stream URL (relative URLs resolve against the page). */
  readonly url: string;
  /** Turns the data text into a value. Default: JSON, or the text when it is not JSON. */
  readonly parse?: (raw: string) => T;
  /** Receives each event. */
  readonly onEvent: (event: SseEvent<T>) => void;
  /** Receives each change of status. */
  readonly onStatus?: (status: StreamStatus) => void;
  /** Headers of every request (for example an authorization header). */
  readonly headers?: HeadersInit;
  /** Reconnection policy. */
  readonly reconnect?: ReconnectOptions;
  /** The `fetch` to use. Default: the global one. */
  readonly fetch?: typeof fetch;
  /**
   * Receives a failure of the client's own code (a `parse` or `onEvent` that threw) or an unexpected
   * one. A network drop is not an error: it is retried. Default: `console.error`.
   */
  readonly onError?: (error: unknown) => void;
}

/** A running SSE client. @since 1.0.0 */
export interface SseClient {
  /** Closes the stream and stops reconnecting. Safe to call twice. */
  close(): void;
  /** The current status. */
  readonly status: StreamStatus;
}

const DEFAULT_MIN_DELAY = 500;
const DEFAULT_MAX_DELAY = 30_000;

/** The delay before attempt `attempt` (0-based) of a reconnection. */
function delayFor(
  attempt: number,
  options: ReconnectOptions,
  serverRetry: number | undefined,
): number {
  const min = options.minDelayMs ?? DEFAULT_MIN_DELAY;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY;
  if (serverRetry !== undefined && attempt === 0) return Math.min(serverRetry, max);
  return Math.min(max, min * 2 ** Math.min(attempt, 30));
}

function defaultParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Parses the text of an event stream, call by call, and reports each complete event. @internal */
export function createSseParser(
  onEvent: (event: { event: string; data: string; id?: string }) => void,
  onRetry: (ms: number) => void,
): (chunk: string) => void {
  let buffer = "";
  let data: string[] = [];
  let name: string | undefined;
  let id: string | undefined;
  let hasData = false;
  const dispatch = (): void => {
    if (hasData) {
      const payload = data.join("\n");
      onEvent(
        id === undefined
          ? { event: name ?? "message", data: payload }
          : { event: name ?? "message", data: payload, id },
      );
    }
    data = [];
    name = undefined;
    hasData = false;
  };
  const field = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const key = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (key === "data") {
      data.push(value);
      hasData = true;
    } else if (key === "event") name = value;
    else if (key === "id") {
      if (!value.includes("\u0000")) id = value;
    } else if (key === "retry") {
      if (/^\d+$/.test(value)) onRetry(Number(value));
    }
  };
  return (chunk) => {
    buffer += chunk;
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character !== "\n" && character !== "\r") continue;
      // A CR at the very end may be the first half of CRLF: wait for the next chunk to decide.
      if (character === "\r" && index === buffer.length - 1) break;
      const line = buffer.slice(start, index);
      if (character === "\r" && buffer[index + 1] === "\n") index += 1;
      start = index + 1;
      field(line);
    }
    buffer = buffer.slice(start);
  };
}

/**
 * Opens an SSE stream and keeps it open: on a drop it waits (backoff, or the server's `retry`) and
 * reconnects with the last event id. Events arrive in order. A 4xx answer stops it (the server refused
 * the stream, retrying would not help); a 5xx or a network error is retried.
 *
 * @param options The URL, the handler and the policy.
 * @returns The client.
 * @example
 * const feed = createSseClient({ url: "/feed", onEvent: (event) => console.log(event.data) });
 * feed.close();
 * @since 1.0.0
 */
export function createSseClient<T = unknown>(options: SseClientOptions<T>): SseClient {
  const send = options.fetch ?? globalThis.fetch;
  const report = options.onError ?? defaultReport;
  const parse = options.parse ?? ((raw: string) => defaultParse(raw) as T);
  const reconnect = options.reconnect ?? {};
  let status: StreamStatus = "connecting";
  let closed = false;
  let lastId: string | undefined;
  let controller: AbortController | undefined;
  let wake: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: StreamStatus): void => {
    status = next;
    options.onStatus?.(next);
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    let serverRetry: number | undefined;
    while (!closed) {
      controller = new AbortController();
      const headers = new Headers(options.headers);
      headers.set("accept", "text/event-stream");
      if (lastId !== undefined) headers.set("last-event-id", lastId);
      let refused = false;
      try {
        setStatus("connecting");
        const response = await send(options.url, {
          headers,
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (response.status >= 400 && response.status < 500) refused = true;
        if (response.ok && response.body !== null) {
          setStatus("open");
          attempt = 0;
          const feed = createSseParser(
            (event) => {
              if (event.id !== undefined) lastId = event.id;
              try {
                options.onEvent({ event: event.event, data: parse(event.data), id: event.id });
              } catch (error) {
                report(error);
              }
            },
            (ms) => {
              serverRetry = ms;
            },
          );
          const decoder = new TextDecoder();
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            feed(decoder.decode(value, { stream: true }));
          }
        } else {
          refused = refused || !response.ok;
        }
      } catch (error) {
        // close() aborts the request: that is the end, not a failure.
        if (closed) return;
        // A network failure (a TypeError from fetch) is retried; anything else is reported and retried too.
        if (!(error instanceof TypeError)) report(error);
      }
      if (closed || refused) break;
      attempt += 1;
      if (reconnect.maxAttempts !== undefined && attempt > reconnect.maxAttempts) break;
      setStatus("reconnecting");
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, delayFor(attempt - 1, reconnect, serverRetry));
      });
      wake = undefined;
    }
    if (!closed) {
      closed = true;
    }
    setStatus("closed");
  };

  void run();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
      controller?.abort();
      setStatus("closed");
    },
    get status(): StreamStatus {
      return status;
    },
  };
}

/** Options of {@link createWebSocketClient}. @since 1.0.0 */
export interface WebSocketClientOptions<T> {
  /** The socket URL (`ws://`, `wss://`, or a path resolved against the page). */
  readonly url: string;
  /** Turns a text message into a value. Default: JSON, or the text when it is not JSON. Binary is passed as is. */
  readonly parse?: (raw: string) => T;
  /** Receives each message. */
  readonly onMessage: (data: T | ArrayBuffer) => void;
  /** Receives each change of status. */
  readonly onStatus?: (status: StreamStatus) => void;
  /** Subprotocols to offer. */
  readonly protocols?: string | readonly string[];
  /** Reconnection policy. */
  readonly reconnect?: ReconnectOptions;
  /** The socket constructor. Default: the global `WebSocket`. */
  readonly WebSocket?: typeof WebSocket;
  /** Receives a failure of the client's own code (a `parse` or `onMessage` that threw). Default: `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/** A running WebSocket client. @since 1.0.0 */
export interface WebSocketClient {
  /** Sends a message. Returns false, and sends nothing, when the socket is not open. */
  send(data: string | BufferSource): boolean;
  /** Closes the socket (code 1000 by default) and stops reconnecting. */
  close(code?: number, reason?: string): void;
  /** The current status. */
  readonly status: StreamStatus;
}

/**
 * Opens a WebSocket and keeps it open: a drop is retried with backoff. A close the client asked for
 * (`close()`) is final. Messages arrive in order; a text message is parsed with `parse`.
 *
 * @param options The URL, the handler and the policy.
 * @returns The client.
 * @example
 * const chat = createWebSocketClient({ url: "/chat", onMessage: (data) => console.log(data) });
 * chat.send("hello");
 * @since 1.0.0
 */
export function createWebSocketClient<T = unknown>(
  options: WebSocketClientOptions<T>,
): WebSocketClient {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const parse = options.parse ?? ((raw: string) => defaultParse(raw) as T);
  const reconnect = options.reconnect ?? {};
  const target = options.url.startsWith("/") ? toWebSocketUrl(options.url) : options.url;
  let status: StreamStatus = "connecting";
  let closed = false;
  let socket: WebSocket | undefined;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: StreamStatus): void => {
    status = next;
    options.onStatus?.(next);
  };

  const report = options.onError ?? defaultReport;
  const protocols =
    typeof options.protocols === "string" || options.protocols === undefined
      ? options.protocols
      : [...options.protocols];

  const connect = (): void => {
    if (closed) return;
    setStatus("connecting");
    let current: WebSocket;
    try {
      current = new Socket(target, protocols);
    } catch (error) {
      // An invalid URL does not heal by retrying: the client stops.
      report(error);
      closed = true;
      setStatus("closed");
      return;
    }
    socket = current;
    current.binaryType = "arraybuffer";
    current.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    current.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      try {
        if (typeof data === "string") options.onMessage(parse(data));
        else if (data instanceof ArrayBuffer) options.onMessage(data);
      } catch (error) {
        report(error);
      }
    };
    current.onclose = () => {
      if (closed) return;
      attempt += 1;
      if (reconnect.maxAttempts !== undefined && attempt > reconnect.maxAttempts) {
        closed = true;
        setStatus("closed");
        return;
      }
      setStatus("reconnecting");
      timer = setTimeout(connect, delayFor(attempt - 1, reconnect, undefined));
    };
  };

  connect();

  return {
    send(data: string | BufferSource): boolean {
      if (closed || socket === undefined || socket.readyState !== Socket.OPEN) return false;
      socket.send(data);
      return true;
    },
    close(code = 1000, reason = ""): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close(code, reason);
      setStatus("closed");
    },
    get status(): StreamStatus {
      return status;
    },
  };
}

/** The default for a failure nobody handles: a console line, never a silent drop. */
function defaultReport(error: unknown): void {
  console.error("[dusk] stream client", error);
}

/** A path made into an absolute `ws:` / `wss:` URL for the page's origin. */
function toWebSocketUrl(path: string): string {
  const location: unknown = Reflect.get(globalThis, "location");
  const href =
    typeof location === "object" && location !== null ? Reflect.get(location, "href") : undefined;
  const base = typeof href === "string" && URL.canParse(href) ? href : "http://localhost/";
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** The reactive view of a stream: what it last received, its status, and how to close it. @since 1.0.0 */
export interface StreamHandle<T> {
  /** The last data received, if any. */
  readonly data: Accessor<T | undefined>;
  /** The status. */
  readonly status: Accessor<StreamStatus>;
  /** Closes the stream. Also done when the owning component is disposed. */
  close(): void;
}

/** Options of {@link useSSE}. @since 1.0.0 */
export type UseSseOptions<T> = Omit<SseClientOptions<T>, "url" | "onEvent" | "onStatus">;

/**
 * Subscribes to a server-sent events route from a component: `data` holds the last event's data and
 * `status` the connection's state. The stream closes when the component is disposed.
 *
 * @param url The stream URL.
 * @param options Parse, headers, reconnection and fetch.
 * @returns The reactive handle.
 * @example
 * const prices = useSSE<Price>("/prices");
 * return <p>{prices.data()?.value}</p>;
 * @since 1.0.0
 */
export function useSSE<T = unknown>(url: string, options: UseSseOptions<T> = {}): StreamHandle<T> {
  const [data, setData] = useSignal<T | undefined>(undefined);
  const [status, setStatus] = useSignal<StreamStatus>("connecting");
  const client = createSseClient<T>({
    ...options,
    url,
    onEvent: (event) => setData(() => event.data),
    onStatus: (next) => setStatus(() => next),
  });
  onCleanup(() => client.close());
  return {
    data,
    status,
    close: () => client.close(),
  };
}

/** Options of {@link useWebSocket}. @since 1.0.0 */
export type UseWebSocketOptions<T> = Omit<
  WebSocketClientOptions<T>,
  "url" | "onMessage" | "onStatus"
>;

/** The reactive view of a WebSocket: the last message, the status, and `send`. @since 1.0.0 */
export interface WebSocketHandle<T> extends StreamHandle<T | ArrayBuffer> {
  /** Sends a message. False when the socket is not open. */
  send(data: string | BufferSource): boolean;
}

/**
 * Connects a WebSocket route from a component: `data` holds the last message, `status` the connection's
 * state, and `send` writes to it. The socket closes when the component is disposed.
 *
 * @param url The socket URL, or a path on this origin.
 * @param options Parse, subprotocols, reconnection and the socket constructor.
 * @returns The reactive handle.
 * @example
 * const chat = useWebSocket<ChatMessage>("/chat");
 * chat.send(JSON.stringify({ text: "hi" }));
 * @since 1.0.0
 */
export function useWebSocket<T = unknown>(
  url: string,
  options: UseWebSocketOptions<T> = {},
): WebSocketHandle<T> {
  const [data, setData] = useSignal<T | ArrayBuffer | undefined>(undefined);
  const [status, setStatus] = useSignal<StreamStatus>("connecting");
  const client = createWebSocketClient<T>({
    ...options,
    url,
    onMessage: (message) => setData(() => message),
    onStatus: (next) => setStatus(() => next),
  });
  onCleanup(() => client.close());
  return {
    data,
    status,
    send: (payload) => client.send(payload),
    close: () => client.close(),
  };
}
