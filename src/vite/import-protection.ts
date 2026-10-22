import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { isAbsolute, posix, relative } from "node:path";
import { lineColumn, ModuleParseError, parseModule, walkTree } from "@shadow-js/router/vite";
import type { Plugin } from "vite";
import { escapesFolder } from "./containment";
import { compileGlob, matchesAny } from "./glob";
import type { ImportProtectionOptions } from "./options";

/**
 * Import protection. Code that runs in the browser must never import server code, and the other
 * way round. The check runs in `resolveId`, which sees an import only after the module's
 * transforms ran: a server function's stub has already replaced its handler, so a server module
 * that only the handler imported is not reachable from the browser and passes. A violation is a
 * build error (and a dev error) that prints the chain of imports from the entry.
 *
 * Built-in conventions:
 * - `*.server.{ts,tsx,js,jsx,mts,mjs}` is server-only, `*.client.*` is client-only;
 * - `@shadow-js/dusk/server`, `/node`, `/static`, `/testing` and Node built-ins (`node:*`, `fs`,
 *   ...) cannot be imported by client code.
 */

const SERVER_PACKAGES = new Set([
  "@shadow-js/dusk/server",
  "@shadow-js/dusk/node",
  "@shadow-js/dusk/static",
  "@shadow-js/dusk/testing",
]);

const BUILTINS = new Set(builtinModules);

/**
 * The npm markers of the server and client worlds (`import "server-only"`, `import "client-only"`). They are read as
 * specifiers only: the packages are not dependencies of Dusk, and an installed copy is ignored.
 */
const SERVER_ONLY_MARKER = "server-only";
const CLIENT_ONLY_MARKER = "client-only";

const SERVER_FILE = compileGlob("**/*.server.{ts,tsx,js,jsx,mts,mjs}");
const CLIENT_FILE = compileGlob("**/*.client.{ts,tsx,js,jsx,mts,mjs}");

/**
 * What the dependency scan gets for a protected specifier: external, so the scan neither follows it nor pre-bundles it.
 * The scanner treats an id as external when it is not an absolute path or holds a NUL character; an absolute specifier
 * is prefixed with NUL for that reason (a virtual id, never loaded).
 */
function externalForScan(source: string): { id: string; external: true } {
  return { id: isAbsolute(source) ? `\0${source}` : source, external: true };
}

/** The ways an import can name a protected module. */
type Verdict = { readonly reason: string; readonly target: string } | undefined;

interface Hop {
  readonly importer: string;
  readonly specifier: string;
}

function cleanId(id: string): string {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

function isBuiltin(source: string): boolean {
  if (source.startsWith("node:")) return true;
  const base = source.split("/")[0] ?? source;
  return BUILTINS.has(source) || BUILTINS.has(base);
}

/**
 * True for an absolute alias target: `/x` on POSIX, or `C:\x`, `C:/x`, `\\server\x` on Windows. Checked natively
 * and on the forward-slash form, because a drive path is absolute on Windows only and the rule is tested on any OS.
 */
function isAbsoluteTarget(target: string): boolean {
  const posixTarget = target.split("\\").join("/");
  return isAbsolute(target) || posixTarget.startsWith("/") || /^[A-Za-z]:\//.test(posixTarget);
}

/**
 * Where each alias sends a server-only package: the folder of the file it names, with forward slashes (Vite
 * module ids use them, and the protection checks resolved ids by prefix). An alias to a relative path is no folder.
 *
 * @param aliases The `resolve.alias` entries of the build.
 * @returns The folders, each ending in `/`.
 * @example aliasedPackageFolders([{ find: "@shadow-js/dusk/server", replacement: "C:\\app\\server\\index.ts" }]);
 *   // ["C:/app/server/"]
 * @since 1.0.0
 */
export function aliasedPackageFolders(
  aliases: readonly { readonly find: string | RegExp; readonly replacement: string }[],
): string[] {
  const folders = new Set<string>();
  for (const name of SERVER_PACKAGES) {
    for (const alias of aliases) {
      let target: string | undefined;
      if (typeof alias.find === "string") {
        if (name === alias.find || name.startsWith(`${alias.find}/`)) {
          target = `${alias.replacement}${name.slice(alias.find.length)}`;
        }
      } else if (alias.find.test(name)) {
        target = name.replace(alias.find, alias.replacement);
      }
      if (target !== undefined && isAbsoluteTarget(target)) {
        folders.add(`${posix.dirname(target.split("\\").join("/"))}/`);
      }
    }
  }
  return [...folders];
}

/** Line and column of the import of `specifier` in a file, or undefined. */
function locate(file: string, specifier: string): { line: number; column: number } | undefined {
  if (file.startsWith("\0")) return undefined;
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: ReturnType<typeof parseModule>;
  try {
    parsed = parseModule(source, file);
  } catch (error) {
    // The file does not parse (it is about to be reported by the transform that read it).
    if (error instanceof ModuleParseError) return undefined;
    throw error;
  }
  let found: number | undefined;
  walkTree(parsed.program, (node) => {
    if (found !== undefined) return false;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
    ) {
      const src = node["source"];
      if (typeof src === "object" && src !== null && Reflect.get(src, "value") === specifier) {
        found = node.start;
      }
    }
    return undefined;
  });
  return found === undefined ? undefined : lineColumn(source, found);
}

