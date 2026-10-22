import { type Dirent, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  codeFrame,
  ROUTE_UI_QUERY,
  RouteScanError,
  type ScanResult,
  type ShadowRouterPlugin,
} from "@shadow-js/router/vite";
import MagicString from "magic-string";
import {
  type ConfigEnv,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
  type UserConfig,
  type ViteBuilder,
  type ViteDevServer,
} from "vite";
import { assertBundle, type BundleFile } from "../adapter/checks";
import { staticFilesMiddlewareWarning } from "../adapter/static-files";
import { type StaticPageInput, staticPagesOf } from "../adapter/static-pages";
import type { AdapterContext, AdapterRoute } from "../adapter/types";
import type { FileImages } from "../metadata/file-images";
import { type BakedServerConfig, serverOptionsFromConfig } from "../server/baked-config";
import { mergeHandlerOptions } from "../server/merge-options";
import { matchPattern } from "../shared/path-match";
import { compilePattern } from "../shared/path-pattern";
import { validateRouting } from "../shared/routing-config";
import type { StaticPage } from "../shared/static-page";
import { outputFileFor } from "../static/prerender";
import {
  type BuiltAssets,
  buildIdOf,
  computeAssets,
  createDuskManifest,
  type DuskManifest,
  loadBuiltServer,
  prerenderPages,
  prerenderTargets,
  resolvePrerenderTargets,
  type ViteManifest,
} from "./build";
import {
  publicValueFindings,
  type SecretScanContext,
  scanBuildOutput,
  scanOutputText,
  secretScanMessage,
} from "./build-scan";
import { bundlerOptions, scanJsxOptions, transformSource } from "./compat";
import {
  bakeServerConfig,
  type DuskBuildBudgets,
  imageWidthsOf,
  type LoadedDuskConfig,
  loadDuskConfigFile,
  localeInstanceOf,
  localeRoutingStaticReason,
  mergeBuildOptions,
  publicEnvOf,
} from "./config-file";
import { escapesFolder, isInsideFolder } from "./containment";
import { CONVENTION_PREFIX, ConventionError, discoverConventions } from "./conventions";
import { devMiddleware } from "./dev";
import { readEntryStaticOptions } from "./entry-static-options";
import {
  applyServerEnv,
  checkEnvFiles,
  clientImportMetaEnvDefines,
  clientProcessEnvDefines,
  clientPublicEnvDefines,
  credentialNameWarnings,
  type EnvFiles,
  type EnvViolation,
  findForbiddenEnvReads,
  loadedEnvFiles,
  loadServerEnv,
  nextPublicNotes,
  publicEnvNames,
  publicEnvTypesSource,
  publicEnvValues,
  publicPrefixes,
  readEnvFiles,
  releaseServerEnv,
  resolvedValues,
} from "./env";
import {
  attachFileImages,
  FILE_IMAGES_ID,
  FILE_IMAGES_MODULE,
  injectFileImages,
} from "./file-images";
import { sourceFingerprint } from "./fingerprint";
import { optionConflictMessage, optionConflicts } from "./option-conflicts";
import {
  type DuskOptions,
  type PrerenderOptions,
  type ResolvedDuskOptions,
  resolveOptions,
} from "./options";
import {
  analyzeFile,
  checkCollisions,
  discoverProject,
  type ProjectLayout,
  type ServerFnCache,
  type ServerFnRecord,
  scanServerFns,
} from "./project";
import { routeMiddlewareSource } from "./route-middleware";
import { ServerFnError, transformServerFns } from "./server-fn";
import { offsetAt, originalPosition } from "./source-position";
import {
  CLIENT_ENTRY_ID,
  clientEntrySource,
  exportsMetadata,
  PROCESS_ENV_ID,
  RESOLVED_PREFIX,
  routerFeaturesFor,
  SERVER_ENTRY_ID,
  serverEntrySource,
} from "./virtual";

/**
 * The core plugins of `dusk()`: the server-function transform, and the plugin that owns the
 * virtual entries, the dev server middleware and the production build.
 */

/** The phases of a production build, in the order they run. @since 1.0.0 */
export type BuildStepName = "client" | "server" | "prerender" | "secret-scan" | "adapter";

/** One phase of a production build and how long it took. @since 1.0.0 */
export interface BuildStep {
  readonly name: BuildStepName;
  readonly ms: number;
}

/**
 * What the last production build did, for the command line's summary. Written when the build finishes; a failed build
 * leaves none.
 * @since 1.0.0
 */
export interface BuildReport {
  readonly steps: readonly BuildStep[];
  /** How many pages were prerendered. */
  readonly prerendered: number;
  /** Whether the secret scan ran, and how many text files it read. */
  readonly secretScan: { readonly enabled: boolean; readonly scanned: number };
  /** The adapter the build ran, with its output folder; undefined without one. */
  readonly adapter: { readonly name: string; readonly outDir: string } | undefined;
  /** What the adapter logged (`context.log`), in order. */
  readonly adapterLog: readonly string[];
}

/** What the core plugin exposes to tests and tools. @since 1.0.0 */
export interface DuskCoreApi {
  /** The server functions of the project (scans on first use). */
  getServerFns(): Promise<readonly ServerFnRecord[]>;
  /** The assets of the last client build, once there was one. */
  readonly builtAssets: BuiltAssets | undefined;
  /** The project layout (after `configResolved`). */
  readonly layout: ProjectLayout | undefined;
  /** The name of the adapter in `dusk({ adapter })`, or undefined without one. */
  readonly adapterName: string | undefined;
  /** The env files loaded for the mode, by name, in the order they are read (names only, never values). */
  readonly envFiles: readonly string[];
  /** `build.budgets` of `dusk.config.ts`, when the file sets them. */
  readonly buildBudgets: DuskBuildBudgets | undefined;
  /** The summary of the last production build, once there was one. */
  readonly buildReport: BuildReport | undefined;
}

/** The core plugin: a Vite plugin with an `api`. @since 1.0.0 */
export interface DuskCorePlugin extends Plugin<DuskCoreApi> {
  readonly name: "shadowjs:start";
  readonly api: DuskCoreApi;
}

const SOURCE_FILE = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"]);

function cleanId(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot);
}

function consumerOf(
  context: { environment?: { config: { consumer: "client" | "server" } } },
  ssr: boolean | undefined,
): "client" | "server" {
  return context.environment?.config.consumer ?? (ssr === true ? "server" : "client");
}

/**
 * Removes the `//#region <path>` and `//#endregion` marker lines the bundler writes into unminified
 * output. The path in them is relative to wherever the build was started, so they would make the
 * same sources produce different files (and different content hashes) in different folders.
 * @internal
 * @example stripRegionComments("//#region x\nconst a = 1;\n//#endregion\n", false)?.code;
 * @since 1.0.0
 */
