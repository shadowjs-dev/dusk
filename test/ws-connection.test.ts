import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "../src/server/types";
import {
  startWebSocket,
  type WebSocketConnection,
  type WebSocketHandlers,
  type WebSocketLimits,
  type WebSocketSink,
} from "../src/server/websocket";

/**
 * The connection behavior of a WebSocket route: handlers, the rate limit, keepalive, the close
 * handshake and the way a failure closes the socket. A fake sink records what the server writes; the
 * client frames are made with the real encoder (control frames are masked like a browser's).
 */

const LIMITS: WebSocketLimits = {
  maxMessageBytes: 1024,
  maxMessagesPerSecond: 5,
  pingIntervalMs: 1000,
  pongTimeoutMs: 500,
};

const EVENT = { signal: new AbortController().signal } as unknown as RequestEvent;

interface Recorder {
  readonly sent: Uint8Array[];
  ended: boolean;
  readonly sink: WebSocketSink;
  /** The server's frames, decoded by a client-side reader (unmasked server frames). */
  frames(): { kind: string; text: string; code?: number; reason?: string }[];
}

function recorder(): Recorder {
  const sent: Uint8Array[] = [];
  const rec: Recorder = {
    sent,
    ended: false,
    sink: {
      write(bytes) {
        sent.push(bytes);
      },
      end() {
        rec.ended = true;
      },
    },
    frames() {
      const out: { kind: string; text: string; code?: number; reason?: string }[] = [];
      for (const bytes of sent) {
        const opcode = (bytes[0] ?? 0) & 0x0f;
        const kind =
          { 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong" }[opcode] ?? String(opcode);
        const length = (bytes[1] ?? 0) & 0x7f;
        const payload = bytes.subarray(2, 2 + length);
        if (kind === "close") {
          out.push({
            kind,
            text: "",
            code: ((payload[0] ?? 0) << 8) | (payload[1] ?? 0),
            reason: new TextDecoder().decode(payload.subarray(2)),
          });
        } else {
          out.push({ kind, text: new TextDecoder().decode(payload) });
        }
      }
      return out;
    },
  };
  return rec;
}

/** A masked client frame, as a browser sends it. */
function fromClient(kind: "text" | "close" | "ping" | "pong", payload: Uint8Array): Uint8Array {
  const opcode = { text: 1, close: 8, ping: 9, pong: 10 }[kind];
  const key = new Uint8Array([1, 2, 3, 4]);
  const masked = new Uint8Array(payload.map((byte, index) => byte ^ (key[index % 4] ?? 0)));
  const header = [0x80 | opcode, 0x80 | masked.byteLength, ...key];
  return new Uint8Array([...header, ...masked]);
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let rec: Recorder;
let reported: unknown[];

beforeEach(() => {
  rec = recorder();
  reported = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function start(handlers: WebSocketHandlers, limits: Partial<WebSocketLimits> = {}) {
  return startWebSocket({
    handlers,
    event: EVENT,
    limits: { ...LIMITS, ...limits },
    data: {},
    sink: rec.sink,
    report: (error) => void reported.push(error),
  });
}

describe("WebSocket connection: messages", () => {
  it("[WS-20] text reaches message as a string, binary as bytes, in order; open gets the connection", async () => {
    const seen: (string | Uint8Array)[] = [];
    let opened: WebSocketConnection | undefined;
    const input = start({
      open(ws) {
        opened = ws;
      },
      message(_ws, message) {
        seen.push(message);
      },
    });
    input.push(fromClient("text", bytes("one")));
    input.push(new Uint8Array(encodeClientBinary(new Uint8Array([7, 8]))));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["one", new Uint8Array([7, 8])]);
    expect(opened).toBeDefined();
  });

  it("[WS-21] send writes a text frame while the socket is open and reports false once it is closed", () => {
    let ws: WebSocketConnection | undefined;
    const input = start({
      open(connection) {
        ws = connection;
      },
    });
    expect(ws?.send("hi")).toBe(true);
    expect(rec.frames()).toEqual([{ kind: "text", text: "hi" }]);
    input.closed();
    expect(ws?.send("late")).toBe(false);
    expect(rec.frames()).toHaveLength(1);
  });

  it("[WS-22] a client ping is answered with a pong that carries the same payload", () => {
    const input = start({});
    input.push(fromClient("ping", bytes("are you there")));
    expect(rec.frames()).toEqual([{ kind: "pong", text: "are you there" }]);
  });

  it("[WS-23] a client close is echoed with its code, the socket ends and close is called with the code and reason", () => {
    const closes: { code: number; reason: string }[] = [];
    const input = start({
      close(_ws, code, reason) {
        closes.push({ code, reason });
      },
    });
    input.push(fromClient("close", new Uint8Array([0x03, 0xe8, ...bytes("bye")])));
    // The code is echoed; the peer's reason is not echoed back (it is peer text).
    expect(rec.frames()).toEqual([{ kind: "close", text: "", code: 1000, reason: "" }]);
    expect(rec.ended).toBe(true);
    expect(closes).toEqual([{ code: 1000, reason: "bye" }]);
  });

  it("[WS-24] more messages than the rate limit in one second close the socket with 1008 and the excess is not delivered", () => {
    const seen: string[] = [];
    const input = start({
      message(_ws, message) {
        if (typeof message === "string") seen.push(message);
      },
    });
    for (let index = 0; index < 8; index += 1) input.push(fromClient("text", bytes(`m${index}`)));
    expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(rec.frames().at(-1)).toMatchObject({ kind: "close", code: 1008 });
    expect(rec.ended).toBe(true);
  });

  it("[WS-25] a protocol violation closes with its code and reaches error; no message is delivered from that frame", () => {
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const input = start({
      message(_ws, message) {
        seen.push(message);
      },
      error(_ws, error) {
        errors.push(error);
      },
    });
    input.push(new Uint8Array([0x81, 0x01, 0x41])); // unmasked client frame
    expect(seen).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(rec.frames().at(-1)).toMatchObject({ kind: "close", code: 1002 });
  });

  it("[WS-26] a socket that drops without a close frame is closed with 1006", () => {
    const closes: number[] = [];
    const input = start({
      close(_ws, code) {
        closes.push(code);
      },
    });
    input.closed();
    input.closed();
    expect(closes).toEqual([1006]);
  });

  it("[WS-27] the server pings on the interval; a peer that does not pong in time is dropped (1006)", () => {
    const closes: number[] = [];
    start({
      close(_ws, code) {
        closes.push(code);
      },
    });
    expect(rec.frames()).toEqual([]);
    vi.advanceTimersByTime(LIMITS.pingIntervalMs);
    expect(rec.frames()).toEqual([{ kind: "ping", text: "" }]);
    vi.advanceTimersByTime(LIMITS.pingIntervalMs + LIMITS.pongTimeoutMs);
    expect(rec.ended).toBe(true);
    expect(closes).toEqual([1006]);
  });

  it("[WS-28] a pong keeps the connection alive", () => {
    const input = start({});
    vi.advanceTimersByTime(LIMITS.pingIntervalMs);
    input.push(fromClient("pong", new Uint8Array()));
    vi.advanceTimersByTime(LIMITS.pingIntervalMs);
    expect(rec.ended).toBe(false);
    expect(rec.frames().filter((frame) => frame.kind === "ping")).toHaveLength(2);
  });

  it("[WS-29] a handler that throws is reported, and the socket closes with 1011", async () => {
    const input = start({
      message() {
        throw new Error("handler exploded");
      },
    });
    input.push(fromClient("text", bytes("boom")));
    await vi.advanceTimersByTimeAsync(0);
    expect(reported).toHaveLength(1);
    expect(rec.frames().at(-1)).toMatchObject({ kind: "close", code: 1011 });
    expect(rec.frames().at(-1)?.reason).toBe("");
  });

  it("[WS-30] open that throws closes the socket with 1011 before any message", async () => {
    const seen: unknown[] = [];
    const input = start({
      open() {
        throw new Error("no database");
      },
      message(_ws, message) {
        seen.push(message);
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    input.push(fromClient("text", bytes("x")));
    expect(seen).toEqual([]);
    expect(rec.frames()[0]).toMatchObject({ kind: "close", code: 1011 });
  });
});

/** A binary client frame (opcode 2), masked. */
function encodeClientBinary(payload: Uint8Array): Uint8Array {
  const key = new Uint8Array([9, 9, 9, 9]);
  const masked = new Uint8Array(payload.map((byte, index) => byte ^ (key[index % 4] ?? 0)));
  return new Uint8Array([0x82, 0x80 | masked.byteLength, ...key, ...masked]);
}
