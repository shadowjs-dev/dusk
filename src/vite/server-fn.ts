import { relative } from "node:path";
import {
  type AstNode,
  codeFrame,
  collectUnits,
  findCaptures,
  freeReferences,
  identifierName,
  isNode,
  lineColumn,
  ModuleParseError,
  nodesAt,
  type ParsedModule,
  parseModule,
  pruneModule,
  stringValue,
  unwrapExpression,
  walkTree,
} from "@shadow-js/router/vite";
import MagicString from "magic-string";
import { fnId } from "./ids";

/**
 * The server-function transform. A server function is written as `serverFn(options, handler)` in
 * an exported binding, or as an async function with a `"use server"` directive (at the top of the
 * module, or as the first statement of the function). The same source is compiled twice:
 *
 * - **server**: kept as written, except that the directive forms are rewritten to `serverFn(...)`
 *   registrations. Nothing is removed.
 * - **client**: every server function becomes a stub that calls `POST {base}/_dusk/fn/<id>`. The
 *   handler, the input schema, the middleware and every import and declaration that only they
 *   needed are removed, so server-only code never reaches a client bundle.
 *
 * The transform reads and edits the syntax tree. Names are resolved through the module's imports
 * and scopes, never by text, so a local function that happens to be called `serverFn` is left alone.
 */

const SERVER_MODULE = "@shadow-js/dusk/server";
const CLIENT_MODULE = "@shadow-js/dusk/client";
const DIRECTIVE = "use server";

/** Diagnostics of the transform. @since 1.0.0 */
export type ServerFnIssueCode =
  | "SERVER_FN_NOT_EXPORTED"
  | "SERVER_FN_OPTIONS_NOT_STATIC"
  | "SERVER_FN_CLOSURE_CAPTURE"
  | "SERVER_FN_NOT_ASYNC"
  | "SERVER_FN_DIRECTIVE_MISPLACED"
  | "SERVER_FN_DIRECTIVE_EXPORT"
  | "SERVER_FN_ID_COLLISION";

/**
 * A problem in a server function, with the position in the file and a code frame.
 * @example
 * import { ServerFnError } from "@shadow-js/dusk/vite";
 * new ServerFnError("SERVER_FN_NOT_ASYNC", "a server function must be async", "src/api.ts", 3, 1, "").code; // "SERVER_FN_NOT_ASYNC"
 * @since 1.0.0
 */
export class ServerFnError extends Error {
  readonly code: ServerFnIssueCode;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly frame: string;

  constructor(
    code: ServerFnIssueCode,
    message: string,
    file: string,
    line: number,
    column: number,
    frame: string,
  ) {
    super(`[${code}] ${file}:${line}:${column}: ${message}\n${frame}`);
    this.name = "ServerFnError";
    this.code = code;
    this.file = file;
    this.line = line;
    this.column = column;
    this.frame = frame;
  }
}

/** A server function found in a module. @since 1.0.0 */
export interface ServerFnInfo {
  /** Name of the export that holds it (`default` for the default export). */
  readonly exportName: string;
  /** Stable id: see {@link fnId}. */
  readonly id: string;
  readonly method: "GET" | "POST";
  /** Whether the function also accepts HTML form posts. */
  readonly form: boolean;
  /** Whether the browser stub may send this call in a batch (default true). */
  readonly batch: boolean;
  /** Whether the response carries the refreshed loader data of the current route. */
  readonly singleFlight: boolean;
  /** Whether an AsyncIterable is delivered as typed SSE items. */
  readonly stream?: true;
  /** How it was written. */
  readonly origin: "serverFn" | "directive-file" | "directive-function";
  /** 1-based line of the definition. */
  readonly line: number;
}

/** Options of {@link transformServerFns}. @since 1.0.0 */
export interface ServerFnTransformOptions {
  /** Module text. */
  readonly code: string;
  /** Absolute file path. */
  readonly file: string;
  /** Project root: ids hash the path relative to it. */
  readonly root: string;
  /** `"client"` stubs the functions out, `"server"` keeps them, `"analyze"` only lists them. */
  readonly target: "client" | "server" | "analyze";
  /** Mount base of the app without a trailing slash. Default `""`. */
  readonly base?: string;
}

/** Outcome of {@link transformServerFns}. @since 1.0.0 */
export interface ServerFnTransformResult {
  /** The new text; equals the input when nothing changed. */
  readonly code: string;
  readonly map: ReturnType<MagicString["generateMap"]> | null;
  readonly changed: boolean;
  /** The server functions of the module. */
  readonly fns: readonly ServerFnInfo[];
  /** Sources of side-effect imports that stayed in a client module (they run for their effects). */
  readonly sideEffectImports: readonly string[];
}