export function stripRegionComments(
  code: string,
  withMap: boolean,
): { code: string; map: ReturnType<MagicString["generateMap"]> | null } | null {
  if (!code.includes("//#")) return null;
  const magic = new MagicString(code);
  let removed = false;
  let start = 0;
  while (start <= code.length) {
    let end = code.indexOf("\n", start);
    if (end === -1) end = code.length;
    const line = code.slice(start, end);
    if (line.startsWith("//#region ") || line === "//#endregion") {
      // The line break goes with the line, so no empty line is left behind.
      magic.remove(start, Math.min(end + 1, code.length));
      removed = true;
    }
    start = end + 1;
  }
  if (!removed) return null;
  return { code: magic.toString(), map: withMap ? magic.generateMap({ hires: "boundary" }) : null };
}

/** Mount base without the trailing slash: `/` -> `""`, `/app/` -> `/app`. */
function mountBase(viteBase: string): string {
  return viteBase === "/" ? "" : viteBase.replace(/\/+$/, "");
}

/** `*.server.*`: files the import protection keeps out of the browser (see `import-protection`). */
const SERVER_ONLY_FILE = /\.server\.(?:[cm]?[jt]sx?)$/;

/** A CSS module's stylesheet link in the dev HTML (`/x.module.css?direct`); see the `hotUpdate` hook. */
const DIRECT_CSS_MODULE = /\.module\.[a-z]+\?direct$/;
/** A component source that can name classes (JSX and TSX). */
const CLASS_ATTRIBUTE = /\.[jt]sx$/;
/** A `class` or `className` attribute in the source text. */
const CLASS_SOURCE = /\bclass(?:Name)?=/;

/**
 * Where an env read found in transformed code stands in the source the author wrote, with a code
 * frame of that source. Falls back to the transformed text when the position has no mapping.
 */
function sourcePosition(
  original: string,
  transformed:
    | { readonly code: string; readonly map: { readonly mappings: string } | null }
    | undefined,
  violation: EnvViolation,
): { line: number; column: number; frame: string } {
  if (transformed === undefined) return violation;
  const mapped =
    transformed.map === null
      ? undefined
      : originalPosition(transformed.map, violation.line, violation.column);
  if (mapped === undefined) return violation;
  return { ...mapped, frame: codeFrame(original, offsetAt(original, mapped.line, mapped.column)) };
}

/**
 * The transform of server functions and the check of `import.meta.env` in client code. It must
 * run before the route-splitting transform (so server function ids are computed on the whole file)
 * and before the compiler.
 *
 * @param shared Settings the core plugin resolves.
 * @returns The plugin.
 * @since 1.0.0
 * @internal
 * @example serverFnPlugin({ root: () => root, base: () => "", prefixes: () => ["DUSK_PUBLIC_"] });
 */
export function serverFnPlugin(shared: {
  root: () => string;
  base: () => string;
  prefixes: () => readonly string[];
  /** The names declared in `.env.public`: public whatever their prefix. */
  publicNames: () => readonly string[];
}): Plugin {
  return {
    name: "shadowjs:start:server-fn",
    enforce: "pre",
    transform(code, id, options) {
      const file = cleanId(id);
      if (id.startsWith("\0") || !SOURCE_FILE.has(extensionOf(file))) return null;
      if (file.includes("/node_modules/") || file.includes("\\node_modules\\")) return null;
      const root = shared.root();
      if (escapesFolder(relative(root, file))) return null;
      const consumer = consumerOf(this, options?.ssr);
      try {
        const result = transformServerFns({
          code,
          file,
          root,
          target: consumer === "client" ? "client" : "server",
          base: shared.base(),
        });
        if (consumer === "client" && !SERVER_ONLY_FILE.test(file)) {
          // The check looks at what the browser gets: the handler of a server function and the code
          // only it used are gone by now, so what they read is none of the browser's business.
          // A `.server.` file never reaches the browser (import protection refuses the import with
          // the chain), so a read in it is not an env error either.
          const reached = result?.changed ? result : undefined;
          for (const violation of findForbiddenEnvReads(
            reached?.code ?? code,
            file,
            shared.prefixes(),
            shared.publicNames(),
          )) {
            const at = sourcePosition(code, reached, violation);
            this.error({
              message: `[ENV_NOT_PUBLIC] ${violation.expression} is not available in client code; only variables that start with ${shared.prefixes().join(" or ")} or declared in .env.public reach the browser.${
                violation.dynamic
                  ? " The key is not a string literal, so the build cannot tell which variable it reads: read the public name directly."
                  : ""
              }\n${at.frame}`,
              id: file,
              loc: { file, line: at.line, column: at.column },
            });
          }
        }
        if (result === null || !result.changed) return null;
        return { code: result.code, map: result.map };
      } catch (error) {
        if (error instanceof ServerFnError) {
          this.error({
            message: error.message,
            id: file,
            loc: { file, line: error.line, column: error.column },
          });
        }
        throw error;
      }
    },
  };
}

/** The env files of a build that reads none (`envDir: false`). */
const NO_ENV_FILES: EnvFiles = {
  values: {},
  sources: {},
  declaredIn: {},
  publicNames: [],
  serverNames: [],
};

/**
 * Refuses a public value that looks like a credential (a live key, a private key block, a password in a URL, a JWT).
 * The message names the variable and its file, never the value. A name listed in `env.public.allow` is public on purpose.
 *
 * @throws TypeError `[ENV_PUBLIC_VALUE]` for each finding, one line per variable.
 */
function refuseSecretValues(
  values: Readonly<Record<string, string | undefined>>,
  publicNames: readonly string[],
  files: EnvFiles,
  allow: readonly string[],
): void {
  const lines: string[] = [];
  for (const name of publicNames) {
    if (allow.includes(name)) continue;
    const value = values[name];
    if (value === undefined) continue;
    const rules = publicValueFindings(value);
    if (rules.length === 0) continue;
    const source =
      process.env[name] !== undefined
        ? "the environment"
        : (files.sources[name] ?? "the environment");
    lines.push(
      `[ENV_PUBLIC_VALUE] ${name} (from ${source}) looks like a secret (${rules.join(", ")}). Public variables are written into the browser bundle: remove the value, keep the variable out of the public set (no public prefix, not in .env.public), or list ${name} in env.public.allow if it is public on purpose.`,
    );
  }
  if (lines.length > 0) throw new TypeError(lines.join("\n"));
}

/**
 * Writes the declaration file of the public names (`src/env.public.d.ts`), only when its content changes. A read-only
 * folder is reported as a warning: the build still runs, and the types are the only thing that is missing.
 */
