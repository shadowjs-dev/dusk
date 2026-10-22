import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSseClient,
  createSseParser,
  createWebSocketClient,
  type StreamStatus,
} from "../../src/client/streams";
import { type ServerHandle, serve } from "../../src/node/index";
import {
  createHandler,
  type DuskRuntimeManifest,
  type SseHandler,
  type WebSocketHandlers,
} from "../../src/server/index";
import { allFeatures } from "../support/features";

/**
 * The browser clients against a real server: the SSE client reads the stream with fetch and resumes with
 * Last-Event-ID; the WebSocket client reconnects with backoff and stops when it is closed. The server is
 * `serve()`; the sockets are real.
 */

const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

interface Seen {
  readonly lastEventIds: (string | undefined)[];
  opens: number;
  aborted: number;
}

async function boot(options: {
  feed: SseHandler;
  chat?: WebSocketHandlers;
}): Promise<{ origin: string; seen: Seen }> {
  const seen: Seen = { lastEventIds: [], opens: 0, aborted: 0 };
  const streams: Array<NonNullable<DuskRuntimeManifest["streams"]>[number]> = [
    {
      id: "/feed",
      path: "/feed",
      kinds: ["SSE"],
      load: async () => ({
        SSE: (event, stream) => {
          seen.lastEventIds.push(stream.lastEventId);
          stream.signal.addEventListener("abort", () => {
            seen.aborted += 1;
          });
          return options.feed(event, stream);
        },
      }),
    },
  ];
  if (options.chat !== undefined) {
    const chat = options.chat;
    const counted: WebSocketHandlers = {
      ...chat,
      open(ws, event) {
        seen.opens += 1;
        return chat.open?.(ws, event);
      },
    };
    streams.push({
      id: "/chat",
      path: "/chat",
      kinds: ["WS"],
      load: async () => ({ WS: counted }),
    });
  }
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
      streams,
    },
    dev: true,
    security: { csrf: { allowMissingOrigin: true } },
    onError: () => undefined,
    onWarning: () => undefined,
  });
  const handle = await serve(handler, {
    port: 0,
    host: "127.0.0.1",
    compress: false,
    shutdownSignals: false,
    exitOnSignal: false,
    onError: () => undefined,
  });
  servers.push(handle);
  return { origin: `http://127.0.0.1:${handle.port}`, seen };
}

/** Waits until `check` holds, polling with the test runner's own waiter (no sleeps). */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 5000, interval: 5 });
}

describe("SSE parser", () => {
  it("[CLI-05] reads LF, CRLF and CR line ends, joins multi-line data, ignores comments, and reports retry", () => {
    const events: { event: string; data: string; id?: string }[] = [];
    const retries: number[] = [];
    const feed = createSseParser(
      (event) => events.push(event),
      (ms) => retries.push(ms),
    );
    feed(": a comment\r\nevent: tick\r\nid: 9\r\ndata: one\r\n");
    feed("data: two\r\n\r\nretry: 1500\ndata: x\n\n");
    feed("data: split\r");
    feed("\n\n");
    expect(events).toEqual([
      { event: "tick", data: "one\ntwo", id: "9" },
      // The last event id persists across events (WHATWG): "x" and "split" carry id 9 too.
      { event: "message", data: "x", id: "9" },
      { event: "message", data: "split", id: "9" },
    ]);
    expect(retries).toEqual([1500]);
  });
});

