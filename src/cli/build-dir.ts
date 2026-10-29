import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord } from "../shared/check";
import { CliError, isErrorCode } from "./errors";

/**
 * Where `dusk start` finds the build. The build's folder is `dusk({ outDir })` (default `dist`), and `dusk start` never
 * evaluates the Vite config, so `dusk build` leaves a small marker, `.dusk/build.json`, naming the folder
 * relative to the app (the folder holds a `.gitignore` with `*`, so it is never committed). `dusk start --dir <folder>` overrides it. Without either, the folder is `dist`.
 *
 * @packageDocumentation
 */

/** The default build folder, relative to the app (the plugin's default `outDir`). @internal */
export const DEFAULT_BUILD_DIR = "dist";

/**
 * The marker `dusk build` writes, relative to the app. It is not in `node_modules`: that folder is often shared or linked
 * between copies of an app, and the marker belongs to one app's build.
 * @internal
 */
export const BUILD_MARKER: string = join(".dusk", "build.json");

/**
 * Records the folder a build wrote to, for `dusk start`.
 *
 * @param root The app's folder.
 * @param outDir The absolute build folder.
 * @throws Error when the marker cannot be written, or `outDir` is outside the app (`dusk start` refuses such a
 *   marker, so none is written and the caller says to pass `--dir`).
 * @internal
 * @since 1.0.0
 * @example await writeBuildMarker("/app", "/app/out"); // .dusk/build.json: { "outDir": "out" }
 */
export async function writeBuildMarker(root: string, outDir: string): Promise<void> {
  const marker = join(root, BUILD_MARKER);
  const inside = relative(root, outDir);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) {
    throw new Error(`the build folder ${outDir} is outside the app`);
  }
  await mkdir(dirname(marker), { recursive: true });
  // A folder of generated files that ignores itself, so the app's `.gitignore` needs no entry.
  await writeFile(join(dirname(marker), ".gitignore"), "*\n", "utf8");
  const folder = relative(root, outDir).split(sep).join("/");
  await writeFile(marker, `${JSON.stringify({ outDir: folder === "" ? "." : folder })}\n`, "utf8");
}

/**
 * The folder `dusk start` serves: `--dir`, else the folder the last build recorded, else `dist`.
 *
 * @param root The app's folder.
 * @param flag The `--dir` value, relative to `root` (or absolute), or `undefined`.
 * @returns The absolute build folder.
 * @throws CliError (`DUSK_BAD_BUILD`) when the marker is not one the build wrote, or names a folder outside the app.
 * @internal
 * @since 1.0.0
 * @example await resolveBuildDir("/app", undefined); // "/app/dist"
 */
export async function resolveBuildDir(root: string, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return resolve(root, flag);
  let text: string;
  try {
    text = await readFile(join(root, BUILD_MARKER), "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return join(root, DEFAULT_BUILD_DIR);
    throw error;
  }
  const refused = (why: string): CliError =>
    new CliError(
      `${BUILD_MARKER.split(sep).join("/")} ${why}. Run \`dusk build\` again, or pass --dir.`,
      "DUSK_BAD_BUILD",
    );
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw refused("is not JSON");
  }
  const outDir = isRecord(data) ? data["outDir"] : undefined;
  if (typeof outDir !== "string" || outDir === "") throw refused("has no outDir");
  const folder = resolve(root, outDir);
  const inside = relative(root, folder);
  if (isAbsolute(outDir) || inside === ".." || inside.startsWith(`..${sep}`)) {
    throw refused("names a folder outside the app");
  }
  return folder;
}
