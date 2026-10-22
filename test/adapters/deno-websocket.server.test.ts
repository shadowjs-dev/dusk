import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "../../src/deno/index";
import { streams } from "../../src/features/streams";
import type { DenoRuntime } from "../../src/internal/deno-sockets";
import { createHandler } from "../../src/server/handler";
import type { Handler } from "../../src/server/types";

/** A close event. `CloseEvent` is a global from Node 23 on; Node 22 has only `Event`. */
function closeEvent(code: number, reason = ""): Event {
  return Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 });
}

class Socket extends EventTarget {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: number[] = [];
  autoClose = true;
  send(message: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(message);
  }
  close(code = 1000): void {
    this.readyState = 2;
    this.closes.push(code);
    if (this.autoClose) this.closed(code);
  }
  closed(code = 1000): void {
    this.readyState = 3;
    this.dispatchEvent(closeEvent(code));
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fakeDeno() {
  let fetch: Parameters<DenoRuntime["serve"]>[1] | undefined;
  const socket = new Socket();
  const response = new Response(null);
  const upgrade = vi.fn(() => ({ socket, response }));
  const shutdown = vi.fn(async () => undefined);
  vi.stubGlobal("Deno", {
    serve(_options: unknown, handler: Parameters<DenoRuntime["serve"]>[1]) {
      fetch = handler;
      return { addr: { port: 4321 }, shutdown };
    },
    upgradeWebSocket: upgrade,
  });
  return {
    socket,
    response,
    upgrade,
    shutdown,
    request(request: Request) {
      if (fetch === undefined) throw new Error("Deno did not listen");
      return fetch(request, { remoteAddr: { hostname: "127.0.0.1" } });
    },
  };
}
function app(): Handler {
  return createHandler({
    features: [streams()],
    manifest: {
      App: (props: { children?: unknown }) => props.children,
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      streams: [
        {
          id: "chat",
          path: "/chat",
          kinds: ["WS"],
          load: async () => ({
            WS: {
              open(ws) {
                ws.send("welcome");
              },
              message(ws, data) {
                ws.send(data);
              },
            },
          }),
        },
      ],
    },
    streams: { wsMaxMessageBytes: 8, wsMaxConnections: 1 },
  });
}
function request(origin = "http://localhost"): Request {
  return new Request("http://localhost/chat", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      origin,
    },
  });
}
async function boot() {
  const fake = fakeDeno();
  running.push(await serve(app(), { static: false, port: 0, shutdownSignals: false }));
  return fake;
}

describe("Deno WebSocket bridge", () => {
  it("[DENO-WS-08] the graceful deadline releases the native close watcher when the peer never replies", async () => {
    vi.useFakeTimers();
    const fake = fakeDeno();
    const server = await serve(app(), {
      static: false,
      port: 0,
      shutdownSignals: false,
      gracefulShutdownMs: 10,
    });
    running.push(server);
    await fake.request(request());
    fake.socket.open();
    fake.socket.autoClose = false;
    const add = vi.spyOn(fake.socket, "addEventListener");
    const remove = vi.spyOn(fake.socket, "removeEventListener");
    let finished = false;
    const closing = server.close().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toBe(true);
    const watcher = add.mock.calls.find(([name]) => name === "close")?.[1];
    expect(watcher).toBeDefined();
    expect(
      remove.mock.calls.some(([name, listener]) => name === "close" && listener === watcher),
    ).toBe(true);
    expect(fake.shutdown).toHaveBeenCalledOnce();
    await closing;
  });
  it("[DENO-WS-07] graceful shutdown waits for the native close handshake", async () => {
    vi.useFakeTimers();
    const fake = await boot();
    await fake.request(request());
    fake.socket.open();
    fake.socket.autoClose = false;
    let finished = false;
    const closing = running[0]?.close().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.socket.closes).toEqual([1001]);
    expect(finished).toBe(false);
    fake.socket.closed(1001);
    await closing;
    expect(finished).toBe(true);
  });
  it("[DENO-WS-06] a completed HTTP upgrade cannot abort the live socket's session", async () => {
    const fake = await boot();
    const abort = new AbortController();
    const original = request();
    await fake.request(new Request(original, { signal: abort.signal }));
    fake.socket.open();
    abort.abort();
    fake.socket.message("hello");
    expect(fake.socket.sent).toEqual(["welcome", "hello"]);
    expect(fake.socket.closes).toEqual([]);
  });
  it("[DENO-WS-01] validates before upgrade, defers route open, and delivers text and binary messages", async () => {
    const fake = await boot();
    expect(await fake.request(request())).toBe(fake.response);
    expect(fake.upgrade).toHaveBeenCalledWith(expect.any(Request), { idleTimeout: 30 });
    expect(fake.socket.sent).toEqual([]);
    expect(fake.socket.binaryType).toBe("arraybuffer");
    fake.socket.open();
    fake.socket.message("hello");
    fake.socket.message(new Uint8Array([1, 2]).buffer);
    expect(fake.socket.sent).toEqual(["welcome", "hello", new Uint8Array([1, 2])]);
  });
  it("[DENO-WS-02] a foreign origin is refused before any native socket exists", async () => {
    const fake = await boot();
    expect((await fake.request(request("https://foreign.example"))).status).toBe(403);
    expect(fake.upgrade).not.toHaveBeenCalled();
  });
  it("[DENO-WS-03] a size violation closes with 1009 and releases its connection slot", async () => {
    const fake = await boot();
    await fake.request(request());
    fake.socket.open();
    fake.socket.message("123456789");
    expect(fake.socket.closes).toEqual([1009]);
    expect(await fake.request(request())).toBe(fake.response);
  });
  it("[DENO-WS-04] shutdown cancels an upgrade before open and removes all native listeners", async () => {
    const fake = await boot();
    await fake.request(request());
    await running[0]?.close();
    fake.socket.open();
    expect(fake.socket.sent).toEqual([]);
    expect(fake.socket.closes).toEqual([1001]);
    expect((await fake.request(request())).status).toBe(503);
  });
  it("[DENO-WS-05] an upgrade exception releases the slot and reports once", async () => {
    const fake = fakeDeno();
    const report = vi.fn();
    running.push(
      await serve(app(), { static: false, port: 0, shutdownSignals: false, onError: report }),
    );
    const error = new Error("upgrade failed");
    fake.upgrade.mockImplementationOnce(() => {
      throw error;
    });
    expect((await fake.request(request())).status).toBe(500);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(await fake.request(request())).toBe(fake.response);
  });
});
