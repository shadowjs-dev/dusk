import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPathFromParams, parsePattern } from "@shadow-js/router/core";
import { ROUTE_UI_QUERY, type RouteEntry, type ScanResult } from "@shadow-js/router/vite";
import { allowedHostsOf, choosePrerenderOrigin, hostRejectionMessage } from "../server/hosts";
import type { StaticPage } from "../shared/static-page";
import {
  crawlPolicyOf,
  describeFailures,
  internalLinks,
  reasonOf,
  runCrawl,
} from "../static/crawl";
import { escapesFolder } from "./containment";
import type { PrerenderOptions } from "./options";
import { closestRoute, routeMatches } from "./prerender-routes";
import type { ServerFnRecord } from "./project";

export { closestRoute, routeMatches };

/**
 * Production build helpers: the asset manifest computed from Vite's client manifest, and the
 * prerender step. Everything here is deterministic: sorted keys, no timestamps, no absolute paths.
 */

/** One entry of Vite's `.vite/manifest.json`. @since 1.0.0 */
export interface ViteManifestChunk {
  readonly file: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}

/** Vite's client manifest. @since 1.0.0 */
export type ViteManifest = Readonly<Record<string, ViteManifestChunk>>;

/** The asset section the handler's manifest takes. @since 1.0.0 */
export interface BuiltAssets {
  readonly entry: string;
  readonly css: readonly string[];
  readonly preloads: Readonly<Record<string, readonly string[]>>;
  readonly base: string;
}

function posix(path: string): string {
  return path.split("\\").join("/");
}

/** Chunk keys reachable from `start` through static imports, `start` first, each once. */
function staticClosure(
  manifest: ViteManifest,
  start: string,
  exclude: ReadonlySet<string>,
): string[] {
  const order: string[] = [];
  const seen = new Set<string>(exclude);
  const stack = [start];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
    const chunk = manifest[key];
    const imports = chunk?.imports ?? [];
    for (let index = imports.length - 1; index >= 0; index -= 1) {
      const next = imports[index];
      if (next !== undefined) stack.push(next);
    }
  }
  return order;
}

/**
 * Computes what the server puts in the page for each route: the entry, the stylesheets every page
 * needs, and per route the chunks and stylesheets of its lazily loaded UI that the entry does not
 * already bring. Lists are deduplicated and cut to `maxPreloads`.
 *
 * @param input The Vite manifest, the scanned routes and the project root.
 * @returns The asset section and the route facts.
 * @throws Error when the manifest has no entry chunk.
 * @example
 * const { assets } = computeAssets({ manifest, scan, root, base: "/", maxPreloads: 24 });
 * @since 1.0.0
 */
export function computeAssets(input: {
  readonly manifest: ViteManifest;
  readonly scan: ScanResult;
  readonly root: string;
  readonly base: string;
  readonly maxPreloads: number;
  /** The CDN origin of the built assets (`assetOrigin`); the file names become `<origin><base><file>`. */
  readonly origin?: string;
}): BuiltAssets {
  const { manifest, scan, root } = input;
  const keys = Object.keys(manifest).sort();
  const entryKey = keys.find((key) => manifest[key]?.isEntry === true);
  const entryChunk = entryKey === undefined ? undefined : manifest[entryKey];
  if (entryKey === undefined || entryChunk === undefined) {
    throw new Error("the client build has no entry chunk");
  }
  const entryClosure = staticClosure(manifest, entryKey, new Set());
  const inEntry = new Set(entryClosure);
  const css: string[] = [];
  for (const key of entryClosure) {
    for (const file of manifest[key]?.css ?? []) if (!css.includes(file)) css.push(file);
  }

  const preloads: Record<string, readonly string[]> = {};
  for (const entry of scan.entries) {
    const key = findUiKey(manifest, keys, root, entry);
    if (key === undefined) {
      preloads[entry.id] = [];
      continue;
    }
    const chunks = staticClosure(manifest, key, inEntry);
    const js: string[] = [];
    const sheets: string[] = [];
    for (const chunkKey of chunks) {
      const chunk = manifest[chunkKey];
      if (chunk === undefined) continue;
      if (!js.includes(chunk.file)) js.push(chunk.file);
      for (const file of chunk.css ?? []) {
        if (!css.includes(file) && !sheets.includes(file)) sheets.push(file);
      }
    }
    preloads[entry.id] = [...sheets, ...js].slice(0, input.maxPreloads);
  }
  const sorted: Record<string, readonly string[]> = {};
  for (const id of Object.keys(preloads).sort()) sorted[id] = preloads[id] ?? [];
  // A CDN origin makes the built references absolute (the runtime keeps a path that is already absolute as it is).
  const at = (file: string): string =>
    input.origin === undefined ? file : `${input.origin}${input.base.replace(/\/+$/, "")}/${file}`;
  const withOrigin: Record<string, readonly string[]> = {};
  for (const id of Object.keys(sorted)) withOrigin[id] = (sorted[id] ?? []).map(at);
  return { entry: at(entryChunk.file), css: css.map(at), preloads: withOrigin, base: input.base };
}

