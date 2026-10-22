import type { ApiEntry, StreamEntry } from "@shadow-js/router/vite";
import type { BakedServerConfig } from "../server/baked-config";
import type { ImageWidths } from "../shared/image";
import type { ServerFnRecord } from "./project";
import type { RouteMiddlewareSource } from "./route-middleware";

/**
 * Source text of the virtual modules the plugin serves: the server entry (which builds the
 * handler from the route tree, the API routes and the server functions) and the client entry
 * (which calls `hydrateDusk`). They are generated from lists, with every path written through
 * `JSON.stringify`, so no file name can break out of a string.
 */

/**
 * Id of the server entry module (what a user of the plugin imports or builds).
 *
 * @example
 * import { SERVER_ENTRY_ID } from "@shadow-js/dusk/vite";
 * SERVER_ENTRY_ID; // "virtual:dusk/server-entry"
 * @since 1.0.0
 */
export const SERVER_ENTRY_ID = "virtual:dusk/server-entry";

/**
 * Id of the generated client entry.
 *
 * @example
 * import { CLIENT_ENTRY_ID } from "@shadow-js/dusk/vite";
 * CLIENT_ENTRY_ID; // "virtual:dusk/client-entry"
 * @since 1.0.0
 */
export const CLIENT_ENTRY_ID = "virtual:dusk/client-entry";

/**
 * Id of the dev-only `process` shim (`env.public.processEnv`). The dev server does not replace
 * `process.env.NAME` in client code (Vite's defines are build-time), so the client entry imports this
 * module first; it sets a `process` holding the public variables. The build does not use it.
 * @example
 * PROCESS_ENV_ID; // "virtual:dusk/process-env"
 * @since 1.0.0
 */
export const PROCESS_ENV_ID = "virtual:dusk/process-env";

/**
 * Prefix Vite gives a resolved virtual module so no other plugin touches it.
 *
 * @internal
 * @since 1.0.0
 */
export const RESOLVED_PREFIX = "\0";

function posix(path: string): string {
  return path.split("\\").join("/");
}

const q = (text: string): string => JSON.stringify(text);

/**
 * A router feature a page route's export needs (see {@link ServerEntryInput.routerFeatures}).
 * @since 1.0.0
 */
export type RouterFeatureKey =
  | "loaders"
  | "head"
  | "errors"
  | "filters"
  | "search"
  | "not-found"
  | "pending";

/** The router factory each {@link RouterFeatureKey} names, its module, and the call the entry makes. */
const ROUTER_FEATURES: Readonly<
  Record<
    RouterFeatureKey,
    {
      readonly module: string;
      readonly name: string;
      readonly alias: string;
      readonly args: string;
    }
  >
> = {
  loaders: {
    module: "@shadow-js/router/loaders",
    name: "loaderCache",
    alias: "duskRouterLoaders",
    args: "{}",
  },
  head: {
    module: "@shadow-js/router/head",
    name: "headManagement",
    alias: "duskRouterHead",
    args: "",
  },
  errors: {
    module: "@shadow-js/router/errors",
    name: "errorBoundaries",
    alias: "duskRouterErrors",
    args: "",
  },
  filters: {
    module: "@shadow-js/router/filters",
    name: "matchFilters",
    alias: "duskRouterFilters",
    args: "",
  },
  search: {
    module: "@shadow-js/router/search",
    name: "searchValidation",
    alias: "duskRouterSearch",
    args: "",
  },
  "not-found": {
    module: "@shadow-js/router/not-found",
    name: "notFoundUi",
    alias: "duskRouterNotFound",
    args: "",
  },
  pending: {
    module: "@shadow-js/router/pending",
    name: "pendingUi",
    alias: "duskRouterPending",
    args: "",
  },
};

/**
 * The router features the exports of the page routes need: a `loader` export needs `loaders`, `head` needs `head`, `error`
 * needs `errors`, `matchFilters` needs `filters`, `validateSearch` needs `search`, `notFound` needs `not-found` and
 * `pending` needs `pending`. Read from the names the route modules export (see the route scan).
 *
 * @param exportNames The export names of every page and layout module of the app.
 * @returns The features, in a fixed order.
 * @internal
 */
