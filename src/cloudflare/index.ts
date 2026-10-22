/**
 * `@shadow-js/dusk/cloudflare`: the Cloudflare Workers adapter. It emits `worker.mjs` (a
 * `{ fetch(request, env, ctx) }` module over the server bundle) and a `wrangler.toml` that serves the
 * client folder through the static assets binding and turns on `nodejs_compat` (so
 * `AsyncLocalStorage` works for `getRequestEvent()`).
 *
 * The bindings arrive as `env` on each request and become the environment (`envSource: false`), so
 * `defineEnv` validates them on the first request. The client address is the `cf-connecting-ip`
 * header, which Cloudflare sets on the way in.
 * @packageDocumentation
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostListSource } from "../adapter/host-routes";
import { IMMUTABLE_CACHE_CONTROL, immutableFolders } from "../adapter/immutable";
import { pageHeaderBlock } from "../adapter/page-headers";
import { checkOutDir, relativePath } from "../adapter/paths";
import { type Adapter, NODE_LIKE_CAPABILITIES } from "../adapter/types";
import type { FetchModule } from "../server/platform";
import type { Handler } from "../server/types";

/** Options of the {@link cloudflare} adapter. @since 1.0.0 */
export interface CloudflareAdapterOptions {
  /** Output folder relative to the project. Default `dist/cloudflare`. */
  readonly outDir?: string;
  /** The Worker name: lower case letters, digits and hyphens, at most 63 characters. Default `dusk-app`. */
  readonly name?: string;
  /** The `compatibility_date` of the Worker, `YYYY-MM-DD`. Default `2025-09-01`. */
  readonly compatibilityDate?: string;
  /** Extra `compatibility_flags` besides `nodejs_compat`. */
  readonly compatibilityFlags?: readonly string[];
}

/**
 * The Node built-ins a Worker runs with `nodejs_compat`, by bare name: the modules Cloudflare lists as fully or
 * partially supported (its "Node.js compatibility" page). Refused, although listed there: the import-only stubs
 * (`child_process`, `worker_threads`, `vm`, `http2`, `tty`, and the rest of that list), which import and then fail; and
 * `fs`, which is a virtual filesystem (`/bundle` read-only, `/tmp` writable, nothing else on disk), so a read of a
 * package file by path (an OG route's wasm from `node_modules`) fails at run time. The build names the import instead.
 * Subpaths (`fs/promises`) are not listed and are refused.
 * @internal
 */
const WORKERS_NODE_BUILTINS: readonly string[] = Object.freeze([
  "assert",
  "async_hooks",
  "buffer",
  "console",
  "crypto",
  "diagnostics_channel",
  "dns",
  "events",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "stream",
  "string_decoder",
  "test",
  "timers",
  "tls",
  "url",
  "util",
  "zlib",
]);

/** The Worker name rule of Wrangler. @internal */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates the options; throws a TypeError naming the bad field. @internal */
export function checkCloudflareOptions(options: CloudflareAdapterOptions): Required<
  Omit<CloudflareAdapterOptions, "compatibilityFlags">
> & {
  compatibilityFlags: readonly string[];
} {
  const name = options.name ?? "dusk-app";
  if (!WORKER_NAME.test(name)) {
    throw new TypeError(
      `cloudflare(): name "${name}" is not a Worker name (lower case letters, digits and hyphens, 1 to 63 characters)`,
    );
  }
  const compatibilityDate = options.compatibilityDate ?? "2025-09-01";
  if (!DATE.test(compatibilityDate) || Number.isNaN(Date.parse(compatibilityDate))) {
    throw new TypeError(
      `cloudflare(): compatibilityDate must be YYYY-MM-DD (got "${compatibilityDate}")`,
    );
  }
  const flags = options.compatibilityFlags ?? [];
  for (const flag of flags) {
    if (!/^[a-z][a-z0-9_]*$/.test(flag))
      throw new TypeError(`cloudflare(): compatibility flag "${flag}" is not valid`);
  }
  return {
    outDir: checkOutDir("cloudflare()", options.outDir ?? "dist/cloudflare"),
    name,
    compatibilityDate,
    compatibilityFlags: flags,
  };
}

