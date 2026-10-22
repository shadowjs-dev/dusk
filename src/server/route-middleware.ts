import { HttpError } from "../internal/http-error";
import type { Middleware, MiddlewareModule, RouteMiddlewareManifest } from "./types";

/** Longest query string a gate request may carry (bounded, like every request input). */
const GATE_SEARCH_LIMIT = 2048;

/**
 * The target of a gate request: its app path and its query string (`search`, `""` or starting with `?`).
 * The path is checked by {@link gatePathOf}; the search may not hold control characters, a fragment or a
 * backslash, and is bounded.
 *
 * @param body The parsed JSON body (`{ path, search? }`).
 * @returns The path and the search.
 * @throws HttpError 400 for anything else.
 * @internal
 */
export function gateTargetOf(body: unknown): { readonly path: string; readonly search: string } {
  const path = gatePathOf(body);
  const raw = typeof body === "object" && body !== null ? Reflect.get(body, "search") : undefined;
  if (raw === undefined) return { path, search: "" };
  if (typeof raw !== "string" || raw.length > GATE_SEARCH_LIMIT)
    throw new HttpError(400, "Bad Request");
  if (raw !== "" && !raw.startsWith("?")) throw new HttpError(400, "Bad Request");
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || raw[index] === "\\" || raw[index] === "#") {
      throw new HttpError(400, "Bad Request");
    }
  }
  return { path, search: raw };
}

/**
 * The pathname of a gate request, checked: an app path, not a URL (no scheme, no host, no query or fragment,
 * no backslash, no control characters). Anything else is a 400.
 *
 * @param body The parsed JSON body.
 * @returns The path.
 * @throws HttpError 400 for anything else.
 * @internal
 */
export function gatePathOf(body: unknown): string {
  const path = typeof body === "object" && body !== null ? Reflect.get(body, "path") : undefined;
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new HttpError(400, "Bad Request");
  }
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    const bad =
      code < 0x20 ||
      code === 0x7f ||
      path[index] === "\\" ||
      path[index] === "?" ||
      path[index] === "#";
    if (bad) throw new HttpError(400, "Bad Request");
  }
  return path;
}

/**
 * The server-only middleware of the routes: which of it applies to a request, in the order it runs.
 *
 * For a page, the chain is: the `_middleware` folders above the matched page (outermost first), then
 * the `middleware` export of each matched route (the root layout first, the page last). For an API
 * route, the `_middleware` folders above it run before the route module's own `middleware` (the API
 * module runs that itself). Handler-wide middleware is outside all of this.
 *
 * @internal
 */

/** A matched route: its id, as the matcher reports it. */
export interface MatchedRoute {
  readonly id: string;
}

/** A load that resolved to something that is not a middleware list. */
function notAList(where: string): TypeError {
  return new TypeError(
    `${where}: the \`middleware\` export must be an array of middleware functions.`,
  );
}

/**
 * Loads a module's `middleware` export and checks it is an array of functions.
 * @internal
 */
async function loadList(
  module: MiddlewareModule | undefined,
  where: string,
): Promise<Middleware[]> {
  if (module === undefined) throw new TypeError(`${where}: no middleware module is registered.`);
  const value = await module.load();
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "function")) {
    throw notAList(where);
  }
  return [...(value as readonly Middleware[])];
}

/** Loads the middleware of a list of folders, outermost first. @internal */
export async function folderChain(
  manifest: RouteMiddlewareManifest,
  folders: readonly string[],
): Promise<Middleware[]> {
  const out: Middleware[] = [];
  for (const folder of folders) {
    const label = folder === "" ? "the routes folder" : `folder "${folder}"`;
    out.push(...(await loadList(manifest.directories[folder], `_middleware in ${label}`)));
  }
  return out;
}

/**
 * True when a page request whose matched chain is `chain` runs any server middleware. Such a page is
 * never answered from the ISR cache: a cached answer would skip the check for a request that lacks what
 * the middleware looks at.
 *
 * @param manifest The middleware manifest, if the build emitted one.
 * @param chain The matched route chain (outermost first).
 * @returns Whether middleware applies.
 * @internal
 */
export function hasPageMiddleware(
  manifest: RouteMiddlewareManifest | undefined,
  chain: readonly MatchedRoute[],
): boolean {
  if (manifest === undefined || chain.length === 0) return false;
  for (const route of chain) {
    if (manifest.routes[route.id] !== undefined) return true;
  }
  const leaf = chain[chain.length - 1];
  return leaf !== undefined && (manifest.pages[leaf.id]?.length ?? 0) > 0;
}

/**
 * The middleware of a page request, in run order (see the module comment).
 *
 * @param manifest The middleware manifest, if any.
 * @param chain The matched route chain (outermost first).
 * @returns The middleware to run; empty when none applies.
 * @throws TypeError when a registered module does not export a middleware list.
 * @internal
 */
export async function pageMiddlewareFor(
  manifest: RouteMiddlewareManifest | undefined,
  chain: readonly MatchedRoute[],
): Promise<Middleware[]> {
  if (manifest === undefined || chain.length === 0) return [];
  const leaf = chain[chain.length - 1];
  const folders = leaf === undefined ? [] : (manifest.pages[leaf.id] ?? []);
  const out = await folderChain(manifest, folders);
  for (const route of chain) {
    const module = manifest.routes[route.id];
    if (module !== undefined) out.push(...(await loadList(module, `route "${route.id}"`)));
  }
  return out;
}
