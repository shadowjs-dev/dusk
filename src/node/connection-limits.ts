import type { Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";

/**
 * What one client may hold of a `serve()` process: sockets, time to send a request, time to stay idle, requests
 * per socket and time to read a response. Node's own defaults leave all of it open (no cap on sockets, no bound on
 * a response nobody reads), so `serve()` sets a limit for each and lets the app turn any of them off with `0`.
 */

/** The limit values of a server, after defaults. A value of `0` means the limit is off. @internal */
export interface ConnectionLimits {
  readonly maxConnections: number;
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly keepAliveTimeoutMs: number;
  readonly maxRequestsPerSocket: number;
  readonly writeTimeoutMs: number;
}

/** The options of {@link serve} that set a limit. @internal */
export interface LimitOptions {
  readonly maxConnections?: number;
  readonly headersTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly keepAliveTimeoutMs?: number;
  readonly maxRequestsPerSocket?: number;
  readonly writeTimeoutMs?: number;
}

/**
 * The defaults. A busy single process behind no proxy rarely holds ten thousand sockets (the file descriptor
 * limit of most hosts is lower), headers get thirty seconds and a whole request two minutes, an idle keep-alive
 * socket five seconds, a socket a thousand requests (nginx's own default), and a response that makes no progress
 * for a minute is dropped.
 * @internal
 */
export const DEFAULT_LIMITS: ConnectionLimits = {
  maxConnections: 10_000,
  headersTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 1_000,
  writeTimeoutMs: 60_000,
};

/** The code of the error the slow-client drop reports to `onError`. @internal */
export const SLOW_CLIENT_CODE = "ERR_DUSK_SLOW_CLIENT";

/** Reported (to `onError`) when a client that stopped reading its response is dropped. @internal */
export class SlowClientError extends Error {
  readonly code: string = SLOW_CLIENT_CODE;
  constructor(timeoutMs: number) {
    super(`The client read nothing of its response for ${timeoutMs} ms and was disconnected.`);
    this.name = "SlowClientError";
  }
}

/** A limit is a whole number of at least zero; `0` turns it off. */
function limitOf(name: keyof LimitOptions, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `serve(): \`${name}\` must be a whole number of at least 0 (0 turns the limit off), got ${String(value)}.`,
    );
  }
  return value;
}

/**
 * Checks the limit options and fills in the defaults.
 *
 * @param options The options of `serve()`.
 * @returns Every limit, `0` where it is off.
 * @throws TypeError naming the option, for a value that is not a whole number of at least 0.
 * @internal
 */
export function resolveLimits(options: LimitOptions): ConnectionLimits {
  return {
    maxConnections: limitOf(
      "maxConnections",
      options.maxConnections,
      DEFAULT_LIMITS.maxConnections,
    ),
    headersTimeoutMs: limitOf(
      "headersTimeoutMs",
      options.headersTimeoutMs,
      DEFAULT_LIMITS.headersTimeoutMs,
    ),
    requestTimeoutMs: limitOf(
      "requestTimeoutMs",
      options.requestTimeoutMs,
      DEFAULT_LIMITS.requestTimeoutMs,
    ),
    keepAliveTimeoutMs: limitOf(
      "keepAliveTimeoutMs",
      options.keepAliveTimeoutMs,
      DEFAULT_LIMITS.keepAliveTimeoutMs,
    ),
    maxRequestsPerSocket: limitOf(
      "maxRequestsPerSocket",
      options.maxRequestsPerSocket,
      DEFAULT_LIMITS.maxRequestsPerSocket,
    ),
    writeTimeoutMs: limitOf(
      "writeTimeoutMs",
      options.writeTimeoutMs,
      DEFAULT_LIMITS.writeTimeoutMs,
    ),
  };
}

/**
 * How often Node looks for requests past their header or body deadline. Its default is 30 seconds, which lets a
 * 30 second header timeout run for up to a minute and makes a short timeout meaningless, so the interval follows
 * the shorter deadline (a quarter of it, between 10 ms and 5 s). `undefined` when both deadlines are off.
 * @internal
 */
export function checkingIntervalOf(limits: ConnectionLimits): number | undefined {
  const deadlines = [limits.headersTimeoutMs, limits.requestTimeoutMs].filter((ms) => ms > 0);
  if (deadlines.length === 0) return undefined;
  return Math.min(5_000, Math.max(10, Math.floor(Math.min(...deadlines) / 4)));
}

/** The server as the guard needs it: the 'timeout' event is the one of Node's socket timeout. */
type TimeoutServer = Server | HttpsServer;

/** What the guard offers the request listener. @internal */
export interface SlowClientGuard {
  /**
   * Marks a response as open on its socket.
   * @param socket The request's socket.
   * @returns A function to call when the response is closed.
   */
  open(socket: Duplex): () => void;
  /** Clients dropped so far. */
  dropped(): number;
}

/**
 * Drops a client that stopped reading its response. Node's socket timeout fires after `writeTimeoutMs` without
 * activity on the socket (a read, or a write that completed), and `server.timeout` is the value Node applies
 * while a request is being handled (it switches to the keep-alive timeout between requests). When it fires:
 *
 * - no response is open on the socket: an idle keep-alive socket or a connection that never sent a request.
 *   Node's rule applies and the socket is destroyed.
 * - a response is open and bytes wait in the socket's write buffer: the client reads nothing, so the socket is
 *   destroyed (the response's close aborts the render and cancels the body).
 * - a response is open and nothing waits to be written: the handler is working (a slow query, a stream between
 *   two events). That is not the client's fault, so the timer is armed again.
 *
 * @param server The Node server.
 * @param writeTimeoutMs The limit in milliseconds; `0` installs nothing.
 * @param report Receives a {@link SlowClientError} for each drop.
 * @returns The guard.
 * @internal
 */
export function guardSlowClients(
  server: TimeoutServer,
  writeTimeoutMs: number,
  report: (error: unknown) => void,
): SlowClientGuard {
  // Keyed by socket, so an entry goes away with its socket; counts requests whose response is not closed yet.
  const open = new WeakMap<Duplex, number>();
  let dropped = 0;
  if (writeTimeoutMs > 0) {
    server.timeout = writeTimeoutMs;
    server.on("timeout", (socket) => {
      if ((open.get(socket) ?? 0) === 0) {
        socket.destroy();
        return;
      }
      if (socket.writableLength > 0) {
        dropped += 1;
        report(new SlowClientError(writeTimeoutMs));
        socket.destroy();
        return;
      }
      socket.setTimeout(writeTimeoutMs);
    });
  }
  return {
    open(socket: Duplex) {
      open.set(socket, (open.get(socket) ?? 0) + 1);
      return () => {
        const left = (open.get(socket) ?? 1) - 1;
        if (left <= 0) open.delete(socket);
        else open.set(socket, left);
      };
    },
    dropped: () => dropped,
  };
}
