/**
 * The build-time check of options that `dusk.config.ts` and `src/entry-server.ts` both set. The entry's value wins (the
 * merge of `mergeHandlerOptions`), so a leaf key the file sets to one value and the entry to another is reported once,
 * naming the leaf: a security setting the file declared would otherwise change without a word.
 *
 * The entry is read, never run: its options object is found by name (`export const options`, the default export, or
 * `export { x as options }`), and only literal values are compared. A value the entry computes (a call, a variable
 * that is not a literal, a spread) is skipped: the check cannot know it. The input is JavaScript (the caller
 * transpiles a TypeScript entry first).
 *
 * @packageDocumentation
 */

import { parse } from "acorn";
import type { HandlerOptions } from "../server/types";

/** One leaf key both sides set with different values. @since 1.0.0 */
export interface OptionConflict {
  /** The leaf as a dotted path of handler options (`security.headers.frameOptions`). */
  readonly path: string;
  /** The file's value, described (`"DENY"`, `false`, `an object`). */
  readonly fileValue: string;
  /** The entry's value, described. */
  readonly entryValue: string;
}

/** The fields of a parsed node the check reads. @internal */
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A parsed node, for the readers that share this module's walk of the entry (see `entry-static-options.ts`). @internal */
export type EntryNode = Node;

/** A value the check could read from the entry; `known: false` for anything it cannot evaluate. @internal */
type Evaluated = { readonly known: true; readonly value: unknown } | { readonly known: false };

const UNKNOWN: Evaluated = { known: false };

/** Whether a value is a parsed node (an object with a `type`). @internal */
export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A readable description of a value, for the message. @internal */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "a function";
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return "an object";
  return JSON.stringify(value);
}

/** Equal as JSON data (the literals the entry writes are JSON-compatible, arrays of them included). @internal */
function sameValue(file: unknown, entry: unknown): boolean {
  return JSON.stringify(file) === JSON.stringify(entry);
}

/**
 * The value of a literal node: a string, number, boolean or `null`, a template without substitutions, a negative number,
 * or an array of scalar literals (nested arrays are not read). Anything else is unknown.
 * @internal
 */
function literalOf(node: Node): Evaluated {
  switch (node.type) {
    case "Literal": {
      if (node["regex"] !== undefined || node["bigint"] !== undefined) return UNKNOWN;
      return { known: true, value: node["value"] };
    }
    case "TemplateLiteral": {
      const expressions = node["expressions"];
      const quasis = node["quasis"];
      if (!Array.isArray(expressions) || expressions.length > 0) return UNKNOWN;
      if (!Array.isArray(quasis) || quasis.length !== 1) return UNKNOWN;
      const quasi: unknown = quasis[0];
      if (!isNode(quasi)) return UNKNOWN;
      const text = quasi["value"];
      if (typeof text !== "object" || text === null) return UNKNOWN;
      const cooked: unknown = Reflect.get(text, "cooked");
      return typeof cooked === "string" ? { known: true, value: cooked } : UNKNOWN;
    }
    case "UnaryExpression": {
      const argument = node["argument"];
      if (node["operator"] !== "-" || !isNode(argument) || argument.type !== "Literal") {
        return UNKNOWN;
      }
      const value = argument["value"];
      return typeof value === "number" ? { known: true, value: -value } : UNKNOWN;
    }
    case "ArrayExpression": {
      const elements = node["elements"];
      if (!Array.isArray(elements)) return UNKNOWN;
      const items: unknown[] = [];
      for (const element of elements) {
        if (!isNode(element) || element.type !== "Literal") return UNKNOWN;
        if (element["regex"] !== undefined || element["bigint"] !== undefined) return UNKNOWN;
        items.push(element["value"]);
      }
      return { known: true, value: items };
    }
    default:
      return UNKNOWN;
  }
}