describe("SSE client", () => {
  it("[CLI-01] receives events in order with their names, ids and parsed data, and reports open", async () => {
    const { origin } = await boot({
      feed: async (_event, stream) => {
        await stream.send({ event: "price", id: "1", data: { value: 10 } });
        await stream.send({ event: "price", id: "2", data: { value: 11 } });
        stream.close();
      },
    });
    const received: unknown[] = [];
    const statuses: StreamStatus[] = [];
    const client = createSseClient({
      url: `${origin}/feed`,
      reconnect: { minDelayMs: 1000 },
      onEvent: (event) => received.push(event),
      onStatus: (status) => statuses.push(status),
    });
    await until(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      { event: "price", data: { value: 10 }, id: "1" },
      { event: "price", data: { value: 11 }, id: "2" },
    ]);
    expect(statuses[0]).toBe("connecting");
    expect(statuses).toContain("open");
    client.close();
  });

  it("[CLI-02] after the server ends the stream, the client reconnects with Last-Event-ID and carries on", async () => {
    let round = 0;
    const { origin, seen } = await boot({
      feed: async (_event, stream) => {
        round += 1;
        if (round === 1) {
          await stream.send({ id: "1", data: "a" });
          await stream.send({ id: "2", data: "b" });
          stream.close();
          return;
        }
        await stream.send({ id: "3", data: "c" });
      },
    });
    const received: string[] = [];
    const client = createSseClient({
      url: `${origin}/feed`,
      reconnect: { minDelayMs: 1 },
      onEvent: (event) => received.push(String(event.data)),
    });
    await until(() => expect(received).toEqual(["a", "b", "c"]));
    expect(seen.lastEventIds[0]).toBeUndefined();
    expect(seen.lastEventIds[1]).toBe("2");
    client.close();
  });

  it("[CLI-03] close() stops the stream: the server sees the disconnect and nothing reconnects", async () => {
    const { origin, seen } = await boot({
      feed: async (_event, stream) => {
        await stream.send({ id: "1", data: "hello" });
      },
    });
    const received: unknown[] = [];
    const client = createSseClient({
      url: `${origin}/feed`,
      reconnect: { minDelayMs: 1 },
      onEvent: (event) => received.push(event),
    });
    await until(() => expect(received).toHaveLength(1));
    client.close();
    expect(client.status).toBe("closed");
    await until(() => expect(seen.aborted).toBe(1));
    expect(seen.lastEventIds).toHaveLength(1);
  });

  it("[CLI-04] a refusal (4xx) stops the client: a missing route is not retried", async () => {
    const { origin } = await boot({ feed: () => undefined });
    const statuses: StreamStatus[] = [];
    const client = createSseClient({
      url: `${origin}/missing`,
      reconnect: { minDelayMs: 1 },
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
    });
    await until(() => expect(client.status).toBe("closed"));
    expect(statuses).not.toContain("reconnecting");
  });
});

describe("WebSocket client", () => {
  it("[CLI-06] sends and receives: a text message is parsed with the client's parse", async () => {
    const { origin } = await boot({
      feed: () => undefined,
      chat: {
        open(ws) {
          ws.send(JSON.stringify({ hello: "room" }));
        },
        message(ws, message) {
          if (typeof message === "string") ws.send(JSON.stringify({ echo: message }));
        },
      },
    });
    const received: unknown[] = [];
    const client = createWebSocketClient<{ echo?: string; hello?: string }>({
      url: `${origin.replace("http", "ws")}/chat`,
      onMessage: (data) => received.push(data),
    });
    await until(() => expect(received).toEqual([{ hello: "room" }]));
    await until(() => expect(client.send("ping")).toBe(true));
    await until(() => expect(received).toEqual([{ hello: "room" }, { echo: "ping" }]));
    client.close();
  });

  it("[CLI-07] send is false while the socket is not open", async () => {
    const { origin } = await boot({ feed: () => undefined, chat: {} });
    const client = createWebSocketClient({
      url: `${origin.replace("http", "ws")}/chat`,
      onMessage: () => undefined,
    });
    expect(client.send("too early")).toBe(false);
    client.close();
  });

  it("[CLI-08] a dropped socket is reconnected with backoff; the reconnect opens a new connection", async () => {
    const { origin, seen } = await boot({
      feed: () => undefined,
      chat: {
        message(ws, message) {
          if (message === "drop") ws.close(1011, "try again");
        },
      },
    });
    const statuses: StreamStatus[] = [];
    const client = createWebSocketClient({
      url: `${origin.replace("http", "ws")}/chat`,
      reconnect: { minDelayMs: 1 },
      onMessage: () => undefined,
      onStatus: (status) => statuses.push(status),
    });
    await until(() => expect(seen.opens).toBe(1));
    await until(() => expect(client.status).toBe("open"));
    client.send("drop");
    await until(() => expect(seen.opens).toBe(2));
    expect(statuses).toContain("reconnecting");
    client.close();
  });

  it("[CLI-09] close() is final: the socket does not come back", async () => {
    const { origin, seen } = await boot({ feed: () => undefined, chat: {} });
    const client = createWebSocketClient({
      url: `${origin.replace("http", "ws")}/chat`,
      reconnect: { minDelayMs: 1 },
      onMessage: () => undefined,
    });
    await until(() => expect(seen.opens).toBe(1));
    client.close();
    expect(client.status).toBe("closed");
    expect(seen.opens).toBe(1);
  });
});
