import { createHash } from "node:crypto";

/**
 * Stable id of a server function: the first 22 base64url characters (132 bits) of
 * `sha256(NFC(relative path) + "#" + export name)`.
 *
 * The path is relative to the project root with `/` separators, so the id is the same on every
 * machine, in dev and in build, and a rename of the file or the export changes it. It never
 * contains a character that needs escaping in a URL.
 *
 * @param relativePath File path relative to the project root. `\\` separators are accepted.
 * @param exportName Name of the export (`default` for the default export).
 * @returns A 22-character base64url string.
 * @example
 * fnId("src/server/posts.ts", "getPost"); // "q3Zr0b1g2yTt0m5Qk9w3xA"
 * @since 1.0.0
 */
export function fnId(relativePath: string, exportName: string): string {
  const path = relativePath.replaceAll("\\", "/").replace(/^\.\//, "").normalize("NFC");
  return createHash("sha256").update(`${path}#${exportName}`).digest("base64url").slice(0, 22);
}
