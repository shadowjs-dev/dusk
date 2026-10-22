import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import {
  createHandler,
  type DuskRuntimeManifest,
  type WebSocketHandlers,
} from "../src/server/index";
import { FrameReader, type WsEvent } from "../src/server/ws-protocol";
import { allFeatures } from "./support/features";

/**
 * WebSocket routes over real TCP sockets: the handshake bytes, the refusals, the frames both ways, the
 * close codes and shutdown. The client is a raw socket, so the test controls Origin, the version and
 * every frame; the server is `serve()` as an application runs it.
 */

type Event = { kind: string; text?: string; code?: number; reason?: string };

interface Client {
  readonly socket: Socket;
  readonly status: number;
  readonly headers: Map<string, string>;
  /** The next event of the connection, or the next one of `kind`. */
  next(kind?: string): Promise<Event>;
  send(kind: "text" | "binary" | "close" | "ping", payload?: Uint8Array | string): void;
  /** Resolves when the socket has closed. */
  closed: Promise<void>;
}

/** A frame of the server, as the test reads it: text is a string, the others carry their fields. */
function asEvent(event: WsEvent): Event {
  const decoder = new TextDecoder();
  if (event.kind === "text") return { kind: "text", text: decoder.decode(event.data) };
  if (event.kind === "ping" || event.kind === "pong")
    return { kind: event.kind, text: decoder.decode(event.data) };
  if (event.kind === "close") return { kind: "close", code: event.code, reason: event.reason };
  return { kind: event.kind };
}

const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const chat: WebSocketHandlers = {
  upgrade(event) {
    if (event.url.pathname.endsWith("/refuse")) return new Response("no session", { status: 401 });
    if (event.request.headers.get("x-session") === "gone")
      return new Response(null, { status: 403 });
    return undefined;
  },
  open(ws) {
    ws.data["greeted"] = true;
    ws.send("welcome");
  },
  message(ws, message) {
    if (typeof message === "string") ws.send(`echo:${message}`);
    else ws.send(new Uint8Array([...message].reverse()));
  },
};

async function boot(
  options: { maxMessageBytes?: number } = {},
): Promise<{ port: number; handle: ServerHandle }> {
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
      streams: [
        { id: "/chat", path: "/chat", kinds: ["WS"], load: async () => ({ WS: chat }) },
        {
          id: "/chat/refuse",
          path: "/chat/refuse",
          kinds: ["WS"],
          load: async () => ({ WS: chat }),
        },
        {
          id: "/feed",
          path: "/feed",
          kinds: ["SSE"],
          load: async () => ({ SSE: () => undefined }),
        },
      ] satisfies NonNullable<DuskRuntimeManifest["streams"]>,
    },
    dev: true,
    streams:
      options.maxMessageBytes === undefined ? {} : { wsMaxMessageBytes: options.maxMessageBytes },
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
  return { port: handle.port, handle };
}

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";

/** Opens a raw connection, sends the upgrade request, and resolves with the response head. */
async function open(
  port: number,
  path: string,
  extra: Record<string, string> = {},
): Promise<Client> {
  const socket = connect(port, "127.0.0.1");
  const reader = new FrameReader({ maxMessageBytes: 1 << 20, requireMask: false });
  const queue: Event[] = [];
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  let pending = new Uint8Array(0);
  let resolveHead: (value: { status: number; headers: Map<string, string> }) => void = () =>
    undefined;
  const head = new Promise<{ status: number; headers: Map<string, string> }>((resolve) => {
    resolveHead = resolve;
  });
  let headDone = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socket.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    if (headDone) {
      for (const event of reader.push(bytes)) queue.push(asEvent(event));
      notify();
      return;
    }
    const merged = new Uint8Array(pending.byteLength + bytes.byteLength);
    merged.set(pending, 0);
    merged.set(bytes, pending.byteLength);
    pending = merged;
    const text = new TextDecoder().decode(pending);
    const end = text.indexOf("\r\n\r\n");
    if (end === -1) return;
    headDone = true;
    const lines = text.slice(0, end).split("\r\n");
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    const status = Number((lines[0] ?? "").split(" ")[1]);
    resolveHead({ status, headers });
    const headBytes = new TextEncoder().encode(text.slice(0, end + 4)).byteLength;
    const rest = pending.subarray(headBytes);
    pending = new Uint8Array(0);
    if (status === 101 && rest.byteLength > 0) {
      for (const event of reader.push(rest)) queue.push(asEvent(event));
      notify();
    }
  });
  socket.on("close", () => {
    resolveClosed();
    resolveHead({ status: 0, headers: new Map() });
  });
  socket.on("error", () => {
    resolveClosed();
  });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${KEY}`,
    "Sec-WebSocket-Version: 13",
    `Origin: http://127.0.0.1:${port}`,
    ...Object.entries(extra).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  socket.write(headers.join("\r\n"));
  const answered = await head;
  return {
    socket,
    status: answered.status,
    headers: answered.headers,
    closed,
    next(kind) {
      return new Promise<Event>((resolve) => {
        const take = (): boolean => {
          const index = queue.findIndex((event) => kind === undefined || event.kind === kind);
          if (index === -1) return false;
          const [event] = queue.splice(index, 1);
          if (event !== undefined) resolve(event);
          listeners.delete(take);
          return true;
        };
        if (!take()) listeners.add(take);
      });
    },
    send(kind, payload) {
      const opcode = { text: 1, binary: 2, close: 8, ping: 9 }[kind];
      const bytes =
        typeof payload === "string"
          ? new TextEncoder().encode(payload)
          : (payload ?? new Uint8Array(0));
      const key = new Uint8Array([7, 8, 9, 10]);
      const masked = new Uint8Array(bytes.map((byte, index) => byte ^ (key[index % 4] ?? 0)));
      socket.write(new Uint8Array([0x80 | opcode, 0x80 | masked.byteLength, ...key, ...masked]));
    },
  };
}

