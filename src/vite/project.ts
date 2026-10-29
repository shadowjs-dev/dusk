import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ModuleParseError } from "@shadow-js/router/vite";
import { ServerFnError, type ServerFnInfo, transformServerFns } from "./server-fn";

/**
 * What a Dusk project looks like on disk: the optional entry files by convention, and the
 * server functions found in its source.
 */

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"] as const;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CACHE_LIMIT = 10_000;

/** Files of the project that Dusk looks for by name. @since 1.0.0 */
export interface ProjectLayout {
  readonly root: string;
  /** Absolute source folder. */
  readonly srcDir: string;
  /** `src/app.tsx`: the root component. */
  readonly appFile: string | undefined;
  /** `src/entry-server.ts`: handler options (middleware, security, env). */
  readonly entryServerFile: string | undefined;
  /** `src/entry-client.ts`: replaces the generated client entry. */
  readonly entryClientFile: string | undefined;
}

function firstExisting(dir: string, name: string): string | undefined {
  for (const extension of SOURCE_EXTENSIONS) {
    const file = join(dir, `${name}${extension}`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Looks for the conventional files.
 *
 * @param root Project root (absolute).
 * @param srcDir Source folder relative to the root.
 * @returns The layout; missing files are `undefined`.
 * @since 1.0.0
 * @example discoverProject("/app", "src").appFile; // "/app/src/app.tsx" or undefined
 */
export function discoverProject(root: string, srcDir: string): ProjectLayout {
  const src = join(root, srcDir);
  return {
    root,
    srcDir: src,
    appFile: firstExisting(src, "app"),
    entryServerFile: firstExisting(src, "entry-server"),
    entryClientFile: firstExisting(src, "entry-client"),
  };
}

/** A server function and the file that defines it. @since 1.0.0 */
export interface ServerFnRecord {
  /** Absolute path of the module. */
  readonly file: string;
  readonly fn: ServerFnInfo;
}

/**
 * Memory of analyzed files by content hash.
 *
 * @internal
 * @since 1.0.0
 */
export type ServerFnCache = Map<string, readonly ServerFnInfo[]>;

/** Receives a note about a file the scan skipped or a limit it hit. @internal */
export type ScanWarn = (message: string) => void;

function warnOnConsole(message: string): void {
  console.warn(`[dusk] ${message}`);
}

function isCandidate(name: string): boolean {
  if (name.endsWith(".d.ts") || name.includes(".test.") || name.includes(".spec.")) return false;
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * True for a file the server function scan reads: a source file that is not a type declaration or a test, outside
 * dot-folders and `node_modules`. The dev watcher asks the same question the scan answers, so a file the build ignores
 * is not registered in development either.
 *
 * @param srcDir The absolute source folder.
 * @param file The absolute path of a file the watcher reported.
 * @returns Whether the scan would read it.
 * @example isServerFnSource("/app/src", "/app/src/server/posts.ts"); // true; "/app/src/a.test.ts" is false
 * @internal
 * @since 1.0.0
 */
export function isServerFnSource(srcDir: string, file: string): boolean {
  const parts = relative(srcDir, file).split(sep);
  const name = parts[parts.length - 1] ?? "";
  if (parts[0] === ".." || parts.some((part) => part === "") || !isCandidate(name)) return false;
  // The scan skips every dot-name, a file's included, and `node_modules`.
  return parts.every((part) => !part.startsWith(".") && part !== "node_modules");
}

async function* walk(directory: string): AsyncGenerator<string> {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (let index = dirents.length - 1; index >= 0; index -= 1) {
      const dirent = dirents[index];
      if (dirent === undefined) continue;
      const name = dirent.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = join(current, name);
      if (dirent.isDirectory()) stack.push(path);
      else if (dirent.isFile() && isCandidate(name)) yield path;
    }
  }
}

/**
 * Analyzes one file for server functions, with a memory of unchanged files.
 *
 * @param file Absolute path.
 * @param root Project root.
 * @param cache Memory keyed by content.
 * @param warn Told about a file that is skipped because it is too big. Default: `console.warn`.
 * @returns The server functions of the file; none for a file that mentions neither form.
 * @throws ServerFnError for a server function the build cannot compile.
 * @since 1.0.0
 * @internal
 * @example const fns = await analyzeFile("/app/src/server/posts.ts", "/app", new Map());
 */
export async function analyzeFile(
  file: string,
  root: string,
  cache: ServerFnCache,
  warn: ScanWarn = warnOnConsole,
): Promise<readonly ServerFnInfo[]> {
  const code = await readFile(file, "utf8");
  const mentions = code.includes("serverFn") || code.includes("use server");
  if (code.length > MAX_FILE_BYTES) {
    // A big generated data file is no concern; a big file with server functions would lose them without a word.
    if (mentions) {
      warn(
        `${relative(root, file)} is over ${MAX_FILE_BYTES / 1024 / 1024} MB, so it was not scanned for server functions; any it declares are not registered. Split the file.`,
      );
    }
    return [];
  }
  if (!mentions) return [];
  const key = createHash("sha1")
    .update(relative(root, file))
    .update("\0")
    .update(code)
    .digest("hex");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = transformServerFns({ code, file, root, target: "analyze" });
  const fns = result?.fns ?? [];
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, fns);
  return fns;
}

/**
 * Finds every server function in the source folder.
 *
 * @param layout The project layout.
 * @param cache Memory of analyzed files.
 * @param warn Told when the scan stops at the file limit or skips a file that is too big (the build passes its logger).
 *   Default: `console.warn`.
 * @returns Records sorted by file and line.
 * @throws ServerFnError for a server function that cannot be compiled, or two functions with the
 *   same id (`SERVER_FN_ID_COLLISION`).
 * @since 1.0.0
 * @example const records = await scanServerFns(discoverProject(root, "src"), new Map());
 */
export async function scanServerFns(
  layout: ProjectLayout,
  cache: ServerFnCache,
  warn: ScanWarn = warnOnConsole,
): Promise<ServerFnRecord[]> {
  const records: ServerFnRecord[] = [];
  let count = 0;
  let base: string;
  try {
    base = await realpath(layout.srcDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for await (const real of walk(base)) {
    count += 1;
    if (count > MAX_FILES) {
      warn(
        `the source folder has more than ${MAX_FILES} source files; only the first ${MAX_FILES} (in name order) were scanned for server functions, so the others are not registered. Move generated or vendored files out of ${relative(layout.root, layout.srcDir) || "the source folder"}.`,
      );
      break;
    }
    // The logical path (under `layout.root`, symlinks not resolved) keeps ids independent of
    // where the project folder happens to be linked from.
    const file = join(layout.srcDir, relative(base, real));
    try {
      for (const fn of await analyzeFile(file, layout.root, cache, warn))
        records.push({ file, fn });
    } catch (error) {
      if (error instanceof ModuleParseError) continue;
      throw error;
    }
  }
  return checkCollisions(records, layout.root);
}

/**
 * Fails when two server functions share an id. @internal
 *
 * @example checkCollisions(records, root); // throws SERVER_FN_ID_COLLISION
 * @since 1.0.0
 */
export function checkCollisions(records: ServerFnRecord[], root: string): ServerFnRecord[] {
  const byId = new Map<string, ServerFnRecord>();
  for (const record of records) {
    const previous = byId.get(record.fn.id);
    if (previous !== undefined) {
      throw new ServerFnError(
        "SERVER_FN_ID_COLLISION",
        `"${relative(root, record.file)}#${record.fn.exportName}" and "${relative(root, previous.file)}#${previous.fn.exportName}" have the same id ${record.fn.id}`,
        record.file,
        record.fn.line,
        0,
        "",
      );
    }
    byId.set(record.fn.id, record);
  }
  return records.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.fn.line - b.fn.line,
  );
}
