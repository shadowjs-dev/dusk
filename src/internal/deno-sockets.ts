import type { NativeListen } from "../adapter/native";
import { platformHost } from "../server/platform";
import type { Handler, UpgradeDecision } from "../server/types";
import {
  type BoundMessageSocket,
  bindMessageSocket,
  isMessageSocket,
  type MessageSocket,
} from "./message-socket";

/** Deno operations used by the native bridge. @internal */
export interface DenoRuntime {
  serve(
    options: { hostname: string; port: number; onListen(): void },
    fetch: (
      request: Request,
      info: { remoteAddr: { hostname: string }; completed?: Promise<void> },
    ) => Promise<Response>,
  ): { readonly addr: { readonly port: number }; shutdown(): Promise<void> };
  upgrade(
    request: Request,
    options: { idleTimeout: number },
  ): { readonly socket: MessageSocket; readonly response: Response };
}

function upgradeDeno(
  request: Request,
  options: { idleTimeout: number },
): { socket: MessageSocket; response: Response } {
  const deno: unknown = Reflect.get(globalThis, "Deno");
  if (typeof deno !== "object" || deno === null)
    throw new Error("Deno.upgradeWebSocket is missing");
  const upgrade: unknown = Reflect.get(deno, "upgradeWebSocket");
  if (typeof upgrade !== "function") throw new Error("Deno.upgradeWebSocket is missing");
  const result: unknown = Reflect.apply(upgrade, deno, [request, options]);
  if (typeof result !== "object" || result === null)
    throw new TypeError("Deno.upgradeWebSocket returned an invalid result.");
  const socket: unknown = Reflect.get(result, "socket");
  const response: unknown = Reflect.get(result, "response");
  if (!isMessageSocket(socket) || !(response instanceof Response))
    throw new TypeError("Deno.upgradeWebSocket returned an invalid result.");
  return { socket, response };
}

/** Creates one native Deno listener with bounded sessions owned by its handler. @internal */
export function createDenoListen(
  runtime: () => Pick<DenoRuntime, "serve">,
  handler: Handler,
  report: (error: unknown) => void,
): NativeListen {
  return (hostname, port, fetch) => {
    const deno = runtime();
    let draining = false;
    const active = new Map<BoundMessageSocket, MessageSocket>();
    const waiting = new Set<() => void>();
    let closing: Promise<void> | undefined;
    const server = deno.serve(
      { hostname, port, onListen: () => undefined },
      async (request, info) => {
        const address = info.remoteAddr.hostname;
        if (
          request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          handler.upgrade === undefined
        )
          return fetch(request, address);
        if (draining) return new Response(null, { status: 503, headers: { "retry-after": "1" } });
        let decision: UpgradeDecision | undefined;
        const abort = new AbortController();
        // A protocol switch ends the HTTP lifetime; only a disconnect before that handoff cancels the decision.
        let handedOff = false;
        info.completed?.catch(() => {
          if (!handedOff) abort.abort();
        });
        let bound: BoundMessageSocket | undefined;
        try {
          decision = await handler.upgrade(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              signal: abort.signal,
            }),
            platformHost(undefined, { clientAddress: address }),
          );
          if (decision.kind === "reject") return decision.response;
          if (draining || abort.signal.aborted) {
            decision.abandon?.();
            return new Response(null, { status: 503 });
          }
          if (decision.startMessages === undefined) {
            decision.abandon?.();
            return new Response(null, { status: 501 });
          }
          const upgraded = upgradeDeno(request, {
            idleTimeout: Math.max(1, Math.ceil((decision.limits?.pingIntervalMs ?? 30_000) / 1000)),
          });
          handedOff = true;
          bound = bindMessageSocket(upgraded.socket, decision, report, () => {
            abort.abort();
            if (bound !== undefined) active.delete(bound);
          });
          if (!bound.ended) active.set(bound, upgraded.socket);
          return upgraded.response;
        } catch (error) {
          if (decision?.kind === "websocket") decision.abandon?.();
          report(error);
          return new Response("Internal Server Error", { status: 500 });
        } finally {
          if (bound === undefined) abort.abort();
        }
      },
    );
    return {
      get port() {
        return server.addr.port;
      },
      hostname,
      stop(force) {
        draining = true;
        if (force) {
          for (const finish of waiting) finish();
          return Promise.resolve();
        }
        closing ??= (async () => {
          // HTTP shutdown does not own upgraded sockets. Observe their close before starting the handshake.
          const closed: Promise<void>[] = [];
          for (const [bound, socket] of active) {
            if (socket.readyState !== 3)
              closed.push(
                new Promise<void>((resolve) => {
                  const finish = (): void => {
                    socket.removeEventListener("close", finish);
                    waiting.delete(finish);
                    resolve();
                  };
                  waiting.add(finish);
                  socket.addEventListener("close", finish);
                }),
              );
            bound.shutdown();
          }
          await Promise.all([server.shutdown(), ...closed]);
        })();
        return closing;
      },
    };
  };
}
