import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streams } from "../src/features/streams";
import { type ServerHandle, serve } from "../src/node/index";
import {
  createHandler,
  HttpError,
  type Middleware,
  redirect,
  rewrite,
  type StreamOptions,
  type UpgradeDecision,
  type WebSocketHandlers,
  type WebSocketInput,
} from "../src/server/index";
import { createConnectionTracker } from "../src/server/ws-connections";

/**
 * Residual security risks R-5 and R-6 of Dusk:
 *
 * - R-5: a `message` handler that never settles can have only so many calls in flight on one connection, and one
 *   client address (and the process) can hold only so many upgraded connections. Both are decided without a
 *   socket (the connection cap) or by closing with 1013 (the in-flight bound).
 * - R-6: the app-wide middleware runs for a WebSocket upgrade, after the guards, the handshake and the origin
 *   check, and before the route's `WS.upgrade` hook.
 *
 * The upgrade is driven through `handler.upgrade(request, platform)` (the contract every transport uses) with a
 * recording sink, so no timer and no socket is needed; one test per behavior that depends on the Node
 * transport uses `serve()` and a raw socket.
 */

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const ORIGIN = "http://localhost";

function upgradeRequest(path = "/chat", headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": KEY,
      "sec-websocket-version": "13",
      origin: ORIGIN,
      ...headers,
    },
  });
}

interface Booted {
  readonly decide: (
    request?: Request,
    address?: string | undefined | null,
  ) => Promise<UpgradeDecision>;
  readonly errors: unknown[];
}

interface BootOptions {
  readonly ws?: WebSocketHandlers;
  readonly middleware?: readonly Middleware[];
  readonly streams?: StreamOptions;
  /** Development mode (default true); false shows the production error bodies. */
  readonly dev?: boolean;
  /** The module of `/chat` (default: `{ WS: ws }`). */
  readonly module?: () => Promise<unknown>;
}

function manifestOf(options: BootOptions) {
  return {
    routes: [],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
    streams: [
      {
        id: "/chat",
        path: "/chat",
        kinds: ["WS" as const],
        load: async () => (await (options.module?.() ?? { WS: options.ws ?? {} })) as never,
      },
      {
        id: "/feed",
        path: "/feed",
        kinds: ["SSE" as const],
        load: async () => ({ SSE: () => undefined }) as never,
      },
    ],
  };
}

function handlerOf(options: BootOptions, errors: unknown[] = []) {
  return createHandler({
    features: [streams()],
    manifest: manifestOf(options),
    dev: options.dev ?? true,
    // Production needs a host list (G-C6); the requests of this file are for ORIGIN.
    security: { allowedHosts: ["localhost", "127.0.0.1"] },
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    ...(options.streams === undefined ? {} : { streams: options.streams }),
    onError: (error) => void errors.push(error),
    onWarning: () => undefined,
  });
}

function boot(options: BootOptions = {}): Booted {
  const errors: unknown[] = [];
  const handler = handlerOf(options, errors);
  const upgrade = handler.upgrade;
  if (upgrade === undefined) throw new Error("the handler has no upgrade");
  return {
    errors,
    // `null` is a platform without an address; a string is the peer address; the default is one fixed peer.
    decide: (request = upgradeRequest(), address = "203.0.113.7") =>
      upgrade.call(handler, request, address === null ? undefined : { clientAddress: address }),
  };
}

interface Wire {
  readonly frames: Uint8Array[];
  ended: boolean;
  readonly sink: { write(bytes: Uint8Array): void; end(): void };
  /** The code of the first close frame the server wrote, or undefined. */
  closeCode(): number | undefined;
}

function wire(): Wire {
  const frames: Uint8Array[] = [];
  const out: Wire = {
    frames,
    ended: false,
    sink: {
      write(bytes) {
        frames.push(bytes);
      },
      end() {
        out.ended = true;
      },
    },
    closeCode() {
      const frame = frames.find((bytes) => ((bytes[0] ?? 0) & 0x0f) === 8);
      return frame === undefined ? undefined : ((frame[2] ?? 0) << 8) | (frame[3] ?? 0);
    },
  };
  return out;
}

