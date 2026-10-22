/**
 * What the build reads from the server entry (`src/entry-server.ts`) to decide how each prerendered page is answered (B2).
 *
 * The handler is built from `dusk.config.ts` merged with the entry's options (`mergeHandlerOptions`: the entry wins), so
 * a decision that reads only the file can be wrong: a host rewrite in the entry's global `middleware`, or a CSP in its
 * `security`, changes what `/` answers. The entry is read, never run:
 * - `middleware`: a global middleware runs for every request, so every page is handler-rendered; an empty array (or none)
 *   runs nothing;
 * - `security.headers` and `security.csp` are read as data: a static file's headers come from them;
 * - `routing` and `trustedOrigins` are read as data (the rules, and the origins they may name);
 * - any other key does not change a static file's answer and is not read (a secret, the host list, a limit).
 * A value the build cannot evaluate (a call, an import, a computed key, a spread that may bring a rule) makes every page
 * handler-rendered: a bare file is served only when the build can see that nothing at request time changes it.
 *
 * @packageDocumentation
 */

import { readFileSync } from "node:fs";
import { parse } from "acorn";
import type { HandlerOptions } from "../server/types";
import { transformSource } from "./compat";
import {
  bindingsOf,
  declarationOf,
  declarationsOf,
  type EntryNode,
  isNode,
  keyOf,
} from "./option-conflicts";

/** What the build read of the entry for the static decision. @internal */
export interface EntryStaticReading {
  /** The options the entry sets that decide a static page's answer, as literal data (the keys the build could read). */
  readonly options: Partial<HandlerOptions>;
  /** Why every prerendered page is handler-rendered, or `undefined` when the entry is read in full. */
  readonly reason: string | undefined;
  /**
   * The entry's `security.allowedHosts` as a literal list, when the entry sets one the build can read. The host list does
   * not decide a static page, so it is read on its own and never makes a page handler-rendered; only the platform host
   * routes (see `AdapterContext.allowedHosts`) use it.
   */
  readonly hosts?: readonly string[] | undefined;
  /**
   * Why the entry's host list is not known to the build (a value it cannot read, or an entry it cannot read at all), or
   * `undefined`. The platform host routes are not written then.
   */
  readonly hostsReason?: string | undefined;
}

/** A value the build evaluated, or `known: false` for one it cannot. @internal */
type Evaluated = { readonly known: true; readonly value: unknown } | { readonly known: false };

const UNKNOWN: Evaluated = { known: false };

/** The nodes one value may hold; a larger one is not read, and the decision falls back to the handler. @internal */
const MAX_NODES = 10_000;

/** The names one value may chain through (`const a = b; const b = {...}`). A cycle stops here. @internal */
const MAX_HOPS = 4;

/** The option keys that decide a static page's answer. Any other key is not read. @internal */
const RELEVANT_KEYS: ReadonlySet<string> = new Set([
  "middleware",
  "security",
  "routing",
  "trustedOrigins",
  "runMiddlewareForStaticFiles",
]);

/** The security keys a static file's headers come from. @internal */
const HEADER_KEYS: ReadonlySet<string> = new Set(["headers", "csp"]);

/** One piece of the iterative evaluation: a node, the names it chained through, and where its value goes. @internal */
interface Step {
  readonly node: EntryNode;
  readonly hops: number;
  readonly done: (value: Evaluated) => void;
}

/** A property the reader can take the key and value of: a plain `key: value` (no spread, no method, no accessor). @internal */
function isPlainProperty(value: unknown): value is EntryNode {
  return (
    isNode(value) &&
    value.type === "Property" &&
    value["kind"] === "init" &&
    value["method"] !== true
  );
}

/**
 * The node a name refers to, when the top level binds it once (one level). Any other node is returned as it is.
 * @internal
 */
function resolveName(node: EntryNode, bindings: ReadonlyMap<string, EntryNode>): EntryNode {
  if (node.type !== "Identifier") return node;
  return bindings.get(String(node["name"])) ?? node;
}

/**
 * The value of a template literal without substitutions, or unknown.
 * @internal
 */
function templateOf(node: EntryNode): Evaluated {
  const expressions = node["expressions"];
  const quasis = node["quasis"];
  if (!Array.isArray(expressions) || expressions.length > 0) return UNKNOWN;
  if (!Array.isArray(quasis) || quasis.length !== 1) return UNKNOWN;
  const quasi: unknown = quasis[0];
  if (!isNode(quasi)) return UNKNOWN;
  const text: unknown = quasi["value"];
  const cooked: unknown =
    typeof text === "object" && text !== null ? Reflect.get(text, "cooked") : undefined;
  return typeof cooked === "string" ? { known: true, value: cooked } : UNKNOWN;
}