/** The manifest key of a route's lazily loaded UI chunk. */
function findUiKey(
  manifest: ViteManifest,
  keys: readonly string[],
  root: string,
  entry: RouteEntry,
): string | undefined {
  const rel = posix(relative(root, entry.absolutePath));
  const wanted = `${rel}?${ROUTE_UI_QUERY}`;
  if (manifest[wanted] !== undefined) return wanted;
  return keys.find((key) => manifest[key]?.src === wanted || key.endsWith(wanted));
}

/**
 * Hash of the client assets: the same sources always give the same id. @since 1.0.0
 *
 * @example buildIdOf(viteManifest); // "q3Zr0b1g2yTt0m5Q"
 */
export function buildIdOf(manifest: ViteManifest): string {
  const hash = createHash("sha256");
  for (const key of Object.keys(manifest).sort()) {
    const chunk = manifest[key];
    hash.update(`${key}\0${chunk?.file ?? ""}\0${(chunk?.css ?? []).join(",")}\0`);
  }
  return hash.digest("base64url").slice(0, 16);
}

/** The JSON file `dusk-manifest.json`. @since 1.0.0 */
export interface DuskManifest {
  readonly version: 1;
  readonly buildId: string;
  readonly base: string;
  /** The build's assets folder (Vite's `build.assetsDir`, `assets` by default). Adapters derive their immutable rules from it. */
  readonly assetsDir: string;
  readonly entry: string;
  readonly css: readonly string[];
  readonly routes: Readonly<
    Record<
      string,
      {
        readonly kind: "page" | "layout";
        readonly file: string;
        /** The URL pattern of the route (`/posts/:id`, a layout's folder prefix). */
        readonly path: string;
        readonly preload: readonly string[];
        readonly ssr?: boolean | "data-only";
        readonly prerender?: boolean | readonly string[];
        /** `export const dynamicParams` of the page, when it sets one: `false` makes a param its list omits not found. */
        readonly dynamicParams?: boolean;
        /** `revalidate` of the route in seconds (ISR), when it sets one. */
        readonly revalidate?: number;
      }
    >
  >;
  readonly api: readonly {
    readonly id: string;
    readonly file: string;
    readonly methods: readonly string[];
  }[];
  /** The stream routes (`SSE` and `WS` exports): the URL pattern and the kinds the module exports. */
  readonly streams: readonly {
    readonly id: string;
    readonly path: string;
    readonly kinds: readonly string[];
  }[];
  /** The `_middleware` files, relative to the project root. Each one covers the routes in its folder and below. */
  readonly middleware: readonly { readonly file: string }[];
  readonly serverFns: Readonly<
    Record<
      string,
      { readonly file: string; readonly export: string; readonly method: "GET" | "POST" }
    >
  >;
  readonly prerendered: readonly string[];
  /**
   * How each prerendered page is answered (B2): a file with its headers, or the handler per request. Written when the
   * build prerendered pages; the static layers of the Node, Bun and Deno runtimes and `dusk start` read it.
   */
  readonly staticPages?: readonly StaticPage[];
  /**
   * The adapter the build used, when it has one: its name and its output folder. `dusk start` reads it to know whether
   * the build runs on the Node adapter. Absent when the app has no adapter.
   */
  readonly adapter?: { readonly name: string; readonly outDir: string };
}