interface Binding {
  readonly source: string;
  /** Imported name, `*` for a namespace import, `default` for a default import. */
  readonly imported: string;
}

/** An exported `serverFn(...)` call. */
interface CallDefinition {
  readonly exportName: string;
  readonly call: AstNode;
  readonly method: "GET" | "POST";
  readonly form: boolean;
  readonly batch: boolean;
  readonly singleFlight: boolean;
  readonly stream?: true;
}

/** An exported function that is a server function because of a directive. */
interface ExportedFunction {
  readonly exportName: string;
  /** Local name the function is reachable by, if it has one. */
  readonly localName: string | undefined;
  readonly fn: AstNode;
  /** The statement to rewrite (the whole export statement or the declaration). */
  readonly statement: AstNode;
  /** For `export const a = ..., b = ...`: the declarator; otherwise the same as `statement`. */
  readonly declarator: AstNode | undefined;
  readonly kind: "declaration" | "declarator" | "default-declaration" | "default-expression";
}

/** A function with a directive somewhere inside the module, hoisted to a module-level export. */
interface HoistedFunction {
  readonly fn: AstNode;
  readonly statement: AstNode;
  readonly ordinal: number;
  readonly exportName: string;
  /** Local name of a declaration (`async function save() {}`), if any. */
  readonly declarationName: string | undefined;
  /** The statement that holds the function when it is a declaration statement. */
  readonly declarationStatement: AstNode | undefined;
}

function fail(
  code: ServerFnIssueCode,
  message: string,
  parsed: ParsedModule,
  node: AstNode,
): ServerFnError {
  const { line, column } = lineColumn(parsed.source, node.start);
  return new ServerFnError(
    code,
    message,
    parsed.filename,
    line,
    column,
    codeFrame(parsed.source, node.start),
  );
}

function collectImports(body: readonly AstNode[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration" || statement["importKind"] === "type") continue;
    const source = statement["source"];
    if (!isNode(source) || typeof source["value"] !== "string") continue;
    for (const specifier of nodesAt(statement, "specifiers")) {
      if (specifier["importKind"] === "type") continue;
      const local = identifierName(specifier["local"]);
      if (local === undefined) continue;
      if (specifier.type === "ImportNamespaceSpecifier") {
        bindings.set(local, { source: source["value"], imported: "*" });
      } else if (specifier.type === "ImportDefaultSpecifier") {
        bindings.set(local, { source: source["value"], imported: "default" });
      } else {
        const imported = specifier["imported"];
        const name =
          identifierName(imported) ??
          (isNode(imported) && typeof imported["value"] === "string"
            ? imported["value"]
            : undefined);
        if (name !== undefined) bindings.set(local, { source: source["value"], imported: name });
      }
    }
  }
  return bindings;
}

/** The identifier a `serverFn` callee starts from, when it is the server module's `serverFn`. */
function serverFnRoot(callee: AstNode, imports: ReadonlyMap<string, Binding>): string | undefined {
  const target = unwrapExpression(callee);
  if (target.type === "Identifier") {
    const name = identifierName(target);
    const binding = name === undefined ? undefined : imports.get(name);
    return name !== undefined &&
      binding?.source === SERVER_MODULE &&
      binding.imported === "serverFn"
      ? name
      : undefined;
  }
  if (target.type === "MemberExpression" && target["computed"] !== true) {
    const object = target["object"];
    const property = identifierName(target["property"]);
    const name = isNode(object) ? identifierName(object) : undefined;
    const binding = name === undefined ? undefined : imports.get(name);
    return name !== undefined &&
      property === "serverFn" &&
      binding?.source === SERVER_MODULE &&
      binding.imported === "*"
      ? name
      : undefined;
  }
  return undefined;
}

function isServerFnCall(node: AstNode, imports: ReadonlyMap<string, Binding>): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node["callee"];
  return isNode(callee) && serverFnRoot(callee, imports) !== undefined;
}