/**
 * A negative number literal, or unknown.
 * @internal
 */
function negativeOf(node: EntryNode): Evaluated {
  const argument = node["argument"];
  if (node["operator"] !== "-" || !isNode(argument) || argument.type !== "Literal") return UNKNOWN;
  const value = argument["value"];
  return typeof value === "number" ? { known: true, value: -value } : UNKNOWN;
}

/**
 * Queues the children of a container and calls `finish` once every one has a value. The children are evaluated by the
 * caller's loop (an explicit stack), so the nesting of the entry never becomes recursion.
 * @internal
 */
function fanOut(
  children: readonly EntryNode[],
  hops: number,
  work: Step[],
  finish: (values: readonly Evaluated[]) => void,
): void {
  const values: Evaluated[] = children.map(() => UNKNOWN);
  let pending = children.length;
  if (pending === 0) {
    finish(values);
    return;
  }
  children.forEach((child, index) => {
    work.push({
      node: child,
      hops,
      done: (value) => {
        values[index] = value;
        pending -= 1;
        if (pending === 0) finish(values);
      },
    });
  });
}

/**
 * The literal value of a node: a string, number, boolean, `null`, the name `undefined`, or an array or object of those,
 * through names the top level binds. Anything else (a call, a member read, an arrow function, a spread) is unknown.
 * The walk keeps an explicit stack, so the depth of the entry's nesting is not a recursion.
 * @internal
 */
function evaluateLiteral(root: EntryNode, bindings: ReadonlyMap<string, EntryNode>): Evaluated {
  const result: { value: Evaluated | undefined } = { value: undefined };
  const work: Step[] = [{ node: root, hops: 0, done: (value) => (result.value = value) }];
  let visited = 0;
  for (let step = work.pop(); step !== undefined; step = work.pop()) {
    visited += 1;
    if (visited > MAX_NODES) return UNKNOWN;
    const { node, hops, done } = step;
    switch (node.type) {
      case "Literal":
        done(
          node["regex"] !== undefined || node["bigint"] !== undefined
            ? UNKNOWN
            : { known: true, value: node["value"] },
        );
        break;
      case "TemplateLiteral":
        done(templateOf(node));
        break;
      case "UnaryExpression":
        done(negativeOf(node));
        break;
      case "Identifier": {
        const name = String(node["name"]);
        const binding = bindings.get(name);
        if (binding === undefined) {
          done(name === "undefined" ? { known: true, value: undefined } : UNKNOWN);
        } else if (hops < MAX_HOPS) {
          work.push({ node: binding, hops: hops + 1, done });
        } else {
          done(UNKNOWN);
        }
        break;
      }
      case "ArrayExpression": {
        const elements = node["elements"];
        const list: readonly unknown[] = Array.isArray(elements) ? elements : [];
        // A hole (`null`) or a spread is not a value the build can list.
        if (list.some((element) => !isNode(element) || element.type === "SpreadElement")) {
          done(UNKNOWN);
          break;
        }
        const children = list.filter(isNode);
        fanOut(children, hops, work, (values) => {
          if (values.some((value) => !value.known)) done(UNKNOWN);
          else
            done({
              known: true,
              value: values.map((value) => (value.known ? value.value : undefined)),
            });
        });
        break;
      }
      case "ObjectExpression": {
        const properties = node["properties"];
        const list: readonly unknown[] = Array.isArray(properties) ? properties : [];
        const keys: string[] = [];
        const children: EntryNode[] = [];
        let plain = true;
        for (const property of list) {
          if (!isPlainProperty(property)) {
            plain = false;
            break;
          }
          const key = keyOf(property);
          const value = property["value"];
          if (key === undefined || !isNode(value)) {
            plain = false;
            break;
          }
          keys.push(key);
          children.push(value);
        }
        if (!plain) {
          done(UNKNOWN);
          break;
        }
        fanOut(children, hops, work, (values) => {
          if (values.some((value) => !value.known)) {
            done(UNKNOWN);
            return;
          }
          // A null-prototype object: a key such as `__proto__` is data here, not a prototype.
          const object: Record<string, unknown> = Object.create(null);
          keys.forEach((key, index) => {
            const value = values[index];
            object[key] = value?.known === true ? value.value : undefined;
          });
          done({ known: true, value: object });
        });
        break;
      }
      default:
        done(UNKNOWN);
        break;
    }
  }
  return result.value ?? UNKNOWN;
}