/**
 * Wraps a handler as the Worker module. Use it when you write your own entry instead of the emitted
 * one: `export default workerFetch(handler)`.
 *
 * @param handler The handler from the server bundle.
 * @returns A `{ fetch(request, env, ctx) }` module.
 * @example
 * import { workerFetch } from "@shadow-js/dusk/cloudflare";
 * import { handler } from "./dist/server/entry.js";
 * export default workerFetch(handler);
 * @since 1.0.0
 */
export function workerFetch(handler: Handler): FetchModule {
  // One module promise per app: import-time evaluation never opens a socket or reads Worker globals.
  let module: Promise<FetchModule> | undefined;
  const load = () =>
    (module ??= import("../internal/worker-sockets").then(({ createWorkerFetch }) =>
      createWorkerFetch(handler),
    ));
  return {
    fetch: (request, env, ctx) => load().then((app) => app.fetch(request, env, ctx)),
    ...(handler.gateAsset === undefined
      ? {}
      : {
          gateAsset: (request, env, ctx) =>
            load().then((app) => {
              if (app.gateAsset === undefined) throw new TypeError("Asset gate is missing.");
              return app.gateAsset(request, env, ctx);
            }),
        }),
  };
}

/**
 * The `wrangler.toml` the adapter writes, as a string. TOML because every Wrangler version reads it
 * (Wrangler 3 does not read `main` from a JSON config). The asset directory is relative to the config
 * file. Exported for tests and for tools that generate Wrangler config themselves.
 * @internal
 * @since 1.0.0
 */