/**
 * Builds the contents of `dusk-manifest.json`.
 *
 * @param input Assets, scan, server functions and the project root (paths are made relative). `adapter` is the
 *   adapter the build runs, when there is one.
 * @returns The manifest object; serialize it with `JSON.stringify(manifest, null, 2)`.
 * @since 1.0.0
 * @example JSON.stringify(createDuskManifest({ buildId, assets, scan, serverFns, root, prerendered }), null, 2);
 */
export function createDuskManifest(input: {
  readonly buildId: string;
  readonly assets: BuiltAssets;
  readonly scan: ScanResult;
  readonly serverFns: readonly ServerFnRecord[];
  readonly root: string;
  readonly prerendered: readonly string[];
  readonly staticPages?: readonly StaticPage[];
  readonly adapter?: { readonly name: string; readonly outDir: string };
  /** The build's assets folder. Default `assets`. */
  readonly assetsDir?: string;
}): DuskManifest {
  const routes: Record<string, DuskManifest["routes"][string]> = {};
  for (const entry of [...input.scan.entries].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const revalidate = entry.info.config.revalidate;
    routes[entry.id] = {
      kind: entry.kind,
      file: posix(relative(input.root, entry.absolutePath)),
      path: entry.fullPath,
      preload: input.assets.preloads[entry.id] ?? [],
      ...(entry.info.config.ssr === undefined ? {} : { ssr: entry.info.config.ssr }),
      ...(entry.info.config.prerender === undefined
        ? {}
        : { prerender: entry.info.config.prerender }),
      ...(entry.info.config.dynamicParams === undefined
        ? {}
        : { dynamicParams: entry.info.config.dynamicParams }),
      ...(typeof revalidate === "number" ? { revalidate } : {}),
    };
  }
  const serverFns: Record<string, DuskManifest["serverFns"][string]> = {};
  for (const record of [...input.serverFns].sort((a, b) => (a.fn.id < b.fn.id ? -1 : 1))) {
    serverFns[record.fn.id] = {
      file: posix(relative(input.root, record.file)),
      export: record.fn.exportName,
      method: record.fn.method,
    };
  }
  return {
    version: 1,
    buildId: input.buildId,
    base: input.assets.base,
    assetsDir: input.assetsDir ?? "assets",
    entry: input.assets.entry,
    css: input.assets.css,
    routes,
    api: input.scan.api.map((api) => ({
      id: api.id,
      file: posix(relative(input.root, api.absolutePath)),
      methods: api.methods,
    })),
    streams: input.scan.streams.map((stream) => ({
      id: stream.id,
      path: stream.fullPath,
      kinds: stream.kinds,
    })),
    middleware: input.scan.middleware.map((entry) => ({
      file: posix(relative(input.root, entry.absolutePath)),
    })),
    serverFns,
    prerendered: input.prerendered,
    ...(input.staticPages === undefined ? {} : { staticPages: input.staticPages }),
    ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
  };
}

// ---- prerender ---------------------------------------------------------------------------------

/** A path to render at build time. @since 1.0.0 */
export interface PrerenderTarget {
  readonly path: string;
  /** Render the SPA shell (a route with `ssr = false`) instead of the page. */
  readonly shell: boolean;
  /**
   * Where the path was listed, for the messages about it: `prerender.routes`, `prerender.entries`, "the `prerender`
   * export of <file>", "the `prerender` function of <file>", "the `ssr = false` route <file>".
   */
  readonly source?: string;
}

/**
 * Why a prerender failed.
 *
 * @example
 * import { PrerenderError } from "@shadow-js/dusk/vite";
 * new PrerenderError("/about returned 500").message; // "[PRERENDER] /about returned 500"
 * @since 1.0.0
 */
export class PrerenderError extends Error {
  constructor(message: string) {
    super(`[PRERENDER] ${message}`);
    this.name = "PrerenderError";
  }
}

/**
 * The `prerender` export of a route that is a function, loaded from the server bundle. `id` is the
 * route id the function belongs to.
 *
 * @since 1.0.0
 */