/** The name at the root of a member chain (`a.b["c"]` is `a`), or undefined for anything else. @internal */
function rootNameOf(node: unknown): string | undefined {
  let current: unknown = node;
  // A member chain is bounded by the nodes the entry holds; the loop is iterative all the same.
  for (let hops = 0; hops < MAX_NODES && isNode(current); hops += 1) {
    if (current.type === "Identifier") return String(current["name"]);
    if (current.type !== "MemberExpression") return undefined;
    current = current["object"];
  }
  return undefined;
}

/**
 * Whether the module changes a bound object or array after it is declared: an assignment, an update or a `delete` on it
 * (`options.middleware = [...]`), or a call that receives it (`Object.assign(options, ...)`). The reader sees the
 * declaration only, so such a change would make the literal read wrong; the build then cannot read the entry.
 * @internal
 */
function changesBound(body: readonly unknown[], bindings: ReadonlyMap<string, EntryNode>): boolean {
  const guarded = new Set<string>();
  for (const [name, init] of bindings) {
    if (init.type === "ObjectExpression" || init.type === "ArrayExpression") guarded.add(name);
  }
  if (guarded.size === 0) return false;
  const stack: unknown[] = [...body];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!isNode(node)) continue;
    const root =
      node.type === "AssignmentExpression"
        ? rootNameOf(node["left"])
        : node.type === "UpdateExpression"
          ? rootNameOf(node["argument"])
          : node.type === "UnaryExpression" && node["operator"] === "delete"
            ? rootNameOf(node["argument"])
            : undefined;
    if (root !== undefined && guarded.has(root)) return true;
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const args = node["arguments"];
      const passed = Array.isArray(args) ? args : [];
      if (
        passed.some(
          (arg) => isNode(arg) && arg.type === "Identifier" && guarded.has(String(arg["name"])),
        )
      ) {
        return true;
      }
    }
    for (const child of Object.values(node)) {
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
  return false;
}

/** Where the entry's options object is: a literal, none at all, or something the build cannot read. @internal */
type Located =
  | { readonly kind: "absent" }
  | { readonly kind: "object"; readonly node: EntryNode }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * The options object of the entry, as the handler reads it: `export const options`, else `export { x as options }`,
 * else the default export. No export of either is "absent" (the handler gets no entry options).
 * @internal
 */