/** A masked text frame, as a browser sends it. */
function text(value: string): Uint8Array {
  const payload = new TextEncoder().encode(value);
  const key = [1, 2, 3, 4];
  const masked = payload.map((byte, index) => byte ^ (key[index % 4] ?? 0));
  return new Uint8Array([0x81, 0x80 | payload.byteLength, ...key, ...masked]);
}

/** Every connection a test opened, closed after it so no ping timer outlives the test. */
const opened: WebSocketInput[] = [];

function accepted(decision: UpgradeDecision, sink: Wire["sink"] = wire().sink): WebSocketInput {
  if (decision.kind !== "websocket") {
    throw new Error(`expected an accepted upgrade, got ${decision.response.status}`);
  }
  const input = decision.start(sink);
  opened.push(input);
  return input;
}

function rejected(decision: UpgradeDecision): Response {
  if (decision.kind !== "reject") throw new Error("expected a refused upgrade");
  return decision.response;
}

/** A promise that settles when the test says so, so a handler can stay in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const input of opened.splice(0)) input.closed();
  for (const server of servers.splice(0)) await server.close();
});

describe("SEC-R5 in-flight message handlers", () => {
  /** A route whose `message` stays in flight until the test releases it. */
  function slow() {
    const gates: ReturnType<typeof deferred>[] = [];
    const seen: string[] = [];
    const ws: WebSocketHandlers = {
      message(_ws, message) {
        seen.push(String(message));
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
    };
    return { ws, gates, seen };
  }

  it("SEC-R5-01 the default bound is 16: the 17th message in flight closes the connection with 1013 and does not run the handler", async () => {
    const route = slow();
    const app = boot({ ws: route.ws });
    const wire1 = wire();
    const input = accepted(await app.decide(), wire1.sink);
    for (let index = 0; index < 16; index += 1) input.push(text(`m${index}`));
    expect(route.seen).toHaveLength(16);
    expect(wire1.closeCode()).toBeUndefined();
    input.push(text("m16"));
    expect(route.seen).toHaveLength(16);
    expect(wire1.closeCode()).toBe(1013);
    expect(wire1.ended).toBe(true);
    for (const gate of route.gates) gate.resolve();
  });

  it("SEC-R5-02 a handler that settles frees its slot: the bound counts calls in flight, not messages received", async () => {
    const route = slow();
    const app = boot({ ws: route.ws, streams: { wsMaxInFlightMessages: 2 } });
    const wire1 = wire();
    const input = accepted(await app.decide(), wire1.sink);
    input.push(text("a"));
    input.push(text("b"));
    route.gates[0]?.resolve();
    // The settle of `a` is observed on a microtask; wait for it through the route's own promise.
    await route.gates[0]?.promise;
    await Promise.resolve();
    input.push(text("c"));
    expect(route.seen).toEqual(["a", "b", "c"]);
    expect(wire1.closeCode()).toBeUndefined();
    input.push(text("d"));
    expect(wire1.closeCode()).toBe(1013);
    for (const gate of route.gates) gate.resolve();
  });

  it("SEC-R5-03 a handler that returns synchronously never counts: a long run of messages stays open", async () => {
    const seen: string[] = [];
    const app = boot({
      ws: {
        message(_ws, message) {
          seen.push(String(message));
        },
      },
      streams: { wsMaxInFlightMessages: 1, wsMaxMessagesPerSecond: 1000 },
    });
    const wire1 = wire();
    const input = accepted(await app.decide(), wire1.sink);
    for (let index = 0; index < 200; index += 1) input.push(text("x"));
    expect(seen).toHaveLength(200);
    expect(wire1.closeCode()).toBeUndefined();
  });

  it("SEC-R5-04 the bound is per connection: one connection at its bound does not slow another", async () => {
    const route = slow();
    const app = boot({ ws: route.ws, streams: { wsMaxInFlightMessages: 1 } });
    const first = wire();
    const second = wire();
    const a = accepted(await app.decide(), first.sink);
    const b = accepted(await app.decide(), second.sink);
    a.push(text("a1"));
    a.push(text("a2"));
    expect(first.closeCode()).toBe(1013);
    b.push(text("b1"));
    expect(second.closeCode()).toBeUndefined();
    expect(route.seen).toEqual(["a1", "b1"]);
    for (const gate of route.gates) gate.resolve();
  });

  it("SEC-R5-05 the close that enforces the bound aborts the connection's signal and tells the close handler 1013", async () => {
    const signals: AbortSignal[] = [];
    const closes: number[] = [];
    const gate = deferred();
    const app = boot({
      ws: {
        message(ws) {
          signals.push(ws.signal);
          return gate.promise;
        },
        close(_ws, code) {
          closes.push(code);
        },
      },
      streams: { wsMaxInFlightMessages: 1 },
    });
    const input = accepted(await app.decide());
    input.push(text("one"));
    input.push(text("two"));
    expect(signals[0]?.aborted).toBe(true);
    expect(closes).toEqual([1013]);
    gate.resolve();
  });

  it("SEC-R5-06 a rejected in-flight handler still closes with 1011 and frees its slot (the bound does not mask failures)", async () => {
    const reports: unknown[] = [];
    const reported = deferred();
    const app = boot({
      ws: {
        message() {
          return Promise.reject(new Error("boom"));
        },
        error(_ws, error) {
          reports.push(error);
          reported.resolve();
        },
      },
    });
    const sink = wire();
    const input = accepted(await app.decide(), sink.sink);
    input.push(text("x"));
    await reported.promise;
    expect(reports).toHaveLength(1);
    expect(sink.closeCode()).toBe(1011);
  });

  it("SEC-R5-07 wsMaxInFlightMessages must be a positive integer, and is a known stream option", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => boot({ streams: { wsMaxInFlightMessages: bad } })).toThrow(
        /wsMaxInFlightMessages must be a positive integer/,
      );
    }
    expect(() => boot({ streams: { wsMaxInFlightMessages: 1000 } })).not.toThrow();
  });
});

