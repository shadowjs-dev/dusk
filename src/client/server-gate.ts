import type { RouteDefinition } from "@shadow-js/router";
import { redirect } from "@shadow-js/router/core";
import {
  NAV_CHECK_HEADER,
  NAV_CHECK_VALUE,
  NAV_GATE_ALLOWED,
  NAV_GATE_HEADER,
  NAV_PATH,
} from "../shared/wire";

/** The target of a navigation: its app path (no mount base) and its query string (`""` or `?...`). */
interface NavigationTarget {
  readonly pathname: string;
  readonly search: string;
}

/**
 * Server middleware and client navigation. The middleware of a route runs only on the server (its code
 * never reaches the browser), so a navigation made in the browser would skip it. Before the router loads
 * anything for a top-level route whose subtree runs server middleware, the browser asks the server to run
 * that chain for the target path (`POST {base}/_dusk/nav`). A refusal or a redirect from the chain is
 * applied here: the navigation fails with the status, or the router redirects.
 *
 * The check runs on every navigation into such a tree, including the first load, so it never depends on
 * what the page already rendered.
 */

/**
 * A navigation the server's middleware refused without a redirect. `status` is the status the chain
 * answered (401, 403, ...). It shows up in the route's error boundary like any loader error.
 * @since 1.0.0
 */
export class NavigationRefusedError extends Error {
  /** The status the middleware chain answered. */
  readonly status: number;

  /** @param status The refused status. */
  constructor(status: number) {
    super(`the server refused this navigation (${status})`);
    this.name = "NavigationRefusedError";
    this.status = status;
  }
}

/** True when a route or one of its descendants is marked as running server middleware. Iterative. */
function runsServerMiddleware(route: RouteDefinition): boolean {
  const pending: RouteDefinition[] = [route];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.spec.serverMiddleware === true) return true;
    pending.push(...current.spec.children);
  }
  return false;
}

/** The application path of a same-origin target, without the mount base; `undefined` when it is not inside the app. */
function appPathOf(target: string, origin: string, base: string): string | undefined {
  const url = new URL(target, origin);
  if (url.origin !== origin) return undefined;
  if (base !== "" && url.pathname !== base && !url.pathname.startsWith(`${base}/`))
    return undefined;
  const pathname = base === "" ? url.pathname : url.pathname.slice(base.length) || "/";
  return `${pathname}${url.search}`;
}

/** A named field of a parsed JSON value, if it has one. */
function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Asks the server whether a navigation to `pathname` may proceed. Resolves when it may; throws a
 * {@link NavigationRefusedError}, or the router's redirect, otherwise.
 */
async function checkWithServer(
  options: GateOptions,
  target: NavigationTarget,
  signal: AbortSignal | undefined,
): Promise<void> {
  const response = await options.fetch(`${options.base}${NAV_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      [NAV_CHECK_HEADER]: NAV_CHECK_VALUE,
    },
    body: JSON.stringify({ path: target.pathname, search: target.search }),
    credentials: "same-origin",
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === 204 && response.headers.get(NAV_GATE_HEADER) === NAV_GATE_ALLOWED) {
    // An answer nobody reads is canceled by the browser: the request is then reported as aborted (ERR_ABORTED) although
    // it succeeded. The body is empty, so reading it ends the response at once.
    await response.text();
    return;
  }
  let outcome: unknown;
  try {
    outcome = await response.json();
  } catch {
    // Not the gate's answer (a proxy page, a crash): the navigation is refused with the status it had.
    throw new NavigationRefusedError(response.status);
  }
  const to = fieldOf(outcome, "redirect");
  if (typeof to === "string") {
    // The same semantics as a document redirect: the navigation ends at the redirect target, which
    // replaces the entry of the blocked URL. Inside the app the router follows it; another origin is
    // left to the browser (a document navigation), as a redirect of a document request would be.
    const appPath = appPathOf(to, options.origin, options.base);
    if (appPath !== undefined) throw redirect(appPath, { replace: true });
    options.leave(new URL(to, options.origin).href);
    // The page is leaving: the navigation stays pending, so no error boundary flashes before the unload.
    await new Promise<never>(() => undefined);
  }
  const status = fieldOf(outcome, "status");
  throw new NavigationRefusedError(typeof status === "number" ? status : response.status);
}

/** What the gate needs from the page. @internal */
export interface GateOptions {
  /** Mount base of the app, `""` or `/app`. */
  readonly base: string;
  /** Origin of the page: a redirect inside it is a router navigation, any other is left to the browser. */
  readonly origin: string;
  /** The fetch that asks the server (the page's own by default). */
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Leaves the app for another origin, as a document redirect would (`location.replace` in the page). */
  readonly leave: (href: string) => void;
}

/**
 * Returns the route tree with each top-level route whose subtree runs server middleware asking the server
 * before its own `beforeLoad` runs. Routes without server middleware are returned as they are. The input is
 * not changed.
 *
 * @param routes The route tree (the generated `routeTree`).
 * @param options Base, origin and fetch.
 * @returns The routes to create the router with.
 * @internal
 */
export function gateServerNavigations(
  routes: readonly RouteDefinition[],
  options: GateOptions,
): RouteDefinition[] {
  return routes.map((route) => {
    if (!runsServerMiddleware(route)) return route;
    const original = route.spec.beforeLoad;
    const beforeLoad: NonNullable<typeof original> = async (args) => {
      await checkWithServer(
        options,
        { pathname: args.location.pathname, search: args.location.search },
        args.signal,
      );
      return original === undefined ? undefined : original(args);
    };
    return { ...route, spec: { ...route.spec, beforeLoad } };
  });
}