function locateOptions(
  body: readonly unknown[],
  bindings: ReadonlyMap<string, EntryNode>,
  shown: string,
): Located {
  let namedSeen = false;
  let named: EntryNode | undefined;
  let aliased: EntryNode | undefined;
  let defaultSeen = false;
  let fallback: EntryNode | undefined;
  let starSeen = false;
  for (const statement of body) {
    if (!isNode(statement)) continue;
    if (statement.type === "ExportAllDeclaration") starSeen = true;
    if (statement.type === "ExportDefaultDeclaration") {
      defaultSeen = true;
      const declaration = statement["declaration"];
      fallback = isNode(declaration) ? declaration : undefined;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = declarationOf(statement);
    if (declaration !== undefined) {
      for (const declarator of declarationsOf(declaration)) {
        const id = declarator["id"];
        if (isNode(id) && id.type === "Identifier" && id["name"] === "options") {
          namedSeen = true;
          const init = declarator["init"];
          named = isNode(init) ? init : undefined;
        }
      }
    }
    const specifiers = statement["specifiers"];
    if (!Array.isArray(specifiers)) continue;
    for (const specifier of specifiers) {
      if (!isNode(specifier)) continue;
      const exported = specifier["exported"];
      const name = isNode(exported) ? String(exported["name"] ?? exported["value"]) : "";
      if (name !== "options") continue;
      if (statement["source"] !== null && statement["source"] !== undefined) {
        return {
          kind: "unreadable",
          reason: `${shown} re-exports its options from another module`,
        };
      }
      namedSeen = true;
      const local = specifier["local"];
      aliased = isNode(local) ? local : undefined;
    }
  }
  if (namedSeen) return objectOf(named ?? aliased, bindings, shown);
  if (defaultSeen) return objectOf(fallback, bindings, shown);
  if (starSeen) {
    return {
      kind: "unreadable",
      reason: `${shown} re-exports other modules (export *), so its options cannot be read`,
    };
  }
  return { kind: "absent" };
}

/** The object literal an options export names, or why it cannot be read. @internal */
function objectOf(
  node: EntryNode | undefined,
  bindings: ReadonlyMap<string, EntryNode>,
  shown: string,
): Located {
  const target = node === undefined ? undefined : resolveName(node, bindings);
  if (target?.type === "ObjectExpression") return { kind: "object", node: target };
  return {
    kind: "unreadable",
    reason: `${shown} exports options the build cannot read as an object literal`,
  };
}

/** The `middleware` value: a reason when a global middleware may run, or undefined when none can. @internal */
function middlewareReason(value: EntryNode, shown: string): string | undefined {
  if (value.type === "Literal" && value["value"] === null) return undefined;
  if (value.type === "Identifier" && value["name"] === "undefined") return undefined;
  if (value.type === "ArrayExpression") {
    const elements = value["elements"];
    if (Array.isArray(elements) && elements.length === 0) return undefined;
    return `${shown} sets a global middleware (options.middleware), which runs for every request`;
  }
  return `${shown} sets options.middleware to a value the build cannot read`;
}

/**
 * The `security` options a static file's headers come from (`headers` and `csp`), as data. Any other security key is not
 * read. A spread or a computed key could bring one of them, so it is a reason.
 * @internal
 */
function securityOf(
  value: EntryNode,
  bindings: ReadonlyMap<string, EntryNode>,
  shown: string,
): Record<string, unknown> | string {
  if (value.type !== "ObjectExpression")
    return `${shown} sets options.security to a value the build cannot read`;
  const properties = value["properties"];
  const list: readonly unknown[] = Array.isArray(properties) ? properties : [];
  const security: Record<string, unknown> = {};
  for (const property of list) {
    if (!isNode(property) || property.type === "SpreadElement") {
      return `${shown} spreads options.security, so the build cannot read its headers or csp`;
    }
    if (property.type !== "Property") continue;
    const key = keyOf(property);
    if (key === undefined)
      return `${shown} computes a key of options.security, so the build cannot read its headers or csp`;
    if (!HEADER_KEYS.has(key)) continue;
    if (!isPlainProperty(property))
      return `${shown} sets options.security.${key} with an accessor or a method`;
    const raw = property["value"];
    const evaluated = isNode(raw) ? evaluateLiteral(resolveName(raw, bindings), bindings) : UNKNOWN;
    if (!evaluated.known)
      return `${shown} sets options.security.${key} to a value the build cannot read`;
    security[key] = evaluated.value;
  }
  return security;
}

/**
 * Reads the options object of the entry: the keys that decide a static page, or the reason the build cannot.
 * @internal
 */
function readOptionsObject(
  root: EntryNode,
  bindings: ReadonlyMap<string, EntryNode>,
  shown: string,
): EntryStaticReading {
  const properties = root["properties"];
  const list: readonly unknown[] = Array.isArray(properties) ? properties : [];
  const options: Record<string, unknown> = {};
  const unread = (reason: string): EntryStaticReading => ({ options: {}, reason });
  // A global middleware makes every page handler-rendered (the reason), but it does not hide the other keys: the file gate
  // flag (`runMiddlewareForStaticFiles`) is read whatever the middleware says, so the Worker's build matches the handler.
  let middlewareReasonSeen: string | undefined;
  for (const property of list) {
    if (!isNode(property)) continue;
    if (property.type === "SpreadElement") {
      return unread(
        `${shown} spreads its options, so the build cannot read whether they set a rule`,
      );
    }
    if (property.type !== "Property") continue;
    const key = keyOf(property);
    if (key === undefined)
      return unread(`${shown} computes a key of its options, so the build cannot read them`);
    if (!RELEVANT_KEYS.has(key)) continue;
    if (!isPlainProperty(property))
      return unread(`${shown} sets options.${key} with an accessor or a method`);
    const raw = property["value"];
    if (!isNode(raw))
      return unread(`${shown} sets options.${key} to a value the build cannot read`);
    const value = resolveName(raw, bindings);
    if (key === "middleware") {
      const reason = middlewareReason(value, shown);
      if (reason !== undefined) middlewareReasonSeen ??= reason;
    } else if (key === "security") {
      const security = securityOf(value, bindings, shown);
      if (typeof security === "string") return unread(security);
      options["security"] = security;
    } else {
      const evaluated = evaluateLiteral(value, bindings);
      if (!evaluated.known)
        return unread(`${shown} sets options.${key} to a value the build cannot read`);
      options[key] = evaluated.value;
    }
  }
  return { options: options as Partial<HandlerOptions>, reason: middlewareReasonSeen };
}

/**
 * Reads the entry's source (transpiled JavaScript): the options that decide static pages, or the reason every page is
 * handler-rendered. Nothing is run. A parse error is thrown; the caller decides (see {@link readEntryStaticOptions}).
 *
 * @param code The entry's JavaScript.
 * @param shown The entry's path as the reasons name it (`src/entry-server.ts`).
 * @returns The reading.
 * @throws SyntaxError when `code` is not a module the parser accepts.
 * @example readEntryStatic(`export const options = { middleware: [] };`).reason; // undefined
 * @internal
 */
export function readEntryStatic(code: string, shown = "src/entry-server.ts"): EntryStaticReading {
  const program: unknown = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const body: readonly unknown[] =
    isNode(program) && Array.isArray(program["body"]) ? program["body"] : [];
  const bindings = bindingsOf(body);
  const located = locateOptions(body, bindings, shown);
  if (located.kind === "absent") return { options: {}, reason: undefined };
  if (located.kind === "unreadable") {
    return { options: {}, reason: located.reason, hostsReason: located.reason };
  }
  if (changesBound(body, bindings)) {
    const reason = `${shown} changes an object or array it declares (an assignment, a delete or a call with it), so the build cannot read its options`;
    return { options: {}, reason, hostsReason: reason };
  }
  const hosts = hostsOf(located.node, bindings, shown);
  return { ...readOptionsObject(located.node, bindings, shown), ...hosts };
}

/**
 * The entry's `security.allowedHosts`, read on its own so that a global middleware (which makes the page decision read
 * nothing else) does not hide it. A literal list is `hosts`; a value the build cannot read, a spread or a computed key in
 * `security` is `hostsReason`; no `security.allowedHosts` at all is neither (the dusk config's list stands).
 * @internal
 */
function hostsOf(
  root: EntryNode,
  bindings: ReadonlyMap<string, EntryNode>,
  shown: string,
): { readonly hosts?: readonly string[] | undefined; readonly hostsReason?: string | undefined } {
  const properties = root["properties"];
  const list: readonly unknown[] = Array.isArray(properties) ? properties : [];
  for (const property of list) {
    if (!isNode(property)) continue;
    if (property.type === "SpreadElement") {
      return {
        hostsReason: `${shown} spreads its options, so the build cannot read its host list`,
      };
    }
    if (property.type !== "Property") continue;
    const key = keyOf(property);
    if (key === undefined) {
      return {
        hostsReason: `${shown} computes a key of its options, so the build cannot read its host list`,
      };
    }
    if (key !== "security") continue;
    const raw = property["value"];
    if (!isPlainProperty(property) || !isNode(raw)) {
      return { hostsReason: `${shown} sets options.security to a value the build cannot read` };
    }
    const value = resolveName(raw, bindings);
    if (value.type !== "ObjectExpression") {
      return { hostsReason: `${shown} sets options.security to a value the build cannot read` };
    }
    const members: readonly unknown[] = Array.isArray(value["properties"])
      ? value["properties"]
      : [];
    for (const member of members) {
      if (!isNode(member) || member.type === "SpreadElement") {
        return {
          hostsReason: `${shown} spreads options.security, so the build cannot read its host list`,
        };
      }
      if (member.type !== "Property") continue;
      const memberKey = keyOf(member);
      if (memberKey === undefined) {
        return {
          hostsReason: `${shown} computes a key of options.security, so the build cannot read its host list`,
        };
      }
      if (memberKey !== "allowedHosts") continue;
      const hostsRaw = member["value"];
      const evaluated = isNode(hostsRaw)
        ? evaluateLiteral(resolveName(hostsRaw, bindings), bindings)
        : UNKNOWN;
      const list: unknown = evaluated.known ? evaluated.value : undefined;
      if (
        !isPlainProperty(member) ||
        !Array.isArray(list) ||
        !list.every((host) => typeof host === "string")
      ) {
        return {
          hostsReason: `${shown} sets options.security.allowedHosts to a value the build cannot read`,
        };
      }
      return { hosts: list as readonly string[] };
    }
  }
  return {};
}

/**
 * Reads the entry file of the project for the static decision. A file the build cannot transpile or parse is a reason too:
 * every page is then handler-rendered, which is always correct.
 *
 * @param entryFile The entry's absolute path, or `undefined` when the project has none.
 * @param shown The entry's path as the reasons name it.
 * @returns The reading.
 * @internal
 */
export async function readEntryStaticOptions(
  entryFile: string | undefined,
  shown: string,
): Promise<EntryStaticReading> {
  if (entryFile === undefined) return { options: {}, reason: undefined };
  try {
    const { code } = await transformSource(readFileSync(entryFile, "utf8"), entryFile);
    return readEntryStatic(code, shown);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const reason = `${shown} could not be read (${why})`;
    return { options: {}, reason, hostsReason: reason };
  }
}