function readStaticOptions(
  call: AstNode,
  parsed: ParsedModule,
): { method: "GET" | "POST"; form: boolean; batch: boolean; singleFlight: boolean; stream?: true } {
  let method: "GET" | "POST" = "POST";
  let form = false;
  let batch: boolean | undefined;
  let singleFlight = false;
  let stream = false;
  let cacheControl = false;
  const options = nodesAt(call, "arguments")[0];
  if (options === undefined) return { method, form, batch: true, singleFlight };
  if (options.type !== "ObjectExpression") {
    throw fail(
      "SERVER_FN_OPTIONS_NOT_STATIC",
      "serverFn() options must be an object literal",
      parsed,
      options,
    );
  }
  for (const property of nodesAt(options, "properties")) {
    if (property.type !== "Property" || property["computed"] === true) {
      throw fail(
        "SERVER_FN_OPTIONS_NOT_STATIC",
        "serverFn() options must be plain `key: value` properties (no spread, no computed keys)",
        parsed,
        property,
      );
    }
    const key = property["key"];
    const name = identifierName(key) ?? (isNode(key) ? stringValue(key) : undefined);
    if (name === "cacheControl") cacheControl = true;
    const value = property["value"];
    if (
      name === "method" ||
      name === "form" ||
      name === "batch" ||
      name === "singleFlight" ||
      name === "stream"
    ) {
      const inner = isNode(value) ? unwrapExpression(value) : undefined;
      if (name === "method") {
        const text = inner === undefined ? undefined : stringValue(inner);
        if (text !== "GET" && text !== "POST") {
          throw fail(
            "SERVER_FN_OPTIONS_NOT_STATIC",
            '`method` must be the literal "GET" or "POST"',
            parsed,
            property,
          );
        }
        method = text;
      } else {
        if (
          inner === undefined ||
          inner.type !== "Literal" ||
          typeof inner["value"] !== "boolean"
        ) {
          throw fail(
            "SERVER_FN_OPTIONS_NOT_STATIC",
            `\`${name}\` must be the literal true or false`,
            parsed,
            property,
          );
        }
        if (name === "form") form = inner["value"];
        else if (name === "batch") {
          batch = inner["value"];
        } else if (name === "stream") stream = inner["value"];
        else singleFlight = inner["value"];
      }
    }
  }
  if (stream && (form || singleFlight || batch === true || cacheControl)) {
    throw fail("SERVER_FN_OPTIONS_NOT_STATIC", "stream options are incompatible", parsed, options);
  }
  return {
    method,
    form,
    batch: stream ? false : (batch ?? true),
    singleFlight,
    ...(stream ? { stream: true as const } : {}),
  };
}

function directiveOf(body: readonly AstNode[]): boolean {
  for (const statement of body) {
    const directive = statement["directive"];
    if (typeof directive !== "string") return false;
    if (directive === DIRECTIVE) return true;
  }
  return false;
}

function functionBodyStatements(fn: AstNode): readonly AstNode[] {
  const body = fn["body"];
  return isNode(body) && body.type === "BlockStatement" ? nodesAt(body, "body") : [];
}

