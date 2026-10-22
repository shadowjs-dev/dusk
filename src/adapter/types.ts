import type { StaticPage } from "../shared/static-page";
import type { DuskManifest } from "../vite/build";

/**
 * The adapter contract of `dusk({ adapter })`. An adapter turns the build output (the client
 * folder, the server bundle and `dusk-manifest.json`) into something one platform runs. It runs once
 * per `vite build`, after both bundles and the manifest are written. Adapters never run in the server
 * bundle: they are build-time code, and the runtime entries they emit are plain Web-standard modules.
 *
 * @packageDocumentation
 */

/** What a platform can do; the build checks what it can. @since 1.0.0 */
export interface AdapterCapabilities {
  /** The platform can stream a Response body to the client. */
  readonly streaming: boolean;
  /** `AsyncLocalStorage` is available, so `getRequestEvent()` works without an explicit event. */
  readonly asyncContext: boolean;
  /** Who serves `dist/client`: the adapter's output (a static folder or the runtime), or the platform's CDN. */
  readonly staticAssets: "adapter" | "platform";
  /**
   * The platform's runtime asks the handler about each file it would serve (`Handler.gateAsset`), so the global middleware
   * runs for `public/` and build files (the `runMiddlewareForStaticFiles` option). Absent or `false`: the platform answers
   * files before any code runs, and the build warns when the option is set.
   */
  readonly middlewareForStaticFiles?: boolean;
  /** WebSocket upgrades are possible on the platform. */
  readonly websockets: boolean;
  /** Server-sent events are possible on the platform. */
  readonly serverSentEvents: boolean;
  /**
   * The server sends `103 Early Hints` for a page (the entry, stylesheets and route preloads as `Link` headers) before the
   * page's data loads. Absent or `false`: the page carries the same `Link` header on its final response only.
   */
  readonly earlyHints?: boolean;
}

/**
 * Where the server bundle gets its environment variables:
 * - `"process"`: `process.env` (Node, Bun, Deno, Vercel, the Node layout of Tarout);
 * - `"platform"`: the bindings the platform passes to each request (Cloudflare `env`, Netlify edge),
 *   validated on the first request.
 * @since 1.0.0
 */
export type AdapterEnvSource = "process" | "platform";

/**
 * How much of the dependency tree the server bundle carries. `"dependencies"` leaves third-party
 * packages external (the platform installs them); `"all"` bundles them, so the output runs without
 * a `node_modules` folder (Build Output API functions, edge runtimes).
 * @since 1.0.0
 */
export type AdapterBundling = "dependencies" | "all";

/** One route of the app, as adapters see it. @since 1.0.0 */
export interface AdapterRoute {
  readonly id: string;
  readonly kind: "page" | "api" | "layout";
  /** The route path pattern, such as `/posts/:id`. */
  readonly pattern: string;
  /** Whether a static HTML file was written for it at build time. */
  readonly prerendered: boolean;
}

/**
 * What an adapter's `build` receives. Paths are absolute except `emit`/`copy` destinations, which
 * are relative to `outDir` and checked to stay inside it.
 * @since 1.0.0
 */
export interface AdapterContext {
  /** The project root. */
  readonly root: string;
  /** The adapter's output folder (absolute). It is emptied before `build` runs. */
  readonly outDir: string;
  /** The client build output (absolute), `dist/client`. */
  readonly clientDir: string;
  /** The server bundle entry (absolute), `dist/server/entry.js`. Its folder holds the chunks. */
  readonly serverEntry: string;
  /** The contents of `dusk-manifest.json`. */
  readonly manifest: DuskManifest;
  /** Every route the scanner found. */
  readonly routes: readonly AdapterRoute[];
  /**
   * How each prerendered page is answered (B2): a static file with the app's headers, or the handler per request. An
   * adapter that serves a file for a path must not serve a `handler` page from it, and sends a `static` page's headers.
   */
  readonly staticPages: readonly StaticPage[];
  /**
   * The app's `security.allowedHosts` (the merged options the build reads, as the handler reads them at run time), when
   * the list is not empty. An adapter whose platform answers files before the function routes a Host that is not listed
   * to the function, which answers the handler's 400 (see `vercelRoutes`, the Cloudflare Worker). Absent: no host check.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * The handler runs its global middleware for static files (`runMiddlewareForStaticFiles`). An adapter whose platform
   * cannot do that warns (see `staticFilesMiddlewareWarning`) and one that can wires the gate (the Cloudflare Worker).
   */
  readonly runMiddlewareForStaticFiles?: boolean;
  /** Writes a line to the build log. */
  log(message: string): void;
  /** Writes a file under `outDir` (creating folders). Rejects paths that leave `outDir`. */
  emit(file: string, contents: string | Uint8Array): Promise<void>;
  /** Copies a file or folder (absolute `from`) to a path under `outDir`. */
  copy(from: string, to: string): Promise<void>;
}

