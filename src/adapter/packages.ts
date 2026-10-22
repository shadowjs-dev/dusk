import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Packages a Dusk server loads by name at run time, which a bundler cannot trace (B3). `ImageResponse` loads `satori`
 * through a variable specifier, the app reads the resvg wasm of `@resvg/resvg-wasm` from its folder, and `sharpProcessor`
 * loads `sharp` the same way. A function folder has no `node_modules` unless an adapter copies one in, so the adapter
 * finds these packages in the build's own `node_modules`, with the packages they need, and copies them.
 *
 * Node's resolution is what finds them: a package is searched in the `node_modules` of its folder and of each ancestor.
 * The bundle is searched for a quoted package name (a string search that only decides what to copy: copying a package
 * the server does not load costs bytes, missing one costs the request).
 *
 * @packageDocumentation
 */

/** The packages copied into a function when the server bundle names them. @internal */
export const RUNTIME_PACKAGES: readonly string[] = ["satori", "@resvg/resvg-wasm", "sharp"];

/** An installed package: its name and its folder. @internal */
export interface InstalledPackage {
  readonly name: string;
  readonly dir: string;
}

/**
 * The folder of an installed package, the way Node finds it from `from`: the `node_modules` of that folder, then of each
 * ancestor. A folder with a `package.json` is a package, whatever its `exports` say.
 * @param from The folder to search from.
 * @param name The package name (`sharp`, `@img/sharp-linux-x64`).
 * @returns The package folder, or `undefined` when no ancestor has it.
 * @internal
 * @since 1.0.0
 */
export function findPackage(from: string, name: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The first folder in `from` that has the package, or `undefined`. @internal */
function firstPackage(from: readonly string[], name: string): string | undefined {
  for (const start of from) {
    const dir = findPackage(start, name);
    if (dir !== undefined) return dir;
  }
  return undefined;
}

/** The names a package.json lists as dependencies and optional dependencies. @internal */
function dependencyNames(packageDir: string): string[] {
  const text = readFileSync(join(packageDir, "package.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return [];
  const names: string[] = [];
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const value: unknown = Reflect.get(parsed, field);
    if (typeof value !== "object" || value === null) continue;
    names.push(...Object.keys(value));
  }
  return names;
}

/**
 * The installed packages a list of runtime packages needs: each one, and its dependencies and optional dependencies
 * (only those installed on this machine: an optional native package for another platform is simply absent), transitively.
 * Iterative, so a deep dependency graph cannot exhaust the stack.
 * @param from The folders to resolve from, in order of preference: the project, then the folder of the Dusk package
 *   (where the framework itself finds its runtime packages).
 * @param names The runtime packages.
 * @returns Each package once, in discovery order.
 * @internal
 * @since 1.0.0
 */
export function packageClosure(
  from: readonly string[],
  names: readonly string[],
): InstalledPackage[] {
  const found = new Map<string, InstalledPackage>();
  const queue: InstalledPackage[] = [];
  for (const name of names) {
    const dir = firstPackage(from, name);
    if (dir === undefined) continue;
    queue.push({ name, dir });
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined || found.has(current.name)) continue;
    found.set(current.name, current);
    for (const dependency of dependencyNames(current.dir)) {
      if (found.has(dependency)) continue;
      const dir = findPackage(current.dir, dependency);
      if (dir !== undefined) queue.push({ name: dependency, dir });
    }
  }
  return [...found.values()];
}

/**
 * The runtime packages a server bundle names: those whose quoted name (`"satori"`, `"@resvg/resvg-wasm/index_bg.wasm"`)
 * appears in one of its files. Walks the folder with an explicit stack.
 * @param serverDir The folder of the server bundle.
 * @param names The candidate packages.
 * @returns The names found, in the order given.
 * @internal
 * @since 1.0.0
 */
export function namesMentionedIn(serverDir: string, names: readonly string[]): string[] {
  const texts: string[] = [];
  const stack = [serverDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (/\.m?js$/.test(entry)) texts.push(readFileSync(path, "utf8"));
    }
  }
  return names.filter((name) =>
    texts.some(
      (text) =>
        text.includes(`"${name}`) || text.includes(`'${name}`) || text.includes(`\`${name}`),
    ),
  );
}