/**
 * The import protection plugin.
 *
 * @param getRoot Returns the absolute project root (paths in messages are relative to it).
 * @param options Extra globs and exemptions.
 * @returns A Vite plugin; add it before the compiler plugin.
 * @since 1.0.0
 * @example
 * import { importProtection } from "@shadow-js/dusk/vite";
 * importProtection(() => process.cwd(), { server: ["**\/*.secret.ts"] }); // a Vite plugin
 */
export function importProtection(getRoot: () => string, options: ImportProtectionOptions): Plugin {
  const serverGlobs = [SERVER_FILE, ...(options.server ?? []).map(compileGlob)];
  const clientGlobs = [CLIENT_FILE, ...(options.client ?? []).map(compileGlob)];
  const ignoreGlobs = (options.ignore ?? []).map(compileGlob);
  const customClient = (options.client ?? []).length > 0;
  /** First importer of each module in the client graph: the way back to the entry. */
  const clientParents = new Map<string, Hop>();
  const MAX_PARENTS = 100_000;

  const rel = (file: string): string => {
    const root = getRoot();
    const clean = cleanId(file);
    if (clean.startsWith("\0")) return clean.slice(1);
    const native = relative(root, clean);
    // Outside the root (or on another drive) the full path is shown; a folder named `..x` is inside.
    if (escapesFolder(native)) return clean;
    return native.split("\\").join("/");
  };

  /** The import chain from an entry to `target`, one module per line, with the line of each import. */
  const chainOf = (importer: string, target: string, specifier: string): string => {
    // Walk back to the entry: the map holds the first importer seen for each module.
    const hops: { file: string; via: string }[] = [{ file: target, via: specifier }];
    const seen = new Set<string>();
    for (
      let current: string | undefined = importer;
      current !== undefined && !seen.has(current);
    ) {
      seen.add(current);
      const parent: Hop | undefined = clientParents.get(current);
      hops.unshift({ file: current, via: parent?.specifier ?? "" });
      current = parent?.importer;
    }
    return hops
      .map((hop, index) => {
        const next = hops[index + 1];
        const at = next === undefined ? undefined : locate(cleanId(hop.file), next.via);
        const location = at === undefined ? "" : ` (line ${at.line}, column ${at.column + 1})`;
        return `${index === 0 ? "  " : "  -> "}${rel(hop.file)}${location}`;
      })
      .join("\n");
  };

  /** Folders of the server-only packages when an alias points them elsewhere: an alias cannot hide them. */
  let packageFolders: readonly string[] = [];

  const verdictForClient = (source: string, resolved: string | undefined): Verdict => {
    if (source === SERVER_ONLY_MARKER) {
      return { reason: `"${SERVER_ONLY_MARKER}" marks server code`, target: source };
    }
    if (SERVER_PACKAGES.has(source)) {
      return { reason: `"${source}" is server-only`, target: source };
    }
    if (resolved !== undefined) {
      const hit = packageFolders.find((folder) => resolved.startsWith(folder));
      if (hit !== undefined) {
        return {
          reason: `"${rel(resolved)}" belongs to the server-only part of @shadow-js/dusk`,
          target: resolved,
        };
      }
    }
    if (isBuiltin(source)) {
      return {
        reason: `the Node built-in "${source}" does not exist in the browser`,
        target: source,
      };
    }
    if (resolved === undefined) return undefined;
    const path = rel(resolved);
    if (matchesAny(ignoreGlobs, path)) return undefined;
    if (matchesAny(serverGlobs, path)) {
      return { reason: `"${path}" is a server-only module`, target: resolved };
    }
    return undefined;
  };

  return {
    name: "shadowjs:start:import-protection",
    enforce: "pre",
    configResolved(config) {
      packageFolders = aliasedPackageFolders(config.resolve.alias);
    },
    async resolveId(source, importer, resolveOptions) {
      const consumer =
        this.environment?.config.consumer ?? (resolveOptions.ssr === true ? "server" : "client");
      // The dependency scan (Vite's `scan: true`) reads the raw source of each module: no transform ran, so a server
      // function's file still has its server imports. The verdict is about what the browser gets, which the scan does
      // not produce, so the scan never refuses: a protected specifier is external to it (not crawled, not pre-bundled),
      // and it records no parents (the chains come from the modules the browser loads). Serving and the build still
      // refuse the import.
      // `scan` is Vite's own option (not in the public typings of resolveId).
      const scanning = Reflect.get(resolveOptions, "scan") === true;
      if (importer === undefined) {
        // A request that names a module directly (the dev server answering a URL): a server-only
        // module must not be served to the browser either.
        if (consumer === "client" && !scanning && !source.startsWith("\0")) {
          const found = await this.resolve(source, undefined, {
            ...resolveOptions,
            skipSelf: true,
          });
          if (found !== null && found.external !== true) {
            const path = rel(cleanId(found.id));
            if (!matchesAny(ignoreGlobs, path) && matchesAny(serverGlobs, path)) {
              this.error(
                `[IMPORT_PROTECTED] "${path}" is a server-only module and cannot be requested by the browser.`,
              );
            }
          }
        }
        return null;
      }
      const importerPath = cleanId(importer);
      // Only project code is checked. A package from node_modules is its own business.
      if (importerPath.includes("/node_modules/") || importerPath.includes("\\node_modules\\"))
        return null;
      if (matchesAny(ignoreGlobs, rel(importerPath))) return null;
      if (source.startsWith("\0")) return null;

      if (consumer === "client") {
        let resolved: string | undefined;
        if (!SERVER_PACKAGES.has(source) && !isBuiltin(source)) {
          const found = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
          resolved = found === null || found.external === true ? undefined : cleanId(found.id);
          if (
            !scanning &&
            resolved !== undefined &&
            clientParents.size < MAX_PARENTS &&
            !clientParents.has(resolved)
          ) {
            clientParents.set(resolved, { importer: importerPath, specifier: source });
          }
        }
        const verdict = verdictForClient(source, resolved);
        if (verdict !== undefined && scanning) return externalForScan(source);
        if (verdict !== undefined) {
          const at = locate(importerPath, source);
          this.error({
            message:
              `[IMPORT_PROTECTED] ${verdict.reason} and cannot be imported by client code.\n` +
              `Import chain:\n${chainOf(importerPath, verdict.target, source)}\n` +
              "Move the server-only code behind a server function (serverFn), or import it only from server code.",
            id: importerPath,
            ...(at === undefined
              ? {}
              : { loc: { file: importerPath, line: at.line, column: at.column } }),
          });
        }
        return null;
      }

      if (source === CLIENT_ONLY_MARKER) {
        // The marker is the module itself: any server module that names it is refused, whatever it resolves to.
        const at = locate(importerPath, source);
        this.error({
          message:
            `[IMPORT_PROTECTED] "${CLIENT_ONLY_MARKER}" marks browser code and cannot be imported by server code.\n` +
            `Imported from ${rel(importerPath)}${at === undefined ? "" : ` (line ${at.line}, column ${at.column + 1})`}.`,
          id: importerPath,
          ...(at === undefined
            ? {}
            : { loc: { file: importerPath, line: at.line, column: at.column } }),
        });
        return null;
      }

      // Server code: only `*.client.*` modules are off limits.
      // The `*.client.*` convention can only be named by a specifier that contains ".client".
      if (customClient || source.includes(".client")) {
        const found = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
        if (found !== null && found.external !== true) {
          const path = rel(cleanId(found.id));
          if (!matchesAny(ignoreGlobs, path) && matchesAny(clientGlobs, path)) {
            const at = locate(importerPath, source);
            this.error({
              message:
                `[IMPORT_PROTECTED] "${path}" is a client-only module and cannot be imported by server code.\n` +
                `Imported from ${rel(importerPath)}${at === undefined ? "" : ` (line ${at.line}, column ${at.column + 1})`}.`,
              id: importerPath,
              ...(at === undefined
                ? {}
                : { loc: { file: importerPath, line: at.line, column: at.column } }),
            });
          }
        }
      }
      return null;
    },
    buildStart() {
      clientParents.clear();
    },
  };
}
