import type { RouteDefinition } from "@shadow-js/router";
import type { RouteDefinition as CoreRoute, RedirectSignal } from "@shadow-js/router/core";
import { HttpError, isHttpError } from "../internal/http-error";
import { isNotFound, isRedirect } from "../internal/redirect";
import { attachDigest, errorDigest } from "./digest";
import type { ParamsGate } from "./dynamic-params";
import type { Observation } from "./observe";
import type { RouteSpec } from "./runtime";
import type { RequestEvent } from "./types";

/**
 * What the page pipeline needs to learn from the router's callbacks. `beforeLoad` and loaders run
 * deep inside the router, which follows redirects and turns loader errors into data; the handler
 * must still answer with the right HTTP status. Each route is wrapped once, at startup, and the
 * wrapper finds the request through the router `context` (`context.event`).
 */

/** Per-request record filled by the wrapped routes. @internal */
export interface PageState {
  /** The first redirect any `beforeLoad` or loader asked for. */
  redirect: RedirectSignal | undefined;
  /** Unexpected errors thrown by `beforeLoad` and loaders, in order. */
  readonly failures: unknown[];
  /** The observation of the request: each loader runs in a child span (see `observe.ts`). */
  readonly obs: Pick<Observation, "run"> | undefined;
}

const states = new WeakMap<object, { readonly state: PageState; readonly event: RequestEvent }>();

/**
 * Creates the page state of a request and associates it with the event.
 * @internal
 */
export function openPageState(event: RequestEvent, obs?: Pick<Observation, "run">): PageState {
  const state: PageState = { redirect: undefined, failures: [], obs };
  states.set(event, { state, event });
  return state;
}

/** The state of the request the callback runs for, found through `context.event`. */
function entryOf(
  context: Readonly<Record<string, unknown>>,
): { readonly state: PageState; readonly event: RequestEvent } | undefined {
  const event = context["event"];
  return typeof event === "object" && event !== null ? states.get(event) : undefined;
}

function stateOf(context: Readonly<Record<string, unknown>>): PageState | undefined {
  return entryOf(context)?.state;
}

/** What the wrappers need from the runtime. @internal */
export interface WrapHooks {
  readonly dev: boolean;
  /** `shown` is the error handed to the router instead of `error`; it counts as reported too. */
  report(error: unknown, event: RequestEvent | undefined, shown: unknown): void;
  /**
   * The gate that tells whether the params of a request are among those a page lists (see `dynamic-params.ts`). A page
   * that sets `dynamicParams = false` is not found when they are not. Absent: no page is checked.
   */
  readonly paramsGate?: () => Promise<ParamsGate>;
}

/**
 * The error to hand to the router. In development it is the original, with its digest (see `attachDigest`). In production
 * anything that is not an {@link HttpError} meant for the client becomes a generic 500, so neither the rendered
 * error component nor the hydration data can leak a message such as a database error. That public
 * error carries the `digest` of the original (see `errorDigest`), which the server's log line prints too.
 * @internal
 */
export function publicError(error: unknown, dev: boolean): unknown {
  // The digest of a development error is attached only in a development build (`__DEV__`): production never carries it.
  if (dev) return __DEV__ ? attachDigest(error) : error;
  if (isHttpError(error) && error.expose) return error;
  return Object.assign(
    new HttpError(isHttpError(error) ? error.status : 500, undefined, {
      cause: error,
      expose: false,
    }),
    { digest: errorDigest(error) },
  );
}

/** Records what happened and returns what to rethrow. */
function capture(
  error: unknown,
  context: Readonly<Record<string, unknown>>,
  hooks: WrapHooks,
): unknown {
  const entry = entryOf(context);
  if (isRedirect(error)) {
    if (entry !== undefined && entry.state.redirect === undefined) entry.state.redirect = error;
    return error;
  }
  if (isNotFound(error)) return error;
  const shown = publicError(error, hooks.dev);
  // A client error (4xx) is a normal answer, not a fault of the server.
  if (!(isHttpError(error) && error.status < 500)) hooks.report(error, entry?.event, shown);
  entry?.state.failures.push(error);
  return shown;
}

type BeforeLoad = NonNullable<RouteSpec["beforeLoad"]>;
type Loader = NonNullable<RouteSpec["loader"]>;

