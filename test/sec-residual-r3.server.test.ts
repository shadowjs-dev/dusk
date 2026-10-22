import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ServeOptions, type ServerHandle, serve } from "../src/node/index";
import type { Handler } from "../src/server/types";
import { deferred } from "./support/deferred";
import { settled, statusOf } from "./support/net";

/**
 * SEC-R3: `serve()` bounds what a single client can hold. A cap on concurrent sockets, a header and a body
 * read timeout (slowloris), a short keep-alive with a request limit per socket, and a drop for a client that
 * stops reading a response. Every test runs against a real socket on 127.0.0.1 with limits of a few hundred
 * milliseconds and waits for the socket's own events, never for a fixed time.
 */

const servers: ServerHandle[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const okHandler: Handler = {
  fetch: async () =>
    new Response("ok", { headers: { "content-type": "text/plain", "content-length": "2" } }),
};

/** Starts a server on an ephemeral port. Limits that a test does not set keep their defaults. */
async function boot(
  options: ServeOptions = {},
  handler: Handler = okHandler,
): Promise<{
  handle: ServerHandle;
  errors: unknown[];
  accepted: Array<{ socket: Socket; closed: Promise<void> }>;
  untilAccepted(count: number): Promise<void>;
}> {
  const errors: unknown[] = [];
  const accepted: Array<{ socket: Socket; closed: Promise<void> }> = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  const handle = await serve(handler, {
    port: 0,
    host: "127.0.0.1",
    compress: false,
    shutdownSignals: false,
    onError: (error) => {
      errors.push(error);
    },
    ...options,
  });
  servers.push(handle);
  handle.server.on("connection", (socket: Socket) => {
    accepted.push({
      socket,
      closed: new Promise<void>((resolve) => socket.once("close", () => resolve())),
    });
    for (const wait of waiting) if (accepted.length >= wait.count) wait.resolve();
  });
  return {
    handle,
    errors,
    accepted,
    untilAccepted(count) {
      if (accepted.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.push({ count, resolve }));
    },
  };
}

interface Client {
  readonly socket: Socket;
  /** Everything received so far, as latin1 text. */
  text(): string;
  /** Resolves when the connection is closed, whoever closed it. */
  readonly closed: Promise<void>;
  /** Resolves when `text()` contains `needle`. */
  until(needle: string): Promise<void>;
}

/** Opens a raw TCP connection to the server. */
async function open(port: number): Promise<Client> {
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  const chunks: Buffer[] = [];
  const watchers: Array<{ needle: string; resolve: () => void }> = [];
  const text = (): string => Buffer.concat(chunks).toString("latin1");
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    const seen = text();
    for (const watcher of watchers) if (seen.includes(watcher.needle)) watcher.resolve();
  });
  // A reset is how a dropped connection may look to the client; the test asserts on `closed`.
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // A connection the server drops at once may close before (or without) a connect event on this side.
  await Promise.race([
    new Promise<void>((resolve) => socket.once("connect", () => resolve())),
    closed,
  ]);
  return {
    socket,
    text,
    closed,
    until(needle) {
      if (text().includes(needle)) return Promise.resolve();
      return new Promise<void>((resolve) => watchers.push({ needle, resolve }));
    },
  };
}

const GET = "GET / HTTP/1.1\r\nHost: app.test\r\nConnection: keep-alive\r\n\r\n";

/** A handler whose body is `chunks` pieces of 64 KiB, pulled on demand; it tells when the reader went away. */
function bigStream(chunks: number): {
  handler: Handler;
  pulled: () => number;
  canceled: Promise<void>;
} {
  let pulls = 0;
  const canceled = deferred<void>();
  const piece = new Uint8Array(65_536).fill(97);
  const handler: Handler = {
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls >= chunks) controller.close();
            else {
              pulls += 1;
              controller.enqueue(piece);
            }
          },
          cancel() {
            canceled.resolve();
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      ),
  };
  return { handler, pulled: () => pulls, canceled: canceled.promise };
}

