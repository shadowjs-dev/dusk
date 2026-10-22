import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { Server as NetServer, Socket } from "node:net";
import { type Duplex, pipeline, type Writable } from "node:stream";
import { assertKnownOptions } from "../internal/known-options";
import { hostCheckOf } from "../server/host-policy";
import type { AssetDecision, Handler } from "../server/types";
import { WORKER_HEADER_ENV, workerInfo } from "../shared/worker-info";
import { callHandler, platformOf, requestUrlOf, toWebRequest } from "./bridge";
import type { PoolControl, SuperviseOptions } from "./cluster";
import { linkToPrimary } from "./cluster-worker";
import {
  type CompressOptions,
  type Compressor,
  createCompressor,
  isCompressible,
  negotiateEncoding,
} from "./compress";
import {
  checkingIntervalOf,
  guardSlowClients,
  resolveLimits,
  SLOW_CLIENT_CODE,
  type SlowClientGuard,
} from "./connection-limits";
import { createStaticServer, type StaticContext, type StaticOptions } from "./static-files";
import { answerUpgrade } from "./websocket";
import { resolveWorkerCount } from "./worker-count";

/** The part of `process` the server uses for shutdown signals. @since 1.0.0 */
export interface SignalTarget {
  once(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
}

/** Options of {@link serve}. @since 1.0.0 */
export interface ServeOptions {
  /** Port to listen on; `0` picks a free one. Default 3000. */
  readonly port?: number;
  /** Interface to listen on. Default `"127.0.0.1"`; use `"0.0.0.0"` in a container. */
  readonly host?: string;
  /** Serve files of a directory before the handler (the client build output). */
  readonly static?: false | StaticOptions;
  /**
   * Compress responses (brotli, zstd where `node:zlib` has it, gzip). On by default; `false` leaves it to a proxy.
   * See {@link CompressOptions} for the level, the types and the `filter` that skips responses that reflect secrets.
   */
  readonly compress?: false | CompressOptions;
  /**
   * Send `103 Early Hints` for a page request: the entry script, the stylesheets and the matched routes' preloads go
   * out as `Link` headers (at most 8, same-origin only) before the page's data loads, so the browser starts fetching
   * them while the server renders. The final response carries the same `Link` header either way. HTTP/1.1 clients
   * only. Default `true`.
   */
  readonly earlyHints?: boolean;
  /** Believe `X-Forwarded-Proto` / `X-Forwarded-Host`. Only behind a proxy you control. Default `false`. */
  readonly trustProxy?: boolean;
  /** How long a shutdown waits for requests in flight before closing connections. Default 10 000. */
  readonly gracefulShutdownMs?: number;
  /** Signals that start a graceful shutdown. Default `["SIGTERM", "SIGINT"]`; `false` registers none. */
  readonly shutdownSignals?: false | readonly string[];
  /** Where signal listeners are registered. Default: `process`. */
  readonly signalTarget?: SignalTarget;
  /** After a signal-triggered shutdown, call `exit(0)`. Default `true`. */
  readonly exitOnSignal?: boolean;
  /** Called with the exit code after a signal-triggered shutdown. Default: `process.exit`. */
  readonly exit?: (code: number) => void;
  /**
   * Time to receive the request headers, in milliseconds. A deadline from the first byte of the request, not an
   * idle timer, so a client that sends one header line every second (slowloris) is closed with 408 all the same.
   * Default 30 000; `0` turns it off.
   */
  readonly headersTimeoutMs?: number;
  /**
   * Time to receive the whole request, headers and body, in milliseconds. A body that stalls or trickles is
   * closed with 408 and aborts the handler's `request.signal`. Raise it for routes that accept large uploads
   * over slow links. Default 120 000; `0` turns it off.
   */
  readonly requestTimeoutMs?: number;
  /** Idle time before a keep-alive connection is closed, in milliseconds. Default 5 000; `0` turns it off. */
  readonly keepAliveTimeoutMs?: number;
  /**
   * Most sockets open at once (counting upgraded WebSockets). A connection above the cap is closed before a byte
   * is read; the count is `ServerHandle.droppedConnections`. Default 10 000; `0` turns the cap off.
   */
  readonly maxConnections?: number;
  /**
   * Most requests one keep-alive socket may carry. The last one is answered with `Connection: close`, and a
   * request pipelined beyond the limit gets 503. Default 1 000; `0` turns the limit off.
   */
  readonly maxRequestsPerSocket?: number;
  /**
   * How long a response may make no progress, in milliseconds: a client that stops reading a large or streamed
   * response (its socket has bytes waiting and nothing is written or read for this long) is disconnected, which
   * cancels the response body. A handler that is merely slow to produce data is not affected, and neither is an
   * upgraded WebSocket. Default 60 000; `0` turns it off.
   */
  readonly writeTimeoutMs?: number;
  /** Largest request header block in bytes. Default 16 384. */
  readonly maxHeaderBytes?: number;
  /**
   * Run the server in several processes that share the port (`node:cluster`). A whole number from 1, or `"auto"`: one per
   * available core, at most 16. Absent or 1: one process, as before. With more than one, the process that calls `serve`
   * becomes a primary that forks the workers (each runs this same program and so calls `serve` too), replaces a worker that
   * dies, replaces them all on `SIGUSR2` without a gap, and stops them gracefully on `SIGTERM`/`SIGINT`. It resolves once
   * every worker listens, with a handle whose `role` is `"primary"` and whose `pool` controls the workers; a worker gets a handle with `role` `"worker"`.
   * Entries of in-memory stores are per worker: see the "Using every core" section of the deploy guide.
   */
  readonly workers?: number | "auto";
  /** How the primary supervises the workers: restart delays, the crash-loop breaker, the restart signal. See {@link SuperviseOptions}. */
  readonly supervise?: SuperviseOptions;
  /** Serve https with these TLS options instead of http. */
  readonly tls?: HttpsServerOptions;
  /** Receives failures that cannot be sent to the client (a body that broke mid-stream). Default: `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/** A running server. @since 1.0.0 */
export interface ServerHandle {
  /**
   * `"single"` for one process, `"worker"` inside a worker pool, `"primary"` for the process that forks the workers and
   * serves nothing (its `server` never listens and its counters stay 0; use `pool`).
   */
  readonly role: "single" | "worker" | "primary";
  /** The controls of the worker pool; present when `role` is `"primary"`. */
  readonly pool?: PoolControl;
  /** The port in use (useful with `port: 0`). */
  readonly port: number;
  readonly host: string;
  /** `http(s)://host:port`. */
  readonly url: string;
  /** The underlying Node server. */
  readonly server: Server | HttpsServer;
  /** True after shutdown started: new requests get 503. */
  readonly draining: boolean;
  /** Connections closed at once because `maxConnections` was reached. */
  readonly droppedConnections: number;
  /** Clients disconnected because they stopped reading their response (`writeTimeoutMs`). */
  readonly droppedSlowClients: number;
  /**
   * Stops accepting connections, lets requests in flight finish for up to `gracefulShutdownMs`,
   * then closes what is left. Safe to call more than once.
   */
  close(): Promise<void>;
}

const DEFAULT_SIGNALS: readonly string[] = ["SIGTERM", "SIGINT"];

/** How long a worker that is being replaced keeps its open connections working before it cuts the idle ones, in milliseconds. */
const QUIESCE_MS = 1000;

/** The most `close` listeners one response holds at a time (see `onRequest`). */
const RESPONSE_CLOSE_LISTENERS = 16;

/** The most bytes one write to the socket carries (see `sendResponse`). */
const WRITE_SLICE_BYTES = 65_536;

/** Statuses and methods whose response has no body. */
function hasNoBody(status: number, method: string): boolean {
  return method === "HEAD" || status === 204 || status === 304 || status < 200;
}

/** Writes a plain text answer. */
function plain(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(message);
}

/** Everything {@link sendResponse} needs besides the response. @internal */
export interface SendContext {
  /** The request method (`HEAD` sends no body). */
  readonly method: string;
  /** The request, which the compression `filter` is asked about (absent for a refusal made before a request existed). */
  readonly request: Request | undefined;
  /** The request's `Accept-Encoding`. */
  readonly acceptEncoding: string | undefined;
  /** Bounded compressor, or `undefined`. */
  readonly compressor: Compressor | undefined;
  /** Ask the client to close the connection after this response (shutdown in progress). */
  readonly closeConnection: boolean;
  /** Receives failures that cannot be reported to the client any more. */
  readonly onError: (error: unknown) => void;
}

/** Resolves when the sink drains or the response closes, and leaves no listener behind. */
function drained(sink: Writable, res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      sink.off("drain", done);
      res.off("close", done);
      resolve();
    };
    sink.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Sends a Web `Response` to a Node response: status, headers (several `Set-Cookie` lines stay
 * separate), then the body as a stream with backpressure. A client that disconnects cancels the
 * body, which in turn aborts the render. Compression flushes after every chunk, so a streamed
 * page still arrives progressively.
 *
 * @param res The Node response.
 * @param response The Web response.
 * @param context Method, negotiation inputs and shutdown state.
 * @internal
 */
export async function sendResponse(
  res: ServerResponse,
  response: Response,
  context: SendContext,
): Promise<void> {
  const { compressor } = context;
  const noBody = hasNoBody(response.status, context.method) || response.body === null;
  const type = response.headers.get("content-type");
  const length = response.headers.get("content-length");
  const cacheControl = response.headers.get("cache-control") ?? "";
  const encoding =
    compressor !== undefined &&
    !noBody &&
    response.status !== 206 &&
    !response.headers.has("content-encoding") &&
    !/no-transform/i.test(cacheControl) &&
    compressor.compressible(type) &&
    !(type ?? "").toLowerCase().startsWith("text/event-stream") &&
    (length === null || Number(length) >= compressor.minBytes)
      ? negotiateEncoding(context.acceptEncoding)
      : undefined;
  // The app's filter is asked last, only for a response that would be compressed.
  const compression =
    encoding === undefined ||
    compressor === undefined ||
    !compressor.permits(context.request, response, context.onError)
      ? undefined
      : compressor.open(encoding);

  res.statusCode = response.status;
  if (response.statusText !== "") res.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    if (compression !== undefined && (name === "content-length" || name === "etag")) continue;
    res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (compression !== undefined && encoding !== undefined) {
    res.setHeader("content-encoding", encoding);
    const etag = response.headers.get("etag");
    if (etag !== null) res.setHeader("etag", etag.startsWith("W/") ? etag : `W/${etag}`);
  }
  // A compressible answer varies on Accept-Encoding whether or not this server compresses it: a proxy that does
  // (or the platform in front) must not hand a gzipped copy to a client that did not ask for one.
  if ((compressor?.compressible ?? isCompressible)(type)) {
    const vary = response.headers.get("vary");
    if (vary === null) res.setHeader("vary", "Accept-Encoding");
    else if (!/accept-encoding/i.test(vary)) res.setHeader("vary", `${vary}, Accept-Encoding`);
  }
  if (context.closeConnection) res.setHeader("connection", "close");

  if (noBody || response.body === null) {
    compression?.release();
    await response.body?.cancel();
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let gone = false;
  const onClose = (): void => {
    gone = true;
    reader.cancel().catch(context.onError);
  };
  res.once("close", onClose);
  const sink: Writable = compression === undefined ? res : compression.stream;
  if (compression !== undefined) {
    pipeline(compression.stream, res, (error) => {
      compression.release();
      if (error !== undefined && error !== null && !gone) context.onError(error);
    });
  }
  res.flushHeaders();
  try {
    while (!gone) {
      const { done, value } = await reader.read();
      if (done) break;
      if (gone) break;
      // One huge chunk is one socket write that completes only when the client has read all of it, so a
      // slow-but-moving client would look stalled to the write timeout. Slices keep progress observable.
      for (let offset = 0; offset < value.byteLength && !gone; offset += WRITE_SLICE_BYTES) {
        const last = offset + WRITE_SLICE_BYTES >= value.byteLength;
        const accepted = sink.write(
          offset === 0 && last ? value : value.subarray(offset, offset + WRITE_SLICE_BYTES),
        );
        if (last && compression !== undefined && length === null) compression.flush();
        if (!accepted) await drained(sink, res);
      }
      if (value.byteLength === 0 && compression !== undefined && length === null)
        compression.flush();
    }
    if (!gone) sink.end();
  } catch (error) {
    // The body failed after the status line was sent: the only honest signal left is a broken connection.
    if (!gone) context.onError(error);
    compression?.release();
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    res.off("close", onClose);
  }
  if (!res.closed) await new Promise<void>((resolve) => res.once("close", resolve));
}

/** Error codes Node raises when the other side closed the connection. */
const DISCONNECT_CODES: ReadonlySet<string> = new Set([
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_DESTROYED",
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "ERR_HTTP_REQUEST_TIMEOUT",
  SLOW_CLIENT_CODE,
]);

/** True for a failure that only means the client went away. @internal */
export function isClientDisconnect(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code: unknown = Reflect.get(error, "code");
  if (typeof code === "string" && DISCONNECT_CODES.has(code)) return true;
  return Reflect.get(error, "name") === "AbortError";
}

const SERVE_OPTIONS: ReadonlySet<string> = new Set([
  "port",
  "host",
  "static",
  "compress",
  "earlyHints",
  "trustProxy",
  "gracefulShutdownMs",
  "shutdownSignals",
  "signalTarget",
  "exitOnSignal",
  "exit",
  "headersTimeoutMs",
  "requestTimeoutMs",
  "keepAliveTimeoutMs",
  "maxConnections",
  "maxRequestsPerSocket",
  "writeTimeoutMs",
  "maxHeaderBytes",
  "workers",
  "supervise",
  "tls",
  "onError",
]);

/**
 * Serves a handler over HTTP with Node's `http` module.
 *
 * Requests become Web `Request`s with a streaming body and an abort signal that fires when the
 * client disconnects; responses stream back with backpressure. Static files (the client build)
 * are served first, with safe path resolution, validators, ranges and compression. Shutdown on
 * `SIGTERM` / `SIGINT` is graceful: no new connections, requests in flight finish, then exit.
 *
 * One client cannot hold the process open: sockets are capped (`maxConnections`), headers and the whole request
 * have deadlines (`headersTimeoutMs`, `requestTimeoutMs`), an idle keep-alive socket is closed
 * (`keepAliveTimeoutMs`) after a bounded number of requests (`maxRequestsPerSocket`), and a client that stops
 * reading its response is dropped (`writeTimeoutMs`). Each has a default; `0` turns one off.
 *
 * It reads no `.env` file. The server code sees `process.env` as the platform set it (the dev
 * server and the build's prerender step load the env files; production does not). Start with
 * `node --env-file=<file>` to keep a file next to the server.
 *
 * With `workers` above 1 the process becomes the primary of a worker pool (see {@link ServeOptions.workers}) and the handle's
 * `role` is `"primary"`. Without `workers` nothing of the pool is loaded.
 *
 * @param handler The fetch handler, usually from `createHandler`.
 * @param options Port, host, static files, compression, shutdown and workers.
 * @returns A running server (or, in the primary of a worker pool, the pool's handle).
 * @throws RangeError for an invalid `workers`.
 * @example
 * import { createHandler } from "@shadow-js/dusk/server";
 * import { serve } from "@shadow-js/dusk/node";
 * await serve(createHandler({ manifest, features: [pages()] }), { port: 3000, host: "0.0.0.0", static: { dir: "dist/client" } });
 * @since 1.0.0
 */
export async function serve(handler: Handler, options: ServeOptions = {}): Promise<ServerHandle> {
  assertKnownOptions("serve", options, SERVE_OPTIONS);
  const pool = workerInfo();
  const workers = resolveWorkerCount(options.workers);
  if (workers > 1 && !pool.clustered) {
    // Loaded only here: a server without workers never reads the supervisor.
    const { superviseWorkers } = await import("./cluster");
    return superviseWorkers({
      workers,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.gracefulShutdownMs === undefined
        ? {}
        : { gracefulShutdownMs: options.gracefulShutdownMs }),
      ...(options.shutdownSignals === undefined
        ? {}
        : { shutdownSignals: options.shutdownSignals }),
      ...(options.signalTarget === undefined ? {} : { signalTarget: options.signalTarget }),
      ...(options.exitOnSignal === undefined ? {} : { exitOnSignal: options.exitOnSignal }),
      ...(options.exit === undefined ? {} : { exit: options.exit }),
      ...(options.supervise === undefined ? {} : { supervise: options.supervise }),
      scheme: options.tls === undefined ? "http" : "https",
    });
  }
  // The worker id goes out as a header when the primary says so (by default outside production), so a developer can see which worker answered.
  const workerHeader =
    pool.clustered && process.env[WORKER_HEADER_ENV] === "1" ? String(pool.id) : undefined;
  const limits = resolveLimits(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;
  const gracefulMs = options.gracefulShutdownMs ?? 10_000;
  const trustProxy = options.trustProxy === true;
  const reportFailure =
    options.onError ??
    ((error: unknown): void => {
      // A browser that navigates away or a proxy that times out closes the socket mid-response: that
      // is the client's decision, not a server fault, and it happens on every busy site.
      if (isClientDisconnect(error)) return;
      console.error("[dusk] response failed", error);
    });
  const earlyHints = options.earlyHints !== false;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const compressor =
    options.compress === false ? undefined : createCompressor(options.compress ?? {});
  const statics =
    options.static === undefined || options.static === false
      ? undefined
      : createStaticServer(options.static);
  // The handler's own host list, read through the same URL the bridge builds: a file is answered for a Host the handler
  // would accept, and only then. Absent when the app has no host list, so that path does no host work.
  const hostCheck = hostCheckOf(handler);
  // A handler that runs its middleware for files (`runMiddlewareForStaticFiles`) is asked about each file before it is
  // sent: the gate's answer ends the request, or its headers go out with the file (see `StaticContext.gate`).
  const gateAsset = handler.gateAsset;
  const staticContext = (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
  ): StaticContext => {
    // The request the gate was asked about: the compression filter sees it with the gate's answer.
    let gated: Request | undefined;
    return {
      compressor,
      hostAllowed,
      ...(gateAsset === undefined
        ? {}
        : {
            gate: (asked: IncomingMessage): Promise<AssetDecision> => {
              const bridged = toWebRequest(asked, res, { trustProxy });
              if ("rejection" in bridged) {
                return Promise.resolve({
                  kind: "answer",
                  response: new Response(bridged.rejection.message, {
                    status: bridged.rejection.status,
                  }),
                });
              }
              gated = bridged.request;
              return gateAsset(bridged.request, platformOf(asked));
            },
            answer: (response: Response): Promise<void> =>
              sendResponse(res, response, {
                method,
                request: gated,
                acceptEncoding:
                  typeof req.headers["accept-encoding"] === "string"
                    ? req.headers["accept-encoding"]
                    : undefined,
                compressor,
                closeConnection: draining || quiescing,
                onError: reportFailure,
              }),
          }),
    };
  };
  const hostAllowed =
    hostCheck === undefined
      ? undefined
      : (req: IncomingMessage): boolean => {
          const built = requestUrlOf(req, { trustProxy });
          return "url" in built && hostCheck(built.url.host);
        };
  let inFlight = 0;
  let draining = false;
  // A worker told to leave by the primary first stops accepting and keeps answering on its open connections (with `Connection: close`).
  let quiescing = false;
  let drained: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let droppedConnections = 0;
  let slowGuard: SlowClientGuard | undefined;

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    inFlight += 1;
    if (workerHeader !== undefined) res.setHeader("x-dusk-worker", workerHeader);
    // A response that streams a compressed body holds a bounded set of `close` listeners at once:
    // this request's bookkeeping, the bridge, the compressor pipeline (about six) and one drain
    // wait. Node's default limit is 10 and would warn on a busy page, so the limit is raised to the
    // bound. Every listener is removed when its work ends; the count never grows with the body.
    res.setMaxListeners(RESPONSE_CLOSE_LISTENERS);
    const release = slowGuard?.open(req.socket);
    res.once("close", () => {
      release?.();
      inFlight -= 1;
      if (inFlight === 0) drained?.();
    });
    if (draining) {
      plain(res, 503, "Service Unavailable", { connection: "close", "retry-after": "1" });
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (req.url === "*") {
      res.writeHead(
        method === "OPTIONS" ? 204 : 400,
        method === "OPTIONS" ? { allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" } : {},
      );
      res.end();
      return;
    }
    if (statics !== undefined && (await statics.handle(req, res, staticContext(req, res, method))))
      return;
    const bridged = toWebRequest(req, res, { trustProxy });
    if ("rejection" in bridged) {
      plain(res, bridged.rejection.status, bridged.rejection.message, { connection: "close" });
      return;
    }
    const response = await callHandler(
      handler,
      bridged.request,
      platformOf(req, earlyHints ? res : undefined, reportFailure),
      reportFailure,
    );
    const accept =
      typeof req.headers["accept-encoding"] === "string"
        ? req.headers["accept-encoding"]
        : undefined;
    await sendResponse(res, response, {
      method,
      request: bridged.request,
      acceptEncoding: accept,
      compressor,
      closeConnection: draining || quiescing,
      onError: reportFailure,
    });
  };

  const listener = wrap(onRequest, reportFailure);
  const maxHeaderSize = options.maxHeaderBytes ?? 16_384;
  // Node looks for requests past their deadline only every 30 seconds unless told otherwise.
  const interval = checkingIntervalOf(limits);
  const checkingOf = interval === undefined ? {} : { connectionsCheckingInterval: interval };
  const server: Server | HttpsServer =
    options.tls === undefined
      ? createHttpServer({ maxHeaderSize, ...checkingOf }, listener)
      : createHttpsServer({ ...options.tls, maxHeaderSize, ...checkingOf }, listener);
  // WebSocket routes: the handler decides each upgrade, the socket carries the connection.
  const upgraded = new Set<Duplex>();
  const decide = handler.upgrade;
  if (decide !== undefined) {
    server.on("upgrade", (req, socket, head) => {
      // The connection is a WebSocket from here on: it may stay silent, and its liveness is the ping's job.
      if (socket instanceof Socket) socket.setTimeout(0);
      void answerUpgrade(req, socket, head, {
        decide: (request, platform) => decide.call(handler, request, platform),
        secure: options.tls !== undefined,
        draining: () => draining || quiescing,
        report: reportFailure,
        sockets: upgraded,
      });
    });
  }
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  // Node drops every connection when the cap is 0, so "no cap" is a cap that is never set.
  if (limits.maxConnections > 0) server.maxConnections = limits.maxConnections;
  server.on("drop", () => {
    droppedConnections += 1;
  });
  slowGuard = guardSlowClients(server, limits.writeTimeoutMs, reportFailure);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the server has no TCP address.");
  // In a worker pool: the primary may ask this worker to drain, and learns which stores live in this process only.
  // The server's own close, kept for the shutdown below (in a worker `server.close` is replaced, see further down).
  const closeHttpServer = server.close.bind(server);
  const link = linkToPrimary(() => shutdown(true), exit, reportFailure);
  link?.listening();
  const scheme = options.tls === undefined ? "http" : "https";
  const shownHost = host.includes(":") ? `[${host}]` : host;

  /**
   * Stops the server. `soft` is the worker's way out when the primary replaces it: the primary has already stopped handing it
   * connections (it disconnects the worker first), the listener is closed, and the open connections keep working for a moment, and each response tells its client
   * to close the connection. A client that is mid-stream on a kept-alive connection thus moves to the next worker without a
   * reset and without a 503. Then it ends like any shutdown.
   */
  const shutdown = (soft: boolean): Promise<void> => {
    closing ??= (async () => {
      // The primary must not count a worker that stops on its own (a signal sent to it) as a crash.
      link?.stopping();
      let stopped: Promise<void> | undefined;
      if (soft && options.tls === undefined) {
        quiescing = true;
        // The base class close: `http.Server#close` would also cut idle connections at once, which can reset a request in flight.
        stopped = new Promise<void>((resolve) =>
          NetServer.prototype.close.call(server, () => resolve()),
        );
        let settle: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => {
            settle = setTimeout(resolve, Math.min(QUIESCE_MS, gracefulMs));
          }),
        ]);
        clearTimeout(settle);
      }
      draining = true;
      stopped ??= new Promise<void>((resolve) => closeHttpServer(() => resolve()));
      server.closeIdleConnections();
      if (inFlight > 0) {
        const idle = new Promise<void>((resolve) => {
          drained = resolve;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, gracefulMs);
        });
        await Promise.race([idle, deadline]);
        clearTimeout(timer);
      }
      server.closeAllConnections();
      // Upgraded sockets are not HTTP connections: they are ended here (their handlers see 1006).
      for (const socket of upgraded) socket.destroy();
      await stopped;
      for (const [signal, registered] of listeners) target?.off(signal, registered);
      link?.dispose();
    })();
    return closing;
  };
  const close = (): Promise<void> => shutdown(false);
  if (link !== undefined) {
    // The primary retires a worker with `worker.disconnect()`, and the cluster module then calls `server.close()` on this
    // server. The `http.Server` version of it also cuts idle connections at once, which resets a request that a client
    // sends on one at that moment; the soft shutdown lets each client move on by itself.
    server.close = ((callback?: (error?: Error) => void) => {
      shutdown(true).then(
        () => callback?.(),
        (error: unknown) => callback?.(error instanceof Error ? error : new Error(String(error))),
      );
      return server;
    }) as typeof server.close;
  }