export function wranglerToml(input: {
  readonly name: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly assetsDirectory: string;
  /**
   * Paths the Worker answers before the assets binding (B2): a prerendered page the app's rules apply to. Without this the
   * platform serves its file. Omitted when empty.
   */
  readonly workerFirst?: readonly string[];
  /**
   * Every request runs the Worker first (`run_worker_first = true`): the app lists its hosts, and the Worker answers a
   * Host the list refuses through the handler. Routes cannot test the Host, so this is the only way to reach the Worker
   * before the assets for every Host. It replaces `workerFirst`.
   */
  readonly allRequests?: boolean;
  /** Leave out the `[assets]` table (for runtimes that do not serve it, such as a local test run). */
  readonly withAssets?: boolean;
}): string {
  const flags = [
    "nodejs_compat",
    ...input.compatibilityFlags.filter((flag) => flag !== "nodejs_compat"),
  ];
  const lines = [
    "# Generated by @shadow-js/dusk (adapter: cloudflare). Deploy with: npx wrangler deploy",
    `name = ${JSON.stringify(input.name)}`,
    `main = "worker.mjs"`,
    `compatibility_date = ${JSON.stringify(input.compatibilityDate)}`,
    `compatibility_flags = [${flags.map((flag) => JSON.stringify(flag)).join(", ")}]`,
  ];
  if (input.withAssets !== false) {
    lines.push(
      "",
      "[assets]",
      `directory = ${JSON.stringify(input.assetsDirectory)}`,
      `binding = "ASSETS"`,
    );
    if (input.allRequests === true) {
      lines.push("run_worker_first = true");
    } else if (input.workerFirst !== undefined && input.workerFirst.length > 0) {
      lines.push(
        `run_worker_first = [${input.workerFirst.map((path) => JSON.stringify(path)).join(", ")}]`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The Worker module the adapter writes. Without a host list and without the file gate it is the plain handler (the assets
 * binding serves files before the Worker runs). Otherwise the Worker runs for every request (`run_worker_first = true`):
 * - a Host the list refuses goes to the handler, which answers its 400 (a file is never served for it);
 * - a `GET` or `HEAD` for a listed Host, on a path no page rule takes, is looked up in the assets binding (a 404 from it
 *   falls through to the handler);
 * - with the file gate (`runMiddlewareForStaticFiles`), a file the binding has goes through the handler's `gateAsset`
 *   first: the middleware's refusal is sent, or the file is sent with the headers and cookies the middleware set;
 * - a prerendered page a rule applies to goes to the handler, never to its file (B2).
 * The page key mirrors `pageKeyOf` (`shared/static-page.ts`); a test pins the two together.
 *
 * @param input The server bundle's path from the output folder, the host list, the pages the handler answers, and whether
 * the middleware runs for files.
 * @returns The module source.
 * @internal
 * @since 1.0.0
 */
export function workerSource(input: {
  readonly serverFile: string;
  readonly allowedHosts?: readonly string[];
  readonly handlerPages: readonly string[];
  /** The handler runs its middleware for files (`runMiddlewareForStaticFiles`): every file goes through its gate. */
  readonly gateFiles?: boolean;
}): string {
  const hosts = input.allowedHosts ?? [];
  const gated = input.gateFiles === true;
  const header = [
    "// Generated by @shadow-js/dusk (adapter: cloudflare).",
    `import { handler, workerFetch } from ${JSON.stringify(input.serverFile)};`,
    "",
    "const app = workerFetch(handler);",
  ];
  if (hosts.length === 0 && !gated) {
    return [...header, "", "export default app;", ""].join("\n");
  }
  const handlerKeys = [...new Set(input.handlerPages.map(pageKeyOfSource))];
  const notes = [
    "// This Worker runs for every request (run_worker_first = true). See workerSource.",
    ...(hosts.length === 0
      ? []
      : [
          "// security.allowedHosts is set: a Host the list refuses never reaches the assets binding.",
        ]),
    ...(gated
      ? [
          "// runMiddlewareForStaticFiles is set: a file the assets binding has is decided by the handler's gateAsset.",
        ]
      : []),
  ];
  return [
    ...header,
    "",
    ...notes,
    // Without a host list every Host is listed: the pattern accepts any name.
    `const ALLOWED_HOST = ${hosts.length === 0 ? "/^/" : `new RegExp(${JSON.stringify(hostListSource(hosts))})`};`,
    `const GATE_FILES = ${gated ? "true" : "false"};`,
    `const HANDLER_PAGES = new Set(${JSON.stringify(handlerKeys)});`,
    "",
    "// Mirrors pageKeyOf (shared/static-page.ts): /about/, /about/index.html and /about.html are /about.",
    "function pageKeyOf(pathname) {",
    "  let path = pathname;",
    '  if (path.endsWith("/index.html")) path = path.slice(0, -"/index.html".length);',
    '  else if (path.endsWith(".html")) path = path.slice(0, -".html".length);',
    '  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);',
    '  return path === "" ? "/" : path;',
    "}",
    "",
    "// The handler's middleware decides a file it would serve: a refusal is sent; otherwise the file is sent with the",
    "// headers and cookies the middleware set (the framing headers stay the binding's).",
    "async function gatedFile(asset, request, env, ctx) {",
    "  const decision = await app.gateAsset(request, env, ctx);",
    '  if (decision.kind === "answer") return decision.response;',
    "  const headers = new Headers(asset.headers);",
    "  for (const [name, value] of decision.headers) {",
    '    if (name !== "set-cookie") headers.set(name, value);',
    "  }",
    '  for (const cookie of decision.headers.getSetCookie()) headers.append("set-cookie", cookie);',
    "  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });",
    "}",
    "",
    "export default {",
    "  async fetch(request, env, ctx) {",
    '    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return app.fetch(request, env, ctx);',
    "    const url = new URL(request.url);",
    "    const assets = env === undefined || env === null ? undefined : env.ASSETS;",
    "    const method = request.method;",
    '    const candidate = (method === "GET" || method === "HEAD") && ALLOWED_HOST.test(url.host);',
    "    let page;",
    "    try {",
    "      page = pageKeyOf(decodeURIComponent(url.pathname));",
    "    } catch {",
    "      page = undefined;",
    "    }",
    "    // A malformed escape is not a file name: it goes to the handler, which refuses it.",
    "    if (candidate && page !== undefined && !HANDLER_PAGES.has(page) && assets !== undefined) {",
    "      const answer = await assets.fetch(request);",
    "      if (answer.status !== 404) {",
    "        return GATE_FILES ? gatedFile(answer, request, env, ctx) : answer;",
    "      }",
    "    }",
    "    return app.fetch(request, env, ctx);",
    "  },",
    "};",
    "",
  ].join("\n");
}

/**
 * The page key a path names, as `pageKeyOf` computes it at build time (the same rule the Worker runs).
 * @internal
 */
function pageKeyOfSource(path: string): string {
  let text = path;
  if (text.endsWith("/index.html")) text = text.slice(0, -"/index.html".length);
  else if (text.endsWith(".html")) text = text.slice(0, -".html".length);
  while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
  return text === "" ? "/" : text;
}

/**
 * The Cloudflare Workers adapter.
 *
 * @param options See {@link CloudflareAdapterOptions}.
 * @returns The adapter for `dusk({ adapter })`.
 * @throws TypeError for an invalid option.
 * @example
 * import { cloudflare } from "@shadow-js/dusk/cloudflare";
 * export default { plugins: [dusk({ adapter: cloudflare({ name: "my-app" }) })] };
 * @since 1.0.0
 */
export function cloudflare(options: CloudflareAdapterOptions = {}): Adapter {
  const checked = checkCloudflareOptions(options);
  return {
    name: "cloudflare",
    outDir: checked.outDir,
    env: "platform",
    bundling: "all",
    edge: true,
    supportedBuiltins: WORKERS_NODE_BUILTINS,
    capabilities: {
      ...NODE_LIKE_CAPABILITIES,
      staticAssets: "platform",
      middlewareForStaticFiles: true,
      asyncContext: true,
      websockets: true,
    },
    async build(context) {
      const serverFile = relativePath(context.outDir, context.serverEntry);
      const handlerPages = context.staticPages
        .filter((page) => page.mode === "handler")
        .map((page) => page.path);
      const allowedHosts = context.allowedHosts;
      const gateFiles = context.runMiddlewareForStaticFiles === true;
      await context.emit(
        "worker.mjs",
        workerSource({
          serverFile,
          ...(allowedHosts === undefined ? {} : { allowedHosts }),
          handlerPages,
          gateFiles,
        }),
      );
      await context.emit(
        "wrangler.toml",
        wranglerToml({
          name: checked.name,
          compatibilityDate: checked.compatibilityDate,
          compatibilityFlags: checked.compatibilityFlags,
          assetsDirectory: relativePath(context.outDir, context.clientDir).replace(/\/$/, ""),
          // A page the app's rules apply to is answered by the Worker, not by its file (B2). With a host list, or the file
          // gate, every request runs the Worker first (see workerSource).
          allRequests: allowedHosts !== undefined || gateFiles,
          workerFirst: handlerPages.flatMap((path) => (path === "/" ? ["/"] : [path, `${path}/`])),
        }),
      );
      // The assets binding serves the client folder itself, and Workers static assets read a `_headers` file from
      // that folder. It is written there (the folder is the build output, outside this adapter's own folder).
      await writeFile(
        join(context.clientDir, "_headers"),
        [
          "# Generated by @shadow-js/dusk (adapter: cloudflare). Hashed build assets and vendored fonts never change.",
          ...immutableFolders(context.manifest).flatMap((folder) => [
            `${folder}/*`,
            `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`,
          ]),
          ...context.staticPages.flatMap((page) => pageHeaderBlock(page)),
          "",
        ].join("\n"),
      );
      context.log(
        `wrote worker.mjs and wrangler.toml (deploy with: npx wrangler deploy -c ${checked.outDir}/wrangler.toml)`,
      );
    },
  };
}
