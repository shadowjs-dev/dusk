import { HttpError } from "../internal/http-error";
import type { RequestEvent } from "./types";
import {
  CLOSE,
  closePayload,
  encodeFrame,
  FrameReader,
  WebSocketProtocolError,
} from "./ws-protocol";

/**
 * WebSocket routes: the handlers a route module exports as `WS`, and the connection they run on. The
 * runtime-agnostic part lives here: a connection takes bytes in and writes bytes out through a
 * {@link WebSocketSink}, so any runtime that can read and write a socket (Node, Bun, Deno, a Worker's
 * accepted socket) serves the same route. The Node adapter is in `node/websocket.ts`.
 */

/** The handlers of a WebSocket route. @since 1.0.0 */
export interface WebSocketHandlers {
  /**
   * Runs before the handshake answers. Return a `Response` to refuse the connection (a 401 for a missing
   * session, say); return nothing to accept it. The event carries the request's cookies, so a session
   * is read here. Anything it stores on `event` is not kept: copy what the connection needs into
   * `ws.data` in `open`.
   */
  upgrade?(event: RequestEvent): Response | undefined | void | Promise<Response | undefined | void>;
  /** Runs once the connection is open. Failure closes it with 1011. */
  open?(ws: WebSocketConnection, event: RequestEvent): void | Promise<void>;
  /** Runs for each message: text as a string, binary as bytes. Failure closes the connection with 1011. */
  message?(
    ws: WebSocketConnection,
    message: string | Uint8Array,
    event: RequestEvent,
  ): void | Promise<void>;
  /** Runs once when the connection closes, with the close code and reason. */
  close?(
    ws: WebSocketConnection,
    code: number,
    reason: string,
    event: RequestEvent,
  ): void | Promise<void>;
  /** Runs for a protocol violation or a failed handler, before the connection closes. */
  error?(ws: WebSocketConnection, error: unknown, event: RequestEvent): void | Promise<void>;
}

/**
 * The stream module a route file exports `WS` from: the handlers, as `export const WS = { ... }`.
 * @since 1.0.0
 */
export interface WebSocketModule {
  readonly WS?: WebSocketHandlers;
}

/**
 * One open connection, as the handlers see it.
 * @since 1.0.0
 */
export interface WebSocketConnection {
  /** A bag for this connection's state, filled in `open`. Not shared between connections. */
  readonly data: Record<string, unknown>;
  /** Aborted when the connection closes. */
  readonly signal: AbortSignal;
  /** `open` until the connection starts closing, then `closed`. */
  readonly readyState: "open" | "closed";
  /**
   * Sends a message: a string as text, bytes as binary. Returns false, and sends nothing, once the
   * connection is closed.
   */
  send(message: string | Uint8Array): boolean;
  /** Closes the connection with a code (default 1000) and a reason of at most 123 bytes. */
  close(code?: number, reason?: string): void;
}

/** Limits of a connection. @since 1.0.0 */
export interface WebSocketLimits {
  /** Largest message a client may send, in bytes. Larger closes with 1009. */
  readonly maxMessageBytes: number;
  /** Messages a client may send in one second. More closes with 1008. */
  readonly maxMessagesPerSecond: number;
  /** Milliseconds between the server's pings. */
  readonly pingIntervalMs: number;
  /** Milliseconds a ping may wait for its pong before the connection is dropped. */
  readonly pongTimeoutMs: number;
  /**
   * Message handler calls that may be in flight at once (a call that returned a promise not yet settled).
   * The next message closes the connection with 1013 and is not handled. Default 16.
   */
  readonly maxInFlightMessages?: number;
  /**
   * Unsent bytes a transport may hold for a connection before it is dropped (see {@link WebSocketSink.buffered}).
   * Default 8 times `maxMessageBytes`.
   */
  readonly maxBufferedBytes?: number;
}

/** Where the connection writes its frames: the transport of the runtime. @since 1.0.0 */
export interface WebSocketSink {
  /** Writes bytes (frames) to the peer, in order. */
  write(bytes: Uint8Array): void;
  /** Ends the transport. Called once, after the last frame. */
  end(): void;
  /**
   * Bytes written and not yet taken by the peer (Node: `socket.writableLength`). When the transport reports it, a
   * connection whose unsent bytes pass `maxBufferedBytes` is dropped instead of buffered without bound.
   */
  buffered?(): number;
  /** Drops the transport at once, without flushing what is unsent (Node: `socket.destroy()`). */
  destroy?(): void;
}

