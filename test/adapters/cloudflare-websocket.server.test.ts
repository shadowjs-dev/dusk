import { afterEach, describe, expect, it, vi } from "vitest";
import { workerFetch } from "../../src/cloudflare/index";
import { streams } from "../../src/features/streams";
import { createHandler } from "../../src/server/handler";

/** A close event. `CloseEvent` is a global from Node 23 on; Node 22 has only `Event`. */
function closeEvent(code: number, reason = ""): Event {
  return Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 });
}

class Socket extends EventTarget {
  binaryType = "blob";
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: number[] = [];
  accept(): void {
    this.readyState = 1;
  }
  send(message: string | Uint8Array): void {
    this.sent.push(message);
  }
  close(code = 1000): void {
    this.closes.push(code);
    this.readyState = 3;
    this.dispatchEvent(closeEvent(code));
  }
  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
class WorkerResponse extends Response {
  readonly webSocket: unknown;
  constructor(body?: BodyInit | null, init: ResponseInit & { webSocket?: unknown } = {}) {
    super(body, { ...init, ...(init.status === 101 ? { status: 200 } : {}) });
    this.webSocket = init.webSocket;
  }
  override get status(): number {
    return this.webSocket === undefined ? super.status : 101;
  }
}
function runtime() {
  const sockets: Socket[] = [];
  const pairs = vi.fn();
  vi.stubGlobal("Response", WorkerResponse);
  vi.stubGlobal(
    "WebSocketPair",
    class {
      readonly 0 = {};
      readonly 1 = new Socket();
      constructor() {
        pairs();
        sockets.push(this[1]);
      }
    },
  );
  return { sockets, pairs };
}
function app() {
  return workerFetch(
    createHandler({
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
                open(ws, event) {
                  ws.send(event.clientAddress ?? "missing address");
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
    }),
  );
}
function request(origin = "http://localhost") {
  return new Request("http://localhost/chat", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      origin,
      "cf-connecting-ip": "127.0.0.1",
    },
  });
}
afterEach(() => vi.unstubAllGlobals());
describe("Cloudflare WebSocket bridge", () => {
  it("[CF-WS-05] acknowledges a peer close on runtimes that leave the transport half open", async () => {
    const fake = runtime();
    await app().fetch(request());
    const socket = fake.sockets[0];
    if (socket === undefined) throw new Error("missing socket");
    socket.readyState = 2;
    socket.dispatchEvent(closeEvent(1000, "done"));
    expect(socket.closes).toEqual([1000]);
    expect(socket.readyState).toBe(3);
  });
  it("[CF-WS-01] accepts a guarded native pair and shares text and binary delivery", async () => {
    const fake = runtime();
    const module = app();
    const response = await module.fetch(request());
    expect(response.status).toBe(101);
    const socket = fake.sockets[0];
    expect(socket?.sent).toEqual(["127.0.0.1"]);
    socket?.message("hello");
    socket?.message(new Uint8Array([1, 2]).buffer);
    expect(socket?.sent).toEqual(["127.0.0.1", "hello", new Uint8Array([1, 2])]);
    socket?.close();
  });
  it("[CF-WS-02] refuses a foreign origin before creating a native pair", async () => {
    const fake = runtime();
    expect((await app().fetch(request("https://foreign.example"))).status).toBe(403);
    expect(fake.pairs).not.toHaveBeenCalled();
  });
  it("[CF-WS-03] enforces the connection and message bounds and returns a released slot", async () => {
    const fake = runtime();
    const module = app();
    expect((await module.fetch(request())).status).toBe(101);
    expect((await module.fetch(request())).status).toBe(503);
    fake.sockets[0]?.message("123456789");
    expect(fake.sockets[0]?.closes).toEqual([1009]);
    expect((await module.fetch(request())).status).toBe(101);
    fake.sockets[1]?.close();
  });
  it("[CF-WS-04] reports a native accept failure and releases the upgrade reservation", async () => {
    const fake = runtime();
    const module = app();
    const error = new Error("accept failed");
    const report = vi.mocked(console.error);
    const accept = vi.spyOn(Socket.prototype, "accept").mockImplementationOnce(() => {
      throw error;
    });
    try {
      expect((await module.fetch(request())).status).toBe(500);
      expect(report).toHaveBeenCalledExactlyOnceWith("[dusk] WebSocket upgrade failed", error);
      expect((await module.fetch(request())).status).toBe(101);
      fake.sockets[1]?.close();
    } finally {
      report.mockClear();
      accept.mockRestore();
    }
  });
});