describe("SEC-R5 connections per client address", () => {
  it("SEC-R5-10 the third upgrade from one address is a 503 with Retry-After, decided before a socket exists; other addresses are unaffected", async () => {
    const app = boot({ streams: { wsMaxConnectionsPerAddress: 2 } });
    accepted(await app.decide(undefined, "198.51.100.1"));
    accepted(await app.decide(undefined, "198.51.100.1"));
    const refusal = rejected(await app.decide(undefined, "198.51.100.1"));
    expect(refusal.status).toBe(503);
    expect(Number(refusal.headers.get("retry-after"))).toBeGreaterThan(0);
    accepted(await app.decide(undefined, "198.51.100.2"));
  });

  it("SEC-R5-11 the default is 100 per address: the 101st is refused", async () => {
    const app = boot();
    for (let index = 0; index < 100; index += 1) accepted(await app.decide());
    expect(rejected(await app.decide()).status).toBe(503);
  });

  it("SEC-R5-12 a closed connection frees its slot, whoever closed it: the client, the server or the in-flight bound", async () => {
    const gate = deferred();
    const app = boot({
      ws: {
        message(ws, message) {
          if (message === "bye") ws.close(1000, "bye");
          return message === "slow" ? gate.promise : undefined;
        },
      },
      streams: { wsMaxConnectionsPerAddress: 1, wsMaxInFlightMessages: 1 },
    });
    // The client goes away.
    const first = accepted(await app.decide());
    expect(rejected(await app.decide()).status).toBe(503);
    first.closed();
    // The server closes.
    const second = accepted(await app.decide());
    second.push(text("bye"));
    // The in-flight bound closes.
    const third = accepted(await app.decide());
    third.push(text("slow"));
    third.push(text("slow"));
    accepted(await app.decide());
    gate.resolve();
  });

  it("SEC-R5-13 an upgrade the route or the hook refuses does not keep a slot: refusals never fill the cap", async () => {
    const app = boot({
      ws: { upgrade: () => new Response("no", { status: 401 }) },
      streams: { wsMaxConnectionsPerAddress: 1 },
    });
    for (let index = 0; index < 5; index += 1) {
      expect(rejected(await app.decide()).status).toBe(401);
    }
    const open = boot({
      ws: {
        upgrade: (event) =>
          event.url.search === "?no" ? new Response(null, { status: 403 }) : undefined,
      },
      streams: { wsMaxConnectionsPerAddress: 1 },
    });
    expect(rejected(await open.decide(upgradeRequest("/chat?no"))).status).toBe(403);
    expect(rejected(await open.decide(upgradeRequest("/chat?no"))).status).toBe(403);
    accepted(await open.decide());
  });

  it("SEC-R5-14 a refused upgrade runs nothing user-written: no middleware, no upgrade hook", async () => {
    const calls: string[] = [];
    const app = boot({
      ws: {
        upgrade() {
          calls.push("hook");
        },
      },
      middleware: [
        (_event, next) => {
          calls.push("middleware");
          return next();
        },
      ],
      streams: { wsMaxConnectionsPerAddress: 1 },
    });
    accepted(await app.decide());
    calls.length = 0;
    expect(rejected(await app.decide()).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("SEC-R5-15 the cap is a function of the client address the rate limiter uses: IPv6 clients share their /64, IPv4-mapped is IPv4", async () => {
    const app = boot({ streams: { wsMaxConnectionsPerAddress: 1 } });
    accepted(await app.decide(undefined, "2001:db8:1:2::1"));
    expect(rejected(await app.decide(undefined, "2001:db8:1:2:ffff::9")).status).toBe(503);
    accepted(await app.decide(undefined, "2001:db8:1:3::1"));
    accepted(await app.decide(undefined, "192.0.2.9"));
    expect(rejected(await app.decide(undefined, "::ffff:192.0.2.9")).status).toBe(503);
  });

  it("SEC-R5-16 a platform that reports no address has no per-address bucket (one shared bucket would lock everyone out); false turns the cap off", async () => {
    const app = boot({ streams: { wsMaxConnectionsPerAddress: 1 } });
    accepted(await app.decide(undefined, null));
    accepted(await app.decide(undefined, null));
    const off = boot({ streams: { wsMaxConnectionsPerAddress: false } });
    for (let index = 0; index < 150; index += 1) accepted(await off.decide());
  });

  it("SEC-R5-17 the total of connections is bounded too, and so is the bookkeeping: distinct addresses cannot grow it past the bound", async () => {
    const app = boot({ streams: { wsMaxConnections: 3 } });
    const inputs: WebSocketInput[] = [];
    for (let index = 0; index < 3; index += 1) {
      inputs.push(accepted(await app.decide(undefined, `198.51.100.${index + 1}`)));
    }
    for (let index = 0; index < 50; index += 1) {
      const refusal = rejected(await app.decide(undefined, `203.0.113.${index + 1}`));
      expect(refusal.status).toBe(503);
      expect(refusal.headers.get("retry-after")).not.toBeNull();
    }
    // Churn: close one, a new address takes the place.
    inputs[0]?.closed();
    accepted(await app.decide(undefined, "203.0.113.200"));
    expect(rejected(await app.decide(undefined, "203.0.113.201")).status).toBe(503);
    for (const input of inputs) input.closed();
  });

  it("SEC-R5-18 wsMaxConnections and wsMaxConnectionsPerAddress must be positive integers or false", () => {
    for (const name of ["wsMaxConnections", "wsMaxConnectionsPerAddress"] as const) {
      for (const bad of [0, -3, 2.5, Number.NaN]) {
        expect(() => boot({ streams: { [name]: bad } })).toThrow(
          new RegExp(`${name} must be a positive integer or false`),
        );
      }
      expect(() => boot({ streams: { [name]: false } })).not.toThrow();
    }
  });

  it("SEC-R5-19 an accepted decision the transport abandons (it never writes the 101) gives its slot back", async () => {
    const app = boot({ streams: { wsMaxConnectionsPerAddress: 1 } });
    const decision = await app.decide();
    if (decision.kind !== "websocket") throw new Error("expected an accepted upgrade");
    expect(rejected(await app.decide()).status).toBe(503);
    decision.abandon?.();
    decision.abandon?.();
    accepted(await app.decide());
    // A start after an abandon would be a transport bug; the slot is not given twice.
    expect(rejected(await app.decide()).status).toBe(503);
  });

  it("SEC-R5-20 over a real socket the refusal is an HTTP 503 with Retry-After, and a client that hangs up frees its slot", async () => {
    const closed = deferred();
    const handler = handlerOf({
      ws: {
        close() {
          closed.resolve();
        },
      },
      streams: { wsMaxConnectionsPerAddress: 1 },
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
    const first = await rawUpgrade(handle.port);
    expect(first.status).toBe(101);
    const second = await rawUpgrade(handle.port);
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).not.toBeNull();
    second.socket.destroy();
    first.socket.destroy();
    await closed.promise;
    const third = await rawUpgrade(handle.port);
    expect(third.status).toBe(101);
    third.socket.destroy();
  });
});

describe("SEC-R5 connection bookkeeping", () => {
  it("SEC-R5-21 the table of addresses never grows past the total cap, and empties as connections end", () => {
    const tracker = createConnectionTracker({ perAddress: 2, total: 5 });
    const slots = [];
    let refused = 0;
    for (let index = 0; index < 1000; index += 1) {
      const slot = tracker.acquire(`198.51.100.${index % 250}`);
      if (slot === undefined) refused += 1;
      else slots.push(slot);
      expect(tracker.addresses).toBeLessThanOrEqual(5);
      expect(tracker.open).toBeLessThanOrEqual(5);
    }
    expect(slots).toHaveLength(5);
    expect(refused).toBe(995);
    for (const slot of slots) {
      slot.release();
      slot.release();
    }
    expect(tracker.open).toBe(0);
    expect(tracker.addresses).toBe(0);
  });

  it("SEC-R5-22 with the total cap off the table still holds only addresses that have a connection", () => {
    const tracker = createConnectionTracker({ perAddress: 1, total: false });
    const slots = Array.from({ length: 50 }, (_, index) => tracker.acquire(`192.0.2.${index}`));
    expect(tracker.addresses).toBe(50);
    expect(tracker.acquire("192.0.2.3")).toBeUndefined();
    for (const slot of slots) slot?.release();
    expect(tracker.addresses).toBe(0);
  });
});

/** Sends an upgrade request on a raw socket and resolves with the status line and headers of the answer. */
async function rawUpgrade(port: number) {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    [
      "GET /chat HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${KEY}`,
      "Sec-WebSocket-Version: 13",
      `Origin: http://127.0.0.1:${port}`,
      "",
      "",
    ].join("\r\n"),
  );
  const head = await new Promise<string>((resolve) => {
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
      if (received.includes("\r\n\r\n")) resolve(received);
    });
    socket.on("close", () => resolve(received));
  });
  const lines = head.split("\r\n\r\n")[0]?.split("\r\n") ?? [];
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return { socket, status: Number((lines[0] ?? "").split(" ")[1]), headers };
}

describe("SEC-R6 global middleware on the upgrade", () => {
  it("SEC-R6-01 the app-wide middleware runs on the upgrade, around the route's upgrade hook, and next() leads to the hook and then to the accepted upgrade", async () => {
    const order: string[] = [];
    const app = boot({
      middleware: [
        async (event, next) => {
          order.push(`before ${event.route.kind} ${event.url.pathname}`);
          const response = await next();
          order.push("after");
          return response;
        },
      ],
      ws: {
        upgrade() {
          order.push("hook");
        },
        open() {
          order.push("open");
        },
      },
    });
    const decision = await app.decide();
    expect(decision.kind).toBe("websocket");
    accepted(decision);
    expect(order).toEqual(["before stream /chat", "hook", "after", "open"]);
  });

  it("SEC-R6-02 a middleware that returns a Response refuses the upgrade with it: no 101, no socket, no hook, no open", async () => {
    const calls: string[] = [];
    const app = boot({
      middleware: [
        (event) =>
          event.request.headers.has("authorization")
            ? new Response("fine", { status: 200 })
            : new Response("sign in", { status: 401, headers: { "www-authenticate": "Bearer" } }),
      ],
      ws: {
        upgrade() {
          calls.push("hook");
        },
        open() {
          calls.push("open");
        },
      },
    });
    const denied = rejected(await app.decide());
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    expect(await denied.text()).toBe("sign in");
    // A 200 is not an upgrade either: only the chain reaching the route's hook accepts.
    const ok = rejected(await app.decide(upgradeRequest("/chat", { authorization: "Bearer x" })));
    expect(ok.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("SEC-R6-03 the guards, the handshake, the origin check and the route match come first: for a request they refuse, no middleware runs", async () => {
    const ran: string[] = [];
    const app = boot({
      middleware: [
        (event, next) => {
          ran.push(event.url.pathname);
          return next();
        },
      ],
    });
    const cases: [Request, number][] = [
      [upgradeRequest("/chat", { origin: "https://evil.example" }), 403],
      [upgradeRequest("/chat", { "sec-websocket-version": "8" }), 426],
      [upgradeRequest("/chat", { "sec-websocket-key": "short" }), 400],
      [upgradeRequest("/chat", { upgrade: "h2c" }), 400],
      [upgradeRequest(`/chat?${"a".repeat(9000)}`), 414],
      [upgradeRequest("/nowhere"), 404],
      [upgradeRequest("/feed"), 404],
      [new Request(`${ORIGIN}/chat`, { method: "POST", headers: { origin: ORIGIN } }), 405],
    ];
    for (const [request, status] of cases) {
      expect(rejected(await app.decide(request)).status).toBe(status);
    }
    expect(ran).toEqual([]);
    accepted(await app.decide());
    expect(ran).toEqual(["/chat"]);
  });

  it("SEC-R6-04 a rewrite, a replaced response or a swallowed next() never accepts: only the response next() handed back can", async () => {
    const accepts = async (middleware: Middleware): Promise<UpgradeDecision> =>
      boot({ middleware: [middleware] }).decide();
    expect(rejected(await accepts(() => rewrite("/other"))).status).toBe(404);
    expect(
      rejected(
        await accepts(async (_event, next) => {
          await next();
          return new Response(null, { status: 204 });
        }),
      ).status,
    ).toBe(204);
    expect(
      rejected(
        await accepts(async (_event, next) => {
          const response = await next();
          return new Response(response.body, response);
        }),
      ).status,
    ).toBe(204);
    // Reading the answer of next() and handing it back unchanged is the way to proceed.
    expect((await accepts(async (_event, next) => next())).kind).toBe("websocket");
  });

  it("SEC-R6-05 what the middleware stores on the event reaches the route's upgrade hook and its handlers (locals), as for any route", async () => {
    const seen: unknown[] = [];
    const app = boot({
      middleware: [
        (event, next) => {
          (event.locals as Record<string, unknown>)["user"] = "ada";
          return next();
        },
      ],
      ws: {
        upgrade(event) {
          seen.push((event.locals as Record<string, unknown>)["user"]);
        },
        open(_ws, event) {
          seen.push((event.locals as Record<string, unknown>)["user"]);
        },
      },
    });
    accepted(await app.decide());
    expect(seen).toEqual(["ada", "ada"]);
  });

  it("SEC-R6-06 headers and cookies a middleware sets are kept on a refusal and not carried by the 101 (the handshake answers with its own three headers)", async () => {
    const stamp: Middleware = async (event, next) => {
      event.responseHeaders.set("x-stamp", "1");
      event.cookies.set("seen", "1");
      const response = await next();
      response.headers.set("x-from-response", "1");
      return response;
    };
    const refused = boot({
      middleware: [stamp],
      ws: { upgrade: () => new Response(null, { status: 401 }) },
    });
    const denied = rejected(await refused.decide());
    expect(denied.status).toBe(401);
    expect(denied.headers.get("x-stamp")).toBe("1");
    expect(denied.headers.get("x-from-response")).toBe("1");
    expect(denied.headers.getSetCookie().some((cookie) => cookie.startsWith("seen=1"))).toBe(true);

    const open = boot({ middleware: [stamp] });
    const decision = await open.decide();
    if (decision.kind !== "websocket") throw new Error("expected an accepted upgrade");
    expect(Object.keys(decision.headers).sort()).toEqual([
      "connection",
      "sec-websocket-accept",
      "upgrade",
    ]);
  });

  it("SEC-R6-07 a failure in the chain is mapped like on any route: HttpError keeps its status, redirect() is a redirect, an unexpected error is a 500 reported once", async () => {
    const run = async (middleware: Middleware) => {
      const app = boot({ middleware: [middleware], dev: false });
      return { response: rejected(await app.decide()), errors: app.errors };
    };
    const denied = await run(() => {
      throw new HttpError(401, "sign in");
    });
    expect(denied.response.status).toBe(401);
    expect(denied.errors).toEqual([]);
    const moved = await run(() => {
      throw redirect("/login");
    });
    expect(moved.response.status).toBeGreaterThanOrEqual(300);
    expect(moved.response.status).toBeLessThan(400);
    expect(moved.response.headers.get("location")).toBe("/login");
    const broken = await run(async () => {
      throw new Error("middleware bug");
    });
    expect(broken.response.status).toBe(500);
    expect(broken.errors).toHaveLength(1);
    expect(await broken.response.text()).not.toContain("middleware bug");
  });

  it("SEC-R6-08 a middleware sees the failure of the route's upgrade hook as a response (next() settles), and the upgrade is refused with it", async () => {
    const statuses: number[] = [];
    const app = boot({
      middleware: [
        async (_event, next) => {
          const response = await next();
          statuses.push(response.status);
          return response;
        },
      ],
      ws: {
        upgrade() {
          throw new HttpError(403, "banned");
        },
      },
    });
    expect(rejected(await app.decide()).status).toBe(403);
    expect(statuses).toEqual([403]);
  });

  it("SEC-R6-09 a refusal by the middleware keeps no connection slot (the cap counts accepted upgrades only)", async () => {
    let deny = true;
    const app = boot({
      middleware: [(_event, next) => (deny ? new Response(null, { status: 401 }) : next())],
      streams: { wsMaxConnectionsPerAddress: 1 },
    });
    for (let index = 0; index < 4; index += 1)
      expect(rejected(await app.decide()).status).toBe(401);
    deny = false;
    accepted(await app.decide());
  });

  it("SEC-R6-10 a middleware that calls next() twice gets the usual programming error, and the upgrade is not accepted", async () => {
    const app = boot({
      middleware: [
        async (_event, next) => {
          await next();
          return next();
        },
      ],
    });
    expect(rejected(await app.decide()).status).toBe(500);
  });

  it("SEC-R6-11 without app-wide middleware nothing changes: the hook alone decides, and the module is loaded once per upgrade", async () => {
    let loads = 0;
    const app = boot({
      module: async () => {
        loads += 1;
        return {
          WS: {
            upgrade: (event: { url: URL }) =>
              event.url.search === "?no" ? new Response(null, { status: 401 }) : undefined,
          },
        };
      },
    });
    expect(rejected(await app.decide(upgradeRequest("/chat?no"))).status).toBe(401);
    accepted(await app.decide());
    expect(loads).toBe(2);
  });

  it("SEC-R6-12 the middleware is an owner of its own authentication: a session check there protects a route that has no upgrade hook", async () => {
    const app = boot({
      middleware: [
        (event, next) =>
          event.cookies.get("session") === "ok" ? next() : new Response(null, { status: 401 }),
      ],
      ws: {},
    });
    expect(rejected(await app.decide()).status).toBe(401);
    expect((await app.decide(upgradeRequest("/chat", { cookie: "session=ok" }))).kind).toBe(
      "websocket",
    );
  });
});
