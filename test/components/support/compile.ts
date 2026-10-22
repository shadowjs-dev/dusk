import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@shadow-js/compiler/javascript";

/**
 * Compiles `src/components` the way the package build does (`dom` for the browser, `ssr` for the server) into
 * `test/.generated/components/<target>`. Relative imports into the rest of `src` are rewritten to absolute paths
 * so the generated tree needs no copy of the sources. Imports the generated modules by name, e.g. `loadComponent("dom", "image")`.
 */
export type Target = "dom" | "ssr";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..", "..");
const srcRoot = join(packageRoot, "src");
const componentsRoot = join(srcRoot, "components");
const compiled = new Map<Target, string>();

function filesUnder(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** The output root of one target, built once per test process. */
export function compiledComponents(target: Target): string {
  const known = compiled.get(target);
  if (known !== undefined) return known;
  const out = join(packageRoot, "test", ".generated", "components", target);
  for (const file of filesUnder(componentsRoot)) {
    if (!/\.tsx?$/.test(file)) continue;
    const name = relative(componentsRoot, file).replace(/\.tsx$/, ".ts");
    const result = compile(readFileSync(file, "utf8"), {
      filename: file,
      generate: target,
      dev: true,
      autoReactive: false,
      hmr: false,
      sourceMap: false,
    });
    const text = result.code.replaceAll(/from "\.\.\//g, `from "${srcRoot}/`);
    const destination = join(out, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, text);
  }
  compiled.set(target, out);
  return out;
}

/** Imports a compiled component module, e.g. `loadComponent("dom", "image")` for `src/components/image.tsx`. */
export async function loadComponent<T = Record<string, unknown>>(
  target: Target,
  name: string,
): Promise<T> {
  return (await import(/* @vite-ignore */ join(compiledComponents(target), `${name}.ts`))) as T;
}
