/**
 * Path arithmetic for the files adapters emit. It is pure string work (no `node:path`) because the
 * adapter modules are also bundled for edge runtimes; every path is absolute and POSIX-style when it
 * arrives, since the build runs on the host the paths came from.
 *
 * @packageDocumentation
 */

/** Forward slashes, no trailing slash (except the root). @internal */
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "") ? parts.shift() : undefined;
  const joined = parts.join("/");
  if (drive !== undefined) return `${drive}/${joined}`;
  return slashed.startsWith("/") ? `/${joined}` : joined;
}

/**
 * The specifier that imports `to` from a file inside `fromDir`: `"./x"`, `"../client/"` (a trailing
 * slash is kept, so it works as a base for `new URL`).
 * @param fromDir Absolute folder the importing file is in.
 * @param to Absolute path of the target.
 * @returns A relative path with `./` or `../`.
 * @example relativePath("/app/dist/bun", "/app/dist/client"); // "../client"
 * @internal
 * @since 1.0.0
 */
export function relativePath(fromDir: string, to: string): string {
  const from = normalize(fromDir)
    .split("/")
    .filter((part) => part !== "");
  const target = normalize(to)
    .split("/")
    .filter((part) => part !== "");
  let shared = 0;
  while (shared < from.length && shared < target.length && from[shared] === target[shared])
    shared += 1;
  const ups = from.slice(shared).map(() => "..");
  const rest = target.slice(shared);
  const tail = rest.join("/");
  const trailing = /[\\/]$/.test(to) && tail !== "" ? "/" : "";
  if (ups.length === 0) return `./${tail}${trailing}`;
  return `${[...ups, ...rest].join("/")}${trailing}`;
}

/**
 * Checks an `outDir` option: relative, inside the project, not empty.
 * @param adapter The adapter name, for the message.
 * @param outDir The folder.
 * @returns The folder.
 * @throws TypeError when it is absolute, empty or leaves the project.
 * @internal
 * @since 1.0.0
 */
export function checkOutDir(adapter: string, outDir: string): string {
  if (
    outDir === "" ||
    outDir.startsWith("/") ||
    /^[A-Za-z]:/.test(outDir) ||
    outDir.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError(`${adapter}: outDir must be a folder inside the project (got "${outDir}")`);
  }
  return outDir.replace(/[\\/]+$/, "");
}
