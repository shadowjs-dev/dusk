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

/** Every file below a folder, sorted, as absolute paths. A missing folder has none. @internal */
async function filesBelow(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else if (entry.isFile()) found.push(path);
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
