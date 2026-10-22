/**
 * What differs between the Vite releases Dusk supports. Vite 8 bundles with Rolldown and transforms with Oxc; Vite 7
 * bundles with Rollup and transforms with esbuild. The environment API Dusk builds on (`createBuilder`, per-environment
 * build options, `hotUpdate`) is the same in both. Every place that names a Rolldown or esbuild only option or function
 * goes through this module, so the rest of the plugin reads the same on either release.
 *
 * @packageDocumentation
 */

import * as vite from "vite";

/**
 * True when this Vite bundles with Rolldown and transforms with Oxc (Vite 8 and later, and the Rolldown builds of Vite 7).
 * Found by what the module exports, not by a version number: only a Rolldown based Vite exports `rolldownVersion`.
 */
export const bundlesWithRolldown: boolean = "rolldownVersion" in vite;

/**
 * The bundler options of one build, under the key this Vite reads: `rolldownOptions` on Vite 8, `rollupOptions` on
 * Vite 7. Rolldown-only settings (`cwd`) belong in `rolldownOnly`; Rollup has no such option and is not given it.
 *
 * @param common Options both bundlers read (`input`, `output`).
 * @param rolldownOnly Options only Rolldown reads.
 * @returns An object to spread into `build`.
 */
export function bundlerOptions(
  common: Record<string, unknown>,
  rolldownOnly: Record<string, unknown> = {},
): Record<string, unknown> {
  return bundlesWithRolldown
    ? { rolldownOptions: { ...common, ...rolldownOnly } }
    : { rollupOptions: common };
}

/** The JSX runtime a ShadowJS page needs, in the form each transformer reads. */
const JSX_RUNTIME = { runtime: "automatic", importSource: "@shadow-js/web" } as const;

/** What the dependency scan reads for JSX, as Vite 8 and Vite 7 name it. */
interface ScanOptions {
  readonly rolldownOptions?: { readonly transform?: { readonly jsx?: unknown } };
  readonly esbuildOptions?: { readonly jsx?: unknown };
}

/**
 * The `optimizeDeps` setting that makes the dependency scan read `.tsx` files with the ShadowJS JSX runtime. The scan
 * does not read the transformer's own JSX setting, so without it the scan imports React's runtime for a ShadowJS page
 * and fails when the app has no React. An option the app already set wins.
 *
 * @param optimizeDeps The app's own `optimizeDeps`.
 * @returns The setting to merge, or an empty object when the app chose its own.
 */
export function scanJsxOptions(optimizeDeps: ScanOptions | undefined): Record<string, unknown> {
  if (bundlesWithRolldown) {
    return optimizeDeps?.rolldownOptions?.transform?.jsx === undefined
      ? { rolldownOptions: { transform: { jsx: JSX_RUNTIME } } }
      : {};
  }
  return optimizeDeps?.esbuildOptions?.jsx === undefined
    ? { esbuildOptions: { jsx: "automatic", jsxImportSource: JSX_RUNTIME.importSource } }
    : {};
}

/**
 * Strips the types from a TypeScript or TSX module with the transformer of this Vite (Oxc, or esbuild on Vite 7). The
 * language comes from the file name.
 *
 * @param code The module's source.
 * @param file The module's path, which names its language.
 * @returns The JavaScript.
 */
export async function transformSource(code: string, file: string): Promise<{ code: string }> {
  return bundlesWithRolldown
    ? vite.transformWithOxc(code, file)
    : (
        vite as unknown as {
          transformWithEsbuild(code: string, file: string): Promise<{ code: string }>;
        }
      ).transformWithEsbuild(code, file);
}