describe("SEC-R3 defaults and opt-outs", () => {
  it("[SEC-R3-01] a call with no limit options gets the documented defaults", async () => {
    const { handle } = await boot();
    expect(handle.server.maxConnections).toBe(10_000);
    expect(handle.server.headersTimeout).toBe(30_000);
    expect(handle.server.requestTimeout).toBe(120_000);
    expect(handle.server.keepAliveTimeout).toBe(5_000);
    expect(handle.server.maxRequestsPerSocket).toBe(1_000);
    expect(handle.server.timeout).toBe(60_000);
    expect(handle.droppedConnections).toBe(0);
    expect(handle.droppedSlowClients).toBe(0);
  });

  it("[SEC-R3-02] every limit has an explicit opt-out: 0 turns it off", async () => {
    const { handle } = await boot({
      maxConnections: 0,
      maxRequestsPerSocket: 0,
      writeTimeoutMs: 0,
    });
    expect(handle.server.maxConnections).toBeUndefined();
    expect(handle.server.maxRequestsPerSocket ?? 0).toBe(0);
    expect(handle.server.timeout).toBe(0);
  });

  it("[SEC-R3-03] a value that is not a non-negative integer is refused with the option's name", async () => {
    const bad: Array<[keyof ServeOptions, unknown]> = [
      ["maxConnections", -1],
      ["maxConnections", Number.NaN],
      ["maxConnections", 1.5],
      ["maxConnections", "100"],
      ["maxRequestsPerSocket", -5],
      ["writeTimeoutMs", Number.POSITIVE_INFINITY],
      ["keepAliveTimeoutMs", -1],
      ["headersTimeoutMs", "30000"],
      ["requestTimeoutMs", Number.NaN],
    ];
    for (const [name, value] of bad) {
      const options: Record<string, unknown> = { port: 0, shutdownSignals: false, [name]: value };
      await expect(serve(okHandler, options as ServeOptions)).rejects.toThrow(
        new RegExp(`serve\\(\\).*\`${name}\``),
      );
    }
  });

  it("[SEC-R3-04] a misspelled limit option is still refused as unknown", async () => {
    await expect(
      serve(okHandler, { port: 0, shutdownSignals: false, maxConnection: 5 } as ServeOptions),
    ).rejects.toThrow(/maxConnections/);
  });
});

describe("SEC-R3 connection cap", () => {
  it("[SEC-R3-05] a connection above maxConnections is closed at once, and the others keep working", async () => {
    const { handle, accepted, untilAccepted } = await boot({ maxConnections: 2 });
    const first = await open(handle.port);
    const second = await open(handle.port);
    await untilAccepted(2);
    const third = await open(handle.port);
    await third.closed;
    expect(third.text()).toBe("");
    expect(handle.droppedConnections).toBe(1);
    expect(accepted).toHaveLength(2);
    // The two sockets inside the cap are untouched.
    first.socket.write(GET);
    await first.until("\r\n\r\nok");
    expect(statusOf(first.text())).toBe(200);
    second.socket.write(GET);
    await second.until("\r\n\r\nok");
    expect(statusOf(second.text())).toBe(200);
  });

  it("[SEC-R3-06] a slot is free again once a connection closes", async () => {
    const { handle, accepted, untilAccepted } = await boot({ maxConnections: 1 });
    const first = await open(handle.port);
    await untilAccepted(1);
    const refused = await open(handle.port);
    await refused.closed;
    expect(handle.droppedConnections).toBe(1);
    first.socket.destroy();
    await accepted[0]?.closed;
    const again = await open(handle.port);
    again.socket.write(GET);
    await again.until("\r\n\r\nok");
    expect(statusOf(again.text())).toBe(200);
    expect(handle.droppedConnections).toBe(1);
  });

  it("[SEC-R3-07] with maxConnections: 0 nothing is dropped", async () => {
    const { handle, untilAccepted } = await boot({ maxConnections: 0 });
    const clients = [];
    for (let index = 0; index < 20; index += 1) clients.push(await open(handle.port));
    await untilAccepted(20);
    expect(handle.droppedConnections).toBe(0);
  });
});

describe("SEC-R3 read timeouts", () => {
  it("[SEC-R3-08] a header trickle is closed by the header timeout, however slowly it keeps writing", async () => {
    const { handle } = await boot({ headersTimeoutMs: 200, requestTimeoutMs: 2_000 });
    const client = await open(handle.port);
    client.socket.write("GET / HTTP/1.1\r\nHost: app.test\r\n");
    // One more header line every few milliseconds keeps an idle timer alive; the header timeout is a deadline.
    const trickle = setInterval(() => {
      if (!client.socket.destroyed) client.socket.write("X-Pad: 1\r\n");
    }, 10);
    try {
      await client.closed;
    } finally {
      clearInterval(trickle);
    }
    expect(statusOf(client.text())).toBe(408);
  });

  it("[SEC-R3-09] a request body that stalls is closed by the request timeout and aborts the handler", async () => {
    const aborted = deferred<void>();
    const handler: Handler = {
      fetch: async (request) => {
        request.signal.addEventListener("abort", () => aborted.resolve());
        try {
          return new Response(await request.text());
        } catch {
          // The body ended with the connection: the handler has nothing left to answer.
          return new Response("aborted", { status: 499 });
        }
      },
    };
    const { handle } = await boot({ headersTimeoutMs: 100, requestTimeoutMs: 250 }, handler);
    const client = await open(handle.port);
    client.socket.write(
      "POST / HTTP/1.1\r\nHost: app.test\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\n0123456789",
    );
    await client.closed;
    await aborted.promise;
  });

  it("[SEC-R3-10] a request that arrives inside the timeouts is answered normally", async () => {
    const handler: Handler = {
      fetch: async (request) => new Response(`got:${await request.text()}`),
    };
    const { handle } = await boot({ headersTimeoutMs: 500, requestTimeoutMs: 1_000 }, handler);
    const client = await open(handle.port);
    client.socket.write(
      "POST / HTTP/1.1\r\nHost: app.test\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
    );
    await client.closed;
    expect(statusOf(client.text())).toBe(200);
    expect(client.text()).toContain("got:hello");
  });
});