/** What the transport feeds to a connection. @since 1.0.0 */
export interface WebSocketInput {
  /** Bytes read from the peer. */
  push(bytes: Uint8Array): void;
  /** The transport closed (without a close frame, or after one). Safe to call more than once. */
  closed(): void;
}

/**
 * A runtime that exposes complete WebSocket messages and owns their framing.
 * A ping method opts into Dusk's heartbeat; otherwise the runtime owns heartbeat control frames.
 * @since 1.0.0
 */
export interface MessageWebSocketSink {
  /** Sends a message; false means the transport could not send it. */
  send(message: string | Uint8Array): boolean;
  /** Writes the closing handshake. */
  close(code: number, reason: string): void;
  /** Ends the connection; safe after a closing handshake. */
  end(): void;
  /** Bytes queued by the runtime. */
  buffered?(): number;
  /** Drops the transport immediately. */
  destroy?(): void;
  /** Sends a native ping, when the runtime exposes that operation. */
  ping?(): void;
}

/**
 * Message events supplied by a native WebSocket runtime. Control events are supplied only when
 * the runtime exposes them; they must never be synthesized.
 * @since 1.0.0
 */
export interface MessageWebSocketInput {
  /** Delivers one decoded text or binary message. */
  message(message: string | Uint8Array): void;
  /** Records a native ping (the runtime already sends its pong). */
  ping(): void;
  /** Records a native pong. */
  pong(): void;
  /** Ends the session with the transport's actual close code and reason. */
  closed(code?: number, reason?: string): void;
  /** Closes for server shutdown with code 1001. */
  shutdown(): void;
}

/** Everything a connection needs. @internal */
export interface StartConnectionOptions {
  readonly handlers: WebSocketHandlers;
  readonly event: RequestEvent;
  readonly limits: WebSocketLimits;
  readonly data: Record<string, unknown>;
  readonly sink: WebSocketSink;
  readonly report: (error: unknown) => void;
  /** Called once when the connection ends, whoever ended it (the peer, a handler, a limit, the transport). */
  readonly onFinish?: () => void;
}

/** Bytes of a close reason: a control frame carries 125, and the code takes 2. */
const REASON_LIMIT = 123;

/** The reason cut to {@link REASON_LIMIT} UTF-8 bytes, at a character boundary. */
function reasonWithin(reason: string): string {
  if (reason.length * 3 <= REASON_LIMIT) return reason;
  let kept = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const character of reason) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > REASON_LIMIT) break;
    kept += character;
    bytes += size;
  }
  return kept;
}
/** In-flight `message` calls when the limits name no bound. */
const DEFAULT_MAX_IN_FLIGHT_MESSAGES = 16;

/**
 * Starts a connection on a sink: calls `open`, and returns the input the transport feeds. Frames are
 * decoded by {@link FrameReader}; a protocol violation, a rate-limit excess, a failed handler or a silent
 * peer closes the connection with the code the protocol prescribes.
 *
 * @param options The handlers, limits, the transport sink and the error sink.
 * @returns The input of the connection.
 * @internal
 */
export const startWebSocket: (options: StartConnectionOptions) => WebSocketInput = startConnection;

