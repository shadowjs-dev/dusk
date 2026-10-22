import type { RouteDefinition } from "@shadow-js/router";
import {
  notFound,
  parsePattern,
  type RouteMatcher,
  type RouteVisibility,
} from "@shadow-js/router/core";
import type { RouteSpec } from "./runtime";
import type { DuskRuntimeManifest } from "./types";

/**
 * `export const dynamicParams = false`: the server answers not found for a param the page's `prerender` export does
 * not list. This module decides, for a request, whether its params are listed. It is loaded on the first request to
 * such a page, so an app that never sets `dynamicParams = false` does not carry it on the request path.
 *
 * The export is read the way the build reads it. A list of paths (`["/posts/1", "/posts/2"]`) names the whole path of
 * each page. A function receives the params of the layouts above the page and returns the params of the page, and the
 * layouts' own functions feed it first (`resolvePrerenderTargets` in `vite/build.ts` does the same at build time).
 * The result is read once per process in production, and for every request in development, where the file changes.
 */

/** Where the `prerender` export of a route is loaded from: one entry of the server entry's `prerenderRoutes`. @internal */
export interface PrerenderSource {
  readonly id: string;
  /** Loads the export: a list, a function, a boolean, or anything else (which is refused). */
  load(): Promise<unknown>;
}

/** Answers whether a page's params are listed. @internal */
export interface ParamsGate {
  /**
   * Whether `params` (all the params of the request's match) are among the params the page lists.
   * @throws TypeError when the page's `prerender` export has the wrong form, or whatever its function throws.
   */
  allows(id: string, params: Readonly<Record<string, string | undefined>>): Promise<boolean>;
  /**
   * Runs a page's own `beforeLoad` (`user`, when it has one) after the check: params the page does not list are not
   * found, as if a loader had thrown `notFound()`.
   * @throws NotFoundSignal when the params are not listed.
   */
  guard<A extends { readonly params: Readonly<Record<string, string | undefined>> }, R>(
    id: string,
    args: A,
    user: ((args: A) => R) | undefined,
  ): Promise<R | undefined>;
  /**
   * Whether the page a path matches sets `dynamicParams = false` and its params are not listed. A shell page has no
   * router run, so the server asks this before it answers one.
   */
  refuses(path: string, visibility: RouteVisibility): Promise<boolean>;
}

type ParamSet = Readonly<Record<string, string>>;
type PrerenderFunction = (args: { readonly params: ParamSet }) => unknown;

/** The listed param sets of one page, grouped by the names they carry: a set of keys for each group. */
interface Listed {
  readonly groups: readonly {
    readonly names: readonly string[];
    readonly keys: ReadonlySet<string>;
  }[];
}

function isParamObject(value: unknown): value is Readonly<Record<string, string | undefined>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((item) => item === undefined || typeof item === "string");
}

function keyOf(names: readonly string[], params: Readonly<Record<string, string | undefined>>) {
  return JSON.stringify(names.map((name) => params[name] ?? ""));
}

/** The names of the params in a route's own (relative) path. */
function ownNames(spec: RouteSpec): string[] {
  return parsePattern(spec.path).segments.flatMap((segment) =>
    segment.kind === "static" ? [] : [segment.name],
  );
}

