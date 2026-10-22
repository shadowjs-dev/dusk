import type { DuskManifest } from "../vite/build";

/**
 * The header rule every platform adapter sends for files whose name never changes: the build's hashed assets and
 * the fonts vendored from Google Fonts (named by their content hash). Matches the Node static server's default.
 * @internal
 */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The URL folders of the immutable files, with the mount prefix (`base`) applied: the build's assets folder
 * (`manifest.assetsDir`, Vite's `build.assetsDir`) and `fonts/google`. Each platform turns these into its own rule
 * syntax (`/assets/*` for `_headers` files, `/assets/(.*)` for `config.json`).
 * @param manifest The build's manifest.
 * @returns The folders, each without a trailing slash.
 * @internal
 */
export function immutableFolders(
  manifest: Pick<DuskManifest, "base" | "assetsDir">,
): readonly string[] {
  const mount = manifest.base.replace(/\/+$/, "");
  return [`${mount}/${manifest.assetsDir}`, `${mount}/fonts/google`];
}
