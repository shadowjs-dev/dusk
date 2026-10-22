import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "../../src/bun/index";
import { streams } from "../../src/features/streams";
import type { BunNativeOptions, BunSocket, BunSocketData } from "../../src/internal/bun-sockets";
import { createHandler } from "../../src/server/handler";
import type { Handler } from "../../src/server/types";

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  vi.unstubAllGlobals();
});

function fakeBun() {
  let options: BunNativeOptions | undefined;
  let data: BunSocketData | undefined;
  const upgrade = vi.fn((_request: Request, init: { data: BunSocketData }) => {
    data = init.data;
    return true;
  });
  const stop = vi.fn(async () => undefined);
  vi.stubGlobal("Bun", {
    serve(init: BunNativeOptions) {
      options = init;
      return { port: 4321, stop };
    },
  });
  return {
    upgrade,
    stop,
    get options() {
      if (options === undefined) throw new Error("Bun did not listen");
      return options;
    },
    socket() {
      if (data === undefined) throw new Error("no accepted upgrade");
      let state = 1;
      const sent: (string | Uint8Array)[] = [];
      const closed: number[] = [];
      const socket: BunSocket = {
        data,
        get readyState() {
          return state;
        },
        send(message) {
          sent.push(message);
          return 1;
        },
        close(code) {
          closed.push(code);
          state = 2;
        },
        terminate() {
          state = 3;
        },
        getBufferedAmount: () => 0,
        ping: () => 1,
      };
      return { socket, sent, closed };
    },
  };
}

function app(maxMessageBytes = 16): Handler {
  return createHandler({
    features: [streams()],
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      App: (props: { children?: unknown }) => props.children,
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
              message(ws, message) {
                ws.send(message);
              },
            },
          }),
        },
      ],
    },
    streams: { wsMaxMessageBytes: maxMessageBytes, wsMaxConnections: 1 },
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

async function boot(handler: Handler): Promise<ReturnType<typeof fakeBun>> {
  const fake = fakeBun();
  running.push(await serve(handler, { port: 0, static: false, shutdownSignals: false }));
  return fake;
}

const peer = (fake: ReturnType<typeof fakeBun>) => ({
  requestIP: () => ({ address: "127.0.0.1" }),
  upgrade: fake.upgrade,
});

describe("Bun WebSocket bridge", () => {
  it("[BUN-WS-06] an accepted upgrade cannot start a second session", async () => {
    const fake = await boot(app());
    await fake.options.fetch(request(), peer(fake));
    const run = fake.socket();
    fake.options.websocket?.open(run.socket);
    expect(() =>
      run.socket.data.decision.startMessages?.({
        send: () => true,
        close: () => undefined,
        end: () => undefined,
      }),
    ).toThrow("already consumed");
    expect((await fake.options.fetch(request(), peer(fake)))?.status).toBe(503);
    fake.options.websocket?.close(run.socket, 1000, "done");
  });
  it("[BUN-WS-01] bounds native frames including control payloads and starts callbacks only after the native open event", async () => {
    const fake = await boot(app());
    expect(fake.options.websocket?.maxPayloadLength).toBe(125);
    expect(await fake.options.fetch(request(), peer(fake))).toBeUndefined();
    const run = fake.socket();
    expect(run.sent).toEqual([]);
    fake.options.websocket?.open(run.socket);
    expect(run.sent).toEqual(["welcome"]);
    fake.options.websocket?.message(run.socket, "hello");
    fake.options.websocket?.message(run.socket, new Uint8Array([1, 2]));
    expect(run.sent).toEqual(["welcome", "hello", new Uint8Array([1, 2])]);
    fake.options.websocket?.close(run.socket, 1000, "done");
  });

  it("[BUN-WS-02] origin rejection happens before Bun receives an upgrade", async () => {
    const fake = await boot(app());
    const response = await fake.options.fetch(request("https://foreign.example"), peer(fake));
    expect(response?.status).toBe(403);
    expect(fake.upgrade).not.toHaveBeenCalled();
  });

  it("[BUN-WS-03] a failed native upgrade returns its connection slot", async () => {
    const fake = await boot(app());
    fake.upgrade.mockReturnValueOnce(false);
    expect((await fake.options.fetch(request(), peer(fake)))?.status).toBe(503);
    expect(await fake.options.fetch(request(), peer(fake))).toBeUndefined();
    expect(fake.upgrade).toHaveBeenCalledTimes(2);
    const run = fake.socket();
    fake.options.websocket?.open(run.socket);
    fake.options.websocket?.close(run.socket, 1000, "done");
  });

  it("[BUN-WS-04] shutdown sends going-away and refuses upgrades without calling the handler", async () => {
    const fake = await boot(app());
    await fake.options.fetch(request(), peer(fake));
    const run = fake.socket();
    fake.options.websocket?.open(run.socket);
    await running[0]?.close();
    expect(run.closed).toEqual([1001]);
    expect((await fake.options.fetch(request(), peer(fake)))?.status).toBe(503);
    expect(fake.upgrade).toHaveBeenCalledOnce();
  });

  it("[BUN-WS-05] the shared message limit closes with 1009 and releases the slot", async () => {
    const fake = await boot(app(4));
    await fake.options.fetch(request(), peer(fake));
    const run = fake.socket();
    fake.options.websocket?.open(run.socket);
    fake.options.websocket?.message(run.socket, "ééé");
    expect(run.closed).toEqual([1009]);
    expect(await fake.options.fetch(request(), peer(fake))).toBeUndefined();
    const next = fake.socket();
    fake.options.websocket?.open(next.socket);
    fake.options.websocket?.close(next.socket, 1000, "done");
  });
});
