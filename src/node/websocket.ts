import { type IncomingMessage, STATUS_CODES } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { UpgradeDecision, WebSocketSink } from "../server/index";
import { platformOf } from "./bridge";
import { isClientDisconnect } from "./serve";

/**
 * The Node transport of WebSocket routes: an HTTP `upgrade` event becomes a decision of the handler
 * (refused, or accepted), then either a plain HTTP response is written and the socket ends, or the 101
 * handshake is written and the socket carries the connection. The frames are the protocol's own
 * (`server/ws-protocol.ts`), so nothing here knows the framing.
 */

/** What the upgrade listener needs from the server. @internal */
export interface UpgradeContext {
  /** The handler's decision (`createHandler(...).upgrade`). */
  readonly decide: (request: Request, platform: unknown) => Promise<UpgradeDecision>;
  /** https servers give `https:` request URLs. */
  readonly secure: boolean;
  /** True once shutdown started: new upgrades are refused with 503. */
  readonly draining: () => boolean;
  /** Receives failures nobody can answer (a broken socket, a handler that threw). */
  readonly report: (error: unknown) => void;
  /** Every upgraded socket, so a shutdown can end them. */
  readonly sockets: Set<Duplex>;
}

// A host name or address with an optional port: no path, user info, spaces or quotes. The same pattern `bridge.ts` applies
// to every other request: the upgrade is built from the same two parts, so it is held to the same rule.
const HOST = /^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** How many times a header name appears in the raw header list (the Fetch `Headers` would join the copies). */
function occurrences(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

/**
 * The Web `Request` of an upgrade: the method is GET, the URL is `scheme://host` + the request target, the headers are the
 * request's. Undefined when the request cannot be represented or is not what an HTTP client sends: a missing, repeated or
 * malformed Host (one with a path, a `?`, user info), a target that is not an origin-form path, an invalid header value.
 * The Host decides the URL the routes and the origin check see, so it is checked as strictly as for a plain request.
 * @internal
 */
export function upgradeRequestOf(req: IncomingMessage, secure: boolean): Request | undefined {
  const host = req.headers.host;
  const target = req.url ?? "/";
  if (typeof host !== "string" || !HOST.test(host) || !target.startsWith("/")) return undefined;
  if (occurrences(req.rawHeaders, "host") > 1) return undefined;
  const url = `${secure ? "https" : "http"}://${host}${target}`;
  if (!URL.canParse(url)) return undefined;
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    return new Request(url, { method: "GET", headers });
  } catch (error) {
    // An invalid header value: the request is refused below, as a malformed request.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Writes an HTTP response to a socket that has not been upgraded, then ends the socket. */
async function refuse(
  socket: Duplex,
  status: number,
  message: string,
  headers: Headers,
  body: string | null,
): Promise<void> {
  const bytes = body === null ? new Uint8Array(0) : new TextEncoder().encode(body);
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? message}`];
  headers.forEach((value, name) => {
    if (name !== "set-cookie") lines.push(`${name}: ${value}`);
  });
  for (const cookie of headers.getSetCookie()) lines.push(`set-cookie: ${cookie}`);
  lines.push(`content-length: ${bytes.byteLength}`, "connection: close", "", "");
  socket.write(lines.join("\r\n"));
  socket.end(bytes);
}

/** The socket as the connection's sink: frames are written as they come; the end is the close. */
function sinkOf(socket: Duplex): WebSocketSink {
  return {
    write(bytes) {
      if (!socket.destroyed) socket.write(bytes);
    },
    end() {
      socket.end();
    },
    buffered: () => socket.writableLength,
    destroy: () => socket.destroy(),
  };
}

/**
 * Answers one upgrade request on its socket: a refusal, or the 101 handshake and the connection.
 * Never throws; a failure is reported and the socket is destroyed.
 *
 * @param req The upgrade request.
 * @param socket The socket (the TCP connection, after the request line).
 * @param head Bytes the client sent after its request, already read.
 * @param context The handler and the server state.
 * @internal
 */
export async function answerUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: UpgradeContext,
): Promise<void> {
  let decision: UpgradeDecision | undefined;
  // Node removes its own error listener from an upgraded socket. A client that resets the connection while a refusal is being
  // written (every browser does after a failed handshake) would otherwise raise an uncaught exception and end the process.
  const early = (error: unknown): void => {
    if (!isClientDisconnect(error)) context.report(error);
    socket.destroy();
  };
  socket.on("error", early);
  try {
    if (context.draining()) {
      await refuse(socket, 503, "Service Unavailable", new Headers({ "retry-after": "1" }), null);
      return;
    }
    const request = upgradeRequestOf(req, context.secure);
    if (request === undefined) {
      await refuse(socket, 400, "Bad Request", new Headers(), null);
      return;
    }
    decision = await context.decide(request, platformOf(req));
    if (decision.kind === "reject") {
      const body = await decision.response.text();
      await refuse(
        socket,
        decision.response.status,
        decision.response.statusText,
        decision.response.headers,
        body,
      );
      return;
    }
    // The client hung up while the decision ran: no connection will start, so its slot goes back.
    if (socket.destroyed) {
      decision.abandon?.();
      return;
    }
    const lines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${decision.headers["sec-websocket-accept"] ?? ""}`,
      "",
      "",
    ];
    socket.write(lines.join("\r\n"));
    // From here the connection's own handler (below) owns errors.
    socket.removeListener("error", early);
    // Small frames are sent as they are written: Nagle's delay would add latency to every message.
    if (socket instanceof Socket) socket.setNoDelay(true);
    context.sockets.add(socket);
    const input = decision.start(sinkOf(socket));
    socket.on("data", (chunk: Buffer) => {
      input.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    // `http.Server` keeps sockets half-open, so a peer that hangs up without a close frame ends the readable
    // side only; without this the connection (and its slot under the connection caps) would wait for the pong timeout.
    socket.on("end", () => {
      input.closed();
    });
    socket.on("close", () => {
      context.sockets.delete(socket);
      input.closed();
    });
    socket.on("error", (error: unknown) => {
      if (!isClientDisconnect(error)) context.report(error);
      input.closed();
      socket.destroy();
    });
    if (head.byteLength > 0)
      input.push(new Uint8Array(head.buffer, head.byteOffset, head.byteLength));
  } catch (error) {
    // A decision that was accepted but never started gives its connection slot back (no-op after `start`).
    if (decision?.kind === "websocket") decision.abandon?.();
    context.report(error);
    socket.destroy();
  }
}
