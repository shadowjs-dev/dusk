import type { UpgradeDecision } from "../server/types";
import type { MessageWebSocketInput } from "../server/websocket";

/** WebSocket members shared by Deno and Workers. @internal */
export interface MessageSocket extends EventTarget {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(message: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}
/** One bound transport, including the interval before its open event. @internal */
export interface BoundMessageSocket {
  readonly ended: boolean;
  shutdown(): void;
}

/** Validates a platform-owned object without depending on a runtime-specific constructor. @internal */
export function isMessageSocket(value: unknown): value is MessageSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "readyState") === "number" &&
    ["send", "close", "addEventListener", "removeEventListener"].every(
      (key) => typeof Reflect.get(value, key) === "function",
    )
  );
}

/** Binds one native socket and removes its listeners when the shared session finishes. @internal */
export function bindMessageSocket(
  socket: MessageSocket,
  decision: Extract<UpgradeDecision, { kind: "websocket" }>,
  report: (error: unknown) => void,
  onFinish: () => void,
): BoundMessageSocket {
  let input: MessageWebSocketInput | undefined;
  let ended = false;
  const cleanup = (): void => {
    if (ended) return;
    ended = true;
    for (const [name, listener] of listeners) socket.removeEventListener(name, listener);
    onFinish();
  };
  const failed = (error: unknown): void => {
    report(error);
    try {
      if (socket.readyState < 2) socket.close(1011, "");
    } finally {
      input?.closed();
      decision.abandon?.();
      cleanup();
    }
  };
  const open = (): void => {
    if (ended || input !== undefined) return;
    const start = decision.startMessages;
    if (start === undefined) {
      failed(new TypeError("A message transport is required."));
      return;
    }
    try {
      input = start({
        send(message) {
          if (socket.readyState !== 1) return false;
          socket.send(message);
          return true;
        },
        close: (code, reason) => socket.close(code, reason),
        end() {
          cleanup();
          if (socket.readyState < 2) socket.close(1001, "");
        },
        ...(typeof socket.bufferedAmount === "number"
          ? { buffered: () => socket.bufferedAmount ?? 0 }
          : {}),
      });
    } catch (error) {
      failed(error);
    }
  };
  const message = (event: Event): void => {
    try {
      const data: unknown = Reflect.get(event, "data");
      if (typeof data === "string") input?.message(data);
      else if (data instanceof ArrayBuffer) input?.message(new Uint8Array(data));
      else if (ArrayBuffer.isView(data))
        input?.message(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else throw new TypeError("Unknown native WebSocket message.");
    } catch (error) {
      failed(error);
    }
  };
  const close = (event: Event): void => {
    const code: unknown = Reflect.get(event, "code");
    const reason: unknown = Reflect.get(event, "reason");
    try {
      // Older Workers compatibility dates deliver close in CLOSING and require an explicit reply.
      if (socket.readyState === 2)
        socket.close(
          typeof code === "number" && code !== 1005 && code !== 1006 ? code : 1000,
          typeof reason === "string" ? reason : "",
        );
      input?.closed(
        typeof code === "number" ? code : 1006,
        typeof reason === "string" ? reason : "",
      );
    } finally {
      decision.abandon?.();
      cleanup();
    }
  };
  const listeners: readonly (readonly [string, EventListener])[] = [
    ["open", open],
    ["message", message],
    ["close", close],
    ["error", failed],
  ];
  socket.binaryType = "arraybuffer";
  for (const [name, listener] of listeners) socket.addEventListener(name, listener);
  if (socket.readyState === 1) open();
  else if (socket.readyState > 1) {
    decision.abandon?.();
    cleanup();
  }
  return {
    get ended() {
      return ended;
    },
    shutdown() {
      if (ended) return;
      if (input !== undefined) input.shutdown();
      else {
        decision.abandon?.();
        cleanup();
        socket.close(1001, "server shutdown");
      }
    },
  };
}
