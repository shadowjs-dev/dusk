import type { IncomingMessage } from "node:http";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streams } from "../src/features/streams";
import { upgradeRequestOf } from "../src/node/websocket";
import {
  createHandler,
  type DuskRuntimeManifest,
  HttpError,
  type SseHandler,
  type WebSocketConnection,
  type WebSocketHandlers,
  type WebSocketSink,
} from "../src/server/index";
import { startWebSocket } from "../src/server/websocket";
import { CLOSE, FrameReader } from "../src/server/ws-protocol";

/**
 * PASS 2, scope D (server core): streams (SEC2-CORE-79 .. 90). A reader that never reads must not make the server hold
 * more and more: server-sent events (79 .. 82), WebSocket sends (83 .. 85), frames that arrive in many small pieces
 * (86), the upgrade decision (87, 88) and close reasons (89). The PASS 1 limits (R-3, R-5, R-6) stay as they are.
 */

const BASE = {
  routes: [],
  apiRoutes: [],
  serverFns: {},
  assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
  App: (props: { children?: unknown }) => props.children,
} satisfies Partial<DuskRuntimeManifest>;

function sseHandler(
  sse: SseHandler,
  options: { heartbeatMs?: number; maxBufferedEvents?: number } = {},
) {
  return createHandler({
    features: [streams()],
    manifest: {
      ...BASE,
      streams: [{ id: "/feed", path: "/feed", kinds: ["SSE"], load: async () => ({ SSE: sse }) }],
    },
    dev: true,
    security: { allowedHosts: ["example.com"] },
    streams: {
      sseHeartbeatMs: options.heartbeatMs ?? 60_000,
      sseMaxBufferedEvents: options.maxBufferedEvents ?? 256,
    },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

const feed = (): Request => new Request("https://example.com/feed");

/** Everything the body holds right now, then the end (the handler has closed the stream). */
async function drain(response: Response): Promise<string> {
  return response.text();
}

describe("SEC2-CORE server-sent events and a client that does not read", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[SEC2-CORE-79] comment() written in a loop for a consumer that does not read is dropped, not queued without bound", async () => {
    const handler = sseHandler((_event, stream) => {
      for (let index = 0; index < 5000; index += 1) stream.comment("x".repeat(1000));
      stream.close();
    });
    const body = await drain(await handler.fetch(feed()));
    // 5000 comments of 1 KB are 5 MB; the queue holds the one chunk its mark allows.
    expect(body.length).toBeLessThan(64 * 1024);
  });

  it("[SEC2-CORE-80] one comment is at most 1 KiB: a huge text cannot be written as a comment", async () => {
    const handler = sseHandler((_event, stream) => {
      stream.comment("y".repeat(10_000_000));
      stream.close();
    });
    const body = await drain(await handler.fetch(feed()));
    expect(body.length).toBeLessThanOrEqual(1024 + 8);
    expect(body.startsWith(":")).toBe(true);
  });

  it("[SEC2-CORE-81] heartbeats are not queued while the consumer has an unread chunk: a stalled reader gets at most one", async () => {
    vi.useFakeTimers();
    const handler = sseHandler(
      async (_event, stream) => {
        await new Promise<void>((resolve) =>
          stream.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
      { heartbeatMs: 1000 },
    );
    const response = await handler.fetch(feed());
    await vi.advanceTimersByTimeAsync(1000 * 200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    let pings = 0;
    for (;;) {
      const next = await Promise.race([reader.read(), Promise.resolve("stalled" as const)]);
      if (next === "stalled" || next.done) break;
      pings += new TextDecoder().decode(next.value).split(": ping").length - 1;
    }
    expect(pings).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it("[SEC2-CORE-82] a handler that does not await send() is cut off at the buffer bound: at most maxBufferedEvents + 1 events are queued", async () => {
    let failure: unknown;
    const handler = sseHandler(async (_event, stream) => {
      const sends: Promise<void>[] = [];
      for (let index = 0; index < 2000; index += 1) {
        sends.push(
          stream.send({ data: "x".repeat(60 * 1024) }).catch((error: unknown) => {
            failure ??= error;
          }),
        );
      }
      await Promise.all(sends);
    });
    const body = await drain(await handler.fetch(feed()));
    const events = body.split("\n\n").filter((part) => part.startsWith("data:")).length;
    expect(events).toBeLessThanOrEqual(256 + 2);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("event stream was closed");
  });
});

/** A sink that records what is written and reports a buffer the test controls. */
function slowSink() {
  const state = { written: 0, ended: 0, destroyed: 0, buffered: 0 };
  const sink: WebSocketSink = {
    write(bytes) {
      state.written += bytes.byteLength;
    },
    end() {
      state.ended += 1;
    },
    buffered: () => state.buffered,
    destroy() {
      state.destroyed += 1;
    },
  };
  return { sink, state };
}

/** Handlers whose `open` keeps the connection for the test to drive. */
function capture(): {
  readonly box: { ws: WebSocketConnection | undefined };
  readonly handlers: WebSocketHandlers;
} {
  const box: { ws: WebSocketConnection | undefined } = { ws: undefined };
  return {
    box,
    handlers: {
      open(ws) {
        box.ws = ws;
      },
    },
  };
}

function connect(handlers: WebSocketHandlers, sink: WebSocketSink, maxMessageBytes = 1024) {
  const event = {
    signal: new AbortController().signal,
  } as never;
  const errors: unknown[] = [];
  const closes: number[] = [];
  const input = startWebSocket({
    handlers: { ...handlers, close: (_ws, code) => void closes.push(code) },
    event,
    limits: {
      maxMessageBytes,
      maxMessagesPerSecond: 1000,
      pingIntervalMs: 3_600_000,
      pongTimeoutMs: 3_600_000,
    },
    data: {},
    sink,
    report: (error) => void errors.push(error),
  });
  return { input, errors, closes };
}

describe("SEC2-CORE WebSocket sends to a peer that does not read", () => {
  it("[SEC2-CORE-83] send() stops when the transport holds more than 8 x maxMessageBytes unsent: the connection is dropped, not buffered", () => {
    const { sink, state } = slowSink();
    const held = capture();
    const { closes } = connect(held.handlers, sink, 1024);
    const connection = held.box.ws;
    if (connection === undefined) throw new Error("not open");
    expect(connection.send("hello")).toBe(true);
    state.buffered = 8 * 1024 - 100;
    expect(connection.send("still fits")).toBe(true);
    // A peer that stopped reading: the next frame would pass the bound.
    state.buffered = 8 * 1024 + 1;
    const written = state.written;
    expect(connection.send("one more")).toBe(false);
    expect(state.written).toBe(written);
    expect(connection.readyState).toBe("closed");
    expect(state.destroyed).toBe(1);
    expect(closes).toEqual([CLOSE.TRY_AGAIN_LATER]);
    expect(connection.send("after")).toBe(false);
  });

  it("[SEC2-CORE-84] a loop that sends 20 000 messages to a transport that never drains writes about the bound, not everything", () => {
    const { sink, state } = slowSink();
    // Each write adds to the unsent total, as a socket that is not read would.
    const write = sink.write.bind(sink);
    sink.write = (bytes) => {
      write(bytes);
      state.buffered += bytes.byteLength;
    };
    const held = capture();
    connect(held.handlers, sink, 1024);
    const connection = held.box.ws;
    if (connection === undefined) throw new Error("not open");
    let accepted = 0;
    for (let index = 0; index < 20_000; index += 1) {
      if (connection.send("x".repeat(512))) accepted += 1;
    }
    expect(accepted).toBeLessThanOrEqual((8 * 1024) / 512 + 2);
    expect(state.written).toBeLessThanOrEqual(8 * 1024 + 1024);
  });

  it("[SEC2-CORE-85] a transport that reports no buffer (a runtime without one) keeps the old behavior: sends are written", () => {
    const written: number[] = [];
    const sink: WebSocketSink = {
      write: (bytes) => void written.push(bytes.byteLength),
      end: () => undefined,
    };
    const held = capture();
    connect(held.handlers, sink, 1024);
    const connection = held.box.ws;
    for (let index = 0; index < 50; index += 1)
      expect(connection?.send("x".repeat(512))).toBe(true);
    expect(written).toHaveLength(50);
    connection?.close();
  });
});

describe("SEC2-CORE WebSocket frames in many small pieces", () => {
  it("[SEC2-CORE-86] a 400 000-byte frame that arrives one byte at a time is held in one buffer, not as 300 000 chunk objects", () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const reader = new FrameReader({ maxMessageBytes: 1024 * 1024, requireMask: true });
    const length = 400_000;
    const header = new Uint8Array(14);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    new DataView(header.buffer).setBigUint64(2, BigInt(length));
    reader.push(header);
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < 300_000; index += 1) reader.push(new Uint8Array([index & 0xff]));
    gc();
    const grown = process.memoryUsage().heapUsed - before;
    // 300 000 retained `Uint8Array` objects are tens of megabytes; one buffer of the frame is under a megabyte or two.
    expect(grown).toBeLessThan(8 * 1024 * 1024);
    const events = reader.push(new Uint8Array(length + 14 - 14 - 300_000).fill(1));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("binary");
  });

  it("[SEC2-CORE-86b] frames split at every offset still decode to the same events (the buffer logic is exact)", () => {
    const frames: number[] = [];
    const mask = [1, 2, 3, 4];
    const frame = (payload: number[], opcode = 0x2): number[] => {
      const body = payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0));
      const head =
        payload.length < 126
          ? [0x80 | opcode, 0x80 | payload.length]
          : [0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff];
      return [...head, ...mask, ...body];
    };
    frames.push(
      ...frame([1, 2, 3]),
      ...frame(Array.from({ length: 300 }, (_, index) => index & 0xff)),
      ...frame([9], 0x9),
      ...frame([]),
    );
    const whole = new FrameReader({ maxMessageBytes: 4096, requireMask: true }).push(
      new Uint8Array(frames),
    );
    expect(whole).toHaveLength(4);
    for (let cut = 1; cut < frames.length; cut += 7) {
      const reader = new FrameReader({ maxMessageBytes: 4096, requireMask: true });
      const events = [
        ...reader.push(new Uint8Array(frames.slice(0, cut))),
        ...reader.push(new Uint8Array(frames.slice(cut))),
      ];
      expect(events, `cut at ${cut}`).toEqual(whole);
    }
  });
});

describe("SEC2-CORE the upgrade decision and close reasons", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
  const upgrade = (): Request =>
    new Request("https://example.com/chat", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": KEY,
        "sec-websocket-version": "13",
        origin: "https://example.com",
      },
    });

  function wsHandler(ws: WebSocketHandlers) {
    return createHandler({
      features: [streams()],
      manifest: {
        ...BASE,
        streams: [{ id: "/chat", path: "/chat", kinds: ["WS"], load: async () => ({ WS: ws }) }],
      },
      dev: true,
      security: { allowedHosts: ["example.com"], limits: { requestTimeoutMs: 5000 } },
      streams: { wsMaxConnectionsPerAddress: 1 },
      onError: () => undefined,
      onWarning: () => undefined,
    });
  }

  it("[SEC2-CORE-87] an upgrade hook that never settles is answered 504 after requestTimeoutMs and gives its connection slot back", async () => {
    vi.useFakeTimers();
    const handler = wsHandler({ upgrade: () => new Promise<never>(() => undefined) });
    const upgradeFn = handler.upgrade;
    if (upgradeFn === undefined) throw new Error("no upgrade");
    const platform = { clientAddress: "203.0.113.9" };
    const pending = upgradeFn.call(handler, upgrade(), platform);
    await vi.advanceTimersByTimeAsync(5001);
    const decision = await pending;
    expect(decision.kind).toBe("reject");
    if (decision.kind === "reject") expect(decision.response.status).toBe(504);
    // The single slot per address was released: the next upgrade is decided (and times out) rather than refused with 503.
    const second = upgradeFn.call(handler, upgrade(), platform);
    await vi.advanceTimersByTimeAsync(5001);
    const next = await second;
    expect(next.kind === "reject" ? next.response.status : 0).toBe(504);
  });

  it("[SEC2-CORE-88] a hook that settles in time is untouched by the timeout", async () => {
    const handler = wsHandler({ upgrade: async () => undefined });
    const upgradeFn = handler.upgrade;
    if (upgradeFn === undefined) throw new Error("no upgrade");
    const decision = await upgradeFn.call(handler, upgrade(), { clientAddress: "203.0.113.9" });
    expect(decision.kind).toBe("websocket");
    if (decision.kind === "websocket") decision.abandon?.();
    const refusing = wsHandler({
      upgrade: () => {
        throw new HttpError(401, "no");
      },
    });
    const refused = await refusing.upgrade?.call(refusing, upgrade(), {
      clientAddress: "203.0.113.9",
    });
    expect(refused?.kind === "reject" ? refused.response.status : 0).toBe(401);
  });

  it("[SEC2-CORE-89] close(code, reason) with a long non-ASCII reason sends a valid close frame (at most 125 bytes) and closes", () => {
    const frames: Uint8Array[] = [];
    const sink: WebSocketSink = { write: (bytes) => void frames.push(bytes), end: () => undefined };
    const held = capture();
    const { closes } = connect(held.handlers, sink, 1024);
    const connection = held.box.ws;
    if (connection === undefined) throw new Error("not open");
    expect(() => connection?.close(1000, "é".repeat(100))).not.toThrow();
    expect(connection.readyState).toBe("closed");
    expect(closes).toEqual([1000]);
    const close = frames.at(-1);
    expect(close?.[0]).toBe(0x88);
    expect(close?.[1] ?? 999).toBeLessThanOrEqual(125);
    const reason = new TextDecoder("utf-8", { fatal: true }).decode(close?.subarray(4));
    expect(reason.startsWith("é")).toBe(true);
  });

  it("[SEC2-CORE-90] PASS 1 limits still hold: a message handler stuck in flight closes the connection with 1013 at the bound", async () => {
    const sink: WebSocketSink = { write: () => undefined, end: () => undefined };
    const { input, closes } = connect(
      { message: () => new Promise<void>(() => undefined) },
      sink,
      1024,
    );
    const mask = [1, 2, 3, 4];
    const text = (word: string): Uint8Array => {
      const bytes = [...new TextEncoder().encode(word)];
      return new Uint8Array([
        0x81,
        0x80 | bytes.length,
        ...mask,
        ...bytes.map((byte, index) => byte ^ (mask[index % 4] ?? 0)),
      ]);
    };
    for (let index = 0; index < 17; index += 1) input.push(text("hi"));
    expect(closes).toEqual([CLOSE.TRY_AGAIN_LATER]);
  });
});

