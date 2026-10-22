import { createReadStream, type Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  contentTypeOf,
  defaultImmutable,
  isAllowedWellKnown,
  safeSegments,
  WELL_KNOWN_NAMES,
} from "../node/static-files";
import { hostCheckOf } from "../server/host-policy";
import { platformHost } from "../server/platform";
import type { AssetDecision, Handler } from "../server/types";
import { pageKeyOf, type StaticPage } from "../shared/static-page";

/**
 * The part shared by the runtimes that have their own HTTP server (Bun, Deno): a Web `Request` in,
 * a Web `Response` out, static files from a folder, gzip for buffered and streamed bodies, and a
 * graceful stop. Nothing here knows which runtime it runs in; `bun.ts` and `deno.ts` supply the
 * listener. It uses `node:fs` and `node:stream`, which both runtimes provide.
 *
 * @packageDocumentation
 */

/** Options shared by `serve()` of the native runtimes. @since 1.0.0 */
export interface NativeServeOptions {
  /** Port to listen on. Default: `process.env.PORT`, else 3000. `0` picks a free one. */
  readonly port?: number;
  /** Interface to listen on. Default `"127.0.0.1"`. The generated entries use `HOST`, default `0.0.0.0`. */
  readonly hostname?: string;
  /** Absolute folder of the client build, served before the handler. `false` serves no files. */
  readonly static?: string | false;
  /**
   * The URL path the static folder is served under: the app's base (`/app`). A request outside it is not a
   * static file. Default `"/"`, the root.
   */
  readonly prefix?: string;
  /** The build's assets folder (Vite's `build.assetsDir`), for the immutable rule of hashed files. Default `"assets"`. */
  readonly assetsDir?: string;
  /**
   * Gzip for buffered text responses (those with a `Content-Length`). Streamed responses are not
   * compressed: the gzip stream would hold every chunk back until the end. Default `true`.
   */
  readonly compress?: boolean;
  /** Time a stop waits for requests in flight before it closes them, in milliseconds. Default 10 000. */
  readonly gracefulShutdownMs?: number;
  /** Signals that start a graceful stop. Default `["SIGTERM", "SIGINT"]`; `false` registers none. */
  readonly shutdownSignals?: false | readonly string[];
  /** Exit the process after a signal-triggered stop. Default `true`. */
  readonly exitOnSignal?: boolean;
  /** Receives failures that cannot reach the client. Default: `console.error`. */
  readonly onError?: (error: unknown) => void;
  /**
   * The prerendered pages and how each is answered (see {@link StaticPage}): a `handler` page is rendered per request,
   * a `static` page is served from its file with the app's headers. Default: none.
   */
  readonly pages?: readonly StaticPage[];
}

/** A running native server. @since 1.0.0 */
export interface NativeServeHandle {
  readonly port: number;
  readonly hostname: string;
  /** `http://host:port`. */
  readonly url: string;
  /** True once a stop has started: new requests are refused. */
  readonly draining: boolean;
  /** Stops accepting connections and waits for requests in flight, up to `gracefulShutdownMs`. Idempotent. */
  close(): Promise<void>;
}

/** What a runtime's listener provides to the shared code. @internal */
export interface NativeListener {
  readonly port: number;
  readonly hostname: string;
  /**
   * Stops listening. `closeActive` false waits for requests in flight; true drops them.
   */
  stop(closeActive: boolean): Promise<void>;
}

/** Starts the runtime's server with the given fetch function. @internal */
export type NativeListen = (
  hostname: string,
  port: number,
  fetch: (request: Request, clientAddress: string | undefined) => Promise<Response>,
) => NativeListener;

const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|x-www-form-urlencoded)|image\/svg\+xml)/i;
/** Responses at least this long (when the length is known) are worth compressing. */
const MIN_GZIP_BYTES = 1024;

/**
 * Whether a client accepts gzip (an `Accept-Encoding` entry that is not `q=0`).
 * @param accept The header value.
 * @internal
 * @since 1.0.0
 */
export function acceptsGzip(accept: string | null): boolean {
  if (accept === null) return false;
  return accept.split(",").some((part) => {
    const [coding = "", ...params] = part.trim().split(";");
    if (coding.trim().toLowerCase() !== "gzip" && coding.trim() !== "*") return false;
    return !params.some((param) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param));
  });
}

