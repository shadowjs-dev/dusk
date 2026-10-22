import { createFetch, type FetchModule } from "../server/platform";
import type { Handler, UpgradeDecision } from "../server/types";
import {
  type BoundMessageSocket,
  bindMessageSocket,
  isMessageSocket,
  type MessageSocket,
} from "./message-socket";

interface AcceptedSocket extends MessageSocket {
  accept(): void;
}

function pair(): { client: object; server: AcceptedSocket } {
  const pairConstructor: unknown = Reflect.get(globalThis, "WebSocketPair");
  if (typeof pairConstructor !== "function") throw new Error("WebSocketPair is missing");
  const result: unknown = Reflect.construct(pairConstructor, []);
  if (typeof result !== "object" || result === null) throw new TypeError("Invalid WebSocketPair.");
  const client: unknown = Reflect.get(result, "0");
  const server: unknown = Reflect.get(result, "1");
  if (
    typeof client !== "object" ||
    client === null ||
    !isMessageSocket(server) ||
    typeof Reflect.get(server, "accept") !== "function"
  )
    throw new TypeError("Invalid WebSocketPair.");
  return { client, server: server as AcceptedSocket };
}

/** Bridges Worker-owned message framing after the handler has accepted an upgrade. @internal */
export function createWorkerFetch(handler: Handler): FetchModule {
  const report = (error: unknown): void => console.error("[dusk] WebSocket upgrade failed", error);
  return createFetch(
    {
      ...handler,
      async fetch(request, platform) {
        const upgrade = handler.upgrade;
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || upgrade === undefined)
          return handler.fetch(request, platform);
        const abort = new AbortController();
        const cancel = (): void => abort.abort();
        request.signal.addEventListener("abort", cancel, { once: true });
        if (request.signal.aborted) cancel();
        let decision: UpgradeDecision | undefined;
        let bound: BoundMessageSocket | undefined;
        let socket: AcceptedSocket | undefined;
        try {
          decision = await upgrade(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              signal: abort.signal,
            }),
            platform,
          );
          if (decision.kind === "reject") return decision.response;
          if (abort.signal.aborted) {
            decision.abandon?.();
            return new Response(null, { status: 503 });
          }
          if (decision.startMessages === undefined) {
            decision.abandon?.();
            return new Response(null, { status: 501 });
          }
          const sockets = pair();
          socket = sockets.server;
          const headers = new Headers(decision.headers);
          for (const name of ["upgrade", "connection", "sec-websocket-accept"])
            headers.delete(name);
          const init: ResponseInit & { webSocket: object } = {
            status: 101,
            headers,
            webSocket: sockets.client,
          };
          const response = new Response(null, init);
          socket.binaryType = "arraybuffer";
          socket.accept();
          bound = bindMessageSocket(socket, decision, report, cancel);
          return response;
        } catch (error) {
          report(error);
          if (decision?.kind === "websocket") decision.abandon?.();
          try {
            if (bound !== undefined) bound.shutdown();
            else if (socket !== undefined && socket.readyState < 2) socket.close(1011, "");
          } catch (closeError) {
            report(closeError);
          }
          return new Response("Internal Server Error", { status: 500 });
        } finally {
          request.signal.removeEventListener("abort", cancel);
          if (bound === undefined) cancel();
        }
      },
    },
    { clientAddressHeader: "cf-connecting-ip", geo: "cloudflare" },
  );
}
