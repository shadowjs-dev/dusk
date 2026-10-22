import { createMatcher } from "@shadow-js/router/core";
import { HttpError } from "../internal/http-error";
import { runMiddleware } from "../server/api";
import { resolveClientAddress } from "../server/client-address";
import { runWithEvent } from "../server/context";
import { RequestTimeoutError } from "../server/errors";
import { EventState } from "../server/event";
import { bindFailureMapper } from "../server/failure";
import type { DuskFeature, StreamHit } from "../server/features";
import { isLoopback, peerOf } from "../server/request-env";
import { rewriteOf } from "../server/rewrite";
import { sseResponse } from "../server/sse";
import type { StreamModule, StreamOptions, UpgradeDecision } from "../server/types";
import {
  checkHandshake,
  type MessageWebSocketSink,
  startConnection,
  type WebSocketSink,
} from "../server/websocket";
import { type ConnectionSlot, createConnectionTracker } from "../server/ws-connections";
import { websocketAcceptKey } from "../server/ws-protocol";
import { DUSK_MATCHER_OPTIONS } from "../shared/router";

const EMPTY_ENV: Readonly<Record<string, unknown>> = Object.freeze({});

/** Seconds a client is told to wait after a refusal because a connection cap is reached. */
const CAP_RETRY_AFTER_SECONDS = 5;

/**
 * Settles with `work`, or rejects with a 504 `RequestTimeoutError` once `ms` have passed. The work itself cannot be
 * canceled; what matters is that the upgrade is decided and its connection slot is given back.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The validated stream limits (see `resolveStreams`). */
interface StreamLimits {
  readonly sseHeartbeatMs: number;
  readonly sseMaxBufferedEvents: number;
  readonly websocket: import("../server/websocket").WebSocketLimits;
  readonly wsMaxConnectionsPerAddress: number | false;
  readonly wsMaxConnections: number | false;
}

/** Validates the stream limits and fills their defaults. */
function resolveStreams(options: StreamOptions | undefined): StreamLimits {
  const value = (
    name: string,
    given: number | undefined,
    fallback: number,
    suffix = "",
  ): number => {
    const chosen = given ?? fallback;
    if (!Number.isInteger(chosen) || chosen < 1)
      throw new RangeError(`streams.${name} must be a positive integer${suffix}.`);
    return chosen;
  };
  /** A cap is a positive integer, or `false` for no cap. */
  const capOrOff = (
    name: string,
    given: number | false | undefined,
    fallback: number,
  ): number | false => {
    if (given === false) return false;
    return value(name, given, fallback, " or false");
  };
  return {
    sseHeartbeatMs: value("sseHeartbeatMs", options?.sseHeartbeatMs, 15_000),
    sseMaxBufferedEvents: value("sseMaxBufferedEvents", options?.sseMaxBufferedEvents, 256),
    websocket: {
      maxMessageBytes: value("wsMaxMessageBytes", options?.wsMaxMessageBytes, 1024 * 1024),
      maxMessagesPerSecond: value("wsMaxMessagesPerSecond", options?.wsMaxMessagesPerSecond, 100),
      pingIntervalMs: value("wsPingIntervalMs", options?.wsPingIntervalMs, 30_000),
      pongTimeoutMs: value("wsPongTimeoutMs", options?.wsPongTimeoutMs, 10_000),
      maxInFlightMessages: value("wsMaxInFlightMessages", options?.wsMaxInFlightMessages, 16),
    },
    wsMaxConnectionsPerAddress: capOrOff(
      "wsMaxConnectionsPerAddress",
      options?.wsMaxConnectionsPerAddress,
      100,
    ),
    wsMaxConnections: capOrOff("wsMaxConnections", options?.wsMaxConnections, 10_000),
  };
}

/**
 * The `streams()` feature: stream routes. A file that exports `SSE` answers a GET with an event stream; a file
 * that exports `WS` takes WebSocket upgrades (decided before a socket exists: the guards, the handshake, the
 * origin, the connection caps, the app-wide middleware, then the route's `WS.upgrade`). Limits come from
 * `streams` (heartbeats, buffers, message sizes, in-flight messages, connections per address).
 *
 * Without it, a stream path is not an endpoint, `Handler.upgrade` is absent, and a `streams` option or a
 * manifest with stream routes is refused at creation.
 *
 * @example
 * import { streams } from the "@shadow-js/dusk/features/streams" subpath;
 * const handler = createHandler({ manifest, features: [pages(), streams()] });
 * @returns The feature.
 * @since 1.0.0
 */