/**
 * An adapter. The `outDir` is relative to the project root; the first-party adapters pick their own
 * default (`dist/bun`, `.vercel/output`, ...) and accept an override in their options.
 * @since 1.0.0
 */
export interface Adapter {
  /** Short name used in logs and errors, such as `"vercel"`. */
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /** Output folder relative to the project root. Must not be empty, absolute or contain `..`. */
  readonly outDir: string;
  readonly env: AdapterEnvSource;
  readonly bundling: AdapterBundling;
  /**
   * Set when the platform runs without Node built-ins (edge runtimes, Workers without `nodejs_compat`).
   * The build then fails if the server bundle imports a Node built-in, unless `supportedBuiltins` names it.
   */
  readonly edge?: boolean;
  /**
   * The Node built-ins an edge platform runs anyway, by their bare name (`crypto`, not `node:crypto`), when it runs
   * some (Workers with `nodejs_compat`). Read only when `edge` is set: a built-in not listed fails the build, naming it.
   * Absent: every built-in fails.
   */
  readonly supportedBuiltins?: readonly string[];
  /** Emits the deployable output. */
  build(context: AdapterContext): Promise<void>;
}

/** Capabilities of a platform with a native HTTP server and everything a Node-like runtime offers. @since 1.0.0 */
export const NODE_LIKE_CAPABILITIES: AdapterCapabilities = Object.freeze({
  streaming: true,
  asyncContext: true,
  staticAssets: "adapter",
  websockets: false,
  serverSentEvents: true,
});

function adapterProblem(message: string): never {
  throw new TypeError(`dusk: adapter ${message}`);
}

/**
 * Checks an object given as `dusk({ adapter })`. Throws a TypeError that names the problem.
 * @param value What the user passed.
 * @returns The same adapter, typed.
 * @throws TypeError when a field is missing or has the wrong shape, or the output folder is unsafe.
 * @internal
 * @since 1.0.0
 */
export function assertAdapter(value: unknown): Adapter {
  if (typeof value !== "object" || value === null) {
    adapterProblem("must be an adapter object, such as the result of vercel() or bun()");
  }
  const candidate = value as Partial<Record<keyof Adapter, unknown>>;
  if (typeof candidate.name !== "string" || candidate.name === "") adapterProblem("needs a name");
  if (typeof candidate.build !== "function")
    adapterProblem(`"${candidate.name}" has no build() function`);
  const outDir = candidate.outDir;
  if (
    typeof outDir !== "string" ||
    outDir === "" ||
    outDir.startsWith("/") ||
    /^[A-Za-z]:/.test(outDir)
  ) {
    adapterProblem(`"${candidate.name}" needs an outDir relative to the project`);
  }
  if (outDir.split(/[\\/]/).includes("..")) {
    adapterProblem(`"${candidate.name}" outDir must not leave the project`);
  }
  if (candidate.env !== "process" && candidate.env !== "platform") {
    adapterProblem(`"${candidate.name}" env must be "process" or "platform"`);
  }
  if (candidate.bundling !== "dependencies" && candidate.bundling !== "all") {
    adapterProblem(`"${candidate.name}" bundling must be "dependencies" or "all"`);
  }
  if (typeof candidate.capabilities !== "object" || candidate.capabilities === null) {
    adapterProblem(`"${candidate.name}" needs capabilities`);
  }
  return value as Adapter;
}
