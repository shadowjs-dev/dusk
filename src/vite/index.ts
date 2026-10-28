/**
 * `@shadow-js/dusk/vite`: the Vite plugin set of Dusk. Build time only (Node).
 * @packageDocumentation
 */

import { shadowRouter } from "@shadow-js/router/vite";
import shadow from "@shadow-js/vite";
import type { Plugin } from "vite";
import { importProtection } from "./import-protection";
import { type DuskOptions, resolveOptions } from "./options";
import { type CoreState, duskCore, serverFnPlugin } from "./plugin";

export {
  type BuiltAssets,
  type BuiltServer,
  computeAssets,
  createDuskManifest,
  type DuskManifest,
  loadBuiltServer,
  PrerenderError,
  type PrerenderRouteLoader,
  type PrerenderTarget,
  prerenderFile,
  prerenderTargets,
  resolvePrerenderTargets,
  type ViteManifest,
  type ViteManifestChunk,
} from "./build";
export {
  type BakedServerConfig,
  bakeServerConfig,
  type DuskBuildBudgets,
  type DuskBuildConfig,
  type DuskConfig,
  type DuskDevConfig,
  type DuskDraftModeConfig,
  type DuskEnvShape,
  type DuskI18nConfig,
  type DuskI18nRoutingConfig,
  type DuskImageConfig,
  type DuskSecurityConfig,
  defineConfig,
  devAllowedHostsOf,
  type LoadedDuskConfig,
  loadDuskConfigFile,
  mergeBuildOptions,
  validateDuskConfig,
} from "./config-file";
export {
  applyServerEnv,
  checkEnvFiles,
  type EnvFiles,
  findForbiddenEnvReads,
  loadServerEnv,
  PUBLIC_ENV_PREFIX,
  publicEnvNames,
  publicPrefixes,
  readEnvFiles,
} from "./env";
export { compileGlob } from "./glob";
export { fnId } from "./ids";
export { importProtection } from "./import-protection";
export type {
  DuskOptions,
  ImportProtectionOptions,
  PrerenderFailureEvent,
  PrerenderOptions,
  PrerenderSuccess,
} from "./options";
export type {
  BuildReport,
  BuildStep,
  BuildStepName,
  DuskCoreApi,
  DuskCorePlugin,
} from "./plugin";
export { discoverProject, type ProjectLayout, type ServerFnRecord } from "./project";
export { type RouteMiddlewareSource, routeMiddlewareSource } from "./route-middleware";
export {
  ServerFnError,
  type ServerFnInfo,
  type ServerFnIssueCode,
  type ServerFnTransformOptions,
  type ServerFnTransformResult,
  transformServerFns,
} from "./server-fn";
export { CLIENT_ENTRY_ID, clientEntrySource, SERVER_ENTRY_ID, serverEntrySource } from "./virtual";

/**
 * The Vite plugins of a Dusk app, in the order they must run:
 *
 * 1. the server-function transform (stubs in the browser build, registration on the server);
 * 2. the file-route plugin (scanner, `routeTree.gen.ts`, route splitting);
 * 3. the core plugin (virtual entries, dev server, build orchestration, prerender);
 * 4. import protection (server-only code cannot reach the browser);
 * 5. the ShadowJS compiler.
 *
 * `vite dev` serves pages through the app's handler with HMR. `vite build --app` builds the
 * browser bundle, then the server bundle, writes `dist/dusk-manifest.json` and prerenders.
 *
 * @param options See {@link DuskOptions}. All optional.
 * @returns An array of Vite plugins.
 * @throws TypeError for an unknown or invalid option (with a suggestion).
 * @example
 * // vite.config.ts
 * import { dusk } from "@shadow-js/dusk/vite";
 * export default { plugins: [dusk()] };
 * @since 1.0.0
 */
export function dusk(options: DuskOptions = {}): Plugin[] {
  const resolved = resolveOptions(options);
  const router = shadowRouter(resolved.router);
  const state: CoreState = {
    config: undefined,
    envFiles: [],
    report: undefined,
    root: process.cwd(),
    viteBase: "/",
    assetsDir: "assets",
    prefixes: ["DUSK_PUBLIC_"],
    envValues: {},
    publicNames: [],
    publicAllow: [],
    devProcessEnv: false,
    layout: undefined,
    assets: undefined,
    fnByFile: undefined,
    file: undefined,
    effective: undefined,
    deploymentId: undefined,
    conventions: new Map<string, string>(),
    fileImages: new Map(),
  };
  const base = (): string => (state.viteBase === "/" ? "" : state.viteBase.replace(/\/+$/, ""));
  const plugins: Plugin[] = [
    serverFnPlugin({
      root: () => state.root,
      base,
      prefixes: () => state.prefixes,
      publicNames: () => state.publicNames,
    }),
    router,
    duskCore(options, resolved, router, state),
  ];
  if (resolved.importProtection !== false) {
    plugins.push(importProtection(() => state.root, resolved.importProtection));
  }
  // `@shadow-js/vite` may carry its own copy of Vite's typings (a different patch version): the
  // plugin object is the same shape, so it is typed through this package's Vite.
  plugins.push(shadow(resolved.shadow) as unknown as Plugin);
  return plugins;
}

export {
  type FontReport,
  type FontReportFile,
  type FontRoutePreloads,
  fontPreloadsFor,
  formatFontReport,
} from "./font-report";
export {
  FONT_SUBSETS,
  type FontSubset,
  type SubsetFontFn,
  type SubsetFontsOptions,
  subsetFonts,
} from "./font-subsets";
export {
  type DefineFontsOptions,
  type DefineGoogleFontsInput,
  defineFonts,
  type FontDefinition,
  type FontFile,
  type FontsOutput,
} from "./fonts";
export type { GoogleFont, GoogleFontsOptions } from "./google-fonts";
export { type ImageVariantsOptions, imageVariants } from "./image-variants";
export {
  type PwaOfflinePage,
  type PwaOptions,
  type PwaRuntimeRule,
  pwa,
} from "./pwa";
export type { CacheStrategy } from "./pwa-core";