export function routerFeaturesFor(exportNames: readonly string[]): RouterFeatureKey[] {
  const names = new Set(exportNames);
  const out: RouterFeatureKey[] = [];
  if (names.has("loader")) out.push("loaders");
  if (names.has("head")) out.push("head");
  if (names.has("error")) out.push("errors");
  if (names.has("matchFilters")) out.push("filters");
  if (names.has("validateSearch")) out.push("search");
  if (names.has("notFound")) out.push("not-found");
  if (names.has("pending")) out.push("pending");
  return out;
}

/** The metadata exports a route module may carry: any of them needs the metadata engine (see `metadata/server.ts`). */
const METADATA_EXPORT_NAMES: ReadonlySet<string> = new Set([
  "metadata",
  "generateMetadata",
  "notFoundMetadata",
  "errorMetadata",
  "viewport",
  "generateViewport",
  "links",
  "meta",
  "headers",
]);

/**
 * True when some module exports a metadata export. A file image (`opengraph-image`) is not an export: the caller checks
 * the build's file-image map for it.
 *
 * @param exportNames The export names of every page and layout module of the app.
 * @internal
 */
export function exportsMetadata(exportNames: readonly string[]): boolean {
  return exportNames.some((name) => METADATA_EXPORT_NAMES.has(name));
}

/**
 * The module that exports the app's i18n instance, as the plugin resolved it (`localeInstanceOf`): what the generated
 * entries import when `dusk.config.ts` declares `i18n.routing`.
 * @example
 * const instance: LocaleInstanceInput = { file: "/app/src/i18n.ts", exportName: "i18n" };
 * @since 1.0.0
 */
export interface LocaleInstanceInput {
  /** Absolute path of the module. */
  readonly file: string;
  /** The export that holds the instance (an identifier, or `default`). */
  readonly exportName: string;
}

/**
 * The import of the app's i18n instance under a fixed local name. `default` is imported by name, so every export name
 * takes one form; a missing export fails the build, naming it.
 */
function localeInstanceImport(instance: LocaleInstanceInput): string {
  // The name is written into module text unquoted: only an identifier (or `default`) may get there.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(instance.exportName)) {
    throw new TypeError(
      `i18n.routing.instance.export: ${JSON.stringify(instance.exportName)} is not an export name.`,
    );
  }
  return `import { ${instance.exportName} as duskI18nInstance } from ${q(posix(instance.file))};`;
}