  const signals = options.shutdownSignals === undefined ? DEFAULT_SIGNALS : options.shutdownSignals;
  const target = signals === false ? undefined : (options.signalTarget ?? process);
  const listeners: Array<readonly [string, () => void]> = [];
  if (target !== undefined && signals !== false) {
    for (const signal of signals) {
      const onSignal = (): void => {
        close()
          .then(() => {
            if (options.exitOnSignal !== false) exit(0);
          })
          .catch(reportFailure);
      };
      listeners.push([signal, onSignal]);
      target.once(signal, onSignal);
    }
  }

  return {
    role: link === undefined ? "single" : "worker",
    port: address.port,
    host,
    url: `${scheme}://${shownHost}:${address.port}`,
    server,
    get draining() {
      return draining;
    },
    get droppedConnections() {
      return droppedConnections;
    },
    get droppedSlowClients() {
      return slowGuard?.dropped() ?? 0;
    },
    close,
  };
}

/** Adapts an async request listener: a failure that escapes is answered 500 or the socket is destroyed. */
function wrap(
  listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  report: (error: unknown) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    listener(req, res).catch((error: unknown) => {
      report(error);
      if (res.headersSent) res.destroy();
      else plain(res, 500, "Internal Server Error", { connection: "close" });
    });
  };
}