function writeEnvTypes(srcDir: string, names: readonly string[]): void {
  if (names.length === 0) return;
  const target = join(srcDir, "env.public.d.ts");
  const source = publicEnvTypesSource(names);
  try {
    if (existsSync(target) && readFileSync(target, "utf8") === source) return;
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(target, source);
  } catch (error) {
    console.warn(
      `[ENV_TYPES] could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface CoreState {
  config: ResolvedConfig | undefined;
  /** The env files of the mode that exist, by name (see `loadedEnvFiles`). */
  envFiles: readonly string[];
  /** The summary of the last production build. */
  report: BuildReport | undefined;
  root: string;
  viteBase: string;
  /** The client build's assets folder (`build.environments.client.assetsDir`, `assets` by default). */
  assetsDir: string;
  prefixes: readonly string[];
  /**
   * The variables of the env files and the environment, as the build read them. Used for the
   * `process.env` defines of the client bundle and the scan that refuses a leaked secret.
   */
  envValues: Readonly<Record<string, string | undefined>>;
  /**
   * The public names of the build: the prefixed ones and the names declared in `.env.public`, whatever the
   * environment sets. A read of one of them in client code is allowed, and its value is inlined.
   */
  publicNames: readonly string[];
  /** `env.public.allow` of `dusk.config.ts`: public names whose values may look like credentials. */
  publicAllow: readonly string[];
  /** Dev server with `env.public.processEnv`: the client entry gets the `process` shim. */
  devProcessEnv: boolean;
  layout: ProjectLayout | undefined;
  assets: BuiltAssets | undefined;
  /** Server functions by file; filled by the first scan and kept current by the dev watcher. */
  fnByFile: Map<string, ServerFnRecord[]> | undefined;
  /** The validated `dusk.config.ts`, when the project has one. */
  file: LoadedDuskConfig | undefined;
  /** The build options after the precedence rule (plugin options over the file); undefined without a file. */
  effective: ResolvedDuskOptions | undefined;
  /** The deployment id of this build: the server and the client carry it. */
  deploymentId: string | undefined;
  /** The wrapper module of each file convention, by virtual id; set by the last route scan. */
  conventions: ReadonlyMap<string, string>;
  /** The static `opengraph-image` and `twitter-image` files each route carries, by route id; set by the last scan. */
  fileImages: ReadonlyMap<string, FileImages>;
}

/**
 * The core plugin.
 *
 * @param options Resolved options.
 * @param router The file-route plugin (its `api` supplies the scan).
 * @param shared Getters other plugins of the set use.
 * @returns The plugin, with a testing `api`.
 * @since 1.0.0
 * @internal
 * @example const core = duskCore(options, router, state);
 */
export function duskCore(
  pluginOptions: DuskOptions,
  resolvedOptions: ResolvedDuskOptions,
  router: ShadowRouterPlugin,
  state: CoreState,
): DuskCorePlugin {
  const fnCache: ServerFnCache = new Map();
  /** True while the last page request failed to render (the browser shows the 500 page of the dev server). */
  let pageFailing = false;
  /** The leaf options already noted as conflicts between dusk.config.ts and the entry (each is noted once). */
  const reportedConflicts = new Set<string>();
  /** The options in force: the plugin's, merged with `dusk.config.ts` once the config hook has read it. */
  const opts = (): ResolvedDuskOptions => state.effective ?? resolvedOptions;

  const layoutOf = (): ProjectLayout => {
    if (state.layout === undefined) state.layout = discoverProject(state.root, opts().srcDir);
    return state.layout;
  };

  async function loadServerFns(): Promise<readonly ServerFnRecord[]> {
    const layout = layoutOf();
    if (state.fnByFile === undefined) {
      const records = await scanServerFns(layout, fnCache);
      const byFile = new Map<string, ServerFnRecord[]>();
      for (const record of records) {
        const list = byFile.get(record.file) ?? [];
        list.push(record);
        byFile.set(record.file, list);
      }
      state.fnByFile = byFile;
    }
    return checkCollisions([...state.fnByFile.values()].flat(), state.root);
  }

  const api: DuskCoreApi = {
    getServerFns: loadServerFns,
    get builtAssets(): BuiltAssets | undefined {
      return state.assets;
    },
    get layout(): ProjectLayout | undefined {
      return state.layout;
    },
    get adapterName(): string | undefined {
      return opts().adapter?.name;
    },
    get envFiles(): readonly string[] {
      return state.envFiles;
    },
    get buildBudgets(): DuskBuildBudgets | undefined {
      return state.file?.config.build?.budgets;
    },
    get buildReport(): BuildReport | undefined {
      return state.report;
    },
  };

  /**
   * The route scan of the router plus the file conventions of `src` (`sitemap.ts`, `robots.ts`, icons, ...), which
   * become API routes like any other. Every consumer of the scan (the server entry, the manifest, the adapters) gets both.
   */
  async function scanRoutes(): Promise<ScanResult> {
    const scan = await router.api.getScan();
    // A convention may not share a URL with a page, a stream or an API route (a dynamic image is one of them).
    const taken = [
      ...scan.api,
      ...scan.streams,
      ...scan.entries.filter((entry) => entry.kind === "page"),
    ];
    const found = await discoverConventions(layoutOf().srcDir, taken, router.api.routesDir);
    state.conventions = found.sources;
    state.fileImages = attachFileImages(found.images, scan.entries, mountBase(state.viteBase));
    if (found.entries.length === 0) return scan;
    return { ...scan, api: [...scan.api, ...found.entries] };
  }

  async function scanOrFail(context: { error(message: string): never }): Promise<ScanResult> {
    try {
      return await scanRoutes();
    } catch (error) {
      if (error instanceof RouteScanError || error instanceof ConventionError)
        context.error(error.message);
      throw error;
    }
  }

  function clientEntryUrl(layout: ProjectLayout): string {
    return layout.entryClientFile === undefined
      ? `/@id/${CLIENT_ENTRY_ID}`
      : `/${relative(state.root, layout.entryClientFile).split("\\").join("/")}`;
  }

  /** The `assets` section of the server entry: the client entry URL in dev, the built files in a build. */
  function assetsFor(layout: ProjectLayout, dev: boolean): BuiltAssets {
    if (dev) {
      return {
        entry: `${state.viteBase}${clientEntryUrl(layout).replace(/^\//, "")}`,
        css: [],
        preloads: {},
        base: state.viteBase,
      };
    }
    if (state.assets === undefined) {
      throw new Error("the server entry was requested before the client build produced its assets");
    }
    return state.assets;
  }

  function invalidateServerEntry(server: ViteDevServer): void {
    for (const environment of Object.values(server.environments)) {
      const module = environment.moduleGraph.getModuleById(RESOLVED_PREFIX + SERVER_ENTRY_ID);
      if (module !== undefined) environment.moduleGraph.invalidateModule(module);
      // The entry imports the generated route tree, and that module keeps its old transform until the watcher reports
      // the rewrite. A page loaded in between (a reload after a deleted route) would import the deleted file.
      for (const tree of environment.moduleGraph.getModulesByFile(router.api.generatedFile) ?? []) {
        environment.moduleGraph.invalidateModule(tree);
      }
    }
  }

  /**
   * How each prerendered page is answered (B2): from its file with the app's headers, or by the handler per request when a
   * rule of the app can apply to it (see `adapter/static-pages.ts`). Reads the written HTML, which is what the file serves.
   */
  async function decideStaticPages(
    clientDir: string,
    paths: readonly string[],
    scan: ScanResult,
    format: "directory" | "file",
  ): Promise<{
    readonly pages: StaticPage[];
    readonly allowedHosts: readonly string[] | undefined;
    /** `runMiddlewareForStaticFiles` of the merged options: the handler runs its middleware for files. */
    readonly runMiddlewareForStaticFiles: boolean;
  }> {
    const ignoreCase = resolvedOptions.router.caseSensitive !== true;
    const source = routeMiddlewareSource(scan);
    const middlewareRoutes = new Set(source.routes.map((route) => route.key));
    const pagesWithFolders = new Set(source.pages.map((page) => page.id));
    // A layout with a middleware export wraps every page below it: conservatively, every page is affected.
    const layoutMiddleware = scan.entries.some(
      (entry) => entry.kind === "layout" && middlewareRoutes.has(entry.id),
    );
    const pages: StaticPageInput[] = [];
    for (const path of paths) {
      const pageMiddleware =
        layoutMiddleware ||
        scan.entries.some(
          (entry) =>
            entry.kind === "page" &&
            (middlewareRoutes.has(entry.id) || pagesWithFolders.has(entry.id)) &&
            matchPattern(compilePattern(entry.fullPath), path, ignoreCase) !== undefined,
        );
      pages.push({
        path,
        html: await readPrerendered(clientDir, path, format),
        routeMiddleware: pageMiddleware,
      });
    }
    // The handler's options are the file's, merged with the entry's (the entry wins). The decision reads that merge, so a
    // rule or a header set in the entry is seen here as it is at run time (B2).
    const config = state.file?.config;
    const entryFile = layoutOf().entryServerFile;
    const entry = await readEntryStaticOptions(
      entryFile,
      entryFile === undefined
        ? "src/entry-server.ts"
        : relative(state.root, entryFile).split(sep).join("/"),
    );
    const merged = mergeHandlerOptions(
      serverOptionsFromConfig(bakeServerConfig(config ?? {})),
      entry.options,
    );
    const routing = validateRouting(merged.routing ?? {}, {
      ignoreCase,
      trustedOrigins: merged.trustedOrigins ?? [],
    });
    // The host list the handler reads at run time (an empty list is no host check): the platforms that answer files before
    // the function route a foreign Host to it (see `AdapterContext.allowedHosts`). The entry's literal list wins, read on its
    // own so a global middleware does not hide it; a list the build cannot read, or an entry it cannot read, is not known
    // here, and no host route is written then.
    const hosts = entry.hosts ?? merged.security?.allowedHosts ?? [];
    const hostsKnown = entry.hostsReason === undefined;
    return {
      pages: staticPagesOf(
        {
          routing,
          headers: merged.security?.headers,
          csp: merged.security?.csp,
          // Locale routing is a global middleware of the generated entry: no page may skip it as a file.
          wholeApp: entry.reason ?? localeRoutingStaticReason(config),
          pages,
        },
        ignoreCase,
      ),
      allowedHosts: hostsKnown && hosts.length > 0 ? hosts : undefined,
      runMiddlewareForStaticFiles: merged.runMiddlewareForStaticFiles === true,
    };
  }

  /** The HTML a prerendered path was written to; `undefined` for a path whose file is not HTML (a feed, a sitemap). */
  async function readPrerendered(
    clientDir: string,
    path: string,
    format: "directory" | "file",
  ): Promise<string | undefined> {
    const file = outputFileFor(path, format, "text/html; charset=utf-8");
    try {
      return await readFile(join(clientDir, file), "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return undefined;
  }

  async function writeDuskManifest(
    vite: ViteManifest,
    prerendered: readonly string[],
    staticPages: readonly StaticPage[],
  ): Promise<DuskManifest | undefined> {
    if (state.assets === undefined) return undefined;
    const scan = await scanRoutes();
    const records = await loadServerFns();
    const buildId = opts().buildId ?? buildIdOf(vite);
    const adapter = opts().adapter;
    const manifest = createDuskManifest({
      buildId,
      assets: state.assets,
      scan,
      serverFns: records,
      root: state.root,
      prerendered,
      staticPages,
      assetsDir: state.assetsDir,
      ...(adapter === undefined ? {} : { adapter: { name: adapter.name, outDir: adapter.outDir } }),
    });
    const file = join(state.root, opts().outDir, "dusk-manifest.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }

  /**
   * Runs the adapter after both bundles and the manifest exist. The output folder is emptied first
   * (it belongs to the adapter), then the bundle is checked against the platform (no Node built-ins
   * on an edge runtime, no external packages where the output must be self-contained), then the
   * adapter's `build` runs with a context whose `emit` and `copy` stay inside its folder.
   */
  async function runAdapter(
    scan: ScanResult,
    manifest: DuskManifest,
    prerendered: readonly string[],
    adapterLog: string[],
    allowedHosts: readonly string[] | undefined,
    runMiddlewareForStaticFiles: boolean,
  ): Promise<void> {
    const adapter = opts().adapter;
    if (adapter === undefined) return;
    const filesWarning = staticFilesMiddlewareWarning(
      adapter.name,
      adapter.capabilities.middlewareForStaticFiles === true,
      runMiddlewareForStaticFiles,
    );
    if (filesWarning !== undefined) state.config?.logger.warn(`dusk: ${filesWarning}`);
    const outDir = resolve(state.root, adapter.outDir);
    // Vite hands out `state.root` with forward slashes while `resolve` uses the native separator; comparing the
    // two as strings made every adapter build on Windows fail as "outside the project".
    if (!isInsideFolder(state.root, outDir)) {
      throw new Error(`dusk: adapter "${adapter.name}" writes to ${outDir}, outside the project`);
    }
    const outRoot = join(state.root, opts().outDir);
    const serverDir = join(outRoot, "server");
    const serverFiles: BundleFile[] = [];
    for (const file of await listScripts(serverDir)) {
      serverFiles.push({
        file: relative(state.root, file).split(sep).join("/"),
        code: await readFile(file, "utf8"),
      });
    }
    assertBundle(adapter, serverFiles);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const inside = (target: string): boolean => isInsideFolder(outDir, target);
    const routes: AdapterRoute[] = [];
    for (const entry of scan.entries) {
      routes.push({
        id: entry.id,
        kind: entry.kind,
        pattern: entry.fullPath,
        prerendered: prerendered.includes(entry.fullPath),
      });
    }
    for (const api of scan.api) {
      routes.push({ id: api.id, kind: "api", pattern: api.fullPath, prerendered: false });
    }
    const context: AdapterContext = {
      root: state.root,
      outDir,
      clientDir: join(outRoot, "client"),
      serverEntry: join(serverDir, "entry.js"),
      manifest,
      routes,
      staticPages: manifest.staticPages ?? [],
      ...(allowedHosts === undefined ? {} : { allowedHosts }),
      ...(runMiddlewareForStaticFiles ? { runMiddlewareForStaticFiles: true } : {}),
      log: (message) => {
        adapterLog.push(message);
        if (state.config !== undefined) state.config.logger.info(`[${adapter.name}] ${message}`);
      },
      emit: async (file, contents) => {
        const target = resolve(outDir, file);
        if (!inside(target))
          throw new Error(`adapter "${adapter.name}" emits outside its folder: ${file}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      },
      copy: async (from, to) => {
        const target = resolve(outDir, to);
        if (target !== outDir && !inside(target)) {
          throw new Error(`adapter "${adapter.name}" copies outside its folder: ${to}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await cp(from, target, { recursive: true });
      },
    };
    await adapter.build(context);
  }

  /** True for the error of a path that does not exist. */
  function isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
  }

  /** Every `.js` and `.mjs` file below a folder, sorted. A missing folder has none. */
  async function listScripts(dir: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        // A folder that was never written has no scripts; any other failure is the build's failure.
        if (isMissing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.m?js$/.test(entry.name)) found.push(path);
      }
    };
    await walk(dir);
    return found.sort();
  }

  /**
   * Makes the env files visible to server code as `process.env`. Vite reads them for its own
   * `import.meta.env` (the prefixed variables only); server code that reads `process.env.NAME`
   * would otherwise see nothing in development. Variables already set win over the files.
   */
  function loadEnvFiles(config: ResolvedConfig): void {
    if (config.envDir === false) return;
    applyServerEnv(loadServerEnv(config.mode, config.envDir));
  }

  /**
   * Routes whose `prerender` export is a function (not a literal list), and the pages that set
   * `dynamicParams = false`, whose list (literal or not) the server reads to refuse a param it omits: the
   * server entry loads them lazily, so the client bundle never contains them.
   */
  function functionPrerenders(scan: ScanResult): { id: string; absolutePath: string }[] {
    return scan.entries
      .filter(
        (entry) =>
          entry.info.exports.includes("prerender") &&
          (entry.info.config.prerender === undefined || entry.info.config.dynamicParams === false),
      )
      .map((entry) => ({ id: entry.id, absolutePath: entry.absolutePath }));
  }

  /** `build.secretScan` of `dusk.config.ts`: on unless the file says `false`. */
  const secretScanOn = (): boolean => state.file?.config.build?.secretScan !== false;

  /**
   * What the output scan checks against: the variables of the build, the public prefixes, and the deployment id (the
   * client carries it on purpose, and it may be taken from the environment, for example a commit id).
   */
  function secretScanContext(): SecretScanContext {
    return {
      values: state.envValues,
      prefixes: state.prefixes,
      declared: state.publicNames,
      allowed: new Set(
        state.publicAllow.flatMap((name) => {
          const value = state.envValues[name];
          return value === undefined ? [] : [value];
        }),
      ),
      ignore: new Set(state.deploymentId === undefined ? [] : [state.deploymentId]),
    };
  }

  /**
   * Scans the client output folder (bundles, prerendered pages, `public/` files, source maps); throws on a finding.
   * @returns The number of text files read (0 when the scan is off).
   */
  async function auditClientOutput(clientDir: string): Promise<number> {
    if (!secretScanOn()) return 0;
    // A file over the size limit or a folder over the count limit throws here (`[BUILD_SCAN_LIMIT]`): never a skip.
    const result = await scanBuildOutput(clientDir, secretScanContext());
    if (result.findings.length > 0) throw new Error(secretScanMessage(result.findings));
    return result.scanned;
  }

  async function buildApp(builder: ViteBuilder): Promise<void> {
    const client = builder.environments["client"];
    const ssr = builder.environments["ssr"];
    if (client === undefined || ssr === undefined) {
      throw new Error("dusk needs the client and ssr environments");
    }
    const steps: BuildStep[] = [];
    const adapterLog: string[] = [];
    const timed = async <T>(name: BuildStepName, work: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await work();
      steps.push({ name, ms: performance.now() - started });
      return result;
    };
    state.report = undefined;
    const outRoot = join(state.root, opts().outDir);
    await rm(outRoot, { recursive: true, force: true });
    const scan = await scanRoutes();
    await loadServerFns();
    await timed("client", () => builder.build(client));
    const manifestPath = join(outRoot, "client", ".vite", "manifest.json");
    const vite: ViteManifest = JSON.parse(await readFile(manifestPath, "utf8")) as ViteManifest;
    // The manifest is build input only. Removing it here keeps it out of the client folder that every adapter copies or
    // serves (Vercel, Netlify, Cloudflare, and the Node layout that serves the folder in place).
    await rm(join(outRoot, "client", ".vite"), { recursive: true, force: true });
    const assetOrigin = opts().assetOrigin;
    state.assets = computeAssets({
      manifest: vite,
      scan,
      root: state.root,
      base: state.viteBase,
      maxPreloads: opts().maxPreloadsPerRoute,
      ...(assetOrigin === undefined ? {} : { origin: assetOrigin }),
    });
    await timed("server", () => builder.build(ssr));
    let prerendered: string[] = [];
    const prerenderSettings = prerenderOf();
    if (prerenderSettings !== false) {
      prerendered = await timed("prerender", async () => {
        const entryFile = join(outRoot, "server", "entry.js");
        // Literal settings fail here, before the server is loaded; function settings need the server.
        const literal = prerenderTargets(scan, prerenderSettings);
        const mayHaveTargets =
          literal.length > 0 ||
          functionPrerenders(scan).length > 0 ||
          prerenderSettings.entries !== undefined;
        // Prerendering runs the app's server code in this process, which reads its settings from
        // `process.env` just as it will in production. The environment is read before the bundle loads.
        if (mayHaveTargets && state.config !== undefined) loadEnvFiles(state.config);
        const server = mayHaveTargets ? await loadBuiltServer(entryFile) : undefined;
        const targets = await resolvePrerenderTargets({
          scan,
          options: prerenderSettings,
          loaders: server?.prerenderRoutes ?? [],
        });
        if (targets.length === 0) return [];
        return prerenderPages({
          entryFile,
          clientDir: join(outRoot, "client"),
          targets,
          options: prerenderSettings,
          base: mountBase(state.viteBase),
          handler: server?.handler,
        });
      });
    }
    // Everything in the client folder is public now (bundles, prerendered pages, public files): check it before the
    // manifest and the adapter copy it anywhere.
    const scanned = await timed("secret-scan", () => auditClientOutput(join(outRoot, "client")));
    const decision = await decideStaticPages(
      join(outRoot, "client"),
      prerendered,
      scan,
      "directory",
    );
    const manifest = await writeDuskManifest(vite, prerendered, decision.pages);
    if (manifest !== undefined) {
      await timed("adapter", () =>
        runAdapter(
          scan,
          manifest,
          prerendered,
          adapterLog,
          decision.allowedHosts,
          decision.runMiddlewareForStaticFiles,
        ),
      );
    }
    const adapter = opts().adapter;
    state.report = {
      steps,
      prerendered: prerendered.length,
      secretScan: { enabled: secretScanOn(), scanned },
      adapter: adapter === undefined ? undefined : { name: adapter.name, outDir: adapter.outDir },
      adapterLog,
    };
  }

  /**
   * Reads `dusk.config.ts` and merges it with the plugin options: a `dusk({ ... })` option wins over the
   * same key of the file (see `mergeBuildOptions`). The deployment id is the file's (or the plugin's
   * `buildId`), or a fresh id per build, or "dev" in the dev server.
   */
  async function loadFile(env: ConfigEnv): Promise<void> {
    state.file = await loadDuskConfigFile(state.root, env.mode, env.command);
    const merged = mergeBuildOptions(
      {
        buildId: pluginOptions.buildId,
        prerender: pluginOptions.prerender,
        adapter: pluginOptions.adapter,
      },
      state.file?.config,
    );
    state.deploymentId =
      merged.buildId ??
      (env.command === "serve"
        ? "dev"
        : await sourceFingerprint(state.root, resolvedOptions.srcDir, state.file?.path));
    state.effective =
      state.file === undefined
        ? undefined
        : resolveOptions({
            ...pluginOptions,
            ...(merged.buildId === undefined ? {} : { buildId: merged.buildId }),
            ...(merged.prerender === undefined ? {} : { prerender: merged.prerender }),
            ...(merged.adapter === undefined ? {} : { adapter: merged.adapter }),
          });
  }

  /**
   * The prerender settings in force: the merged ones, with the literal paths of the route rules that set
   * `prerender: true` added to the routes to render.
   */
  function prerenderOf(): false | PrerenderOptions {
    const base = opts().prerender;
    if (base === false) return false;
    const fromRules = Object.entries(state.file?.config.routeRules ?? {})
      .filter(([, rule]) => rule.prerender === true)
      .map(([path]) => path);
    return fromRules.length === 0
      ? base
      : { ...base, routes: [...(base.routes ?? []), ...fromRules] };
  }

  /** The server part of `dusk.config.ts` with the deployment id of this build. */
  /** `src/instrumentation.*` of the project, when it exists and `dusk.config.ts` does not turn it off. */
  function instrumentationFileOf(): string | undefined {
    if (state.file?.config.instrumentation === false) return undefined;
    for (const name of [
      "instrumentation.ts",
      "instrumentation.mts",
      "instrumentation.js",
      "instrumentation.mjs",
    ]) {
      const file = join(state.root, opts().srcDir, name);
      if (existsSync(file)) return file;
    }
    return undefined;
  }

  /**
   * Notes each leaf option that `dusk.config.ts` and the server entry both set with different values: the entry's value
   * wins (see `mergeHandlerOptions`), and the note names the leaf. The entry is transpiled and read, never run. A leaf is
   * noted once for this plugin instance, however often the entry loads again.
   */
  async function reportOptionConflicts(
    entryFile: string | undefined,
    baked: BakedServerConfig | undefined,
  ): Promise<void> {
    if (entryFile === undefined || baked === undefined) return;
    const shown = relative(state.root, entryFile).split(sep).join("/");
    try {
      const { code } = await transformSource(readFileSync(entryFile, "utf8"), entryFile);
      for (const conflict of optionConflicts(serverOptionsFromConfig(baked), code)) {
        if (reportedConflicts.has(conflict.path)) continue;
        reportedConflicts.add(conflict.path);
        console.warn(optionConflictMessage(conflict, shown));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `dusk: the options of ${shown} were not compared with dusk.config.ts (${reason}).`,
      );
    }
  }

  function bakedFor(): BakedServerConfig | undefined {
    if (state.file === undefined) return undefined;
    return {
      ...bakeServerConfig(state.file.config),
      ...(state.deploymentId === undefined ? {} : { deploymentId: state.deploymentId }),
    };
  }

  return {
    name: "shadowjs:start",
    enforce: "pre",
    sharedDuringBuild: true,
    api,
    async config(userConfig: UserConfig, env: ConfigEnv): Promise<UserConfig> {
      state.root = resolve(userConfig.root ?? process.cwd());
      await loadFile(env);
      // A restart resolves the configuration again. The values the previous start wrote from the env files are
      // taken back before Vite reads its env (in this hook's order) and before readEnvValues; a file that now
      // fails validation never gets here, so a running server keeps its values.
      releaseServerEnv();
      // `env.public` in dusk.config.ts adds prefixes (NEXT_PUBLIC_ ...) to Vite's envPrefix: their
      // variables reach the browser as import.meta.env.NAME too, so the same check applies.
      const publicEnv = publicEnvOf(state.file?.config);
      const configuredPrefixes =
        userConfig.envPrefix === undefined
          ? []
          : typeof userConfig.envPrefix === "string"
            ? [userConfig.envPrefix]
            : [...userConfig.envPrefix];
      state.prefixes = publicPrefixes([...configuredPrefixes, ...publicEnv.prefixes]);
      const files =
        userConfig.envDir === false
          ? NO_ENV_FILES
          : readEnvFiles(env.mode, userConfig.envDir ?? state.root);
      state.envFiles =
        userConfig.envDir === false
          ? []
          : loadedEnvFiles(env.mode, userConfig.envDir ?? state.root);
      // A name declared both in .env.public and in a server file has no single visibility: refused here.
      checkEnvFiles(files, state.prefixes);
      state.envValues = resolvedValues(files);
      state.publicNames = publicEnvNames(
        Object.keys(state.envValues),
        files.publicNames,
        state.prefixes,
      );
      // Names are notes, never errors: a credential-like public name is a warning (publishable keys contain KEY), and
      // a secret-looking value is the failure (refuseSecretValues below). A Next.js name is noted once in dev, when the
      // app kept its prefix in env.public.prefixes. The notes name variables, never values.
      for (const note of credentialNameWarnings(state.publicNames, publicEnv.allow))
        console.warn(note);
      if (env.command === "serve") {
        for (const note of nextPublicNotes(Object.keys(state.envValues), state.prefixes))
          console.info(note);
      }
      refuseSecretValues(state.envValues, state.publicNames, files, publicEnv.allow);
      state.publicAllow = publicEnv.allow;
      const layout = layoutOf();
      const entry = layout.entryClientFile ?? CLIENT_ENTRY_ID;
      // Declared names are typed for the whole project (names only, never values). Written from the files alone, so
      // the file does not change with the machine's environment.
      writeEnvTypes(
        layout.srcDir,
        publicEnvNames(Object.keys(files.values), files.publicNames, state.prefixes),
      );
      // Every `process.env.NAME` and `import.meta.env.NAME` of a public name is its value in the client bundle (inlined,
      // so no chunk needs a runtime shim). `processEnv` adds the whole `process.env` object of the public variables. The
      // server keeps the real process.env.
      const clientDefine: Record<string, string> = {
        ...(publicEnv.processEnv
          ? clientProcessEnvDefines(state.envValues, state.prefixes, state.publicNames)
          : clientPublicEnvDefines(state.envValues, state.prefixes, state.publicNames)),
        ...clientImportMetaEnvDefines(state.envValues, state.prefixes, state.publicNames),
      };
      state.devProcessEnv = publicEnv.processEnv && env.command === "serve";
      return {
        appType: "custom",
        envPrefix: [...state.prefixes],
        resolve: {
          dedupe: ["@shadow-js/core", "@shadow-js/web", "@shadow-js/router", "@shadow-js/dusk"],
          // `~/x` is `<srcDir>/x` in app code (create-shadow-app sets the same path in tsconfig).
          alias: [{ find: /^~\//, replacement: `${layout.srcDir.split(sep).join("/")}/` }],
        },
        ssr: { noExternal: opts().adapter?.bundling === "all" ? true : [/^@shadow-js\//] },
        // The dependency scan reads `.tsx` files with its own JSX setting, not the transformer's (see `scanJsxOptions`).
        optimizeDeps: scanJsxOptions(userConfig.optimizeDeps),
        // With a CDN (`assetOrigin`) the built bundles, CSS and assets refer to the CDN; public files keep the app's origin.
        ...(opts().assetOrigin === undefined
          ? {}
          : {
              experimental: {
                renderBuiltUrl: (filename: string, reference: { readonly type: string }) =>
                  reference.type === "asset"
                    ? `${opts().assetOrigin ?? ""}${mountBase(state.viteBase)}/${filename}`
                    : undefined,
              },
            }),
        environments: {
          client: {
            define: clientDefine,
            build: {
              outDir: join(opts().outDir, "client"),
              manifest: true,
              emptyOutDir: true,
              // No source maps in a production client build unless the app asks: a map holds the sources, and with
              // them every constant a developer wrote. The Vite setting is the opt-in, per environment first.
              ...(env.command === "build"
                ? {
                    sourcemap:
                      userConfig.environments?.["client"]?.build?.sourcemap ??
                      userConfig.build?.sourcemap ??
                      false,
                  }
                : {}),
              // `cwd` keeps the region comments of unminified output relative to the project, not to
              // wherever the build was started from, so the output does not depend on the folder.
              ...bundlerOptions({ input: entry }, { cwd: state.root }),
            },
          },
          ssr: {
            build: {
              outDir: join(opts().outDir, "server"),
              emptyOutDir: true,
              ssr: true,
              // The client build copies `public/` once; the server bundle must not carry a second copy
              // (adapters copy the server folder into their functions).
              copyPublicDir: false,
              ...bundlerOptions(
                {
                  input: { entry: SERVER_ENTRY_ID },
                  output: { entryFileNames: "entry.js", chunkFileNames: "chunks/[name]-[hash].js" },
                },
                { cwd: state.root },
              ),
            },
          },
        },
        builder: { buildApp },
      };
    },
    configResolved(config) {
      state.config = config;
      state.root = config.root;
      state.viteBase = config.base;
      state.assetsDir = config.environments["client"]?.build.assetsDir ?? config.build.assetsDir;
      state.layout = discoverProject(config.root, opts().srcDir);
    },
    resolveId(source) {
      if (source === SERVER_ENTRY_ID || source === CLIENT_ENTRY_ID || source === PROCESS_ENV_ID)
        return RESOLVED_PREFIX + source;
      if (source.startsWith(CONVENTION_PREFIX)) return RESOLVED_PREFIX + source;
      if (source === FILE_IMAGES_ID) return RESOLVED_PREFIX + source;
      return null;
    },
    renderChunk(code, _chunk, outputOptions) {
      return stripRegionComments(code, Boolean(outputOptions.sourcemap));
    },
    generateBundle(_outputOptions, bundle) {
      // The first line of defense for `process.env`: a server secret whose value is in a browser chunk fails the
      // build before the file is written, whatever put it there (a define in vite.config, a constant in app code).
      // `auditClientOutput` runs the same scan over the whole folder at the end (public files, prerendered pages).
      if (this.environment?.name !== "client" || !secretScanOn()) return;
      const context = secretScanContext();
      for (const [fileName, asset] of Object.entries(bundle)) {
        const code = asset.type === "chunk" ? asset.code : asset.source;
        if (typeof code !== "string") continue;
        const finding = scanOutputText(code, fileName, context);
        if (finding !== undefined) this.error(secretScanMessage([finding]));
      }
    },
    async transform(code, id) {
      // The generated route tree gets the static metadata images of its routes (both the server and the browser
      // read the tree). The file on disk stays as the generator wrote it. The scan is awaited because a project's
      // own client entry can import the tree before any virtual entry has caused a scan.
      if (cleanId(id).split("\\").join("/") === router.api.generatedFile.split("\\").join("/")) {
        await scanOrFail(this);
        const injected = injectFileImages(code, state.fileImages);
        return injected === code ? null : { code: injected, map: null };
      }
      // Dev only (`state.devProcessEnv`): the client entry imports the process shim first, so it runs
      // before any module that reads `process.env` while it loads.
      if (!state.devProcessEnv || this.environment?.name !== "client") return null;
      const entry = state.layout?.entryClientFile;
      if (id !== RESOLVED_PREFIX + CLIENT_ENTRY_ID && (entry === undefined || id !== entry))
        return null;
      return { code: `import ${JSON.stringify(PROCESS_ENV_ID)};\n${code}`, map: null };
    },
    async load(id) {
      const layout = layoutOf();
      if (id === RESOLVED_PREFIX + PROCESS_ENV_ID) {
        // The public variables only; the server's secrets never reach the dev browser.
        const values = publicEnvValues(state.envValues, state.prefixes, state.publicNames);
        return `if (typeof process === "undefined") globalThis.process = { env: ${JSON.stringify(values)} };\n`;
      }
      if (id === RESOLVED_PREFIX + CLIENT_ENTRY_ID) {
        await scanOrFail(this);
        const imageWidths = state.file === undefined ? undefined : imageWidthsOf(state.file.config);
        const localeInstance = localeInstanceOf(state.file?.config, state.root);
        return clientEntrySource({
          base: mountBase(state.viteBase),
          generatedTree: router.api.generatedFile,
          appFile: layout.appFile,
          ...(state.deploymentId === undefined ? {} : { deploymentId: state.deploymentId }),
          reloadOnSkew: state.file?.config.skew?.reload !== false,
          caseSensitive: resolvedOptions.router.caseSensitive === true,
          ...(imageWidths === undefined ? {} : { imageWidths }),
          ...(localeInstance === undefined
            ? {}
            : {
                localeRouting: {
                  ...localeInstance,
                  prefix: state.file?.config.i18n?.routing?.prefix ?? "as-needed",
                },
              }),
        });
      }
      if (id === RESOLVED_PREFIX + FILE_IMAGES_ID) return FILE_IMAGES_MODULE;
      if (id.startsWith(RESOLVED_PREFIX + CONVENTION_PREFIX)) {
        // The wrapper of a file convention: the scan that names it has run (it is the server entry's).
        await scanOrFail(this);
        return state.conventions.get(id.slice(RESOLVED_PREFIX.length)) ?? null;
      }
      if (id !== RESOLVED_PREFIX + SERVER_ENTRY_ID) return null;
      const scan = await scanOrFail(this);
      let records: readonly ServerFnRecord[];
      try {
        records = await loadServerFns();
      } catch (error) {
        if (error instanceof ServerFnError) this.error(error.message);
        throw error;
      }
      const dev = state.config?.command === "serve";
      const baked = bakedFor();
      await reportOptionConflicts(layout.entryServerFile, baked);
      const instrumentationFile = instrumentationFileOf();
      const localeInstance = localeInstanceOf(state.file?.config, state.root);
      return serverEntrySource({
        dev,
        base: mountBase(state.viteBase),
        generatedTree: router.api.generatedFile,
        appFile: layout.appFile,
        entryServerFile: layout.entryServerFile,
        apiRoutes: scan.api,
        streams: scan.streams,
        caseSensitive: resolvedOptions.router.caseSensitive === true,
        ...(scan.globalError === undefined
          ? {}
          : { globalErrorFile: scan.globalError.absolutePath }),
        prerenderRoutes: functionPrerenders(scan),
        gatedParams: scan.entries.some((entry) => entry.info.config.dynamicParams === false),
        // The page cache is passed only when a page exports `revalidate` or a route rule sets one (see `isr()`).
        revalidates:
          scan.entries.some((entry) => entry.info.config.revalidate !== undefined) ||
          Object.values(baked?.routing?.routeRules ?? {}).some(
            (rule) => rule.revalidate !== undefined,
          ),
        // The global error file's exports are not scanned: an app with one gets the engine's loader, which the pages
        // feature calls only when a route or the global error exports metadata (see `pages()`).
        metadata:
          scan.globalError !== undefined ||
          state.fileImages.size > 0 ||
          exportsMetadata(scan.entries.flatMap((entry) => entry.info.exports)),
        routerFeatures: routerFeaturesFor(scan.entries.flatMap((entry) => entry.info.exports)),
        middleware: routeMiddlewareSource(scan),
        serverFns: records,
        assets: assetsFor(layout, dev),
        platformEnv: !dev && opts().adapter?.env === "platform",
        ...(baked === undefined ? {} : { baked }),
        ...(localeInstance === undefined ? {} : { localeInstance }),
        ...(instrumentationFile === undefined ? {} : { instrumentationFile }),
        ...(state.deploymentId === undefined ? {} : { deploymentId: state.deploymentId }),
      });
    },
    async hotUpdate({ type, file, modules, read, server }) {
      // A page that failed to render is a 500 document: no client application to update. When the server side
      // changes, the page is loaded again once Vite has invalidated the server modules (the timer runs after the
      // update of this change, which is synchronous). A page that renders again clears the flag.
      if (this.environment.name === "ssr") {
        if (pageFailing) {
          setTimeout(() => {
            server.environments.client.hot.send({ type: "full-reload" });
          }, 0);
        }
        return undefined;
      }
      // A route file that was added or deleted changes the route tree, and the browser's reload asks the server for
      // a page at once: the tree has to be written first, or a deleted route answers with the old tree's error.
      // The router regenerates it on the same watcher event; this waits for that run (a failed scan is reported by
      // the router itself, so the error is not repeated here).
      await router.api.getScan().catch(() => undefined);
      // A CSS module reaches the page twice: through its JavaScript import (which carries the update) and through
      // the stylesheet link the server rendered (`?direct`). The link's module has no importer, so Vite reads the
      // edit as a dead end and reloads the page. The link is left out of the update: the import re-applies the style.
      const updated = modules.filter((mod) => !DIRECT_CSS_MODULE.test(mod.url));
      // A stylesheet generated from the sources (a utility framework such as Tailwind) depends on the classes the
      // components use, and no plugin pushes its new rules when a component changes. An edit that sets classes
      // pushes the plain stylesheets of the client graph too: Vite re-runs their transforms and sends them. Other
      // edits leave the stylesheets alone (each push replaces the stylesheet elements of the page).
      // A deleted file has no text to read (reading it would fail the whole update).
      if (type !== "delete" && CLASS_ATTRIBUTE.test(file) && CLASS_SOURCE.test(await read())) {
        for (const sheet of this.environment.moduleGraph.idToModuleMap.values()) {
          if (sheet.type !== "css" || updated.includes(sheet) || DIRECT_CSS_MODULE.test(sheet.url))
            continue;
          updated.push(sheet);
        }
      }
      return updated;
    },
    configureServer(server) {
      loadEnvFiles(server.config);
      // dusk.config is read when the server starts, so a change, an addition or a removal of the file at the project
      // root restarts the server through Vite's own restart (the same server object, the same port). A file that
      // vite.config.ts imports is in configFileDependencies, and Vite restarts for it already: skipped here, so one
      // save restarts once.
      const DUSK_CONFIG_FILE = /^dusk\.config\.(ts|mts|js|mjs)$/;
      const onConfigFile = (verb: string, file: string): void => {
        const absolute = resolve(file);
        const name = basename(absolute);
        if (dirname(absolute) !== state.root || !DUSK_CONFIG_FILE.test(name)) return;
        if (server.config.configFileDependencies.includes(normalizePath(absolute))) return;
        server.config.logger.info(`${name} ${verb}, restarting the dev server.`, {
          timestamp: true,
        });
        void server.restart().catch((error: unknown) => {
          server.config.logger.error(error instanceof Error ? error.message : String(error));
        });
      };
      const onConfigChange = (file: string): void => onConfigFile("changed", file);
      const onConfigAdd = (file: string): void => onConfigFile("added", file);
      const onConfigRemove = (file: string): void => onConfigFile("removed", file);
      server.watcher.on("change", onConfigChange);
      server.watcher.on("add", onConfigAdd);
      server.watcher.on("unlink", onConfigRemove);
      const layout = layoutOf();
      const unsubscribe = router.api.onScan(() => invalidateServerEntry(server));
      const onFile = (file: string): void => {
        const path = file.split("\\").join("/");
        if (!path.startsWith(`${layout.srcDir.split("\\").join("/")}/`)) return;
        void (async () => {
          const byFile = state.fnByFile;
          if (byFile === undefined) return;
          const previous = JSON.stringify(byFile.get(file)?.map((record) => record.fn));
          let fns: readonly ServerFnRecord["fn"][] = [];
          try {
            fns = await analyzeFile(file, state.root, fnCache);
          } catch (error) {
            // A file that cannot be read or compiled right now (deleted, half-written, with a
            // problem the transform reports when it is requested): no functions until it is fixed.
            if (
              !(error instanceof ServerFnError) &&
              (error as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
              server.config.logger.warn(`could not analyze ${file}: ${(error as Error).message}`);
            }
          }
          if (fns.length === 0) byFile.delete(file);
          else
            byFile.set(
              file,
              fns.map((fn) => ({ file, fn })),
            );
          if (JSON.stringify(byFile.get(file)?.map((record) => record.fn)) !== previous) {
            invalidateServerEntry(server);
          }
        })();
      };
      for (const event of ["add", "unlink", "change"] as const) server.watcher.on(event, onFile);
      server.httpServer?.once("close", () => {
        unsubscribe();
        server.watcher.off("change", onConfigChange);
        server.watcher.off("add", onConfigAdd);
        server.watcher.off("unlink", onConfigRemove);
        for (const event of ["add", "unlink", "change"] as const) server.watcher.off(event, onFile);
      });
      // Pre-transform the client entry and every route module, so import protection violations
      // and compile errors surface at boot instead of at the first visit of a page.
      const warm = (): void => {
        const client = server.environments.client;
        const log = (error: unknown): void => server.config.logger.error(String(error));
        client.warmupRequest(clientEntryUrl(layout).replace(/^\/@id\//, "")).catch(log);
        router.api
          .getScan()
          .then((scan) => {
            for (const entry of scan.entries) {
              const url = `/${relative(state.root, entry.absolutePath).split("\\").join("/")}`;
              client.warmupRequest(url).catch(log);
              client.warmupRequest(`${url}?${ROUTE_UI_QUERY}`).catch(log);
            }
          })
          .catch(log);
      };
      warm();
      return () => {
        server.middlewares.use(
          devMiddleware(server, {
            root: state.root,
            viteBase: state.viteBase,
            clientEntryUrl: clientEntryUrl(layout),
            router: router.api,
            onRender(rendered) {
              pageFailing = !rendered;
            },
          }),
        );
      };
    },
  };
}

export type { CoreState };