/**
 * Gzips a buffered text response when the client accepts it. A streamed body (no `Content-Length`) is
 * never gzipped here: `CompressionStream` holds its output until the input ends, which would delay
 * every chunk of a streamed page to the end of the page (measured on Bun: first byte at 1235 ms
 * instead of 5 ms). Streamed text is served as it is; compression of those is left to a proxy.
 * @param response The handler's response.
 * @param accept The request's `Accept-Encoding`.
 * @param method The request method.
 * @returns The same response, or a gzipped copy.
 * @internal
 * @since 1.0.0
 */
export function gzipResponse(response: Response, accept: string | null, method: string): Response {
  const type = response.headers.get("content-type") ?? "";
  const length = response.headers.get("content-length");
  const cache = response.headers.get("cache-control") ?? "";
  if (
    response.body === null ||
    method === "HEAD" ||
    response.status === 204 ||
    response.status === 304 ||
    response.status === 206 ||
    response.headers.has("content-encoding") ||
    !COMPRESSIBLE.test(type) ||
    type.toLowerCase().startsWith("text/event-stream") ||
    /no-transform/i.test(cache) ||
    length === null ||
    Number(length) < MIN_GZIP_BYTES ||
    !acceptsGzip(accept) ||
    typeof CompressionStream !== "function"
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.delete("content-length");
  const vary = headers.get("vary");
  if (vary === null) headers.set("vary", "Accept-Encoding");
  else if (!/accept-encoding/i.test(vary)) headers.set("vary", `${vary}, Accept-Encoding`);
  const etag = headers.get("etag");
  if (etag !== null && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The path below the mount prefix (`/app/x` under `/app` is `/x`), or `undefined` when the path is outside the
 * prefix. The root prefix (`/`, or none) leaves the path as it is.
 */
function pathUnderPrefix(pathname: string, prefix: string | undefined): string | undefined {
  const mount = (prefix ?? "/").replace(/\/+$/, "");
  if (mount === "") return pathname;
  if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return undefined;
  return pathname.slice(mount.length) || "/";
}

/**
 * Adds `Vary: Accept-Encoding` to a compressible answer, whether or not this server compresses it: a cache in front must
 * not keep a gzipped copy for a client that did not ask for one.
 * @param response The handler's response.
 * @returns The same response, or a copy with the header.
 * @internal
 * @since 1.0.0
 */
export function varyAcceptEncoding(response: Response): Response {
  if (!COMPRESSIBLE.test(response.headers.get("content-type") ?? "")) return response;
  const vary = response.headers.get("vary");
  if (vary !== null && /accept-encoding/i.test(vary)) return response;
  const headers = new Headers(response.headers);
  headers.set("vary", vary === null ? "Accept-Encoding" : `${vary}, Accept-Encoding`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The prerendered page a path names, by page key (see `pageKeyOf`). @internal */
function pageFor(pages: ReadonlyMap<string, StaticPage>, pathname: string): StaticPage | undefined {
  if (pages.size === 0) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  return pages.get(pageKeyOf(decoded));
}

/**
 * The static-file gate of a handler that runs its middleware for files: asked once a file is found, before it is read.
 * Its `answer` is sent instead of the file; its `serve` headers go out with the file (see `Handler.gateAsset`).
 * @internal
 */
type NativeGate = (request: Request) => Promise<AssetDecision>;

/** A file under `root` that the request names, or a response to send instead. */
async function staticFor(
  root: string,
  realRoot: Promise<string>,
  request: Request,
  assetsDir: string,
  prefix: string | undefined,
  pages: ReadonlyMap<string, StaticPage>,
  gate: NativeGate | undefined,
): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const pathname = pathUnderPrefix(new URL(request.url).pathname, prefix);
  if (pathname === undefined) return undefined;
  const segments = safeSegments(pathname);
  if (segments === undefined) {
    return new Response("Bad Request", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  if (
    segments.some((segment) => segment.startsWith(".")) &&
    !isAllowedWellKnown(segments, WELL_KNOWN_NAMES)
  )
    return undefined;
  // A page a rule of the app applies to is rendered by the handler, never read from its file (B2).
  const page = pageFor(pages, pathname);
  if (page?.mode === "handler") return undefined;
  const base = await realRoot;
  // The path itself, then its directory index (`/` and `/about/`), then the clean-URL file (`/about` is `about.html`).
  // A prerendered page is found this way: `about/index.html` for `/about`, `index.html` for `/`.
  const candidates: string[][] = [segments, [...segments, "index.html"]];
  const last = segments[segments.length - 1];
  if (last !== undefined) candidates.push([...segments.slice(0, -1), `${last}.html`]);
  let served: { real: string; info: Stats; relative: string } | undefined;
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const path = resolve(root, ...candidate);
    if (!path.startsWith(root + sep)) {
      return new Response("Bad Request", { status: 400 });
    }
    let real: string;
    let info: Stats;
    try {
      real = await realpath(path);
      info = await stat(real);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG") {
        continue;
      }
      throw error;
    }
    // A symlink that leads out of the folder is not served at all.
    if (!real.startsWith(base + sep)) return undefined;
    if (info.isFile()) {
      served = { real, info, relative: candidate.join("/") };
      break;
    }
  }
  if (served === undefined) return undefined;
  const { real, info, relative } = served;
  // The middleware of a gated handler decides first: its refusal (or failure, redirect, rewrite answer) is the response,
  // and its headers and cookies go out with the file (the framing stays the server's).
  const decision = gate === undefined ? undefined : await gate(request);
  if (decision?.kind === "answer") return decision.response;

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = new Headers({
    "content-type": contentTypeOf(relative),
    ...(COMPRESSIBLE.test(contentTypeOf(relative)) ? { vary: "Accept-Encoding" } : {}),
    "content-length": String(info.size),
    "last-modified": info.mtime.toUTCString(),
    etag,
    "x-content-type-options": "nosniff",
    "cache-control": defaultImmutable(relative, assetsDir)
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
  });
  if (page?.mode === "static") {
    for (const [name, value] of page.headers) headers.set(name, value);
    if (new URL(request.url).protocol === "https:") {
      for (const [name, value] of page.httpsHeaders) headers.set(name, value);
    }
  }
  // The headers the gate's middleware set go out last: they win over the defaults and the page's policy.
  if (decision?.kind === "serve") {
    for (const [name, value] of decision.headers) {
      if (name !== "set-cookie") headers.set(name, value);
    }
    for (const cookie of decision.headers.getSetCookie()) headers.append("set-cookie", cookie);
  }
  const condition = request.headers.get("if-none-match");
  if (
    condition?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""))
  ) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(createReadStream(real)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

/**
 * The fetch function the runtime's server calls for every request: static files first, then the
 * handler with the client address, then gzip. A handler that throws becomes a plain 500 (the
 * error goes to `onError`).
 * @param handler The handler from the server bundle.
 * @param options Static folder, compression and error sink.
 * @returns The fetch function.
 * @internal
 * @since 1.0.0
 */
export function createNativeFetch(
  handler: Handler,
  options: {
    readonly static: string | false;
    readonly compress: boolean;
    readonly onError: (error: unknown) => void;
    readonly assetsDir?: string;
    readonly prefix?: string;
    readonly pages?: readonly StaticPage[];
  },
): (request: Request, clientAddress: string | undefined) => Promise<Response> {
  const root = options.static === false ? undefined : resolve(options.static);
  const pages = new Map((options.pages ?? []).map((page) => [page.path, page] as const));
  // The real path of the folder is resolved once, when the server starts.
  const realRoot = root === undefined ? undefined : realpath(root);
  const assetsDir = options.assetsDir ?? "assets";
  // The handler's host list (`security.allowedHosts`), the same predicate the handler applies to `url.host`. A refused
  // Host is not answered from the folder: the handler answers its own 400, for a file and a missing path alike.
  const hostCheck = hostCheckOf(handler);
  // A handler that runs its middleware for files (`runMiddlewareForStaticFiles`) is asked about each file it would send;
  // the platform is the one the handler gets for the same request.
  const gateAsset = handler.gateAsset;
  return async (request, clientAddress) => {
    try {
      if (
        root !== undefined &&
        realRoot !== undefined &&
        (hostCheck === undefined || hostCheck(new URL(request.url).host))
      ) {
        const gate =
          gateAsset === undefined
            ? undefined
            : (asked: Request): Promise<AssetDecision> =>
                gateAsset(asked, platformHost(undefined, { clientAddress }));
        const file = await staticFor(
          root,
          realRoot,
          request,
          assetsDir,
          options.prefix,
          pages,
          gate,
        );
        if (file !== undefined) return file;
      }
      const answer = varyAcceptEncoding(
        await handler.fetch(request, platformHost(undefined, { clientAddress })),
      );
      return options.compress
        ? gzipResponse(answer, request.headers.get("accept-encoding"), request.method)
        : answer;
    } catch (error) {
      options.onError(error);
      return new Response("Internal Server Error", {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    }
  };
}

interface SignalSource {
  on(signal: string, listener: () => void): unknown;
  off(signal: string, listener: () => void): unknown;
}

/** Ends the process with `code` through the runtime's `process.exit`. @internal */
function exitProcess(code: number): void {
  const host: unknown = Reflect.get(globalThis, "process");
  const exit: unknown =
    typeof host === "object" && host !== null ? Reflect.get(host, "exit") : undefined;
  if (typeof exit === "function") Reflect.apply(exit, host, [code]);
}

/** The `process` of the runtime (Bun and Deno both have one), or `undefined`. @internal */
export function processOf(): SignalSource | undefined {
  const host: unknown = Reflect.get(globalThis, "process");
  if (typeof host !== "object" || host === null) return undefined;
  const on: unknown = Reflect.get(host, "on");
  const off: unknown = Reflect.get(host, "off");
  if (typeof on !== "function" || typeof off !== "function") return undefined;
  return host as SignalSource;
}

/**
 * Starts a native server and wires graceful stop to signals.
 * @param listen The runtime's listener factory.
 * @param handler The handler.
 * @param options Shared options.
 * @returns The running server.
 * @internal
 * @since 1.0.0
 */
export async function startNative(
  listen: NativeListen,
  handler: Handler,
  options: NativeServeOptions,
): Promise<NativeServeHandle> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? defaultPort();
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`serve: port must be an integer from 0 to 65535 (got ${port})`);
  }
  const reportFailure =
    options.onError ??
    ((error: unknown): void => {
      console.error("[dusk] request failed", error);
    });
  const fetch = createNativeFetch(handler, {
    static: options.static ?? false,
    compress: options.compress !== false,
    onError: reportFailure,
    ...(options.assetsDir === undefined ? {} : { assetsDir: options.assetsDir }),
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.pages === undefined ? {} : { pages: options.pages }),
  });
  const listener = listen(hostname, port, fetch);
  let draining = false;
  let closing: Promise<void> | undefined;
  const gracefulMs = options.gracefulShutdownMs ?? 10_000;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      draining = true;
      const graceful = listener.stop(false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), gracefulMs);
      });
      try {
        const outcome = await Promise.race([graceful.then(() => "done" as const), deadline]);
        if (outcome === "timeout") {
          graceful.catch(reportFailure);
          await listener.stop(true);
        }
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };

  const signals =
    options.shutdownSignals === false ? [] : (options.shutdownSignals ?? ["SIGTERM", "SIGINT"]);
  const source = processOf();
  const registered: Array<readonly [string, () => void]> = [];
  if (source !== undefined) {
    for (const signal of signals) {
      const onSignal = (): void => {
        close()
          .then(() => {
            if (options.exitOnSignal !== false) exitProcess(0);
          })
          .catch(reportFailure);
      };
      registered.push([signal, onSignal]);
      source.on(signal, onSignal);
    }
  }
  const shownHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return {
    port: listener.port,
    hostname,
    url: `http://${shownHost}:${listener.port}`,
    get draining() {
      return draining;
    },
    close: async () => {
      try {
        await close();
      } finally {
        for (const [signal, listenerFn] of registered) source?.off(signal, listenerFn);
      }
    },
  };
}

/** `PORT` from the environment, else 3000. @internal */
export function defaultPort(): number {
  const host: unknown = Reflect.get(globalThis, "process");
  const env: unknown =
    typeof host === "object" && host !== null ? Reflect.get(host, "env") : undefined;
  const raw = typeof env === "object" && env !== null ? Reflect.get(env, "PORT") : undefined;
  if (typeof raw !== "string" || raw.trim() === "") return 3000;
  const value = Number(raw);
  return Number.isInteger(value) ? value : 3000;
}
