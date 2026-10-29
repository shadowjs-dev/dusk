/**
 * The deployment id of a build when none is configured: a fingerprint of the app's sources and its config file.
 * Identical sources give the same id (so a rebuild is byte-identical, which the build tests pin); a source
 * change gives a new one, and a stale browser is told to reload. Dependencies (node_modules) are not part of it:
 * set `deploymentId` in `dusk.config.ts` to pin the id yourself.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Every file below a folder, as absolute paths, in the order a depth-first walk over sorted names gives (a folder's files
 * come at the folder's place in the listing). A missing folder has none; any other failure to list a folder
 * (permissions, a file where a folder should be) is thrown, because an id computed from a partial listing would not
 * change with the code that was left out.
 *
 * The walk keeps its own stack: the depth of the folders is the project's, not ours.
 * @internal
 */
async function filesBelow(dir: string): Promise<string[]> {
  const found: string[] = [];
  const pending: Array<{ path: string; folder: boolean }> = [{ path: dir, folder: true }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!next.folder) {
      found.push(next.path);
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(next.path, { withFileTypes: true });
    } catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
        continue;
      }
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Pushed last to first, so the first entry is popped first.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const path = join(next.path, entry.name);
      if (entry.isDirectory()) pending.push({ path, folder: true });
      else if (entry.isFile()) pending.push({ path, folder: false });
    }
  }
  return found;
}

/**
 * The fingerprint of the sources: the path (relative to the project, with `/`) and the bytes of every file in
 * the source folder, then the config file.
 *
 * @param root The project root.
 * @param srcDir The source folder, relative to the root.
 * @param configFile The config file, absolute, if there is one.
 * @returns 16 hexadecimal characters.
 * @internal
 */
export async function sourceFingerprint(
  root: string,
  srcDir: string,
  configFile: string | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  const files = [
    ...(await filesBelow(join(root, srcDir))),
    ...(configFile === undefined ? [] : [configFile]),
  ];
  for (const file of files) {
    hash.update(relative(root, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