export interface PrerenderRouteLoader {
  readonly id: string;
  /** Loads the export: a function, a list, a boolean, or anything else (which is ignored). */
  readonly load: () => Promise<unknown>;
}

const MAX_SEGMENT = 200;
const MAX_PATH = 1000;

/** The fix every failed prerender run names. */
const FIX =
  "Fix the page, remove its path from prerender.routes or prerender.entries, skip it with prerender.filter, set prerender.skipMissing to true to skip a path that matches no route, or set prerender.failOnError to false.";

/** A set of param values for a route pattern. */
type ParamSet = Readonly<Record<string, string>>;

/** The function form of `export const prerender`: called with the params of the parent route. */
type PrerenderFunction = (args: { readonly params: ParamSet }) => unknown;

function isDynamic(pattern: string): boolean {
  return pattern.includes(":") || pattern.includes("*");
}

/**
 * Which paths to prerender from literal settings: routes with `export const prerender = true` and a
 * static path, `export const prerender = ["/a", "/b"]`, routes with `export const ssr = false` (their
 * shell), and the paths given in `routes`. Function forms are resolved by
 * {@link resolvePrerenderTargets}.
 *
 * @param scan The scanned routes.
 * @param options Prerender options.
 * @returns Targets sorted by path.
 * @throws PrerenderError for `prerender = true` on a route with params (list the paths instead).
 * @since 1.0.0
 * @example prerenderTargets(scan, { routes: ["/extra"] }); // [{ path: "/about", shell: false }, ...]
 */