function acceptOf(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

describe("WebSocket: the handshake", () => {
  it("[WS-40] a same-origin upgrade is accepted with the RFC accept key, and open runs before any frame", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat");
    expect(client.status).toBe(101);
    expect(client.headers.get("sec-websocket-accept")).toBe(acceptOf(KEY));
    expect(client.headers.get("upgrade")?.toLowerCase()).toBe("websocket");
    expect(await client.next()).toEqual({ kind: "text", text: "welcome" });
    client.socket.destroy();
  });

  it("[WS-41] a cross-origin upgrade is refused with 403 and no connection", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat", { Origin: "https://evil.example" });
    expect(client.status).toBe(403);
    await client.closed;
  });

  it("[WS-42] an upgrade without an Origin is refused by default (CSRF-style check on the handshake)", async () => {
    const { port } = await boot();
    const socket = connect(port, "127.0.0.1");
    socket.write(
      [
        `GET /chat HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${KEY}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const head = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("latin1");
        if (text.includes("\r\n\r\n")) resolve(text);
      });
    });
    expect(head.startsWith("HTTP/1.1 403")).toBe(true);
    socket.destroy();
  });

  it("[WS-43] a wrong Sec-WebSocket-Version is 426 and names the version the server speaks", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat", { "Sec-WebSocket-Version": "8" });
    expect(client.status).toBe(426);
    expect(client.headers.get("sec-websocket-version")).toBe("13");
  });

  it("[WS-44] a plain GET of a WebSocket-only path is 426 Upgrade Required", async () => {
    const { port } = await boot();
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(response.status).toBe(426);
    expect(response.headers.get("upgrade")).toBe("websocket");
  });

  it("[WS-45] the route's upgrade hook refuses with its own response: no connection opens", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat/refuse");
    expect(client.status).toBe(401);
    await client.closed;
  });

  it("[WS-46] the upgrade hook reads the session from the cookies of the upgrade request", async () => {
    const { port } = await boot();
    const denied = await open(port, "/chat", { "X-Session": "gone" });
    expect(denied.status).toBe(403);
    const allowed = await open(port, "/chat", { Cookie: "session=ok" });
    expect(allowed.status).toBe(101);
    allowed.socket.destroy();
  });

  it("[WS-47] a key that is not 16 bytes of base64 is a 400", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat", { "Sec-WebSocket-Key": "not-a-key" });
    expect(client.status).toBe(400);
  });
});

describe("WebSocket: frames and close codes over the socket", () => {
  it("[WS-48] text and binary messages are delivered in order and answered in kind", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat");
    await client.next();
    client.send("text", "ping-pong");
    expect(await client.next()).toEqual({ kind: "text", text: "echo:ping-pong" });
    client.send("binary", new Uint8Array([1, 2, 3]));
    expect(await client.next()).toEqual({ kind: "binary", text: undefined });
    client.socket.destroy();
  });

  it("[WS-49] a ping is answered with a pong", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat");
    await client.next();
    client.send("ping", "are you there");
    expect(await client.next()).toEqual({ kind: "pong", text: "are you there" });
    client.socket.destroy();
  });

  it("[WS-50] a client close is answered with a close frame carrying the code, and the socket ends", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat");
    await client.next();
    client.send("close", new Uint8Array([0x03, 0xe8]));
    expect(await client.next()).toEqual({ kind: "close", code: 1000, reason: "" });
    await client.closed;
  });

  it("[WS-51] a message over the size limit closes the socket with 1009", async () => {
    const { port } = await boot({ maxMessageBytes: 16 });
    const client = await open(port, "/chat");
    await client.next();
    client.send("text", "x".repeat(64));
    expect(await client.next()).toEqual({ kind: "close", code: 1009, reason: "" });
    await client.closed;
  });

  it("[WS-52] an unmasked client frame is a protocol error: the socket closes with 1002", async () => {
    const { port } = await boot();
    const client = await open(port, "/chat");
    await client.next();
    client.socket.write(new Uint8Array([0x81, 0x02, 0x68, 0x69]));
    expect(await client.next()).toEqual({ kind: "close", code: 1002, reason: "" });
  });

  it("[WS-53] shutdown ends open connections", async () => {
    const { port, handle } = await boot();
    const client = await open(port, "/chat");
    await client.next();
    await handle.close();
    await client.closed;
    expect(client.socket.destroyed).toBe(true);
  });
});