/** Starts the same bounded session on a runtime's message transport. @internal */
export function startConnection(
  options: Omit<StartConnectionOptions, "sink"> & {
    readonly sink: WebSocketSink | MessageWebSocketSink;
  },
): WebSocketInput & MessageWebSocketInput {
  const { handlers, event, limits, sink, report } = options;
  const raw = "write" in sink ? sink : undefined;
  const native = "write" in sink ? undefined : sink;
  const encoder = new TextEncoder();
  const reader =
    raw === undefined
      ? undefined
      : new FrameReader({ maxMessageBytes: limits.maxMessageBytes, requireMask: true });
  const abort = new AbortController();
  let state: "open" | "closed" = "open";
  let closeCode: number | undefined;
  let closeReason = "";
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let pings: ReturnType<typeof setInterval> | undefined;
  let windowStart = 0;
  let windowCount = 0;
  let inFlight = 0;
  const maxInFlight = limits.maxInFlightMessages ?? DEFAULT_MAX_IN_FLIGHT_MESSAGES;
  const maxBuffered = limits.maxBufferedBytes ?? limits.maxMessageBytes * 8;
  const clearPong = (): void => {
    clearTimeout(pongTimer);
    pongTimer = undefined;
  };

  const connection: WebSocketConnection = {
    data: options.data,
    signal: abort.signal,
    get readyState() {
      return state;
    },
    send(message) {
      if (state !== "open") return false;
      const payload = typeof message === "string" ? encoder.encode(message) : message;
      const frame =
        raw === undefined
          ? payload
          : encodeFrame(typeof message === "string" ? "text" : "binary", payload);
      // A peer that stopped reading makes every frame wait in memory: past the bound it is dropped, not served.
      if (sink.buffered !== undefined && sink.buffered() + frame.byteLength > maxBuffered) {
        finish(CLOSE.TRY_AGAIN_LATER, "slow consumer");
        sink.destroy?.();
        notifyClose();
        return false;
      }
      if (raw !== undefined) raw.write(frame);
      else if (native?.send(message) === false) {
        finish(CLOSE.ABNORMAL, "");
        notifyClose();
        return false;
      }
      return true;
    },
    close(code = CLOSE.NORMAL, reason = "") {
      startClose(code, reasonWithin(reason));
    },
  };

  /** Stops everything and ends the transport. Idempotent. */
  const finish = (code: number, reason: string): void => {
    if (state === "closed") return;
    state = "closed";
    closeCode = code;
    closeReason = reason;
    if (pings !== undefined) clearInterval(pings);
    clearPong();
    event.signal.removeEventListener("abort", onAbort);
    abort.abort();
    try {
      sink.end();
    } finally {
      options.onFinish?.();
    }
  };

  /** Sends a close frame, then ends. The peer's close frame, if any, is ignored after this. */
  const startClose = (code: number, reason: string): void => {
    if (state === "closed") return;
    try {
      if (raw !== undefined) raw.write(encodeFrame("close", closePayload(code, reason)));
      else native?.close(code, reason);
    } finally {
      try {
        finish(code, reason);
      } finally {
        notifyClose();
      }
    }
  };

  let notified = false;
  const notifyClose = (): void => {
    const code = closeCode;
    if (notified || code === undefined) return;
    notified = true;
    runHandler(() => handlers.close?.(connection, code, closeReason, event));
  };

  const notifyError = (error: unknown): void => {
    try {
      const outcome = untrack(() => handlers.error?.(connection, error, event));
      if (outcome instanceof Promise) outcome.catch(report);
    } catch (handlerError) {
      report(handlerError);
    }
  };

  /** Runs a user callback. A failure is reported, then the connection closes with 1011. */
  const runHandler = (callback: () => void | Promise<void> | undefined): void => {
    const fail = (error: unknown): void => {
      report(error);
      if (state === "closed") return;
      notifyError(error);
      startClose(CLOSE.INTERNAL, "");
    };
    try {
      const outcome = untrack(callback);
      if (outcome instanceof Promise) outcome.catch(fail);
    } catch (error) {
      fail(error);
    }
  };

  /** A protocol violation: the error handler hears of it, then the connection closes with the code. */
  const protocolFailure = (error: unknown): void => {
    const code = error instanceof WebSocketProtocolError ? error.code : CLOSE.PROTOCOL_ERROR;
    notifyError(error);
    startClose(code, "");
  };

  /**
   * Hands a message to the route. A call that returns a promise counts as in flight until it settles; with
   * `maxInFlight` calls pending the connection is closed with 1013 instead of starting another (the rate limit
   * bounds how fast messages arrive, this bounds how much work they leave running).
   */
  const deliver = (message: string | Uint8Array): void => {
    if (inFlight >= maxInFlight) {
      startClose(CLOSE.TRY_AGAIN_LATER, "too many messages in flight");
      return;
    }
    runHandler(() => {
      const outcome = handlers.message?.(connection, message, event);
      if (!(outcome instanceof Promise)) return outcome;
      inFlight += 1;
      return outcome.finally(() => {
        inFlight -= 1;
      });
    });
  };

  const pingTick = (): void => {
    if (state !== "open" || pongTimer !== undefined) return;
    if (raw !== undefined) raw.write(encodeFrame("ping", new Uint8Array(0)));
    else native?.ping?.();
    if (state !== "open") return;
    pongTimer = setTimeout(() => {
      finish(CLOSE.ABNORMAL, "");
      notifyClose();
    }, limits.pongTimeoutMs);
  };

  /** The rate limit: a fixed window of one second. */
  const admit = (): boolean => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount <= limits.maxMessagesPerSecond) return true;
    startClose(CLOSE.POLICY, "rate limit exceeded");
    return false;
  };

  if (raw !== undefined || native?.ping !== undefined)
    pings = setInterval(pingTick, limits.pingIntervalMs);
  const onAbort = (): void => {
    finish(CLOSE.ABNORMAL, "");
    notifyClose();
  };
  event.signal.addEventListener("abort", onAbort, { once: true });

  if (event.signal.aborted) onAbort();
  else runHandler(() => handlers.open?.(connection, event));

  return {
    message(message) {
      if (state !== "open") return;
      const size =
        typeof message === "string" ? encoder.encode(message).byteLength : message.byteLength;
      if (size > limits.maxMessageBytes) {
        protocolFailure(new WebSocketProtocolError(CLOSE.TOO_BIG, "message too large"));
        return;
      }
      if (admit()) deliver(message);
    },
    ping() {
      if (state === "open") admit();
    },
    pong() {
      if (state !== "open") return;
      if (!admit()) return;
      clearPong();
    },
    shutdown() {
      startClose(CLOSE.GOING_AWAY, "server shutdown");
    },
    push(bytes) {
      if (state !== "open") return;
      if (reader === undefined) throw new TypeError("Raw transport required.");
      let events: ReturnType<FrameReader["push"]>;
      try {
        events = reader.push(bytes);
      } catch (error) {
        protocolFailure(error);
        return;
      }
      for (const frame of events) {
        if (state !== "open") return;
        // Control frames count against the same rate as messages: a pong is written for every ping, so an
        // unlimited ping stream costs the server a write each, forever.
        if (frame.kind === "close") {
          // The peer asked to close: echo its code, end, and tell the handler how it closed.
          const echo = frame.code === CLOSE.NO_STATUS ? CLOSE.NORMAL : frame.code;
          raw?.write(encodeFrame("close", closePayload(echo, "")));
          finish(frame.code, frame.reason);
          notifyClose();
          return;
        }
        if (!admit()) return;
        if (frame.kind === "ping") raw?.write(encodeFrame("pong", frame.data));
        else if (frame.kind === "pong") {
          clearPong();
        } else {
          const message = frame.kind === "text" ? new TextDecoder().decode(frame.data) : frame.data;
          deliver(message);
        }
      }
    },
    closed(code: number = CLOSE.ABNORMAL, reason: string = "") {
      if (state === "closed") return;
      finish(code, reason);
      notifyClose();
    },
  };
}

