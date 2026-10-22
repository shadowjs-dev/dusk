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