export function prerenderTargets(
  scan: ScanResult,
  options: PrerenderOptions,
  routeSources: ReadonlyMap<string, string> = new Map(),
): PrerenderTarget[] {
  const targets = new Map<string, PrerenderTarget>();
  for (const entry of scan.entries) {
    if (entry.kind !== "page") continue;
    const { prerender, ssr } = entry.info.config;
    const exported = `the \`prerender\` export of ${entry.file}`;
    if (Array.isArray(prerender)) {
      for (const path of prerender) {
        targets.set(path, { path, shell: ssr === false, source: exported });
      }
    } else if (prerender === true) {
      if (isDynamic(entry.fullPath)) {
        throw new PrerenderError(
          `"${entry.file}" has prerender = true but its path "${entry.fullPath}" has params; export the list of paths instead (prerender = ["/posts/1", ...]), or a function that returns the params`,
        );
      }
      targets.set(entry.fullPath, { path: entry.fullPath, shell: ssr === false, source: exported });
    } else if (ssr === false && !isDynamic(entry.fullPath)) {
      targets.set(entry.fullPath, {
        path: entry.fullPath,
        shell: true,
        source: `the \`ssr = false\` route ${entry.file}`,
      });
    }
  }
  for (const path of options.routes ?? []) {
    if (!targets.has(path)) {
      targets.set(path, {
        path,
        shell: false,
        source: routeSources.get(path) ?? "prerender.routes",
      });
    }
  }
  return [...targets.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** True for a value a `prerender` function may return as one set of params. */
function isParamObject(value: unknown): value is Readonly<Record<string, string | undefined>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((item) => item === undefined || typeof item === "string");
}

/** The names of the required params of a pattern (optional and catch-all-optional ones are not). */
function requiredParamNames(pattern: string): string[] {
  return parsePattern(pattern).segments.flatMap((segment) =>
    segment.kind === "param" || (segment.kind === "splat" && segment.optional !== true)
      ? [segment.name]
      : [],
  );
}

/**
 * Calls a route's `prerender` function once per set of params its parent produced. Each returned set
 * is merged onto the parent's, so a child route receives every param above it. Sets that repeat are
 * kept once, in the order they were produced.
 */
async function expandParams(
  entry: RouteEntry,
  parents: readonly ParamSet[],
  fn: PrerenderFunction,
): Promise<ParamSet[]> {
  const invalid = (): PrerenderError =>
    new PrerenderError(
      `route "${entry.id}" (file "${entry.file}"): its prerender function must return an array of param objects, like [{ id: "1" }]`,
    );
  const out: ParamSet[] = [];
  const seen = new Set<string>();
  for (const parent of parents) {
    const returned: unknown = await fn({ params: { ...parent } });
    if (!Array.isArray(returned)) throw invalid();
    for (const item of returned) {
      if (!isParamObject(item)) throw invalid();
      const merged: Record<string, string> = { ...parent };
      for (const [name, value] of Object.entries(item)) {
        if (value !== undefined) merged[name] = value;
      }
      const key = JSON.stringify(
        Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(merged);
    }
  }
  return out;
}

/**
 * Every page to prerender: the literal settings of {@link prerenderTargets}, the paths that the route
 * functions produce, and `entries`. A route's function receives the params of its parent route (a
 * layout's function, or the function of the route above it); a page with no function of its own
 * is prerendered for every set its ancestors produced, and skipped for a set that leaves one of its
 * params out. A function that leaves a param out of its own page is a build error, naming the param.
 *
 * @param input The scan, the options, and the loaders of the route functions (from the server bundle).
 * @returns Targets sorted by path.
 * @throws PrerenderError for a function that returns something other than param objects, or leaves
 *   a param of its own path out, and for the literal errors of {@link prerenderTargets}.
 * @since 1.0.0
 * @example await resolvePrerenderTargets({ scan, options: {}, loaders });
 */
export async function resolvePrerenderTargets(input: {
  readonly scan: ScanResult;
  readonly options: PrerenderOptions;
  readonly loaders: readonly PrerenderRouteLoader[];
  /** Where paths of `options.routes` came from when it is not `prerender.routes` (path to text). */
  readonly routeSources?: ReadonlyMap<string, string>;
}): Promise<PrerenderTarget[]> {
  const targets = new Map<string, PrerenderTarget>();
  for (const target of prerenderTargets(input.scan, input.options, input.routeSources)) {
    targets.set(target.path, target);
  }
  const loaders = new Map(input.loaders.map((loader) => [loader.id, loader] as const));
  const sets = new Map<string, readonly ParamSet[]>();
  const generating = new Map<string, boolean>();
  for (const entry of input.scan.entries) {
    const parentSets = entry.parentId === undefined ? [{}] : (sets.get(entry.parentId) ?? [{}]);
    const inherited = entry.parentId !== undefined && generating.get(entry.parentId) === true;
    let own = false;
    let current: readonly ParamSet[] = parentSets;
    if (entry.info.exports.includes("prerender") && entry.info.config.prerender === undefined) {
      const loader = loaders.get(entry.id);
      const value = loader === undefined ? undefined : await loader.load();
      if (typeof value === "function") {
        own = true;
        current = await expandParams(entry, parentSets, value as PrerenderFunction);
      }
    }
    sets.set(entry.id, current);
    generating.set(entry.id, own || inherited);
    if (entry.kind !== "page" || !(own || inherited)) continue;
    for (const params of current) {
      let path: string;
      try {
        path = buildPathFromParams(entry.fullPath, params);
      } catch (error) {
        if (!own) continue;
        const missing = requiredParamNames(entry.fullPath).filter(
          (name) => (params[name] ?? "") === "",
        );
        const names = missing.length > 0 ? missing.join('", "') : reasonOf(error);
        throw new PrerenderError(
          `"${names}" is missing for route "${entry.id}" (file "${entry.file}"): its prerender function must return a value for "${names}"`,
        );
      }
      if (!targets.has(path)) {
        targets.set(path, {
          path,
          shell: entry.info.config.ssr === false,
          source: `the \`prerender\` function of ${entry.file}`,
        });
      }
    }
  }
  const listed =
    input.options.entries === undefined
      ? []
      : typeof input.options.entries === "function"
        ? await input.options.entries()
        : input.options.entries;
  for (const path of listed) {
    if (!targets.has(path)) targets.set(path, { path, shell: false, source: "prerender.entries" });
  }
  return [...targets.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Whether a path segment is a Windows device name: `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9` and `LPT1`-`LPT9`, in
 * any case, with or without an extension. Windows cannot create a folder with such a name, so a route that maps to
 * one would fail the build on Windows only. The rule applies on every OS, so a project builds the same everywhere.
 * Windows drops trailing spaces and dots from a name, so `CON.` and `CON ` are the device too.
 *
 * @param segment One path segment, already decoded.
 * @returns True when the segment names a Windows device.
 * @example isWindowsReservedName("aux.txt"); // true
 * @since 1.0.0
 */
export function isWindowsReservedName(segment: string): boolean {
  const stem = (segment.split(".")[0] ?? "").replace(/ +$/, "");
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}

/**
 * The file a path is written to, inside `clientDir`: `/` is `index.html`, `/about` is
 * `about/index.html`. A page whose last segment is a file name keeps it, as `static/prerender.ts` does: a response that
 * is not HTML for a path with an extension (`/sitemap.xml`, `/robots.txt`) is written as that file, and a path that ends
 * in `.html` is written as it is. An HTML page for a dotted name (`/v1.2`) still gets its folder. Percent escapes are
 * decoded once; a segment that could leave the folder or is too long is refused.
 *
 * @param clientDir The output folder.
 * @param path A URL path starting with `/`.
 * @param contentType The `content-type` of the response, when it is known. Default `text/html`.
 * @returns The absolute file path.
 * @throws PrerenderError for a path that is not safe to write.
 * @since 1.0.0
 * @example prerenderFile("/app/dist/client", "/about"); // "/app/dist/client/about/index.html"
 * @example prerenderFile("/app/dist/client", "/sitemap.xml", "application/xml"); // "/app/dist/client/sitemap.xml"
 */
export function prerenderFile(clientDir: string, path: string, contentType = "text/html"): string {
  if (!path.startsWith("/") || path.length > MAX_PATH) {
    throw new PrerenderError(`"${path}" is not a valid path to prerender`);
  }
  const segments: string[] = [];
  for (const raw of path.split("/").slice(1)) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch (error) {
      throw new PrerenderError(
        `"${path}" has a malformed percent escape (${(error as Error).message})`,
      );
    }
    if (
      segment === "." ||
      segment === ".." ||
      segment.length > MAX_SEGMENT ||
      /[\\/\0]/.test(segment) ||
      segment.includes(":")
    ) {
      throw new PrerenderError(`"${path}" has a segment that cannot be a folder name`);
    }
    if (isWindowsReservedName(segment)) {
      throw new PrerenderError(
        `"${path}" has the segment "${segment}", which Windows reserves for a device name and cannot be a folder`,
      );
    }
    segments.push(segment);
  }
  const last = segments[segments.length - 1];
  const html = contentType.toLowerCase().startsWith("text/html");
  const asFile =
    last !== undefined && ((!html && last.includes(".")) || last.toLowerCase().endsWith(".html"));
  const target = asFile ? join(clientDir, ...segments) : join(clientDir, ...segments, "index.html");
  const inside = relative(clientDir, target);
  if (escapesFolder(inside) || inside === "") {
    throw new PrerenderError(`"${path}" would be written outside the output folder`);
  }
  return target;
}

interface RenderingHandler {
  /** `security.allowedHosts` of the handler, when it exposes them (a `createHandler` result does). */
  readonly allowedHosts?: readonly string[] | undefined;
  fetch(request: Request): Promise<Response>;
  renderShell?(request?: Request): Promise<Response>;
}

/** A built server entry, loaded: its handler and the loaders of its route functions. @since 1.0.0 */
export interface BuiltServer {
  readonly handler: RenderingHandler;
  readonly prerenderRoutes: readonly PrerenderRouteLoader[];
}

function isRouteLoader(value: unknown): value is PrerenderRouteLoader {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "load") === "function"
  );
}

/**
 * Loads the built server entry: its handler, and the `prerenderRoutes` it exports (the route
 * functions, loaded lazily).
 *
 * @internal
 * @example const { handler, prerenderRoutes } = await loadBuiltServer("/app/dist/server/entry.js");
 * @since 1.0.0
 */
export async function loadBuiltServer(entryFile: string): Promise<BuiltServer> {
  const module: unknown = await import(`${pathToFileURL(entryFile).href}?build=${Date.now()}`);
  const candidate =
    typeof module === "object" && module !== null
      ? (Reflect.get(module, "handler") ?? Reflect.get(module, "default"))
      : undefined;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof Reflect.get(candidate, "fetch") !== "function"
  ) {
    throw new PrerenderError(`${entryFile} does not export a handler with fetch()`);
  }
  const listed: unknown =
    typeof module === "object" && module !== null
      ? Reflect.get(module, "prerenderRoutes")
      : undefined;
  const prerenderRoutes = Array.isArray(listed) ? listed.filter(isRouteLoader) : [];
  return { handler: candidate as RenderingHandler, prerenderRoutes };
}

