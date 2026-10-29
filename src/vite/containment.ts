import * as nodePath from "node:path";

/** The path functions a check runs on: this machine's, or `path.win32` in tests. */
export type PathApi = nodePath.PlatformPath;

/**
 * True when a path relative to a folder leaves that folder: it is absolute (another drive on Windows),
 * or its first segment is `..`. A folder named `..x` is not a way out, so it is not a match on the prefix.
 *
 * @param relative A path from `path.relative`, with native separators.
 * @param path The path functions to read it with. Default: this machine's.
 * @returns True when the path escapes the folder.
 * @example escapesFolder("../x"); // true
 * @since 1.0.0
 */
export function escapesFolder(relative: string, path: PathApi = nodePath): boolean {
  return path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
}

/**
 * True when `target` is strictly inside `root`. Both are resolved first: Vite hands out `config.root` with
 * forward slashes, while `resolve` returns native separators, and a string prefix check fails between the two.
 *
 * @param root The folder.
 * @param target The path to test.
 * @param path The path functions to resolve with. Default: this machine's.
 * @returns True when `target` is below `root` and is not `root`.
 * @example isInsideFolder("/app", "/app/dist"); // true
 * @since 1.0.0
 */
export function isInsideFolder(root: string, target: string, path: PathApi = nodePath): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !escapesFolder(relative, path);
}

/**
 * Why an adapter may not empty and write `outDir`, or `undefined` when it may. The build removes the adapter's folder
 * before it runs the adapter, so a folder that is, or holds, the build output or the source folder would delete the
 * bundles the adapter is about to copy, or the app itself. A folder inside `client/` or `server/` would be emptied with
 * the next build of that bundle.
 *
 * @param outDir Absolute adapter output folder.
 * @param build Absolute build output folder (the `outDir` of `dusk()`).
 * @param srcDir Absolute source folder.
 * @param path The path functions to resolve with. Default: this machine's.
 * @returns A sentence naming the overlap, or `undefined`.
 * @example adapterOutDirConflict("/app/dist", "/app/dist", "/app/src"); // "it is the build output folder"
 * @since 1.0.0
 */
export function adapterOutDirConflict(
  outDir: string,
  build: string,
  srcDir: string,
  path: PathApi = nodePath,
): string | undefined {
  const same = (a: string, b: string): boolean =>
    path.relative(path.resolve(a), path.resolve(b)) === "";
  // `outDir` holds `folder` when `folder` is `outDir` itself or below it.
  const holds = (folder: string): boolean =>
    same(outDir, folder) || isInsideFolder(outDir, folder, path);
  // `folder` holds `outDir` when `outDir` is `folder` itself or below it.
  const inside = (folder: string): boolean =>
    same(folder, outDir) || isInsideFolder(folder, outDir, path);
  if (holds(build)) return "it holds the build output folder";
  if (holds(srcDir)) return "it holds the source folder";
  if (inside(path.join(build, "client")) || inside(path.join(build, "server"))) {
    return "it sits inside the client or server bundle of the build";
  }
  return undefined;
}