function wrapBeforeLoad(user: BeforeLoad, hooks: WrapHooks): BeforeLoad {
  return async (args) => {
    const state = stateOf(args.context);
    // Once a redirect is decided, later hops must not run application code for a response that
    // will not be rendered.
    if (state?.redirect !== undefined) throw state.redirect;
    try {
      return await user(args);
    } catch (error) {
      throw capture(error, args.context, hooks);
    }
  };
}

function wrapLoader(user: Loader, hooks: WrapHooks, routeId: string): Loader {
  return async (args) => {
    const state = stateOf(args.context);
    if (state?.redirect !== undefined) throw state.redirect;
    try {
      const obs = state?.obs;
      return await (obs === undefined
        ? user(args)
        : obs.run("dusk.loader", { "dusk.route.id": routeId }, () => user(args)));
    } catch (error) {
      throw capture(error, args.context, hooks);
    }
  };
}

/**
 * Copies a route tree with wrapped `beforeLoad` and loaders. Iterative, so a tree of any depth is
 * safe. The result shares nothing mutable with the input.
 *
 * @param routes The manifest's routes.
 * @param hooks Reporting and development flag.
 * @returns The wrapped routes, an index of every spec by id and the same tree in the shape the
 *   matcher takes (ids and paths only).
 * @throws TypeError when two routes share an id.
 * @internal
 */
export function wrapRoutes(
  routes: readonly RouteDefinition[],
  hooks: WrapHooks,
): {
  readonly routes: RouteDefinition[];
  readonly specs: Map<string, RouteSpec>;
  readonly tree: CoreRoute[];
} {
  interface Node {
    readonly definition: RouteDefinition;
    readonly children: number[];
  }
  const nodes: Node[] = [];
  const rootIndexes: number[] = [];
  const queue: Array<{ readonly definition: RouteDefinition; readonly parent: number }> =
    routes.map((definition) => ({ definition, parent: -1 }));
  for (let head = 0; head < queue.length; head += 1) {
    const item = queue[head];
    if (item === undefined) break;
    const index = nodes.length;
    nodes.push({ definition: item.definition, children: [] });
    if (item.parent === -1) rootIndexes.push(index);
    else nodes[item.parent]?.children.push(index);
    for (const child of item.definition.spec.children)
      queue.push({ definition: child, parent: index });
  }
  const wrapped: RouteDefinition[] = [];
  const trees: CoreRoute[] = [];
  const specs = new Map<string, RouteSpec>();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const spec = node.definition.spec;
    const children = node.children
      .map((childIndex) => wrapped[childIndex])
      .filter((child): child is RouteDefinition => child !== undefined);
    // A page with `dynamicParams = false` runs the check first: a request whose params the page does not list is not
    // found, with the app's own not-found UI, as if a loader had thrown `notFound()`. Its own `beforeLoad` and loader
    // do not run for it.
    const gate = spec.dynamicParams === false ? hooks.paramsGate : undefined;
    const user = spec.beforeLoad;
    const checked: BeforeLoad | undefined =
      gate === undefined ? user : async (args) => (await gate()).guard(spec.id, args, user);
    const next: RouteSpec = {
      ...spec,
      children,
      beforeLoad: checked === undefined ? undefined : wrapBeforeLoad(checked, hooks),
      loader: spec.loader === undefined ? undefined : wrapLoader(spec.loader, hooks, spec.id),
    };
    wrapped[index] = { ...node.definition, spec: next };
    trees[index] = {
      id: spec.id,
      path: spec.path,
      // The matcher applies the same rules the browser does: a value that fails a rule is not a match.
      ...(spec.matchFilters === undefined ? {} : { matchFilters: spec.matchFilters }),
      children: node.children
        .map((childIndex) => trees[childIndex])
        .filter((child): child is CoreRoute => child !== undefined),
    };
    if (specs.has(spec.id)) throw new TypeError(`two routes share the id "${spec.id}".`);
    specs.set(spec.id, next);
  }
  const top = rootIndexes
    .map((rootIndex) => wrapped[rootIndex])
    .filter((route): route is RouteDefinition => route !== undefined);
  const tree = rootIndexes
    .map((rootIndex) => trees[rootIndex])
    .filter((route): route is CoreRoute => route !== undefined);
  return { routes: top, specs, tree };
}
