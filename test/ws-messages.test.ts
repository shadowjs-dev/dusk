import { createRoot, flushSync, useEffect, useSignal } from "@shadow-js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "../src/server/types";
import {
  type MessageWebSocketSink,
  startMessageWebSocket,
  type WebSocketConnection,
  type WebSocketHandlers,
} from "../src/server/websocket";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function session(
  handlers: WebSocketHandlers = {},
  options: {
    maxMessageBytes?: number;
    maxMessagesPerSecond?: number;
    maxInFlightMessages?: number;
    maxBufferedBytes?: number;
    buffered?: number;
    ping?: boolean;
    aborted?: boolean;
    pongTimeoutMs?: number;
  } = {},
) {
  const abort = new AbortController();
  if (options.aborted === true) abort.abort();
  const sent: (string | Uint8Array)[] = [];
  const closes: { code: number; reason: string }[] = [];
  const end = vi.fn();
  const finish = vi.fn();
  const report = vi.fn();
  const ping = vi.fn();
  const sink: MessageWebSocketSink = {
    send(message) {
      sent.push(message);
      return true;
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
    end,
    buffered: () => options.buffered ?? 0,
    ...(options.ping === true ? { ping } : {}),
  };
  const input = startMessageWebSocket({
    handlers,
    sink,
    event: { signal: abort.signal } as unknown as RequestEvent,
    data: {},
    report,
    onFinish: finish,
    limits: {
      maxMessageBytes: options.maxMessageBytes ?? 8,
      maxMessagesPerSecond: options.maxMessagesPerSecond ?? 5,
      maxInFlightMessages: options.maxInFlightMessages ?? 2,
      maxBufferedBytes: options.maxBufferedBytes ?? 64,
      pingIntervalMs: 1000,
      pongTimeoutMs: options.pongTimeoutMs ?? 500,
    },
  });
  return { input, abort, sent, closes, end, finish, report, ping, sink };
}

describe("message-based WebSocket transports", () => {
  it("[WS-MSG-15] a pong deadline longer than the ping interval still leaves only one pending ping", () => {
    const run = session({}, { ping: true, pongTimeoutMs: 3000 });
    vi.advanceTimersByTime(2000);
    expect(run.ping).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(run.finish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("[WS-MSG-13] a transport closing during ping cannot leave a pong deadline behind", () => {
    const run = session({}, { ping: true });
    run.ping.mockImplementation(() => run.input.closed());
    vi.advanceTimersByTime(1000);
    expect(run.finish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("[WS-MSG-14] a failed closing write still releases the session and cancels its timers", () => {
    const close = vi.fn();
    const run = session({ close }, { ping: true });
    const error = new Error("closing write failed");
    run.sink.close = () => {
      throw error;
    };
    expect(() => run.input.shutdown()).toThrow(error);
    expect(run.finish).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("[WS-MSG-12] a request already aborted cannot invoke open or leave a heartbeat timer", () => {
    const open = vi.fn();
    const run = session({ open }, { aborted: true, ping: true });
    expect(open).not.toHaveBeenCalled();
    expect(run.finish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("[WS-MSG-11] route callbacks run untracked even when a session is driven by an effect", () => {
    const [trigger, setTrigger] = useSignal(0);
    const [secret, setSecret] = useSignal(0);
    let runs = 0;
    let current: ReturnType<typeof session> | undefined;
    const dispose = createRoot((stop) => {
      useEffect(() => {
        trigger();
        runs += 1;
        current?.input.closed();
        current = session({
          open() {
            secret();
          },
          message() {
            secret();
            throw new Error("broken");
          },
          error() {
            secret();
          },
          close() {
            secret();
          },
        });
        current.input.message("one");
      });
      return stop;
    });
    try {
      flushSync();
      expect(runs).toBe(1);
      setSecret(1);
      flushSync();
      expect(runs).toBe(1);
      setTrigger(1);
      flushSync();
      expect(runs).toBe(2);
    } finally {
      dispose();
      current?.input.closed();
    }
  });
  it("[WS-MSG-10] closing removes the request abort listener", () => {
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    try {
      const run = session();
      const listener = add.mock.calls.find((call) => call[0] === "abort")?.[1];
      expect(listener).toBeDefined();
      run.input.closed();
      expect(remove.mock.calls.some((call) => call[0] === "abort" && call[1] === listener)).toBe(
        true,
      );
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
  it("[WS-MSG-01] text and binary share the route and preserve the native messages", () => {
    const close = vi.fn();
    const run = session({
      message(ws, message) {
        ws.send(message);
      },
      close,
    });
    run.input.message("hello");
    const bytes = new Uint8Array([1, 2]);
    run.input.message(bytes);
    expect(run.sent).toEqual(["hello", bytes]);
    run.input.closed(1000, "done");
    run.input.closed(1000, "done");
    expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]?.slice(1, 3)).toEqual([1000, "done"]);
    expect(run.finish).toHaveBeenCalledOnce();
  });

  it("[WS-MSG-02] the incoming limit counts UTF-8 bytes and refuses the first oversized message", () => {
    const message = vi.fn();
    const run = session({ message }, { maxMessageBytes: 4 });
    run.input.message("éé");
    run.input.message("ééé");
    expect(message).toHaveBeenCalledOnce();
    expect(run.closes[0]?.code).toBe(1009);
    expect(run.finish).toHaveBeenCalledOnce();
  });

  it("[WS-MSG-03] messages and exposed control frames share the rate bound", () => {
    const run = session({}, { maxMessagesPerSecond: 2 });
    run.input.message("one");
    run.input.pong();
    run.input.ping();
    expect(run.closes[0]?.code).toBe(1008);
    expect(run.finish).toHaveBeenCalledOnce();
  });

  it("[WS-MSG-04] an unresolved handler hits the in-flight bound and closes only its connection", async () => {
    let resolve: (() => void) | undefined;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const run = session({ message: () => pending }, { maxInFlightMessages: 1 });
    const other = session({
      message(ws, message) {
        ws.send(message);
      },
    });
    run.input.message("one");
    run.input.message("two");
    expect(run.closes[0]?.code).toBe(1013);
    other.input.message("other");
    expect(other.sent).toEqual(["other"]);
    resolve?.();
    await pending;
    run.input.closed();
    other.input.closed();
  });

  it("[WS-MSG-05] outgoing UTF-8 bytes hit the slow-consumer bound without sending", () => {
    let connection: WebSocketConnection | undefined;
    const run = session(
      {
        open(ws) {
          connection = ws;
        },
      },
      { buffered: 3, maxBufferedBytes: 6 },
    );
    expect(connection?.send("éé")).toBe(false);
    expect(run.sent).toEqual([]);
    expect(run.end).toHaveBeenCalledOnce();
    expect(run.finish).toHaveBeenCalledOnce();
    expect(connection?.signal.aborted).toBe(true);
  });

  it("[WS-MSG-06] a transport owning its heartbeat receives no fabricated pongs or framework ping timer", () => {
    const run = session();
    vi.advanceTimersByTime(100_000);
    expect(run.end).not.toHaveBeenCalled();
    expect(run.ping).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    run.input.closed();
  });

  it("[WS-MSG-07] native ping support waits for a real pong and closes a silent peer", () => {
    const run = session({}, { ping: true });
    vi.advanceTimersByTime(1000);
    expect(run.ping).toHaveBeenCalledOnce();
    run.input.pong();
    vi.advanceTimersByTime(500);
    expect(run.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(run.end).toHaveBeenCalledOnce();
    expect(run.finish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[WS-MSG-08] shutdown aborts the route once and sends going-away to the peer", () => {
    const close = vi.fn();
    const run = session({ close });
    run.input.shutdown();
    run.input.shutdown();
    expect(run.closes).toEqual([{ code: 1001, reason: "server shutdown" }]);
    expect(close).toHaveBeenCalledOnce();
    expect(run.finish).toHaveBeenCalledOnce();
  });

  it("[WS-MSG-09] handler failures report once, close with 1011 and release the connection", () => {
    const error = new Error("broken");
    const run = session({
      message() {
        throw error;
      },
    });
    run.input.message("one");
    expect(run.report).toHaveBeenCalledExactlyOnceWith(error);
    expect(run.closes[0]?.code).toBe(1011);
    expect(run.finish).toHaveBeenCalledOnce();
  });
});