describe("SEC-R3 keep-alive", () => {
  it("[SEC-R3-11] an idle keep-alive socket is closed after keepAliveTimeoutMs", async () => {
    const { handle } = await boot({ keepAliveTimeoutMs: 100 });
    // Node adds a safety buffer (a second) to the keep-alive timeout; the test does not need to wait for it.
    handle.server.keepAliveTimeoutBuffer = 0;
    const client = await open(handle.port);
    client.socket.write(GET);
    await client.until("\r\n\r\nok");
    expect(client.text().toLowerCase()).toContain("keep-alive: timeout=");
    await client.closed;
  });

  it("[SEC-R3-12] the last request a socket may carry is answered with Connection: close and the socket ends", async () => {
    // Node leaves the last socket to the client or to the keep-alive timeout, so that one is short here.
    const { handle } = await boot({ maxRequestsPerSocket: 2, keepAliveTimeoutMs: 100 });
    handle.server.keepAliveTimeoutBuffer = 0;
    const client = await open(handle.port);
    client.socket.write(GET);
    await client.until("\r\n\r\nok");
    expect(client.text().toLowerCase()).not.toContain("connection: close");
    expect(client.socket.destroyed).toBe(false);
    client.socket.write(GET);
    await client.closed;
    const answers = client.text().split("HTTP/1.1 ").slice(1);
    expect(answers).toHaveLength(2);
    expect(answers[1]?.toLowerCase()).toContain("connection: close");
  });

  it("[SEC-R3-13] requests pipelined past the limit are refused with 503, not served", async () => {
    // Node leaves the last socket to the client or to the keep-alive timeout, so that one is short here.
    const { handle } = await boot({ maxRequestsPerSocket: 2, keepAliveTimeoutMs: 100 });
    handle.server.keepAliveTimeoutBuffer = 0;
    const client = await open(handle.port);
    client.socket.write(GET + GET + GET);
    await client.closed;
    const statuses = client
      .text()
      .split("HTTP/1.1 ")
      .slice(1)
      .map((part) => Number(part.slice(0, 3)));
    expect(statuses).toEqual([200, 200, 503]);
  });

  it("[SEC-R3-14] a socket that has used up its limit does not stop a new one from being served", async () => {
    const { handle } = await boot({ maxRequestsPerSocket: 1, keepAliveTimeoutMs: 100 });
    handle.server.keepAliveTimeoutBuffer = 0;
    for (let round = 0; round < 3; round += 1) {
      const client = await open(handle.port);
      client.socket.write(GET);
      await client.closed;
      expect(statusOf(client.text())).toBe(200);
    }
  });
});

