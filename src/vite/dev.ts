import type { IncomingMessage, ServerResponse } from "node:http";
import { relative } from "node:path";
import { createMatcher } from "@shadow-js/router/core";
import {
  ROUTE_UI_QUERY,
  type RouteEntry,
  type ScanResult,
  type ShadowRouterApi,
} from "@shadow-js/router/vite";
import type { Connect, EnvironmentModuleNode, ViteDevServer } from "vite";
import { errorDigest } from "../server/digest";
import type { ErrorInfo } from "../server/types";
import { DUSK_MATCHER_OPTIONS } from "../shared/router";
import { BadRequestError, toWebRequest, writeWebResponse } from "./node-bridge";
import { SERVER_ENTRY_ID } from "./virtual";

/**
 * The dev server. Page requests that Vite does not answer itself (module requests, `public/`
 * files, HMR) go to the app's `fetch` handler, loaded through `ssrLoadModule` so edits take effect
 * on the next request without a restart. The HTML the handler returns gets Vite's client (HMR and
 * the error overlay) and the stylesheets of the routes on the page, so there is no flash of
 * unstyled content.
 */

/** What the dev middleware needs to know about the project. @since 1.0.0 */
export interface DevOptions {
  readonly root: string;
  /** Vite's `base` (`/` or `/app/`). */
  readonly viteBase: string;
  /** URL path of the client entry as the browser requests it (without the base). */
  readonly clientEntryUrl: string;
  readonly router: ShadowRouterApi;
  /**
   * Told after each page request: `false` when the page failed to render (a server error, shown as a 500 page). The
   * plugin uses it to reload that page once the server code is fixed; see the `hotUpdate` hook of the core plugin.
   */
  readonly onRender?: (rendered: boolean) => void;
}

interface HandlerLike {
  fetch(request: Request, env?: unknown): Promise<Response>;
}

interface EntryModule {
  readonly handler: HandlerLike;
  readonly setDevReporter:
    | ((report: (error: unknown, info: ErrorInfo) => void) => void)
    | undefined;
}

/** Most modules the style collection visits for one page. */
const MAX_STYLE_MODULES = 5000;

/**
 * URLs Vite itself owns: its client, the module ids (`/@id/`, `/@fs/`), the React refresh runtime and its `__vite*` and
 * `__open-in-editor` endpoints. A bare `/@` or `/__` prefix is not enough: a page route may start with `@` (`/@me`, a
 * profile page) and the app answers it in production, so the dev server must too.
 */
const VITE_INTERNAL =
  /^\/(?:@(?:vite|id|fs|react-refresh|vite-plugin[^/?]*)(?:[/?]|$)|__(?:vite|open-in-editor|inspect)[^/?]*(?:[/?]|$))/;

/**
 * True for a request URL (path and query) that Vite answers and the app's handler never sees.
 *
 * @param url The request URL as the middleware stack sees it (the base is already stripped).
 * @returns Whether the request belongs to Vite.
 * @example isViteInternal("/@vite/client"); // true; isViteInternal("/@me") is false
 * @internal
 * @since 1.0.0
 */
export function isViteInternal(url: string): boolean {
  return VITE_INTERNAL.test(url);
}

const STYLE_URL = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:\?|$)/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/**
 * Loads the server entry against the route tree on disk. The tree is brought up to date first: the watcher reports a
 * removed or added route after the file system has changed, so a request that comes in between would load a tree that
 * names a file that is gone (a 500). A load that fails after the sync is tried once more after a second sync, which
 * rewrites the tree and tells the server to load it again; a failure that remains is the app's own and is reported.
 */
async function loadFreshEntry(
  server: ViteDevServer,
  router: ShadowRouterApi,
): Promise<EntryModule> {
  await router.sync();
  try {
    return await loadEntry(server);
  } catch {
    await router.sync();
    return loadEntry(server);
  }
}

