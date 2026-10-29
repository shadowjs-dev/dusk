/**
 * `@shadow-js/dusk/deno`: run a Dusk app on Deno's native server (`Deno.serve`), and the `deno()`
 * adapter that emits the entry for `deno run --allow-read --allow-env --allow-net server.mjs`.
 *
 * Same behavior as the Bun runtime: static files from the client folder, gzip for text, graceful
 * stop on signals. Deno's server has no forced close: a stop waits for requests in flight, and
 * `gracefulShutdownMs` only bounds how long the process waits before it exits.
 * @packageDocumentation
 */

import {
  type NativeListen,
  type NativeServeHandle,
  type NativeServeOptions,
  startNative,
} from "../adapter/native";
import { checkOutDir, relativePath } from "../adapter/paths";
import { type Adapter, NODE_LIKE_CAPABILITIES } from "../adapter/types";
import type { DenoRuntime } from "../internal/deno-sockets";
import type { Handler } from "../server/types";

export type {
  NativeServeHandle as DenoServeHandle,
  NativeServeOptions as DenoServeOptions,
} from "../adapter/native";

function denoGlobal(): Pick<DenoRuntime, "serve"> {
  const deno: unknown = Reflect.get(globalThis, "Deno");
  const serve: unknown =
    typeof deno === "object" && deno !== null ? Reflect.get(deno, "serve") : undefined;
  if (typeof serve !== "function") {
    throw new Error(
      "@shadow-js/dusk/deno: this runtime is not Deno (globalThis.Deno.serve is missing).",
    );
  }
  return {
    serve(options, handler) {
      const server: unknown = Reflect.apply(serve, deno, [options, handler]);
      if (typeof server !== "object" || server === null)
        throw new Error(__DEV__ ? "Deno.serve did not return a server" : "DUSK_DENO");
      const addr: unknown = Reflect.get(server, "addr");
      const shutdown: unknown = Reflect.get(server, "shutdown");
      const port: unknown =
        typeof addr === "object" && addr !== null ? Reflect.get(addr, "port") : undefined;
      if (typeof port !== "number" || typeof shutdown !== "function") {
        throw new Error(__DEV__ ? "Deno.serve returned an unexpected server" : "DUSK_DENO");
      }
      return {
        addr: { port },
        shutdown: () => Promise.resolve(Reflect.apply(shutdown, server, [])).then(() => undefined),
      };
    },
  };
}

const listen: NativeListen = (hostname, port, fetch) => {
  const server = denoGlobal().serve(
    { hostname, port, onListen: () => undefined },
    (request, info) => fetch(request, info.remoteAddr.hostname),
  );
  let closing: Promise<void> | undefined;
  return {
    get port() {
      return server.addr.port;
    },
    hostname,
    // Deno cannot force HTTP connections closed; the deadline must stop waiting instead.
    stop(force) {
      if (force) return Promise.resolve();
      closing ??= server.shutdown();
      return closing;
    },
  };
};

/**
 * Serves a handler with `Deno.serve`.
 *
 * @param handler The fetch handler, usually `handler` from the server bundle.
 * @param options Port, hostname, static folder, compression and shutdown.
 * @returns The running server.
 * @throws Error when the code does not run on Deno.
 * @example
 * import { serve } from "@shadow-js/dusk/deno";
 * import { handler } from "./dist/server/entry.js";
 * await serve(handler, { static: "/srv/app/dist/client", hostname: "0.0.0.0" });
 * @since 1.0.0
 */
export function serve(
  handler: Handler,
  options: NativeServeOptions = {},
): Promise<NativeServeHandle> {
  if (handler.upgrade === undefined) return startNative(listen, handler, options);
  return import("../internal/deno-sockets").then(({ createDenoListen }) =>
    startNative(
      createDenoListen(
        denoGlobal,
        handler,
        options.onError ?? ((error: unknown) => console.error("[dusk] request failed", error)),
      ),
      handler,
      options,
    ),
  );
}

/** Options of the {@link deno} adapter. @since 1.0.0 */
export interface DenoAdapterOptions {
  /** Output folder relative to the project. Default `dist/deno`. */
  readonly outDir?: string;
}

/**
 * The Deno adapter: writes `server.mjs`, which serves the server bundle and the client folder with
 * `Deno.serve`. Run it with `deno run --allow-read --allow-env --allow-net server.mjs`. It reads
 * `PORT` (default 3000) and `HOST` (default `0.0.0.0`) through `process.env`.
 *
 * @param options See {@link DenoAdapterOptions}.
 * @returns The adapter for `dusk({ adapter })`.
 * @throws TypeError for an invalid `outDir`.
 * @example
 * import { deno } from "@shadow-js/dusk/deno";
 * export default { plugins: [dusk({ adapter: deno() })] };
 * @since 1.0.0
 */
export function deno(options: DenoAdapterOptions = {}): Adapter {
  const outDir = checkOutDir("deno()", options.outDir ?? "dist/deno");
  return {
    name: "deno",
    outDir,
    env: "process",
    bundling: "dependencies",
    // The native layer asks the handler's gate about each file (`runMiddlewareForStaticFiles`), as the Node layer does.
    capabilities: { ...NODE_LIKE_CAPABILITIES, websockets: true, middlewareForStaticFiles: true },
    async build(context) {
      const clientFolder = relativePath(context.outDir, context.clientDir);
      const serverFile = relativePath(context.outDir, context.serverEntry);
      await context.emit(
        "server.mjs",
        [
          "// Generated by @shadow-js/dusk (adapter: deno). Run with: deno run --allow-read --allow-env --allow-net server.mjs",
          'import { serve } from "@shadow-js/dusk/deno";',
          `import { handler } from ${JSON.stringify(serverFile)};`,
          'import { fileURLToPath } from "node:url";',
          "",
          "await serve(handler, {",
          '  hostname: process.env.HOST ?? "0.0.0.0",',
          `  static: fileURLToPath(new URL(${JSON.stringify(clientFolder.endsWith("/") ? clientFolder : `${clientFolder}/`)}, import.meta.url)),`,
          `  assetsDir: ${JSON.stringify(context.manifest.assetsDir)},`,
          `  prefix: ${JSON.stringify(context.manifest.base)},`,
          `  pages: ${JSON.stringify(context.staticPages)},`,
          "});",
          "",
        ].join("\n"),
      );
      context.log(`wrote ${outDir}/server.mjs`);
    },
  };
}