describe("SEC-R3 slow readers", () => {
  it("[SEC-R3-15] a client that never reads a large response is dropped, and the render is canceled", async () => {
    const { handler, pulled, canceled } = bigStream(2_048);
    const { handle, accepted, errors, untilAccepted } = await boot(
      { writeTimeoutMs: 200 },
      handler,
    );
    const client = await open(handle.port);
    await untilAccepted(1);
    client.socket.pause();
    client.socket.write(GET);
    await canceled;
    await accepted[0]?.closed;
    expect(handle.droppedSlowClients).toBe(1);
    // Backpressure held the producer back: it did not run to the end of the 128 MiB body.
    expect(pulled()).toBeLessThan(2_048);
    // The default error sink treats a slow client like a disconnect (no console output); a custom sink hears of it.
    expect(errors).toHaveLength(1);
    expect(Reflect.get(errors[0] as object, "code")).toBe("ERR_DUSK_SLOW_CLIENT");
    expect(handle.draining).toBe(false);
  });

  it("[SEC-R3-16] a stalled reader of a static file is dropped too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-r3-"));
    dirs.push(dir);
    writeFileSync(join(dir, "big.bin"), Buffer.alloc(48 * 1024 * 1024, 98));
    const { handle, accepted, untilAccepted } = await boot({
      writeTimeoutMs: 200,
      static: { dir },
    });
    const client = await open(handle.port);
    await untilAccepted(1);
    client.socket.pause();
    client.socket.write(
      "GET /big.bin HTTP/1.1\r\nHost: app.test\r\nConnection: keep-alive\r\n\r\n",
    );
    await accepted[0]?.closed;
    expect(handle.droppedSlowClients).toBe(1);
  });

  it("[SEC-R3-17] a handler that is still working is not a slow reader: an idle socket with nothing to write survives the timeout", async () => {
    const gate = deferred<Response>();
    const handler: Handler = { fetch: () => gate.promise };
    const { handle } = await boot({ writeTimeoutMs: 100 }, handler);
    const timeouts = deferred<void>();
    let fired = 0;
    handle.server.on("timeout", () => {
      fired += 1;
      if (fired === 3) timeouts.resolve();
    });
    const client = await open(handle.port);
    client.socket.write(GET);
    await timeouts.promise;
    expect(client.socket.destroyed).toBe(false);
    expect(handle.droppedSlowClients).toBe(0);
    gate.resolve(new Response("late"));
    await client.until("late");
    expect(statusOf(client.text())).toBe(200);
  });

  it("[SEC-R3-18] an idle keep-alive socket is closed at keepAliveTimeoutMs even when writeTimeoutMs is longer", async () => {
    const { handle, accepted, untilAccepted } = await boot({
      keepAliveTimeoutMs: 100,
      writeTimeoutMs: 60_000,
    });
    handle.server.keepAliveTimeoutBuffer = 0;
    const client = await open(handle.port);
    await untilAccepted(1);
    client.socket.write(GET);
    await client.until("\r\n\r\nok");
    await accepted[0]?.closed;
    expect(handle.droppedSlowClients).toBe(0);
  });

  it("[SEC-R3-19] a client that reads a large response completely gets every byte, once", async () => {
    const size = 3 * 1024 * 1024 + 17;
    const body = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) body[index] = (index * 31) & 0xff;
    const handler: Handler = {
      fetch: async () =>
        new Response(body, { headers: { "content-type": "application/octet-stream" } }),
    };
    const { handle } = await boot({ writeTimeoutMs: 5_000 }, handler);
    const response = await fetch(`${handle.url}/`, { headers: { "accept-encoding": "identity" } });
    const received = new Uint8Array(await response.arrayBuffer());
    expect(received.byteLength).toBe(size);
    expect(createHash("sha256").update(received).digest("hex")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(handle.droppedSlowClients).toBe(0);
  });

  it("[SEC-R3-21] one large chunk is written to the socket in slices, so a stalled client holds back at most one slice", async () => {
    const handler: Handler = {
      fetch: async () =>
        new Response(new Uint8Array(32 * 1024 * 1024).fill(99), {
          headers: { "content-type": "application/octet-stream" },
        }),
    };
    const { handle, accepted, untilAccepted } = await boot({ writeTimeoutMs: 0 }, handler);
    const client = await open(handle.port);
    await untilAccepted(1);
    client.socket.pause();
    client.socket.write(GET);
    const server = accepted[0]?.socket;
    // Wait until the server has written all the kernel takes and its buffer stops changing.
    await settled(() => server?.writableLength);
    expect(server?.bytesWritten).toBeGreaterThan(0);
    expect(server?.writableLength).toBeLessThanOrEqual(256 * 1024);
  });

  it("[SEC-R3-20] an upgraded socket is not under the write timeout (a WebSocket may stay silent)", async () => {
    const handler: Handler = {
      fetch: async () => new Response("no"),
      upgrade: async () => ({
        kind: "websocket",
        headers: { "sec-websocket-accept": "x" },
        start: () => ({ push: () => undefined, closed: () => undefined }),
      }),
    };
    const { handle, accepted, untilAccepted } = await boot({ writeTimeoutMs: 100 }, handler);
    const client = await open(handle.port);
    await untilAccepted(1);
    client.socket.write(
      "GET /ws HTTP/1.1\r\nHost: app.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
    await client.until("\r\n\r\n");
    expect(statusOf(client.text())).toBe(101);
    expect(accepted[0]?.socket.timeout).toBe(0);
    expect(client.socket.destroyed).toBe(false);
  });
});