/**
 * Loads the built server entry and returns its handler.
 *
 * @internal
 * @example const handler = await loadBuiltHandler("/app/dist/server/entry.js");
 * @since 1.0.0
 */
export async function loadBuiltHandler(entryFile: string): Promise<RenderingHandler> {
  return (await loadBuiltServer(entryFile)).handler;
}

/** What a page answered, once it is rendered. */
type Rendered =
  | { readonly ok: true; readonly links: readonly string[] }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly message: string;
      /** The path answered 404 and no route matches it (it was removed or renamed). */
      readonly missing?: string;
    };

/** Where a path came from, for a message: `(listed in prerender.routes)` or `(linked from "/")`. */
function originOf(source: string | undefined, from: string | undefined): string {
  if (from !== undefined) return ` (linked from "${from}")`;
  return source === undefined ? "" : ` (listed in ${source})`;
}

/**
 * Renders the targets with the built handler and writes the HTML next to the client assets. With
 * `crawlLinks`, the internal links of the rendered pages are rendered too (up to the depth and limit).
 * A failed listed page fails the run, naming every failed path, unless `failOnError` is false; a
 * failed page found by the crawl is skipped and reported to `onError`.
 *
 * @param input The built server entry (or its loaded handler), the output folder and the targets.
 * @returns The prerendered paths, sorted.
 * @throws PrerenderError for a path that is not safe to write, or a run with failed pages.
 * @since 1.0.0
 * @example await prerenderPages({ entryFile, clientDir, targets, options: {}, base: "" });
 */