describe("SEC2-CORE the request an upgrade is built from", () => {
  /** The parts of a Node request that `upgradeRequestOf` reads. */
  function incoming(headers: Record<string, string>, url: string, raw?: string[]): IncomingMessage {
    const rawHeaders = raw ?? Object.entries(headers).flat();
    return { headers, rawHeaders, url } as unknown as IncomingMessage;
  }
  const upgrade = { upgrade: "websocket", connection: "Upgrade" };

  it("[SEC2-CORE-91] a Host with a path, a query, user info or a space is not turned into a URL (it would choose the route)", () => {
    for (const host of [
      "localhost/admin-ws?",
      "localhost#x",
      "evil.com@localhost",
      "a b",
      "localhost\\x",
      "",
      "local%68ost",
      "[::1",
    ]) {
      expect(
        upgradeRequestOf(incoming({ host, ...upgrade }, "/chat"), false),
        host,
      ).toBeUndefined();
    }
    for (const host of [
      "localhost",
      "localhost:8080",
      "app.example.com",
      "127.0.0.1:3000",
      "[::1]:8080",
    ]) {
      expect(upgradeRequestOf(incoming({ host, ...upgrade }, "/chat"), false)?.url, host).toBe(
        `http://${host}/chat`,
      );
    }
    expect(upgradeRequestOf(incoming({ ...upgrade }, "/chat"), false)).toBeUndefined();
  });

  it("[SEC2-CORE-92] an absolute-form target, a repeated Host and a bad header value are refused; the target keeps its // as a path", () => {
    const base = { host: "localhost", ...upgrade };
    expect(upgradeRequestOf(incoming(base, "http://evil.example/chat"), false)).toBeUndefined();
    expect(upgradeRequestOf(incoming(base, "chat"), false)).toBeUndefined();
    expect(
      upgradeRequestOf(
        incoming(base, "/chat", ["Host", "localhost", "host", "evil.example"]),
        false,
      ),
    ).toBeUndefined();
    expect(
      upgradeRequestOf(incoming({ ...base, "x-bad": "a\nb" }, "/chat"), false),
    ).toBeUndefined();
    expect(
      new URL(upgradeRequestOf(incoming(base, "//evil.example/x"), true)?.url ?? "").host,
    ).toBe("localhost");
  });
});