/** Starts the same bounded session on a runtime's message transport. @internal */
export const startMessageWebSocket: (
  options: Omit<StartConnectionOptions, "sink"> & { readonly sink: MessageWebSocketSink },
) => MessageWebSocketInput = startConnection;

/** Result of checking an upgrade request before its handlers run. @internal */
export interface HandshakeCheck {
  /** The client key, valid base64 of 16 bytes. */
  readonly key: string;
}

/**
 * Checks the handshake headers of a WebSocket upgrade (RFC 6455 section 4.2.1). A request that is not a
 * valid upgrade is a 400; a wrong version is a 426 that names the version the server speaks.
 *
 * @internal
 */
export function checkHandshake(headers: Headers): HandshakeCheck {
  const upgrade = headers.get("upgrade") ?? "";
  if (upgrade.toLowerCase() !== "websocket") {
    throw new HttpError(400, "Bad Request: an Upgrade: websocket header is required");
  }
  if (
    !(headers.get("connection") ?? "")
      .split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade")
  ) {
    throw new HttpError(400, "Bad Request: Connection: Upgrade is required");
  }
  const key = headers.get("sec-websocket-key") ?? "";
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    throw new HttpError(400, "Bad Request: Sec-WebSocket-Key must be a base64 value of 16 bytes");
  }
  if (headers.get("sec-websocket-version") !== "13") {
    throw new HttpError(426, "Upgrade Required", {
      headers: { "sec-websocket-version": "13", upgrade: "websocket" },
    });
  }
  return { key };
}

import { untrack } from "@shadow-js/core";
