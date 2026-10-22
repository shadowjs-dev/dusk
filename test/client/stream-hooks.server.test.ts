import { createRoot } from "@shadow-js/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSSE, useWebSocket } from "../../src/client/streams";
import { type ServerHandle, serve } from "../../src/node/index";
import { createHandler, type DuskRuntimeManifest } from "../../src/server/index";
import { allFeatures } from "../support/features";

/**
 * The reactive hooks: they hold the last data and the status as signals, and they close their stream when
 * the owning root is disposed. Run against a real server, inside a root (the owner the cleanup needs).
 */

const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function boot(): Promise<string> {
  const streams: Array<NonNullable<DuskRuntimeManifest["streams"]>[number]> = [
    {
      id: "/feed",
      path: "/feed",
      kinds: ["SSE"],
      load: async () => ({
        SSE: async (_event, stream) => {
          await stream.send({ id: "1", data: { price: 42 } });
        },
      }),
    },
    {
      id: "/chat",
      path: "/chat",
      kinds: ["WS"],
      load: async () => ({
        WS: {
          open(ws) {
            ws.send("hello");
          },
        },
      }),
    },
  ];
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
      streams,
    },
    dev: true,
    security: { csrf: { allowMissingOrigin: true } },
    onError: () => undefined,
    onWarning: () => undefined,
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
  return `http://127.0.0.1:${handle.port}`;
}

describe("stream hooks", () => {
  it("[CLI-10] useSSE holds the last event's data and reports open, and closes when its root is disposed", async () => {
    const origin = await boot();
    let stream: ReturnType<typeof useSSE<{ price: number }>> | undefined;
    const dispose = createRoot((disposeRoot) => {
      stream = useSSE<{ price: number }>(`${origin}/feed`, { reconnect: { minDelayMs: 1 } });
      return disposeRoot;
    });
    await vi.waitFor(() => expect(stream?.data()).toEqual({ price: 42 }));
    expect(stream?.status()).toBe("open");
    dispose();
    await vi.waitFor(() => expect(stream?.status()).toBe("closed"));
  });

  it("[CLI-11] useWebSocket holds the last message and sends through the open socket", async () => {
    const origin = await boot();
    let socket: ReturnType<typeof useWebSocket> | undefined;
    const dispose = createRoot((disposeRoot) => {
      socket = useWebSocket(`${origin.replace("http", "ws")}/chat`, {
        reconnect: { minDelayMs: 1 },
      });
      return disposeRoot;
    });
    await vi.waitFor(() => expect(socket?.data()).toBe("hello"));
    expect(socket?.status()).toBe("open");
    expect(socket?.send("ping")).toBe(true);
    dispose();
    await vi.waitFor(() => expect(socket?.status()).toBe("closed"));
  });
});