/** Loads the server entry and checks its shape. */
async function loadEntry(server: ViteDevServer): Promise<EntryModule> {
  const loaded: unknown = await server.ssrLoadModule(SERVER_ENTRY_ID);
  const handler = isRecord(loaded) ? Reflect.get(loaded, "handler") : undefined;
  if (!isRecord(handler) || typeof Reflect.get(handler, "fetch") !== "function") {
    throw new TypeError(`${SERVER_ENTRY_ID} must export \`handler\` (a createHandler() result)`);
  }
  const setter = Reflect.get(loaded as object, "setDevReporter");
  return {
    handler: handler as unknown as HandlerLike,
    setDevReporter:
      typeof setter === "function" ? (setter as EntryModule["setDevReporter"]) : undefined,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface DevErrorShape {
  message: string;
  stack: string;
  id?: string;
  frame?: string;
  plugin?: string;
  loc?: { file?: string; line: number; column: number };
}

function shapeOf(error: unknown): DevErrorShape {
  const failure = error instanceof Error ? error : new Error(String(error));
  const extra = failure as Error & {
    id?: unknown;
    frame?: unknown;
    plugin?: unknown;
    loc?: unknown;
  };
  const shape: DevErrorShape = { message: failure.message, stack: failure.stack ?? "" };
  if (typeof extra.id === "string") shape.id = extra.id;
  if (typeof extra.frame === "string") shape.frame = extra.frame;
  if (typeof extra.plugin === "string") shape.plugin = extra.plugin;
  if (
    isRecord(extra.loc) &&
    typeof extra.loc["line"] === "number" &&
    typeof extra.loc["column"] === "number"
  ) {
    shape.loc = {
      line: extra.loc["line"],
      column: extra.loc["column"],
      ...(typeof extra.loc["file"] === "string" ? { file: extra.loc["file"] } : {}),
    };
  }
  return shape;
}

/** Shows an error in the browser overlay and returns the shape that was sent. */
function reportToOverlay(server: ViteDevServer, error: unknown): DevErrorShape {
  if (error instanceof Error) server.ssrFixStacktrace(error);
  const shape = shapeOf(error);
  server.environments.client.hot.send({ type: "error", err: shape });
  return shape;
}

/** True for a request of a page (a document): the browser asks for `text/html` when it navigates. */
function acceptsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/html");
}

function wantsJson(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  const json = accept.indexOf("application/json");
  if (json === -1) return false;
  const html = accept.indexOf("text/html");
  return html === -1 || json < html;
}

/**
 * Answers a failed request with the error. The HTML page loads Vite's client (`clientScript`): the page then hears the
 * server when the error is fixed (the plugin reloads the page) and shows the error overlay.
 */
function sendError(
  req: IncomingMessage,
  res: ServerResponse,
  shape: DevErrorShape,
  clientScript: string,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = 500;
  if (wantsJson(req)) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: shape }));
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="${escapeHtml(clientScript)}"></script><title>500 Server Error</title></head><body>` +
      `<h1>500 Server Error</h1><pre>${escapeHtml(shape.message)}</pre>` +
      `<pre>${escapeHtml(shape.frame ?? "")}</pre><pre>${escapeHtml(shape.stack)}</pre></body></html>`,
  );
}

/** The `<head>` open tag. A word boundary keeps `<header>` out. */
const HEAD_OPEN = /<head\b[^>]*>/i;

/**
 * Wraps a body so `first` is written right after the `<head>` open tag and `last` just before
 * `</head>`. Vite's client goes first: module scripts run in document order, and the app's entry
 * must evaluate after the client has set the build constants and connected the HMR socket.
 */
function injectIntoHead(
  body: ReadableStream<Uint8Array>,
  first: string,
  last: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (done) {
          controller.enqueue(chunk);
          return;
        }
        buffer += decoder.decode(chunk, { stream: true });
        const end = buffer.indexOf("</head>");
        if (end !== -1) {
          const open = HEAD_OPEN.exec(buffer.slice(0, end));
          const start = open === null ? -1 : open.index + open[0].length;
          const page =
            start === -1
              ? buffer.slice(0, end) + last + buffer.slice(end)
              : buffer.slice(0, start) +
                first +
                buffer.slice(start, end) +
                last +
                buffer.slice(end);
          controller.enqueue(encoder.encode(page));
        } else if (buffer.length > 262_144) {
          // No head in the first 256 KiB: not a page the plugin understands; pass it on untouched.
          controller.enqueue(encoder.encode(buffer));
        } else {
          return;
        }
        buffer = "";
        done = true;
      },
      flush(controller) {
        if (buffer !== "") controller.enqueue(encoder.encode(buffer));
      },
    }),
  );
}

/** The tags Vite and its plugins add to a page's head (client, HMR, `transformIndexHtml` hooks). */
async function viteHeadTags(server: ViteDevServer, url: string): Promise<string> {
  const probe = "<!doctype html><html><head></head><body></body></html>";
  const html = await server.transformIndexHtml(url, probe, url);
  const start = html.indexOf("<head>");
  const end = html.indexOf("</head>");
  return start === -1 || end === -1 ? "" : html.slice(start + "<head>".length, end);
}

function toTree(
  entries: readonly RouteEntry[],
): { id: string; path: string; children: unknown[] }[] {
  return entries.map((entry) => ({
    id: entry.id,
    path: entry.path,
    children: toTree(entry.children),
  }));
}

const matchers = new WeakMap<ScanResult, ReturnType<typeof createMatcher>>();

function matcherOf(scan: ScanResult): ReturnType<typeof createMatcher> {
  let matcher = matchers.get(scan);
  if (matcher === undefined) {
    matcher = createMatcher(
      toTree(scan.roots) as Parameters<typeof createMatcher>[0],
      DUSK_MATCHER_OPTIONS,
    );
    matchers.set(scan, matcher);
  }
  return matcher;
}

/** Stylesheets reachable from the modules the page at `pathname` runs, in import order. */
async function stylesheetsFor(
  server: ViteDevServer,
  options: DevOptions,
  scan: ScanResult | undefined,
  pathname: string,
): Promise<string[]> {
  const client = server.environments.client;
  const starts: string[] = [options.clientEntryUrl];
  const matcher = scan === undefined ? undefined : matcherOf(scan);
  if (scan !== undefined && matcher !== undefined) {
    const byId = new Map(scan.entries.map((entry) => [entry.id, entry]));
    for (const match of matcher.match(pathname)) {
      const entry = byId.get(match.id);
      if (entry === undefined) continue;
      const url = `/${relative(options.root, entry.absolutePath).split("\\").join("/")}`;
      starts.push(url, `${url}?${ROUTE_UI_QUERY}`);
    }
  }
  const sheets: string[] = [];
  const seen = new Set<EnvironmentModuleNode>();
  const queue: EnvironmentModuleNode[] = [];
  const seeds = new Set<EnvironmentModuleNode>();
  for (const url of starts) {
    // A virtual module is served as `/@id/<id>` and lives in the graph under `\0<id>`.
    const virtualId = url.startsWith("/@id/") ? url.slice("/@id/".length) : undefined;
    try {
      await client.transformRequest(virtualId ?? url);
    } catch (error) {
      // The browser will request the same module and show the error; the page is still served.
      server.config.logger.warn(`could not collect styles of ${url}: ${(error as Error).message}`);
      continue;
    }
    const node =
      virtualId !== undefined
        ? client.moduleGraph.getModuleById(`\0${virtualId}`)
        : await client.moduleGraph.getModuleByUrl(url);
    if (node !== undefined) {
      queue.push(node);
      seeds.add(node);
    }
  }
  // Depth first in import order: the order of the stylesheets is the order of the cascade. A
  // module's imports are known once it was transformed, so project modules are transformed on the
  // way; packages and Vite's own modules are not followed (a stylesheet they import is still found).
  const rootPrefix = `${options.root.split("\\").join("/")}/`;
  const stack = queue.reverse();
  let visited = 0;
  while (stack.length > 0 && visited < MAX_STYLE_MODULES) {
    const node = stack.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    visited += 1;
    if (STYLE_URL.test(node.url) && !/[?&](?:inline|url|raw)\b/.test(node.url)) {
      sheets.push(node.url);
      continue;
    }
    // A route's lazily loaded UI is reached through the route tree too; only the routes on this
    // page (the seeds) bring their UI, so other routes' styles are not linked.
    if (node.url.includes(ROUTE_UI_QUERY) && !seeds.has(node)) continue;
    const id = node.id ?? node.url;
    const inProject = id.startsWith(rootPrefix) && !id.includes("/node_modules/");
    if (!inProject && !id.startsWith("\0")) continue;
    if (node.transformResult === null || node.transformResult === undefined) {
      try {
        await client.transformRequest(node.url);
      } catch (error) {
        server.config.logger.warn(
          `could not collect styles of ${node.url}: ${(error as Error).message}`,
        );
        continue;
      }
    }
    const imports = [...node.importedModules];
    for (let index = imports.length - 1; index >= 0; index -= 1) {
      const imported = imports[index];
      if (imported !== undefined) stack.push(imported);
    }
  }
  return sheets;
}

/**
 * Creates the middleware that answers page requests with the app's handler.
 *
 * @param server The dev server.
 * @param options Project facts.
 * @returns A Connect middleware; install it after Vite's own.
 * @since 1.0.0
 * @internal
 * @example server.middlewares.use(devMiddleware(server, { root, viteBase: "/", clientEntryUrl, router }));
 */
export function devMiddleware(
  server: ViteDevServer,
  options: DevOptions,
): Connect.NextHandleFunction {
  const protocol = server.config.server.https === undefined ? "http" : "https";
  return (req, res, next) => {
    const url = req.url ?? "/";
    if (isViteInternal(url)) {
      next();
      return;
    }
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    void (async () => {
      try {
        const entry = await loadFreshEntry(server, options.router);
        entry.setDevReporter?.((error, info) => {
          // The server gave the error its digest before it reported it (the page shows the same one). It is not computed
          // here: this bundle has a key of its own, so its digest would differ. The fallback is for a value that cannot
          // take a property.
          const given =
            typeof error === "object" && error !== null
              ? Object.getOwnPropertyDescriptor(error, "digest")?.value
              : undefined;
          const digest = typeof given === "string" ? given : errorDigest(error);
          reportToOverlay(server, error);
          // The same line the production sink prints (`[dusk] <phase> error (request <id>, digest <digest>)`), so the
          // digest of the error page is found in the log. The logger adds the `[dusk]` tag and the time.
          const request = info.event === undefined ? "-" : info.event.id;
          const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
          server.config.logger.error(
            `${info.phase} error (request ${request}, digest ${digest})\n${text}`,
            {
              timestamp: true,
            },
          );
        });
        const request = toWebRequest(req, { protocol, signal: controller.signal });
        const response = await entry.handler.fetch(request);
        const type = response.headers.get("content-type") ?? "";
        let out = response;
        if (type.includes("text/html") && response.body !== null && request.method !== "HEAD") {
          let scan: ScanResult | undefined;
          try {
            scan = await options.router.getScan();
          } catch (error) {
            // Route problems are already in the overlay; the page renders without route styles.
            server.config.logger.warn(
              `routes unavailable for style collection: ${(error as Error).message}`,
            );
          }
          const pathname = new URL(request.url).pathname;
          const base = options.viteBase === "/" ? "" : options.viteBase.replace(/\/$/, "");
          const local =
            base !== "" && pathname.startsWith(base)
              ? pathname.slice(base.length) || "/"
              : pathname;
          const sheets = await stylesheetsFor(server, options, scan, local);
          const links = sheets
            .map((sheet) => {
              const href = `${options.viteBase}${sheet.replace(/^\//, "")}${sheet.includes("?") ? "&" : "?"}direct`;
              return `<link rel="stylesheet" href="${escapeHtml(href)}" data-vite-dev-id="${escapeHtml(sheet)}">`;
            })
            .join("");
          const tags = await viteHeadTags(server, url);
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          out = new Response(injectIntoHead(response.body, tags, links), {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
        if (type.includes("text/html")) options.onRender?.(out.status < 500);
        await writeWebResponse(res, out, request.method === "HEAD");
      } catch (error) {
        if (error instanceof BadRequestError) {
          res.statusCode = 400;
          res.end(error.message);
          return;
        }
        // Only a page that failed counts (its document is the 500 page the fix reloads). A failed server function call or
        // API request fails by itself: it does not make the page fail.
        if (acceptsHtml(req)) options.onRender?.(false);
        sendError(req, res, reportToOverlay(server, error), `${options.viteBase}@vite/client`);
      }
    })();
  };
}