/** The property key of an object literal entry, when it is a plain name or a string or number literal. @internal */
export function keyOf(property: Node): string | undefined {
  const key = property["key"];
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier" && property["computed"] !== true) return String(key["name"]);
  if (key.type === "Literal") {
    const value = key["value"];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
}

/**
 * The variables of the top-level scope, by name, when they hold an initializer. One level only: a name that refers to
 * another name is not followed.
 * @internal
 */
export function bindingsOf(statements: readonly unknown[]): Map<string, Node> {
  const bindings = new Map<string, Node>();
  for (const statement of statements) {
    const declaration = declarationOf(statement);
    if (declaration === undefined) continue;
    for (const declarator of declarationsOf(declaration)) {
      const id = declarator["id"];
      const init = declarator["init"];
      if (isNode(id) && id.type === "Identifier" && isNode(init)) {
        bindings.set(String(id["name"]), init);
      }
    }
  }
  return bindings;
}

/** The variable declaration a top-level statement holds (directly or as an export), if any. @internal */
export function declarationOf(statement: unknown): Node | undefined {
  if (!isNode(statement)) return undefined;
  if (statement.type === "VariableDeclaration") return statement;
  if (statement.type === "ExportNamedDeclaration") {
    const declaration = statement["declaration"];
    if (isNode(declaration) && declaration.type === "VariableDeclaration") return declaration;
  }
  return undefined;
}

/** The declarators of a variable declaration. @internal */
export function declarationsOf(declaration: Node): Node[] {
  const declarators = declaration["declarations"];
  if (!Array.isArray(declarators)) return [];
  return declarators.filter(isNode);
}

/** The entry's options object literal and the top-level bindings it may name. @internal */
interface EntryOptions {
  readonly root: Node;
  readonly bindings: ReadonlyMap<string, Node>;
}

/**
 * The entry's options object literal: `export const options = {...}`, else `export { x as options }`, else the default
 * export. A name is followed to its one initializer. `undefined` when none of them is an object literal.
 * @internal
 */
function entryOptionsOf(program: Node): EntryOptions | undefined {
  const body = program["body"];
  if (!Array.isArray(body)) return undefined;
  const bindings = bindingsOf(body);
  const resolve = (node: unknown): Node | undefined => {
    if (!isNode(node)) return undefined;
    const target = node.type === "Identifier" ? bindings.get(String(node["name"])) : node;
    return target !== undefined && target.type === "ObjectExpression" ? target : undefined;
  };
  let named: Node | undefined;
  let aliased: Node | undefined;
  let fallback: Node | undefined;
  for (const statement of body) {
    if (!isNode(statement)) continue;
    if (statement.type === "ExportDefaultDeclaration") fallback = resolve(statement["declaration"]);
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = declarationOf(statement);
    if (declaration !== undefined) {
      for (const declarator of declarationsOf(declaration)) {
        const id = declarator["id"];
        if (isNode(id) && id.type === "Identifier" && id["name"] === "options") {
          named = resolve(declarator["init"]);
        }
      }
    }
    const specifiers = statement["specifiers"];
    if (statement["source"] !== null && statement["source"] !== undefined) continue;
    if (!Array.isArray(specifiers)) continue;
    for (const specifier of specifiers) {
      if (!isNode(specifier)) continue;
      const exported = specifier["exported"];
      const exportedName = isNode(exported) ? String(exported["name"] ?? exported["value"]) : "";
      if (exportedName !== "options") continue;
      const local = specifier["local"];
      if (isNode(local)) aliased = resolve(local);
    }
  }
  const root = named ?? aliased ?? fallback;
  return root === undefined ? undefined : { root, bindings };
}

/** An object literal's own entries, with the key and the value node each one sets. @internal */
function entriesOf(object: Node): Array<{ key: string; value: Node }> {
  const entries: Array<{ key: string; value: Node }> = [];
  const properties = object["properties"];
  if (!Array.isArray(properties)) return entries;
  for (const property of properties) {
    // A spread brings keys the check cannot know; an accessor or a method is not a value.
    if (!isNode(property) || property.type !== "Property" || property["kind"] !== "init") continue;
    const key = keyOf(property);
    const value = property["value"];
    if (key === undefined || !isNode(value)) continue;
    entries.push({ key, value });
  }
  return entries;
}

/**
 * Leaf keys the file and the entry both set with different values.
 *
 * @param file The file's server options, as `serverOptionsFromConfig` returns them (`undefined`: no file).
 * @param code The entry's JavaScript (transpiled).
 * @returns The conflicts, in the order they are found. Empty when the entry has no options object or none conflicts.
 * @throws SyntaxError when `code` is not a module the parser accepts.
 * @example
 * optionConflicts({ security: { headers: { frameOptions: "DENY" } } }, 'export const options = { security: { headers: { frameOptions: "SAMEORIGIN" } } };');
 * // [{ path: "security.headers.frameOptions", fileValue: '"DENY"', entryValue: '"SAMEORIGIN"' }]
 * @since 1.0.0
 */
export function optionConflicts(
  file: Partial<HandlerOptions> | undefined,
  code: string,
): OptionConflict[] {
  if (file === undefined) return [];
  const program: unknown = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  if (!isNode(program)) return [];
  const entry = entryOptionsOf(program);
  if (entry === undefined) return [];
  const { bindings } = entry;
  const conflicts: OptionConflict[] = [];
  // Breadth first over the entry's object literals. Each queued item is an object the file also sets.
  const queue: Array<{ path: string; file: unknown; object: Node }> = [
    { path: "", file, object: entry.root },
  ];
  for (const current of queue) {
    if (typeof current.file !== "object" || current.file === null) continue;
    for (const { key, value: written } of entriesOf(current.object)) {
      const fileValue: unknown = Object.hasOwn(current.file, key)
        ? Reflect.get(current.file, key)
        : undefined;
      // The file does not set it: the entry only adds, and there is nothing to compare.
      if (fileValue === undefined) continue;
      const path = current.path === "" ? key : `${current.path}.${key}`;
      // A name the entry binds to a literal or an object is read through its initializer.
      const value =
        written.type === "Identifier"
          ? (bindings.get(String(written["name"])) ?? written)
          : written;
      if (value.type === "ObjectExpression") {
        if (isPlainObject(fileValue)) queue.push({ path, file: fileValue, object: value });
        else conflicts.push({ path, fileValue: describe(fileValue), entryValue: "an object" });
        continue;
      }
      const evaluated = literalOf(value);
      if (!evaluated.known) continue;
      if (isPlainObject(fileValue) || !sameValue(fileValue, evaluated.value)) {
        conflicts.push({
          path,
          fileValue: describe(fileValue),
          entryValue: describe(evaluated.value),
        });
      }
    }
  }
  return conflicts;
}

/**
 * The warning for one conflict: the leaf, both values, and which one is in force.
 *
 * @param conflict The conflict.
 * @param entryFile The entry's path as the message shows it (`src/entry-server.ts`).
 * @returns One line.
 * @example optionConflictMessage(conflict, "src/entry-server.ts");
 * @since 1.0.0
 */
export function optionConflictMessage(conflict: OptionConflict, entryFile: string): string {
  return `dusk: ${conflict.path} is set in dusk.config.ts (${conflict.fileValue}) and in ${entryFile} (${conflict.entryValue}). ${entryFile} wins; keep one of the two, or set the same value in both.`;
}
