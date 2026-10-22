import type { NativeListen } from "../adapter/native";
import { platformHost } from "../server/platform";
import type { Handler, UpgradeDecision } from "../server/types";
import type { MessageWebSocketInput } from "../server/websocket";

/** Native Bun socket members used by the bridge. @internal */
export interface BunSocket {
  readonly data: BunSocketData;
  readonly readyState: number;
  send(message: string | Uint8Array): number;
  close(code: number, reason: string): void;
  terminate(): void;
  getBufferedAmount(): number;
  ping(): number;
}
/** Per-upgrade framework data; never stored on user callbacks. @internal */
export interface BunSocketData {
  readonly decision: Extract<UpgradeDecision, { kind: "websocket" }>;
  input?: MessageWebSocketInput;
}
/** Bun's server callbacks and bounded native transport settings. @internal */
export interface BunNativeOptions {
  readonly hostname: string;
  readonly port: number;
  fetch(
    request: Request,
    server: {
      requestIP(request: Request): { address: string } | null;
      upgrade(request: Request, options: { data: BunSocketData; headers?: Headers }): boolean;
    },
  ): Promise<Response | undefined>;
  readonly websocket?: {
    readonly maxPayloadLength: number;
    readonly idleTimeout: number;
    readonly sendPings: boolean;
    readonly backpressureLimit: number;
    readonly closeOnBackpressureLimit: boolean;
    open(socket: BunSocket): void;
    message(socket: BunSocket, message: string | Uint8Array): void;
    close(socket: BunSocket, code: number, reason: string): void;
    ping(socket: BunSocket): void;
    pong(socket: BunSocket): void;
  };
}
/** The validated Bun global supplied by the runtime entry. @internal */
export interface BunRuntime {
  serve(options: BunNativeOptions): {
    readonly port: number;
    stop(closeActive: boolean): Promise<void>;
  };
}

/** Creates one native listener with its own active sessions and draining state. @internal */
export function createBunListen(
  runtime: BunRuntime,
  handler: Handler,
  report: (error: unknown) => void,
): NativeListen {
  return (hostname, port, fetch) => {
    let draining = false;
    const active = new Set<MessageWebSocketInput>();
    const callback = (socket: BunSocket, run: () => void): void => {
      try {
        run();
      } catch (error) {
        report(error);
        socket.data.decision.abandon?.();
        try {
          socket.terminate();
        } finally {
          socket.data.input?.closed();
        }
      }
    };
    const server = runtime.serve({
      hostname,
      port,
      async fetch(request, bunServer) {
        const address = bunServer.requestIP(request)?.address;
        if (
          request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          handler.upgrade === undefined
        )
          return fetch(request, address);
        if (draining) return new Response(null, { status: 503, headers: { "retry-after": "1" } });
        let decision: UpgradeDecision | undefined;
        try {
          decision = await handler.upgrade(
            request,
            platformHost(undefined, { clientAddress: address }),
          );
          if (decision.kind === "reject") return decision.response;
          if (draining) {
            decision.abandon?.();
            return new Response(null, { status: 503 });
          }
          if (decision.startMessages === undefined) {
            decision.abandon?.();
            return new Response(null, { status: 501 });
          }
          const headers = new Headers(decision.headers);
          for (const name of ["upgrade", "connection", "sec-websocket-accept"])
            headers.delete(name);
          if (bunServer.upgrade(request, { data: { decision }, headers })) return undefined;
          decision.abandon?.();
          return new Response(null, { status: 503 });
        } catch (error) {
          if (decision?.kind === "websocket") decision.abandon?.();
          report(error);
          return new Response("Internal Server Error", { status: 500 });
        }
      },
      websocket: {
        // Control frames may carry 125 bytes even when the application data limit is smaller.
        maxPayloadLength: Math.max(125, handler.webSocketLimits?.maxMessageBytes ?? 1024 * 1024),
        // The shared session owns Bun's ping/pong deadlines; two keepalive loops would race.
        idleTimeout: 0,
        sendPings: false,
        backpressureLimit: (handler.webSocketLimits?.maxMessageBytes ?? 1024 * 1024) * 8,
        closeOnBackpressureLimit: true,
        open(socket) {
          callback(socket, () => {
            const start = socket.data.decision.startMessages;
            if (start === undefined) {
              socket.data.decision.abandon?.();
              socket.terminate();
              return;
            }
            let ended = false;
            let input: MessageWebSocketInput | undefined;
            input = start({
              send: (message) => socket.send(message) !== 0,
              close: (code, reason) => socket.close(code, reason),
              end() {
                ended = true;
                if (input !== undefined) active.delete(input);
                if (socket.readyState === 1) socket.terminate();
              },
              buffered: () => socket.getBufferedAmount(),
              destroy: () => socket.terminate(),
              ping: () => {
                if (socket.ping() === 0) input?.closed();
              },
            });
            socket.data.input = input;
            if (!ended) active.add(input);
            if (draining) input.shutdown();
          });
        },
        message(socket, message) {
          callback(socket, () => socket.data.input?.message(message));
        },
        ping(socket) {
          callback(socket, () => socket.data.input?.ping());
        },
        pong(socket) {
          callback(socket, () => socket.data.input?.pong());
        },
        close(socket, code, reason) {
          callback(socket, () => {
            const input = socket.data.input;
            if (input !== undefined) {
              active.delete(input);
              input.closed(code, reason);
              delete socket.data.input;
            } else socket.data.decision.abandon?.();
          });
        },
      },
    });
    return {
      get port() {
        return server.port;
      },
      hostname,
      stop(closeActive) {
        draining = true;
        for (const input of active) {
          if (closeActive) input.closed();
          else input.shutdown();
        }
        return server.stop(closeActive);
      },
    };
  };
}
