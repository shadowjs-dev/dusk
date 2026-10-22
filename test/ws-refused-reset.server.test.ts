import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { allFeatures } from "./support/features";

/**
 * A browser resets the connection after a refused WebSocket handshake. The refusal is written on a socket that Node has
 * stripped of its own error listener, so the reset must not become an uncaught exception that ends the process.
 */

const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function boot(): Promise<number> {
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
      streams: [
        {
          id: "/feed",
          path: "/feed",
          kinds: ["SSE"],
          load: async () => ({ SSE: () => undefined }),
        },
      ] satisfies NonNullable<DuskRuntimeManifest["streams"]>,
    },
    dev: true,
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
  return handle.port;
}

describe("a refused WebSocket upgrade", () => {
  it("[WS-REFUSE-RESET-01] survives a client that resets the connection after the refusal", async () => {
    const port = await boot();
    const uncaught: unknown[] = [];
    const listener = (error: unknown): void => {
      uncaught.push(error);
    };
    const existing = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", listener);
    try {
      for (let round = 0; round < 25; round += 1) {
        await new Promise<void>((resolve) => {
          const socket = connect(port, "127.0.0.1");
          socket.on("error", () => undefined);
          socket.on("data", () => {
            // The refusal arrived: reset instead of closing politely, as a browser does.
            socket.resetAndDestroy();
            resolve();
          });
          socket.on("close", () => resolve());
          socket.write(
            [
              "GET /feed HTTP/1.1",
              `Host: 127.0.0.1:${port}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n"),
          );
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.removeListener("uncaughtException", listener);
      for (const old of existing) process.on("uncaughtException", old);
    }
    expect(uncaught).toEqual([]);
  });
});