export async function prerenderPages(input: {
  readonly entryFile: string;
  readonly clientDir: string;
  readonly targets: readonly PrerenderTarget[];
  readonly options: PrerenderOptions;
  readonly base: string;
  /** A handler already loaded from the entry (the build loads the server once). */
  readonly handler?: RenderingHandler | undefined;
  /**
   * The route patterns of the app (pages, API routes, streams). With them, a path that answers 404 and matches none
   * is reported as a missing route, with the closest one; without them the answer is only "answered 404".
   */
  readonly routes?: readonly string[] | undefined;
  /** The locales of the app, so `/ar/about` is known to belong to the route `/about`. */
  readonly locales?: readonly string[] | undefined;
  /** Told about a path `skipMissing` left out. */
  readonly onWarn?: ((message: string) => void) | undefined;
}): Promise<string[]> {
  if (input.targets.length === 0) return [];
  const handler = input.handler ?? (await loadBuiltHandler(input.entryFile));
  const hosts = allowedHostsOf(handler);
  const chosen = choosePrerenderOrigin(hosts, input.options.origin);
  if (!chosen.ok) throw new PrerenderError(chosen.message);
  const origin = new URL(chosen.origin).origin;
  const failOnError = input.options.failOnError !== false;
  const retries = input.options.retry ?? 0;
  const crawl = crawlPolicyOf(input.options.crawlLinks);
  const rendered = new Set<string>();
  const byPath = new Map(input.targets.map((target) => [target.path, target] as const));
  // Every listed path is checked before anything is rendered: an unsafe path fails the run at once.
  for (const target of input.targets) prerenderFile(input.clientDir, target.path);
  // Two pages whose files differ only in case overwrite each other on a case-insensitive file system (macOS, Windows), so
  // the build fails instead of shipping whichever was written last. The listed paths are checked before anything renders.
  const claimFile = (
    claimed: Map<string, { readonly path: string; readonly file: string }>,
    path: string,
    absolute: string,
  ): string | undefined => {
    const file = relative(input.clientDir, absolute);
    const key = file.normalize("NFC").toLowerCase();
    const known = claimed.get(key);
    if (known === undefined) {
      claimed.set(key, { path, file });
      return undefined;
    }
    // The same file for `/a` and `/a/` is one page; the same file under another spelling is a collision.
    if (known.file === file) return undefined;
    const [first, second] = [known.path, path].sort();
    return `"${first}" and "${second}" differ only in case: they would overwrite each other on a case-insensitive file system. Rename one of them, or leave one out of the prerender.`;
  };
  const listed = new Map<string, { readonly path: string; readonly file: string }>();
  for (const target of input.targets) {
    const message = claimFile(listed, target.path, prerenderFile(input.clientDir, target.path));
    if (message !== undefined) throw new PrerenderError(message);
  }
  const written = new Map<string, { readonly path: string; readonly file: string }>();
  const collisions: string[] = [];

  const renderOnce = async (path: string, from: string | undefined): Promise<Rendered> => {
    const target: PrerenderTarget = byPath.get(path) ?? { path, shell: false };
    const request = new Request(new URL(`${input.base}${path === "/" ? "" : path}` || "/", origin));
    let response: Response;
    try {
      response =
        target.shell && handler.renderShell !== undefined
          ? await handler.renderShell(request)
          : await handler.fetch(request);
    } catch (error) {
      return {
        ok: false,
        retryable: true,
        message: `"${path}" failed to render: ${reasonOf(error)}${originOf(target.source, from)}`,
      };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      const where = originOf(target.source, from);
      if (
        response.status === 404 &&
        input.routes !== undefined &&
        !routeMatches(input.routes, path, input.locales)
      ) {
        const closest = closestRoute(input.routes, path);
        const missing = `"${path}" matches no route${where}.${closest === undefined ? "" : ` Closest route: "${closest}".`}`;
        return { ok: false, retryable: false, message: missing, missing };
      }
      const why = response.status === 400 ? hostRejectionMessage(hosts, origin) : undefined;
      return {
        ok: false,
        retryable: response.status >= 500,
        message:
          why === undefined
            ? `"${path}" answered ${response.status}${where}`
            : `"${path}" answered 400${where}: ${why}`,
      };
    }
    const type = response.headers.get("content-type") ?? "text/html";
    const html = await response.text();
    const file = prerenderFile(input.clientDir, path, type);
    const collision = claimFile(written, path, file);
    if (collision !== undefined) {
      // Not a failure `failOnError: false` may forgive: the page that lost would silently replace the other.
      collisions.push(collision);
      return { ok: false, retryable: false, message: collision };
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html, "utf8");
    await input.options.onSuccess?.({ path, file, status: 200 });
    const links =
      crawl === undefined || !type.toLowerCase().includes("html")
        ? []
        : internalLinks(html, new URL(request.url), origin, input.base);
    return { ok: true, links };
  };

  const render = async (path: string, from: string | undefined): Promise<readonly string[]> => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await renderOnce(path, from);
      if (result.ok) {
        rendered.add(path);
        return result.links;
      }
      if (result.missing !== undefined && input.options.skipMissing === true) {
        input.onWarn?.(`prerender skipped: ${result.missing}`);
        return [];
      }
      if (!result.retryable || attempt >= retries) throw new PrerenderError(result.message);
    }
  };

  const onError = input.options.onError;
  const failures = await runCrawl({
    paths: input.targets.map((target) => target.path),
    concurrency: input.options.concurrency ?? 4,
    crawl,
    filter: input.options.filter,
    render,
    onFailure:
      onError === undefined
        ? undefined
        : async (failure) => {
            await onError({
              path: failure.path,
              error: failure.error,
              explicit: failure.explicit,
              ...(failure.from === undefined ? {} : { from: failure.from }),
            });
          },
  });
  if (collisions.length > 0) throw new PrerenderError([...new Set(collisions)].sort().join("\n"));
  if (failures.length > 0 && failOnError) {
    throw new PrerenderError(describeFailures(failures, FIX));
  }
  return [...rendered].sort();
}