/** What the server entry needs to be generated. @since 1.0.0 */
export interface ServerEntryInput {
  /** True in the dev server: error details, and the dev error reporter. */
  readonly dev: boolean;
  /** Mount base without a trailing slash (`""` or `/app`). */
  readonly base: string;
  /** Absolute path of `routeTree.gen.ts`. */
  readonly generatedTree: string;
  /** Absolute path of `src/app.*`, if present. */
  readonly appFile: string | undefined;
  /** Absolute path of `src/entry-server.*`, if present. */
  readonly entryServerFile: string | undefined;
  readonly apiRoutes: readonly ApiEntry[];
  /** The build's `router.caseSensitive`: written to the manifest when true (the runtime matchers read it). */
  readonly caseSensitive?: boolean;
  /** Absolute path of `src/routes/_global-error.*`, when the routes have one: the handler's `globalError` option. */
  readonly globalErrorFile?: string;
  /** Stream routes (`SSE` and `WS` exports). Absent: none. */
  readonly streams?: readonly StreamEntry[];
  /**
   * Routes whose `prerender` export is a function. The entry exports them as `prerenderRoutes`, each
   * loaded lazily, so the build can call them and the browser bundle never imports them.
   */
  readonly prerenderRoutes?: readonly { readonly id: string; readonly absolutePath: string }[];
  /** True when some page sets `dynamicParams = false`: the entry gives the pages feature the check's loader. */
  readonly gatedParams?: boolean;
  /**
   * True when a page exports `revalidate` or the configuration gives a route rule a `revalidate`: the entry then passes the
   * `isr()` feature (without it, the page cache is not in the handler).
   */
  readonly revalidates?: boolean;
  /**
   * True when a route or the global error exports metadata (or has file images): the entry gives the pages feature the
   * metadata engine's loader. Absent: no route has metadata, and the engine is not in the bundle.
   */
  readonly metadata?: boolean;
  /**
   * The router features the page routes' exports need: `loaders` (a `loader` export), `head` (`head`), `errors` (`error`)
   * and `filters` (`matchFilters`). Absent: none.
   */
  readonly routerFeatures?: readonly RouterFeatureKey[];
  readonly serverFns: readonly ServerFnRecord[];
  /**
   * Server-only middleware of the routes (see `routeMiddlewareSource`). Absent: none. Never part of the
   * browser's route tree.
   */
  readonly middleware?: RouteMiddlewareSource;
  /**
   * True for an adapter whose platform passes the bindings to each request (`env: "platform"`): the
   * handler then validates the environment on the first request, not at import time.
   */
  readonly platformEnv?: boolean;
  /** The server part of `dusk.config.ts` (absent: no file). */
  readonly baked?: BakedServerConfig;
  /**
   * The module of the app's i18n instance (`i18n.routing.instance`), given exactly when `baked.i18n.routing` is: the
   * entry then wraps the handler options with `withLocaleRouting`. Absent: the entry names nothing of i18n.
   */
  readonly localeInstance?: LocaleInstanceInput;
  /** Absolute path of `src/instrumentation.*` when the project has one and it is enabled. */
  readonly instrumentationFile?: string;
  /** The deployment id of this build; the client sends it and the server checks it. */
  readonly deploymentId?: string;
  /** The client asset section: JSON-compatible. */
  readonly assets: {
    readonly entry: string;
    readonly css: readonly string[];
    readonly preloads: Readonly<Record<string, readonly string[]>>;
    readonly base: string;
  };
}

/**
 * The server entry: imports the route tree, the app and the user's handler options, registers
 * the API routes lazily and the server functions (lazily in the dev server, from static imports
 * in a build), and exports `handler` (also as default).
 *
 * @param input See {@link ServerEntryInput}.
 * @returns Module text.
 * @since 1.0.0
 * @example serverEntrySource({ dev: false, base: "", generatedTree, appFile, entryServerFile, apiRoutes, serverFns, assets });
 */