export function streams(): DuskFeature {
  return {
    name: "streams",
    install(host): void {
      const { config, runtime } = host;
      const limits = resolveStreams(host.options.streams);
      const socketLimits = limits.websocket;
      const list = config.manifest.streams ?? [];
      const entries = new Map(list.map((route) => [route.id, route]));
      if (entries.size !== list.length) throw new TypeError("two stream routes share an id.");
      // Per handler, never shared: the count of upgraded connections (bounded by `wsMaxConnections`).
      const connections = createConnectionTracker({
        perAddress: limits.wsMaxConnectionsPerAddress,
        total: limits.wsMaxConnections,
      });
      const matcher = createMatcher(
        list.map((route) => ({ id: route.id, path: route.path })),
        {
          ...DUSK_MATCHER_OPTIONS,
          basePath: config.base,
          caseSensitive: config.manifest.caseSensitive === true,
        },
      );
      const match = async (
        pathname: string,
        visibility: import("@shadow-js/router/core").RouteVisibility = "public",
      ): Promise<StreamHit | undefined> => {
        const leaf = matcher.match(pathname, visibility).at(-1);
        if (leaf === undefined) return undefined;
        const entry = entries.get(leaf.id);
        if (entry === undefined) return undefined;
        const module: StreamModule = await entry.load();
        return { id: leaf.id, pattern: leaf.pattern, params: leaf.params, module };
      };

      /** A GET answers with the route's SSE stream; a WebSocket-only route is not an HTTP resource (426). */
      const answer = (event: EventState, hit: StreamHit): Response => {
        if (event.method !== "GET")
          throw new HttpError(405, "Method Not Allowed", { headers: { allow: "GET" } });
        if (hit.module.SSE === undefined) {
          throw new HttpError(426, "Upgrade Required", { headers: { upgrade: "websocket" } });
        }
        return sseResponse(
          event,
          hit.module.SSE,
          {
            heartbeatMs: limits.sseHeartbeatMs,
            maxBufferedEvents: limits.sseMaxBufferedEvents,
          },
          (error) => runtime.report(error, "request", event),
        );
      };

      /**
       * Decides a WebSocket upgrade, before any socket is involved: the URL and host guards, the method, the
       * handshake headers, the origin (CSRF-style: same origin, or a trusted one), the route, the connection
       * caps (503 with `Retry-After`), the app-wide middleware, the route's `WS.upgrade` hook (where a session
       * is checked). A refusal is a response; an acceptance carries the handshake headers and the start
       * function the transport calls after writing 101. Nothing user-written runs for a request an earlier
       * step refused.
       */
      const upgrade = async (request: Request, platform?: unknown): Promise<UpgradeDecision> => {
        const url = new URL(request.url);
        const event = new EventState({
          request,
          url,
          signal: request.signal,
          id: crypto.randomUUID(),
          nonce: undefined,
          signer: config.signer,
          secureCookies: !(config.dev && url.protocol === "http:" && isLoopback(url.hostname)),
          env: EMPTY_ENV,
          platform,
          clientAddress: resolveClientAddress(peerOf(platform), request.headers, config.trustProxy),
          dev: config.dev,
          lang: config.document.lang,
        });
        let slot: ConnectionSlot | undefined;
        try {
          if (request.url.length > config.limits.maxUrlLength)
            throw new HttpError(414, "URI Too Long");
          if (request.method !== "GET")
            throw new HttpError(405, "Method Not Allowed", { headers: { allow: "GET" } });
          if (config.hostAllowed !== undefined && !config.hostAllowed(url.host)) {
            throw new HttpError(400, "Bad Request");
          }
          const { key } = checkHandshake(request.headers);
          if (config.csrf.enabled) {
            const origin = request.headers.get("origin");
            const sameOrigin = origin === url.origin;
            const trusted = origin !== null && config.csrf.trusted.has(origin);
            if (origin === null ? !config.csrf.allowMissingOrigin : !(sameOrigin || trusted)) {
              throw new HttpError(403, "Forbidden");
            }
          }
          const hit = await match(url.pathname);
          if (hit === undefined || hit.module.WS === undefined)
            throw new HttpError(404, "Not Found");
          const handlers = hit.module.WS;
          event.route = { kind: "stream", id: hit.id, params: hit.params };
          slot = connections.acquire(event.clientAddress);
          if (slot === undefined) {
            return {
              kind: "reject",
              response: await host.finalize(
                event,
                new Response(null, {
                  status: 503,
                  headers: { "retry-after": String(CAP_RETRY_AFTER_SECONDS) },
                }),
              ),
            };
          }
          event.env = host.envFor(platform);
          // The chain sees a failure of what is inside it as a response, as on every route.
          bindFailureMapper(event, (thrown) => host.failureResponse(event, thrown));
          // The app-wide middleware runs around the route's hook. Reaching the end of the chain with no
          // refusal answers with this marker; only the marker itself (the response `next()` handed back)
          // accepts the upgrade, so a middleware that returns any other response refuses it.
          const proceed = new Response(null, { status: 204 });
          // Bounded like any request: a hook that never settles must not hold the connection slot for good.
          const outcome = await within(
            runWithEvent(
              event,
              () =>
                runMiddleware(config.middleware, event, async () => {
                  const refusal =
                    handlers.upgrade === undefined ? undefined : await handlers.upgrade(event);
                  return refusal instanceof Response ? refusal : proceed;
                }),
              config.asyncContext,
            ),
            config.limits.requestTimeoutMs,
          );
          if (outcome !== proceed) {
            slot.release();
            // A rewrite names another route to serve; an upgrade has no other route to move to.
            const answer =
              rewriteOf(outcome) === undefined
                ? outcome
                : host.failureResponse(event, new HttpError(404, "Not Found"));
            return { kind: "reject", response: await host.finalize(event, answer) };
          }
          const accept = await websocketAcceptKey(key);
          const held = slot;
          let started = false;
          const startOptions = {
            handlers,
            event,
            limits: socketLimits,
            data: {},
            report: (error: unknown) => runtime.report(error, "request", event),
            onFinish: held.release,
          };
          const start = (sink: WebSocketSink | MessageWebSocketSink) => {
            if (started) throw new TypeError("WebSocket upgrade already consumed.");
            started = true;
            try {
              return startConnection({ ...startOptions, sink });
            } catch (error) {
              held.release();
              throw error;
            }
          };
          return {
            kind: "websocket",
            headers: {
              upgrade: "websocket",
              connection: "Upgrade",
              "sec-websocket-accept": accept,
            },
            limits: socketLimits,
            startMessages: start,
            start,
            abandon: () => {
              if (!started) {
                started = true;
                held.release();
              }
            },
          };
        } catch (error) {
          slot?.release();
          return {
            kind: "reject",
            response: await host.finalize(event, host.failureResponse(event, error)),
          };
        }
      };

      host.capabilities.streams = {
        limits: socketLimits,
        match,
        answer,
        upgrade,
      };
    },
  };
}
