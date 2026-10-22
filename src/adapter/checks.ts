import { isBuiltin } from "node:module";
import { parse } from "acorn";
import type { Adapter } from "./types";

/**
 * Checks the server bundle against what the adapter's platform can run. The check parses each file with a real
 * JavaScript parser (acorn) and reads its module records: static `import`/`export ... from`, literal `import("x")`,
 * and literal `require("x")` calls. Comments, strings and template text are not code, so a comment that quotes an import
 * is not an import. A computed `import(name)` has no name to check and is not reported.
 *
 * A Node built-in (`crypto` or `node:crypto`) is a built-in: allowed where Node runs, refused on an edge runtime.
 *
 * @packageDocumentation
 */

/** A file of the server bundle, with its text. @internal */
export interface BundleFile {
  /** Path relative to the project root, for the message. */
  readonly file: string;
  readonly code: string;
}

/** A problem found in the bundle. @internal */
export interface BundleProblem {
  readonly file: string;
  readonly specifier: string;
  readonly message: string;
}

/** The fields of a parsed node this check reads. @internal */
interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

/** A string literal's value, or `undefined` for any other node. @internal */
function literalString(node: unknown): string | undefined {
  if (!isAstNode(node) || node.type !== "Literal") return undefined;
  const value: unknown = Reflect.get(node, "value");
  return typeof value === "string" ? value : undefined;
}

/** The module specifier of one node, when the node names a module it loads. @internal */
function specifierOf(node: AstNode): string | undefined {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression":
      return literalString(node["source"]);
    case "CallExpression": {
      const callee = node["callee"];
      if (!isAstNode(callee) || callee.type !== "Identifier" || callee["name"] !== "require") {
        return undefined;
      }
      const args: unknown = node["arguments"];
      return Array.isArray(args) ? literalString(args[0]) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Module specifiers a bundle names by code (not by text), in source order, with duplicates.
 * Walks the tree with an explicit stack, so a deeply nested bundle cannot exhaust the call stack.
 *
 * @param code Module text.
 * @returns The specifiers.
 * @throws SyntaxError when the text is not a module the parser accepts.
 * @internal
 * @example importsOf('// import x from "zod"\nimport y from "node:fs";'); // ["node:fs"]
 * @since 1.0.0
 */
export function importsOf(code: string): string[] {
  const program: unknown = parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    allowReturnOutsideFunction: false,
  });
  const found: Array<{ specifier: string; start: number }> = [];
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node: unknown = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (!isAstNode(node)) continue;
    const specifier = specifierOf(node);
    if (specifier !== undefined) found.push({ specifier, start: numberField(node, "start") });
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
  // The walk is depth first from the end, so the source order is restored from the offsets.
  return found.sort((a, b) => a.start - b.start).map((entry) => entry.specifier);
}

/** A numeric field of a node, or 0 when the parser did not record it. @internal */
function numberField(node: AstNode, key: string): number {
  const value: unknown = Reflect.get(node, key);
  return typeof value === "number" ? value : 0;
}

/** A parser error, as the message the problem list shows. @internal */
function parseMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an edge adapter runs a built-in: it must be in the adapter's `supportedBuiltins`, by bare name (`node:crypto`
 * and `crypto` name the same module). Exact names only: a subpath such as `fs/promises` is not `fs`.
 * @internal
 */
function runsOnEdge(adapter: Pick<Adapter, "supportedBuiltins">, specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return adapter.supportedBuiltins?.includes(bare) === true;
}

/**
 * Checks bundle files against an adapter's platform:
 * - an edge runtime (`edge: true`) may name no Node built-in, with or without `node:`, except the ones the adapter
 *   lists in `supportedBuiltins` (the Node built-ins its platform runs, such as Workers with `nodejs_compat`);
 * - bundling `"all"` may name no package (a relative file or a Node built-in is fine on the Node.js runtime).
 *
 * @param adapter The adapter.
 * @param files The bundle files.
 * @returns The problems, in file order. Empty when the bundle fits the platform.
 * @internal
 * @example checkBundle(vercelAdapter, [{ file: "dist/server/entry.js", code }]);
 * @since 1.0.0
 */
export function checkBundle(
  adapter: Pick<Adapter, "name" | "edge" | "bundling" | "supportedBuiltins">,
  files: readonly BundleFile[],
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  for (const { file, code } of files) {
    let specifiers: string[];
    try {
      specifiers = importsOf(code);
    } catch (error) {
      problems.push({
        file,
        specifier: "",
        message: `${adapter.name}: ${file} could not be parsed as an ES module, so its imports cannot be checked (${parseMessage(error)}).`,
      });
      continue;
    }
    for (const specifier of new Set(specifiers)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      if (isBuiltin(specifier)) {
        if (adapter.edge === true && !runsOnEdge(adapter, specifier)) {
          problems.push({
            file,
            specifier,
            message:
              adapter.supportedBuiltins === undefined
                ? `${adapter.name} runs without Node built-ins, but the server bundle imports "${specifier}". Remove it from the code that the server runs (or move it to a *.server.* module that only the platform adapter does not reach).`
                : `${adapter.name} runs only the Node built-ins it supports, and the server bundle imports "${specifier}", which it does not run. Remove it from the code that the server runs, or use the Web API or a package that does not need it.`,
          });
        }
        continue;
      }
      if (adapter.bundling === "all") {
        problems.push({
          file,
          specifier,
          message: `${adapter.name} needs a self-contained server bundle, but "${specifier}" was left external. Import it from a relative path or add it to a bundled dependency.`,
        });
      }
    }
  }
  return problems;
}

/**
 * Throws one error that lists every problem, or does nothing.
 * @param adapter The adapter.
 * @param files The bundle files.
 * @throws Error listing every problem with its file.
 * @internal
 * @since 1.0.0
 */
export function assertBundle(
  adapter: Pick<Adapter, "name" | "edge" | "bundling" | "supportedBuiltins">,
  files: readonly BundleFile[],
): void {
  const problems = checkBundle(adapter, files);
  if (problems.length === 0) return;
  const lines = problems.map((problem) => `  ${problem.file}: ${problem.message}`);
  throw new Error(
    `[ADAPTER_BUNDLE] ${adapter.name}: the server bundle does not fit the platform\n${lines.join("\n")}`,
  );
}