export function serverEntrySource(input: ServerEntryInput): string {
  // A feature the app does not use is not passed, so its module is not in the bundle. An entry file's options are
  // JavaScript the build cannot read, and an option without its feature is refused at startup: with an entry file the
  // options features are passed too. Without one, the configuration decides.
  const keepOptionFeatures = input.entryServerFile !== undefined;
  const useRpc = keepOptionFeatures || input.serverFns.length > 0;
  const useStreams = keepOptionFeatures || (input.streams ?? []).length > 0;
  // The declarative routing (redirects, rewrites, headers, route rules) is passed when the configuration declares some;
  // the page cache (isr) when a page or a route revalidates; draft mode when the configuration sets it.
  const useRouting = keepOptionFeatures || input.baked?.routing !== undefined;
  const useIsr = keepOptionFeatures || input.revalidates === true;
  const useDraft = keepOptionFeatures || input.baked?.draftMode !== undefined;
  const useApi = input.apiRoutes.length > 0;
  const featureImports = [
    ...(useRouting
      ? [`import { routing as duskRouting } from "@shadow-js/dusk/features/routing";`]
      : []),
    ...(useApi
      ? [`import { apiRoutes as duskApiRoutes } from "@shadow-js/dusk/features/api-routes";`]
      : []),
    `import { dataCache as duskDataCache } from "@shadow-js/dusk/features/data-cache";`,
    ...(useDraft
      ? [`import { draftMode as duskDraftMode } from "@shadow-js/dusk/features/draft-mode";`]
      : []),
    `import { images as duskImages } from "@shadow-js/dusk/features/images";`,
    ...(useIsr ? [`import { isr as duskIsr } from "@shadow-js/dusk/features/isr";`] : []),
    `import { pages as duskPages } from "@shadow-js/dusk/features/pages";`,
    ...(useRpc ? [`import { rpc as duskRpc } from "@shadow-js/dusk/features/rpc";`] : []),
    ...(useStreams
      ? [`import { streams as duskStreams } from "@shadow-js/dusk/features/streams";`]
      : []),
  ];
  const lines: string[] = [
    `import { createHandler, mergeHandlerOptions, serverOptionsFromConfig } from "@shadow-js/dusk/server";`,
    // The features the app uses are passed; a hand-written handler lists the ones it needs (see
    // @shadow-js/dusk/features/<name>).
    ...featureImports,
    `import { routeTree } from ${q(posix(input.generatedTree))};`,
  ];
  input.apiRoutes.forEach((api, index) => {
    if (api.matchFilters)
      lines.push(`import * as apiFilters${index} from ${q(posix(api.absolutePath))};`);
  });
  if (input.globalErrorFile !== undefined) {
    lines.push(`import * as globalErrorModule from ${q(posix(input.globalErrorFile))};`);
  }
  // The router features the page routes' exports need, and the pages options: the `dynamicParams = false` check and the
  // metadata engine are modules of their own, loaded on the first request that needs them. Only an app with such an
  // export names them: every other app's pages feature is the plain one.
  const routerFactories = (input.routerFeatures ?? []).map((key) => {
    const feature = ROUTER_FEATURES[key];
    lines.push(`import { ${feature.name} as ${feature.alias} } from ${q(feature.module)};`);
    return `${feature.alias}(${feature.args})`;
  });
  const pageOptions: string[] = [];
  if (input.gatedParams === true) {
    pageOptions.push(`dynamicParams: () => import("@shadow-js/dusk/features/dynamic-params")`);
  }
  if (input.metadata === true) {
    pageOptions.push(`metadata: () => import("@shadow-js/dusk/features/metadata")`);
  }
  if (routerFactories.length > 0)
    pageOptions.push(`routerFeatures: [${routerFactories.join(", ")}]`);
  const pagesFeature =
    pageOptions.length === 0 ? "duskPages()" : `duskPages({ ${pageOptions.join(", ")} })`;
  const features = [
    ...(useRouting ? ["duskRouting()"] : []),
    pagesFeature,
    "duskDataCache()",
    ...(useIsr ? ["duskIsr()"] : []),
    ...(useRpc
      ? [
          input.serverFns.some((record) => record.fn.stream === true)
            ? "duskRpc({ streams: {} })"
            : "duskRpc()",
        ]
      : []),
    ...(useApi ? ["duskApiRoutes()"] : []),
    ...(useStreams ? ["duskStreams()"] : []),
    "duskImages()",
    ...(useDraft ? ["duskDraftMode()"] : []),
  ];
  lines.push(`const duskFeatures = [${features.join(", ")}];`);
  if (input.appFile !== undefined) lines.push(`import App from ${q(posix(input.appFile))};`);
  else lines.push("const App = (props) => props.children;");
  if (input.instrumentationFile !== undefined) {
    lines.push(`import * as instrumentation from ${q(posix(input.instrumentationFile))};`);
  }
  // Locale routing (`i18n.routing` in dusk.config.ts): the app's instance and the module that wires it. Only an app
  // that declares it names either; every other entry has no i18n text at all.
  const locale = localeRoutingOf(input);
  if (locale !== undefined) {
    lines.push(
      `import { withLocaleRouting as duskWithLocaleRouting } from "@shadow-js/dusk/i18n";`,
    );
    lines.push(localeInstanceImport(locale));
  }
  // The server part of dusk.config.ts (plain JSON); the entry file's own options come after it and win.
  const baked = {
    ...(input.baked ?? { skew: { reload: true }, instrumentation: true }),
    deploymentId: input.deploymentId ?? input.baked?.deploymentId,
  };
  // A mounted app sets the mount point the image loader writes before anything renders; an unmounted one pays nothing.
  if (input.base !== "") {
    lines.push(`import { configureImageBase } from "@shadow-js/dusk/components";`);
    lines.push(`configureImageBase(${q(input.base)});`);
  }
  lines.push(`const bakedOptions = serverOptionsFromConfig(${JSON.stringify(baked)});`);
  if (input.entryServerFile !== undefined) {
    // The namespace is read by name at run time, not as `userEntry.options`: a module may export
    // only `options`, only a default, or both, and a member access to an export that does not exist
    // is a build warning (IMPORT_IS_UNDEFINED). `options` wins over the default export.
    lines.push(`import * as userEntry from ${q(posix(input.entryServerFile))};`);
    lines.push(
      'const userOptions = Reflect.get(userEntry, "options") ?? Reflect.get(userEntry, "default") ?? {};',
    );
  } else {
    lines.push("const userOptions = {};");
  }
  lines.push("");
  // An API route that exports `matchFilters` is imported statically: its rules are part of the matcher, which is built
  // at startup. The module is still loaded lazily for its handlers (the bundler shares one copy).
  lines.push("const apiRoutes = [");
  input.apiRoutes.forEach((api, index) => {
    const filters = api.matchFilters ? `, matchFilters: apiFilters${index}.matchFilters` : "";
    lines.push(
      `  { id: ${q(api.id)}, path: ${q(api.fullPath)}${filters}, load: () => import(${q(posix(api.absolutePath))}) },`,
    );
  });
  lines.push("];");
  lines.push("");
  lines.push("const streams = [");
  for (const stream of input.streams ?? []) {
    lines.push(
      `  { id: ${q(stream.id)}, path: ${q(stream.fullPath)}, kinds: ${JSON.stringify(stream.kinds)}, load: () => import(${q(posix(stream.absolutePath))}) },`,
    );
  }
  lines.push("];");
  lines.push("");
  const sorted = [...input.serverFns].sort((a, b) =>
    a.fn.id < b.fn.id ? -1 : a.fn.id > b.fn.id ? 1 : 0,
  );
  // A production build imports the server function modules statically. Routes import the same
  // modules (that is how a page calls a server function), so a dynamic import here could never
  // split them into a chunk of their own and the bundler would warn (INEFFECTIVE_DYNAMIC_IMPORT).
  // The dev server keeps them lazy: a request does not load every server function module.
  const names = new Map<string, string>();
  if (!input.dev) {
    for (const record of sorted) {
      if (names.has(record.file)) continue;
      const name = `serverFnModule${names.size}`;
      names.set(record.file, name);
      lines.push(`import * as ${name} from ${q(posix(record.file))};`);
    }
    if (names.size > 0) lines.push("");
  }
  lines.push("export const prerenderRoutes = [");
  for (const route of input.prerenderRoutes ?? []) {
    lines.push(
      `  { id: ${q(route.id)}, load: () => import(${q(posix(route.absolutePath))}).then((module) => module.prerender) },`,
    );
  }
  lines.push("];");
  lines.push("");
  lines.push("const serverFns = {");
  for (const record of sorted) {
    const namespace = names.get(record.file);
    lines.push(
      namespace === undefined
        ? `  ${q(record.fn.id)}: { load: () => import(${q(posix(record.file))}).then((module) => module[${q(record.fn.exportName)}]) },`
        : `  ${q(record.fn.id)}: { load: async () => ${namespace}[${q(record.fn.exportName)}] },`,
    );
  }
  lines.push("};");
  lines.push("");
  lines.push(`const assets = ${JSON.stringify(input.assets)};`);
  const middleware = input.middleware;
  if (middleware !== undefined) lines.push(...middlewareLines(middleware));
  lines.push(
    `export const manifest = { routes: routeTree, apiRoutes, streams, serverFns, assets${(input.prerenderRoutes ?? []).length === 0 ? "" : ", prerenderRoutes"}, App${middleware === undefined ? "" : ", middleware"}${input.caseSensitive === true ? ", caseSensitive: true" : ""} };`,
  );
  lines.push("");
  if (input.dev) {
    lines.push("let reporter;");
    lines.push(
      "/** The dev server hands over a function that shows server errors in the browser overlay. */",
    );
    lines.push("export function setDevReporter(next) { reporter = next; }");
    lines.push("const onError = (error, info) => {");
    lines.push("  if (reporter !== undefined) reporter(error, info);");
    lines.push("  else console.error(error);");
    lines.push("};");
  }
  lines.push(handlerExport(input));
  lines.push("export default handler;");
  // Adapter entries build their platform export from these (see `createFetch`); they are part of
  // the bundle, so the generated entries import only relative files.
  lines.push(
    'export { createFetch, platformHost, runtimeEnvironment } from "@shadow-js/dusk/server";',
    'export { workerFetch } from "@shadow-js/dusk/cloudflare";',
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * The `handler` export of the server entry. Three layers, lowest first: the defaults (`dev`, `onError`, the features,
 * the instrumentation module), the file's options (`bakedOptions`) and the entry's (`userOptions`). The two merges are
 * `mergeHandlerOptions`: an entry that sets `security.csp` keeps the file's `security.headers`, and a value the entry sets
 * replaces the file's (see that function's rules). The fixed values the entry never overrides come last: the global
 * error page, the platform's environment (`envSource: false`), the manifest and the mount point.
 *
 * Without an entry file there is nothing to merge: the file's options are spread over the defaults.
 *
 * @internal
 */
function handlerExport(input: ServerEntryInput): string {
  const instrumentation = input.instrumentationFile === undefined ? "" : ", instrumentation";
  const defaults = input.dev
    ? `{ dev: true, onError, features: duskFeatures${instrumentation} }`
    : `{ dev: false, features: duskFeatures${instrumentation} }`;
  const options =
    input.entryServerFile === undefined
      ? `{ ...${defaults}, ...bakedOptions }`
      : `mergeHandlerOptions(mergeHandlerOptions(${defaults}, bakedOptions), userOptions)`;
  const fixed = [
    input.globalErrorFile === undefined ? "" : "globalError: globalErrorModule, ",
    !input.dev && input.platformEnv === true ? "envSource: false, " : "",
    `manifest, base: ${q(input.base)}`,
  ].join("");
  const merged = `{ ...${options}, ${fixed} }`;
  // With locale routing the final options (the entry's middleware and document head included) get the locale
  // middleware first and the hreflang links last; the settings are the file's, as the bundle holds them.
  const locale = localeRoutingOf(input);
  return locale === undefined
    ? `export const handler = createHandler(${merged});`
    : `export const handler = createHandler(duskWithLocaleRouting(${merged}, duskI18nInstance, ${JSON.stringify(locale.config)}));`;
}

/**
 * The locale routing of a server entry: the instance module and the `i18n` part of the baked configuration, when the
 * file declares `i18n.routing`. One without the other is a plugin error.
 */
function localeRoutingOf(
  input: ServerEntryInput,
): (LocaleInstanceInput & { readonly config: NonNullable<BakedServerConfig["i18n"]> }) | undefined {
  const config = input.baked?.i18n;
  const declared = config?.routing !== undefined;
  if (declared !== (input.localeInstance !== undefined)) {
    throw new Error(
      "serverEntrySource: localeInstance is given exactly when the baked configuration declares i18n.routing.",
    );
  }
  return config === undefined || input.localeInstance === undefined
    ? undefined
    : { ...input.localeInstance, config };
}

/**
 * The `middleware` object of the server entry: each module is loaded on demand, the folder chains are
 * plain data. Route modules are imported by path, the same way the route tree imports them.
 * @internal
 */
function middlewareLines(source: RouteMiddlewareSource): string[] {
  const load = (absolutePath: string): string =>
    `{ load: () => import(${q(posix(absolutePath))}).then((module) => module.middleware) }`;
  const lines: string[] = ["const middleware = {", "  routes: {"];
  for (const entry of source.routes)
    lines.push(`    ${q(entry.key)}: ${load(entry.absolutePath)},`);
  lines.push("  },", "  directories: {");
  for (const entry of source.directories) {
    lines.push(`    ${q(entry.key)}: ${load(entry.absolutePath)},`);
  }
  lines.push("  },", "  pages: {");
  for (const page of source.pages)
    lines.push(`    ${q(page.id)}: ${JSON.stringify(page.folders)},`);
  lines.push("  },", "  apis: {");
  for (const api of source.apis) lines.push(`    ${q(api.id)}: ${JSON.stringify(api.folders)},`);
  lines.push("  },", "};");
  return lines;
}

/** What the generated client entry needs. @since 1.0.0 */
export interface ClientEntryInput {
  /** The deployment id of this build (sent with every server function call). */
  readonly deploymentId?: string;
  /** Reload the page on a deployment mismatch. Default true. */
  readonly reloadOnSkew?: boolean;
  readonly base: string;
  readonly generatedTree: string;
  readonly appFile: string | undefined;
  /** The build's `router.caseSensitive`: the browser router compares static segments with their case. */
  readonly caseSensitive?: boolean;
  /** The image widths of `dusk.config.ts` (absent: the defaults, and no import of the components). */
  readonly imageWidths?: ImageWidths;
  /**
   * Locale routing (`i18n.routing` of `dusk.config.ts`): the instance module and the URL prefix. With a prefix that puts
   * the locale in the URL, the entry starts the locale sync after hydration, from a chunk it loads on demand. Absent (or
   * `prefix: "never"`): the entry names nothing of i18n.
   */
  readonly localeRouting?: LocaleInstanceInput & {
    readonly prefix: "as-needed" | "always" | "never";
  };
}

/**
 * The generated client entry: starts the app on the server's markup.
 *
 * @param input See {@link ClientEntryInput}.
 * @returns Module text.
 * @since 1.0.0
 * @example clientEntrySource({ base: "", generatedTree, appFile });
 */
export function clientEntrySource(input: ClientEntryInput): string {
  const lines = [
    `import { hydrateDusk } from "@shadow-js/dusk/client";`,
    `import { preloadRoutes, routeTree } from ${q(posix(input.generatedTree))};`,
  ];
  if (input.appFile !== undefined) lines.push(`import App from ${q(posix(input.appFile))};`);
  // The URL names the locale only with a prefix: `"never"` has nothing to follow on the client.
  const locale =
    input.localeRouting !== undefined && input.localeRouting.prefix !== "never"
      ? input.localeRouting
      : undefined;
  if (locale !== undefined) lines.push(localeInstanceImport(locale));
  // Only an app that configures image widths pays for the import: the markup must match the server's widths.
  // A mounted app sets the mount point the image loader writes (the same rule as the server entry).
  const imageSetup: string[] = [];
  if (input.imageWidths !== undefined)
    imageSetup.push(`configureImageWidths(${JSON.stringify(input.imageWidths)});`);
  if (input.base !== "") imageSetup.push(`configureImageBase(${q(input.base)});`);
  if (imageSetup.length > 0) {
    const names = [
      ...(input.imageWidths === undefined ? [] : ["configureImageWidths"]),
      ...(input.base === "" ? [] : ["configureImageBase"]),
    ];
    lines.splice(1, 0, `import { ${names.join(", ")} } from "@shadow-js/dusk/components";`);
    lines.push(...imageSetup);
  }
  const app = input.appFile === undefined ? "" : ", App";
  const deployment =
    input.deploymentId === undefined
      ? ""
      : `, deploymentId: ${q(input.deploymentId)}, reloadOnSkew: ${input.reloadOnSkew === false ? "false" : "true"}`;
  const caseSensitive = input.caseSensitive === true ? ", router: { caseSensitive: true }" : "";
  const hydrate = `hydrateDusk({ routes: routeTree${app}, preload: preloadRoutes, base: ${q(input.base)}${deployment}${caseSensitive} })`;
  if (locale === undefined) {
    lines.push(`await ${hydrate};`);
  } else {
    // The sync module is a chunk of its own, loaded once the app is hydrated: a client navigation then sets the
    // locale (and `<html lang dir>`) the URL names.
    lines.push(`const duskClient = await ${hydrate};`);
    lines.push(
      `import("@shadow-js/dusk/i18n/client").then((duskLocaleSync) => { duskLocaleSync.startLocaleSync(duskI18nInstance, duskClient.router, { base: ${q(input.base)} }); }).catch((error) => { console.error(error); });`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