/** The ids of the routes above `id`, outermost first. */
function ancestorsOf(routes: readonly RouteDefinition[], id: string): string[] | undefined {
  const walk = (
    list: readonly RouteDefinition[],
    trail: readonly string[],
  ): string[] | undefined => {
    for (const route of list) {
      if (route.id === id) return [...trail];
      const found = walk(route.spec.children, [...trail, route.id]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(routes, []);
}

/**
 * Creates the gate of a handler.
 *
 * @param tree The wrapped route tree and the spec of every route by id: layouts above a page are found through it.
 * @param matcher The page matcher, to read the params of a listed path.
 * @param config The handler's configuration: the manifest's `prerenderRoutes` (the `prerender` export of each route
 *   that has one) and whether it runs in development, where nothing is kept between requests.
 * @returns The gate.
 * @throws TypeError when a page sets `dynamicParams = false` and has no entry: the server could not tell a listed
 *   param from another.
 * @internal
 */
export function createParamsGate(
  tree: {
    readonly routes: readonly RouteDefinition[];
    readonly specs: ReadonlyMap<string, RouteSpec>;
  },
  matcher: RouteMatcher,
  config: {
    readonly dev: boolean;
    readonly manifest: Pick<DuskRuntimeManifest, "prerenderRoutes">;
  },
): ParamsGate {
  const dev = config.dev;
  const sources = new Map(
    (config.manifest.prerenderRoutes ?? []).map((entry) => [entry.id, entry] as const),
  );
  for (const [id, spec] of tree.specs) {
    if (spec.dynamicParams === false && !sources.has(id)) {
      throw new TypeError(
        `route "${id}" sets dynamicParams = false, but manifest.prerenderRoutes has no entry for it, so the server cannot tell which params are listed; the server entry passes the prerender export of each route there`,
      );
    }
  }
  /** Only a settled success is kept: a failed read is tried again by the next request. */
  const kept = new Map<string, Promise<Listed>>();

  const expand = async (
    id: string,
    parents: readonly ParamSet[],
    run: PrerenderFunction,
  ): Promise<ParamSet[]> => {
    const out: ParamSet[] = [];
    const seen = new Set<string>();
    for (const parent of parents) {
      const returned: unknown = await run({ params: { ...parent } });
      if (!Array.isArray(returned)) {
        throw new TypeError(
          `route "${id}": its prerender function must return an array of param objects, like [{ id: "1" }]`,
        );
      }
      for (const item of returned) {
        if (!isParamObject(item)) {
          throw new TypeError(
            `route "${id}": its prerender function must return an array of param objects, like [{ id: "1" }]`,
          );
        }
        const merged: Record<string, string> = { ...parent };
        for (const [name, value] of Object.entries(item)) {
          if (value !== undefined) merged[name] = value;
        }
        const key = JSON.stringify(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(merged);
      }
    }
    return out;
  };

  const read = async (id: string): Promise<Listed> => {
    const source = sources.get(id);
    if (source === undefined) {
      throw new TypeError(
        `route "${id}" sets dynamicParams = false but has no prerender export to read`,
      );
    }
    const value = await source.load();
    const names = (() => {
      const spec = tree.specs.get(id);
      return spec === undefined ? [] : ownNames(spec);
    })();
    let sets: ParamSet[] = [];
    if (Array.isArray(value)) {
      for (const path of value) {
        if (typeof path !== "string") continue;
        const chain = matcher.match(matcher.addBase(path), "all");
        const leaf = chain[chain.length - 1];
        // A path that is not this page's is not listed for it.
        if (leaf?.id === id) sets.push(leaf.params as ParamSet);
      }
    } else if (typeof value === "function") {
      sets = [{}];
      for (const above of ancestorsOf(tree.routes, id) ?? []) {
        if (!sources.has(above)) continue;
        const layer = await sources.get(above)?.load();
        if (typeof layer === "function")
          sets = await expand(above, sets, layer as PrerenderFunction);
      }
      sets = await expand(id, sets, value as PrerenderFunction);
    } else {
      throw new TypeError(
        `route "${id}": the prerender export must be a list of paths or a function that returns the params, not ${value === null ? "null" : typeof value}`,
      );
    }
    const groups = new Map<string, { names: string[]; keys: Set<string> }>();
    for (const set of sets) {
      const carried = [
        ...new Set([...Object.keys(set).filter((name) => set[name] !== ""), ...names]),
      ].sort();
      const signature = carried.join("\u0000");
      let group = groups.get(signature);
      if (group === undefined) {
        group = { names: carried, keys: new Set() };
        groups.set(signature, group);
      }
      group.keys.add(keyOf(carried, set));
    }
    return { groups: [...groups.values()] };
  };

  const listedFor = (id: string): Promise<Listed> => {
    if (dev) return read(id);
    const existing = kept.get(id);
    if (existing !== undefined) return existing;
    const pending = read(id);
    kept.set(id, pending);
    pending.catch(() => {
      if (kept.get(id) === pending) kept.delete(id);
    });
    return pending;
  };

  const allows = async (
    id: string,
    params: Readonly<Record<string, string | undefined>>,
  ): Promise<boolean> => {
    const listed = await listedFor(id);
    return listed.groups.some((group) => group.keys.has(keyOf(group.names, params)));
  };
  return {
    allows,
    async guard(id, args, user) {
      if (!(await allows(id, args.params))) throw notFound();
      return user?.(args);
    },
    async refuses(path, visibility): Promise<boolean> {
      const chain = matcher.match(path, visibility);
      const leaf = chain[chain.length - 1];
      if (leaf === undefined || tree.specs.get(leaf.id)?.dynamicParams !== false) return false;
      return !(await allows(leaf.id, leaf.params));
    },
  };
}
