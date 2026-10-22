import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@shadow-js/compiler/javascript";

/**
 * Compiles component source with the real ShadowJS compiler (server target) and imports it, so the
 * fixtures run through the same pipeline as user code. Inside `source`, `"@start/server"` names the
 * source entry of `@shadow-js/dusk/server`; every other import resolves normally.
 */

const dir: string = join(import.meta.dirname, "..", ".generated");
const SERVER_ENTRY: string = join(import.meta.dirname, "..", "..", "src", "server", "index.ts");
const ROOT_ENTRY: string = join(import.meta.dirname, "..", "..", "src", "index.ts");
/**
 * Each load gets its own module instance, so counters in one test never leak into the next. The
 * file name includes the process id: test files run in parallel workers that share the directory.
 */
let loads = 0;

/**
 * Compiles `source` for the server and imports it.
 *
 * @param source Component source (TSX).
 * @returns The module namespace.
 */
export async function load<T = Record<string, unknown>>(source: string): Promise<T> {
  const text = source
    .replaceAll('"@start/server"', JSON.stringify(SERVER_ENTRY))
    .replaceAll('"@start"', JSON.stringify(ROOT_ENTRY));
  mkdirSync(dir, { recursive: true });
  const result = compile(text, { filename: "case.tsx", generate: "ssr" });
  loads += 1;
  const name = `${createHash("sha1").update(`${process.pid}:${loads}:${text}`).digest("hex").slice(0, 12)}.ts`;
  const file = join(dir, name);
  writeFileSync(file, result.code);
  return (await import(/* @vite-ignore */ file)) as T;
}
