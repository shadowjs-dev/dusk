import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@shadow-js/compiler/javascript";

/**
 * Compiles component source with the real ShadowJS compiler and imports the result, so JSX runs
 * through the same module pipeline (aliases, TypeScript stripping) as user code.
 */

// Inside the package so the test runner resolves the module and its aliases like any source file.
const dir = join(import.meta.dirname, "..", "..", ".generated", "client");

/** Each load gets its own module instance, so counters in one test never leak into the next. */
let loads = 0;

export async function load<T = Record<string, unknown>>(
  source: string,
  target: "dom" | "ssr" = "dom",
): Promise<T> {
  mkdirSync(dir, { recursive: true });
  loads += 1;
  const text = `${source}\n// load ${loads}\n`;
  const result = compile(text, { filename: "case.tsx", generate: target });
  const name = `${createHash("sha1").update(`${target}:${text}`).digest("hex").slice(0, 16)}.ts`;
  const file = join(dir, name);
  writeFileSync(file, result.code);
  return (await import(/* @vite-ignore */ file)) as T;
}
