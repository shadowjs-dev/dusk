import { readFileSync } from "node:fs";
import { CliError } from "./errors";

/**
 * The version of the package the bin belongs to. The bin sits at `dist/cli/index.js` (and `src/cli/` in the
 * repository), so the package manifest is two folders up in both.
 *
 * @packageDocumentation
 */

/**
 * The version in `packages/dusk/package.json`.
 * @returns The version string.
 * @throws CliError when the manifest has no version.
 * @since 1.0.0
 */
export function duskVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof manifest === "object" && manifest !== null
      ? Reflect.get(manifest, "version")
      : undefined;
  if (typeof version !== "string")
    throw new CliError("the package manifest has no version", "DUSK_NO_VERSION");
  return version;
}