function isFunction(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** True when `this` is read in an arrow function outside any function of its own (a capture). */
function readsOuterThis(fn: AstNode): boolean {
  if (fn.type !== "ArrowFunctionExpression") return false;
  let found = false;
  walkTree(fn, (node) => {
    if (found) return false;
    if (
      node !== fn &&
      (node.type === "FunctionExpression" || node.type === "FunctionDeclaration")
    ) {
      return false;
    }
    if (node.type === "ThisExpression" || node.type === "Super") {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function assertAsyncFunction(fn: AstNode, parsed: ParsedModule, what: string): void {
  if (fn["async"] !== true) {
    throw fail("SERVER_FN_NOT_ASYNC", `${what} must be an async function`, parsed, fn);
  }
  if (fn["generator"] === true) {
    throw fail("SERVER_FN_NOT_ASYNC", `${what} cannot be a generator`, parsed, fn);
  }
}

/** The async function an exported binding stands for, or undefined. */
function functionOf(node: AstNode | undefined): AstNode | undefined {
  if (node === undefined) return undefined;
  const inner = unwrapExpression(node);
  return inner.type === "ArrowFunctionExpression" || inner.type === "FunctionExpression"
    ? inner
    : undefined;
}

/**
 * Finds the server functions of a module and, for the `client` and `server` targets, rewrites it.
 *
 * @param options The module, its place in the project and the target.
 * @returns The new text and the list of server functions, or `null` for a module with none.
 * @throws ServerFnError for a server function that cannot be compiled: options the build cannot
 *   read, a function that is not exported, a `"use server"` function that captures local variables.
 * @throws ModuleParseError for a syntax error.
 * @example
 * const result = transformServerFns({ code, file, root, target: "client" });
 * result?.fns.map((fn) => fn.id);
 * @since 1.0.0
 */
export function transformServerFns(
  options: ServerFnTransformOptions,
): ServerFnTransformResult | null {
  const { code, file, root, target } = options;
  const base = options.base ?? "";
  // Cheap exit: a module that mentions neither form cannot contain a server function.
  if (!code.includes("serverFn") && !code.includes(DIRECTIVE)) return null;
  const parsed = parseModule(code, file);
  const imports = collectImports(parsed.body);
  const relativePath = relative(root, file).split("\\").join("/");
  const idOf = (exportName: string): string => fnId(relativePath, exportName);
  const lineOf = (node: AstNode): number => lineColumn(code, node.start).line;

  const fileDirective = directiveOf(parsed.body);

  // ---- serverFn(...) calls ------------------------------------------------------------------
  const calls: CallDefinition[] = [];
  const localCalls = new Map<
    string,
    {
      call: AstNode;
      method: "GET" | "POST";
      form: boolean;
      batch: boolean;
      singleFlight: boolean;
      stream?: true;
    }
  >();
  const handled = new Set<AstNode>();
  if (!fileDirective) {
    for (const statement of parsed.body) {
      if (statement.type === "ExportDefaultDeclaration") {
        const declaration = statement["declaration"];
        const inner = isNode(declaration) ? unwrapExpression(declaration) : undefined;
        if (inner !== undefined && isServerFnCall(inner, imports)) {
          const found = readStaticOptions(inner, parsed);
          calls.push({ exportName: "default", call: inner, ...found });
          handled.add(inner);
        }
        continue;
      }
      const exported = statement.type === "ExportNamedDeclaration";
      const declaration = exported ? statement["declaration"] : statement;
      if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue;
      for (const declarator of nodesAt(declaration, "declarations")) {
        const init = declarator["init"];
        const inner = isNode(init) ? unwrapExpression(init) : undefined;
        if (inner === undefined || !isServerFnCall(inner, imports)) continue;
        const name = identifierName(declarator["id"]);
        if (name === undefined) {
          throw fail(
            "SERVER_FN_NOT_EXPORTED",
            "a server function must be bound to a plain name (no destructuring)",
            parsed,
            declarator,
          );
        }
        const found = readStaticOptions(inner, parsed);
        handled.add(inner);
        if (exported) calls.push({ exportName: name, call: inner, ...found });
        else localCalls.set(name, { call: inner, ...found });
      }
    }
    // `const f = serverFn(...); export { f, f as g }`
    for (const statement of parsed.body) {
      if (statement.type !== "ExportNamedDeclaration" || isNode(statement["declaration"])) continue;
      if (isNode(statement["source"])) continue;
      for (const specifier of nodesAt(statement, "specifiers")) {
        const local = identifierName(specifier["local"]);
        const exportedName = identifierName(specifier["exported"]);
        const entry = local === undefined ? undefined : localCalls.get(local);
        if (entry !== undefined && exportedName !== undefined) {
          calls.push({ exportName: exportedName, ...entry });
        }
      }
    }
    const exportedLocals = new Set<AstNode>(calls.map((entry) => entry.call));
    for (const [name, entry] of localCalls) {
      if (!exportedLocals.has(entry.call)) {
        throw fail(
          "SERVER_FN_NOT_EXPORTED",
          `"${name}" is a server function but is not exported, so the build cannot register it; export it`,
          parsed,
          entry.call,
        );
      }
    }
    // Any other `serverFn(...)`: inside a function, an argument, an expression.
    for (const statement of parsed.body) {
      freeReferences(statement, "expr", (node, isLocal) => {
        if (node.type !== "CallExpression" || handled.has(node)) return false;
        const callee = node["callee"];
        const root_ = isNode(callee) ? serverFnRoot(callee, imports) : undefined;
        if (root_ !== undefined && !isLocal(root_)) {
          throw fail(
            "SERVER_FN_NOT_EXPORTED",
            "serverFn() must initialize an exported binding at the top level of a module (`export const name = serverFn(...)`)",
            parsed,
            node,
          );
        }
        return false;
      });
    }
  }

  // ---- "use server" ------------------------------------------------------------------------
  const exportedFunctions: ExportedFunction[] = [];
  const hoisted: HoistedFunction[] = [];
  const unitsForDirectives =
    fileDirective || code.includes(DIRECTIVE) ? collectUnits(parsed) : undefined;

  if (fileDirective) {
    for (const statement of parsed.body) {
      const directive = statement["directive"];
      if (typeof directive === "string") continue;
      const type = statement.type;
      if (type === "ExportNamedDeclaration") {
        if (statement["exportKind"] === "type") continue;
        const declaration = statement["declaration"];
        if (isNode(declaration)) {
          if (
            declaration.type === "TSInterfaceDeclaration" ||
            declaration.type === "TSTypeAliasDeclaration"
          ) {
            continue;
          }
          if (declaration.type === "FunctionDeclaration") {
            assertAsyncFunction(declaration, parsed, 'an export of a "use server" module');
            const name = identifierName(declaration["id"]);
            if (name === undefined)
              throw fail("SERVER_FN_DIRECTIVE_EXPORT", "unnamed export", parsed, declaration);
            exportedFunctions.push({
              exportName: name,
              localName: name,
              fn: declaration,
              statement,
              declarator: undefined,
              kind: "declaration",
            });
          } else if (declaration.type === "VariableDeclaration") {
            for (const declarator of nodesAt(declaration, "declarations")) {
              const name = identifierName(declarator["id"]);
              const init = declarator["init"];
              const fn = functionOf(isNode(init) ? init : undefined);
              if (name === undefined || fn === undefined) {
                throw fail(
                  "SERVER_FN_DIRECTIVE_EXPORT",
                  'every export of a "use server" module must be an async function',
                  parsed,
                  declarator,
                );
              }
              assertAsyncFunction(fn, parsed, 'an export of a "use server" module');
              exportedFunctions.push({
                exportName: name,
                localName: name,
                fn,
                statement,
                declarator,
                kind: "declarator",
              });
            }
          } else {
            throw fail(
              "SERVER_FN_DIRECTIVE_EXPORT",
              'every export of a "use server" module must be an async function',
              parsed,
              declaration,
            );
          }
        } else {
          if (isNode(statement["source"])) {
            throw fail(
              "SERVER_FN_DIRECTIVE_EXPORT",
              'a "use server" module cannot re-export from another module',
              parsed,
              statement,
            );
          }
          for (const specifier of nodesAt(statement, "specifiers")) {
            if (specifier["exportKind"] === "type") continue;
            const local = identifierName(specifier["local"]);
            const exportedName = identifierName(specifier["exported"]);
            const unit = unitsForDirectives?.declaredBy.get(local ?? "")?.[0];
            let fn: AstNode | undefined;
            if (
              unit !== undefined &&
              unit.kind === "declaration" &&
              unit.statement.type === "FunctionDeclaration"
            ) {
              fn = unit.statement;
            } else if (unit !== undefined && unit.kind === "declarator") {
              const init = unit.node["init"];
              fn = functionOf(isNode(init) ? init : undefined);
            }
            if (local === undefined || exportedName === undefined || fn === undefined) {
              throw fail(
                "SERVER_FN_DIRECTIVE_EXPORT",
                'every export of a "use server" module must be an async function',
                parsed,
                specifier,
              );
            }
            assertAsyncFunction(fn, parsed, 'an export of a "use server" module');
            exportedFunctions.push({
              exportName: exportedName,
              localName: local,
              fn,
              statement,
              declarator: specifier,
              kind: "declarator",
            });
          }
        }
      } else if (type === "ExportDefaultDeclaration") {
        const declaration = statement["declaration"];
        if (!isNode(declaration)) continue;
        const fn =
          declaration.type === "FunctionDeclaration" ? declaration : functionOf(declaration);
        if (fn === undefined) {
          throw fail(
            "SERVER_FN_DIRECTIVE_EXPORT",
            'every export of a "use server" module must be an async function',
            parsed,
            declaration,
          );
        }
        assertAsyncFunction(fn, parsed, 'an export of a "use server" module');
        exportedFunctions.push({
          exportName: "default",
          localName: identifierName(fn["id"]),
          fn,
          statement,
          declarator: undefined,
          kind:
            declaration.type === "FunctionDeclaration"
              ? "default-declaration"
              : "default-expression",
        });
      } else if (type === "ExportAllDeclaration") {
        throw fail(
          "SERVER_FN_DIRECTIVE_EXPORT",
          'a "use server" module cannot re-export from another module',
          parsed,
          statement,
        );
      }
    }
  } else if (code.includes(DIRECTIVE)) {
    let ordinal = 0;
    for (const statement of parsed.body) {
      walkTree(statement, (node, parent, key) => {
        if (!isFunction(node)) return undefined;
        if (!directiveOf(functionBodyStatements(node))) return undefined;
        const parentType = parent?.type;
        if (
          parentType === "MethodDefinition" ||
          parentType === "AccessorProperty" ||
          (parentType === "Property" &&
            (parent?.["method"] === true || parent?.["kind"] !== "init")) ||
          (parentType === "PropertyDefinition" && key === "value")
        ) {
          throw fail(
            "SERVER_FN_DIRECTIVE_MISPLACED",
            '"use server" works on functions that are declared, assigned or passed, not on methods or class fields',
            parsed,
            node,
          );
        }
        assertAsyncFunction(node, parsed, 'a function with "use server"');
        // A top-level exported function is a server function under its own export name.
        if (statement.type === "ExportNamedDeclaration" && statement["declaration"] === node) {
          const name = identifierName(node["id"]);
          if (name !== undefined) {
            exportedFunctions.push({
              exportName: name,
              localName: name,
              fn: node,
              statement,
              declarator: undefined,
              kind: "declaration",
            });
            return false;
          }
        }
        if (statement.type === "ExportNamedDeclaration") {
          const declaration = statement["declaration"];
          if (isNode(declaration) && declaration.type === "VariableDeclaration") {
            for (const declarator of nodesAt(declaration, "declarations")) {
              const init = declarator["init"];
              if (isNode(init) && functionOf(init) === node) {
                const name = identifierName(declarator["id"]);
                if (name !== undefined) {
                  exportedFunctions.push({
                    exportName: name,
                    localName: name,
                    fn: node,
                    statement,
                    declarator,
                    kind: "declarator",
                  });
                  return false;
                }
              }
            }
          }
        }
        if (statement.type === "ExportDefaultDeclaration" && statement["declaration"] === node) {
          exportedFunctions.push({
            exportName: "default",
            localName: identifierName(node["id"]),
            fn: node,
            statement,
            declarator: undefined,
            kind:
              node.type === "FunctionDeclaration" ? "default-declaration" : "default-expression",
          });
          return false;
        }
        const captured = findCaptures(statement, node);
        if (readsOuterThis(node)) captured.push("this");
        if (captured.length > 0) {
          throw fail(
            "SERVER_FN_CLOSURE_CAPTURE",
            `a function with "use server" cannot use variables from the enclosing function: ${captured.join(", ")}. Pass them as arguments instead.`,
            parsed,
            node,
          );
        }
        const isDeclaration = node.type === "FunctionDeclaration";
        hoisted.push({
          fn: node,
          statement,
          ordinal,
          exportName: `$$server_${ordinal}`,
          declarationName: isDeclaration ? identifierName(node["id"]) : undefined,
          declarationStatement: isDeclaration ? node : undefined,
        });
        ordinal += 1;
        return false;
      });
    }
  }

  // ---- result list --------------------------------------------------------------------------
  const fns: ServerFnInfo[] = [];
  for (const entry of calls) {
    fns.push({
      exportName: entry.exportName,
      id: idOf(entry.exportName),
      method: entry.method,
      form: entry.form,
      batch: entry.batch,
      singleFlight: entry.singleFlight,
      ...(entry.stream === true ? { stream: true as const } : {}),
      origin: "serverFn",
      line: lineOf(entry.call),
    });
  }
  for (const entry of exportedFunctions) {
    fns.push({
      exportName: entry.exportName,
      id: idOf(entry.exportName),
      method: "POST",
      form: false,
      batch: true,
      singleFlight: false,
      origin: fileDirective ? "directive-file" : "directive-function",
      line: lineOf(entry.fn),
    });
  }
  for (const entry of hoisted) {
    fns.push({
      exportName: entry.exportName,
      id: idOf(entry.exportName),
      method: "POST",
      form: false,
      batch: true,
      singleFlight: false,
      origin: "directive-function",
      line: lineOf(entry.fn),
    });
  }
  if (fns.length === 0) return null;
  const seen = new Map<string, string>();
  for (const fn of fns) {
    const previous = seen.get(fn.id);
    if (previous !== undefined) {
      throw new ServerFnError(
        "SERVER_FN_ID_COLLISION",
        `"${relativePath}#${fn.exportName}" and "${previous}" have the same id ${fn.id}`,
        file,
        fn.line,
        0,
        "",
      );
    }
    seen.set(fn.id, `${relativePath}#${fn.exportName}`);
  }
  if (target === "analyze") {
    return { code, map: null, changed: false, fns, sideEffectImports: [] };
  }

  const stubMeta = (info: ServerFnInfo): string =>
    `$$server${info.stream === true ? "Stream" : "Fn"}Stub(${JSON.stringify(info.id)}, { method: ${JSON.stringify(info.method)}, form: ${info.form}, base: ${JSON.stringify(base)}, batch: ${info.batch}, singleFlight: ${info.singleFlight} })`;
  const infoOf = (exportName: string): ServerFnInfo => {
    const found = fns.find((entry) => entry.exportName === exportName);
    if (found === undefined) throw new Error(`server function "${exportName}" vanished`);
    return found;
  };

  if (target === "client") {
    return transformClient({
      parsed,
      calls,
      exportedFunctions,
      hoisted,
      fileDirective,
      fns,
      stubMeta,
      infoOf,
    });
  }
  return transformServer({ parsed, calls, exportedFunctions, hoisted, fileDirective, fns, base });
}

interface ClientInput {
  readonly parsed: ParsedModule;
  readonly calls: readonly CallDefinition[];
  readonly exportedFunctions: readonly ExportedFunction[];
  readonly hoisted: readonly HoistedFunction[];
  readonly fileDirective: boolean;
  readonly fns: readonly ServerFnInfo[];
  readonly stubMeta: (info: ServerFnInfo) => string;
  readonly infoOf: (exportName: string) => ServerFnInfo;
}

const CLIENT_IMPORT = `import { serverFnStub as $$serverFnStub } from ${JSON.stringify(CLIENT_MODULE)};\n`;

function transformClient(input: ClientInput): ServerFnTransformResult {
  const { parsed, calls, exportedFunctions, hoisted, fileDirective, fns, stubMeta, infoOf } = input;
  const clientImport =
    CLIENT_IMPORT +
    (fns.some((fn) => fn.stream === true)
      ? 'import { serverStreamStub as $$serverStreamStub } from "@shadow-js/dusk/client/stream";\n'
      : "");
  if (fileDirective) {
    // The whole module is the server's: the client gets one stub per export and nothing else.
    const lines = [clientImport.trimEnd()];
    const names: string[] = [];
    for (const entry of exportedFunctions) {
      const info = infoOf(entry.exportName);
      if (entry.exportName === "default") {
        lines.push(`export default ${stubMeta(info)};`);
      } else if (!names.includes(entry.exportName)) {
        names.push(entry.exportName);
        lines.push(`export const ${entry.exportName} = ${stubMeta(info)};`);
      }
    }
    return { code: `${lines.join("\n")}\n`, map: null, changed: true, fns, sideEffectImports: [] };
  }

  const replacements: { start: number; end: number; text: string }[] = [];
  const skip = new Set<AstNode>();
  const replace = (node: AstNode, text: string, start = node.start, end = node.end): void => {
    replacements.push({ start, end, text });
    skip.add(node);
  };
  // A replaced function's body is not code of the client: what it reads must not keep anything.
  for (const entry of exportedFunctions) skip.add(entry.fn);

  for (const entry of calls) replace(entry.call, stubMeta(infoOf(entry.exportName)));
  for (const entry of exportedFunctions) {
    const info = infoOf(entry.exportName);
    const stub = stubMeta(info);
    switch (entry.kind) {
      case "declaration": {
        replace(entry.statement, `export const ${entry.exportName} = ${stub};`);
        break;
      }
      case "declarator":
        replace(entry.fn, stub);
        break;
      case "default-declaration":
      case "default-expression":
        replace(entry.statement, `export default ${stub};`);
        break;
    }
  }
  for (const entry of hoisted) {
    const info = infoOf(entry.exportName);
    if (entry.declarationStatement !== undefined && entry.declarationName !== undefined) {
      replace(entry.declarationStatement, `const ${entry.declarationName} = ${stubMeta(info)};`);
    } else {
      replace(entry.fn, stubMeta(info));
    }
  }

  const result = pruneModule(parsed, {
    skip,
    replacements,
    prepend: clientImport,
  });
  return {
    code: result.code,
    map: result.map,
    changed: true,
    fns,
    sideEffectImports: result.sideEffectImports,
  };
}

interface ServerInput {
  readonly parsed: ParsedModule;
  readonly calls: readonly CallDefinition[];
  readonly exportedFunctions: readonly ExportedFunction[];
  readonly hoisted: readonly HoistedFunction[];
  readonly fileDirective: boolean;
  readonly fns: readonly ServerFnInfo[];
  readonly base: string;
}

function transformServer(input: ServerInput): ServerFnTransformResult {
  const { parsed, calls, exportedFunctions, hoisted, fileDirective, fns, base } = input;
  const code = parsed.source;
  const magic = new MagicString(code);
  const appended: string[] = [];
  const idOf = (exportName: string): string => {
    const found = fns.find((entry) => entry.exportName === exportName);
    if (found === undefined) throw new Error(`server function "${exportName}" vanished`);
    return found.id;
  };
  /** Wraps a definition so the function carries the id and url of its browser stub. */
  const bound = (definition: string, exportName: string): string =>
    `$$bindServerFn(${definition}, ${JSON.stringify(idOf(exportName))}, ${JSON.stringify(base)})`;
  const usesDirective = exportedFunctions.length > 0 || hoisted.length > 0;

  // `serverFn(...)` calls run as written, inside the binding. A call exported under two names
  // (`export { f, f as g }`) is one function: it takes the id of its first export.
  const wrapped = new Set<AstNode>();
  for (const entry of calls) {
    if (wrapped.has(entry.call)) continue;
    wrapped.add(entry.call);
    magic.appendLeft(entry.call.start, "$$bindServerFn(");
    magic.appendRight(
      entry.call.end,
      `, ${JSON.stringify(idOf(entry.exportName))}, ${JSON.stringify(base)})`,
    );
  }

  const define = (exportName: string, handlerRef: string): void => {
    const local = `$$def_${exportName === "default" ? "default" : exportName}`;
    appended.push(
      `const ${local} = ${bound(`$$serverFn({ method: "POST" }, ${handlerRef})`, exportName)};`,
    );
    appended.push(`export { ${local} as ${exportName === "default" ? "default" : exportName} };`);
  };

  const handledStatements = new Set<AstNode>();
  for (const entry of exportedFunctions) {
    switch (entry.kind) {
      case "declaration": {
        // `export async function f() {}` -> `async function f() {}` + a definition exported as f.
        magic.remove(entry.statement.start, (entry.statement["declaration"] as AstNode).start);
        define(entry.exportName, entry.localName ?? entry.exportName);
        break;
      }
      case "declarator": {
        if (entry.statement["declaration"] !== null && isNode(entry.statement["declaration"])) {
          if (!handledStatements.has(entry.statement)) {
            const declaration = entry.statement["declaration"];
            magic.remove(entry.statement.start, declaration.start);
            handledStatements.add(entry.statement);
          }
          define(entry.exportName, entry.localName ?? entry.exportName);
        } else {
          // `export { f, g as h }`: drop the statement, export definitions instead.
          if (!handledStatements.has(entry.statement)) {
            magic.remove(entry.statement.start, entry.statement.end);
            handledStatements.add(entry.statement);
          }
          define(entry.exportName, entry.localName ?? entry.exportName);
        }
        break;
      }
      case "default-declaration": {
        const declaration = entry.statement["declaration"] as AstNode;
        if (entry.localName !== undefined) {
          magic.remove(entry.statement.start, declaration.start);
          define("default", entry.localName);
        } else {
          magic.overwrite(entry.statement.start, declaration.start, "const $$default_fn = ");
          magic.appendLeft(entry.statement.end, ";");
          define("default", "$$default_fn");
        }
        break;
      }
      case "default-expression": {
        const declaration = entry.statement["declaration"] as AstNode;
        magic.overwrite(entry.statement.start, declaration.start, "const $$default_fn = ");
        magic.appendLeft(entry.statement.end, ";");
        define("default", "$$default_fn");
        break;
      }
    }
  }

  if (fileDirective) {
    for (const statement of parsed.body) {
      if (statement["directive"] === DIRECTIVE) magic.remove(statement.start, statement.end);
    }
  }

  // Inserted in reverse so that the definitions read in source order.
  for (const entry of [...hoisted].reverse()) {
    const text = code.slice(entry.fn.start, entry.fn.end);
    magic.prependLeft(
      entry.statement.start,
      `export const ${entry.exportName} = ${bound(`$$serverFn({ method: "POST" }, ${text})`, entry.exportName)};\n`,
    );
    if (entry.declarationStatement !== undefined && entry.declarationName !== undefined) {
      magic.overwrite(
        entry.declarationStatement.start,
        entry.declarationStatement.end,
        `const ${entry.declarationName} = ${entry.exportName};`,
      );
    } else {
      magic.overwrite(entry.fn.start, entry.fn.end, entry.exportName);
    }
  }

  const imports = usesDirective
    ? "bindServerFn as $$bindServerFn, serverFn as $$serverFn"
    : "bindServerFn as $$bindServerFn";
  magic.prepend(`import { ${imports} } from ${JSON.stringify(SERVER_MODULE)};\n`);
  if (appended.length > 0) magic.append(`\n${appended.join("\n")}\n`);
  return {
    code: magic.toString(),
    map: magic.generateMap({ source: parsed.filename, hires: "boundary", includeContent: true }),
    changed: true,
    fns,
    sideEffectImports: [],
  };
}

export { ModuleParseError };
