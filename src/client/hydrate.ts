import {
  createBrowserHistory,
  createRouter,
  isRedirect,
  Outlet,
  parseHydrationData,
  type RouteDefinition,
  type Router,
  type RouterCacheOptions,
  type RouterOptions,
  RouterProvider,
  type RouterWindow,
  unsafeHref,
} from "@shadow-js/router";
import { createComponent, hydrate, render } from "@shadow-js/web";
import { deserialize } from "@shadow-js/web/server";
import { FLASH_ELEMENT_ID, type FlashPayload } from "../shared/action";
import type { AppComponent } from "../shared/app-component";
import type { GlobalErrorModule } from "../shared/global-error";
import { duskFeatures } from "../shared/router";
import { RESOURCE_PAYLOAD_ATTRIBUTE, ROUTER_PAYLOAD_ID } from "../shared/wire";
import { configureDeployment, reloadPage } from "./deployment";
import { gateServerNavigations } from "./server-gate";
import { registerRevalidation } from "./single-flight";
import { bindSubmissions, createSubmissionStore } from "./submissions";

/**
 * The User Timing mark set once the app is attached to the server's markup (dev and production alike), and the measure
 * `dusk:hydration` from navigation start (time 0) to that mark. Read them with
 * `performance.getEntriesByName("dusk:hydration")`; they are cheap and need no setup.
 */
const HYDRATION_MARK = "dusk:hydrated";
/** The measure from navigation start to {@link HYDRATION_MARK}. */
const HYDRATION_MEASURE = "dusk:hydration";

function markHydrated(): void {
  performance.mark(HYDRATION_MARK);
  performance.measure(HYDRATION_MEASURE, { start: 0, end: HYDRATION_MARK });
}

/**
 * `hydrateDusk()`: the one call a Dusk client entry makes. It reads what the server
 * embedded in the page, starts the router on the browser history with the server's loader data
 * (so nothing is fetched twice), loads the code of the routes on screen, attaches the app to the
 * server's markup, and keeps navigation in the browser from then on.
 */

/**
 * The root component: receives the routed page as `children`. The same type as the server
 * manifest's `App` (see {@link AppComponent}), so any props shape is accepted.
 * @since 1.0.0
 */
export type DuskAppComponent = AppComponent;

/** Options of {@link hydrateDusk}. @since 1.0.0 */
export interface HydrateDuskOptions {
  /**
   * The global error document (`src/routes/_global-error.tsx`). When the app itself fails to mount in the browser, the
   * page is requested again, so the server answers with the global error document. The error goes to `onError`; a second failure in the same session is not retried. Absent: the failure is thrown, as before.
   */
  readonly globalError?: GlobalErrorModule;
  /**
   * The deployment id of the build (the server entry has the same one). Every server function call carries it;
   * a call from another deployment is refused with 409, and the page reloads (see `reloadOnSkew`).
   */
  readonly deploymentId?: string;
  /** Reload the page when a call is refused for another deployment. Default true. */
  readonly reloadOnSkew?: boolean;
  /** The route tree: `routeTree` from the generated `routeTree.gen.ts`. */
  readonly routes: readonly RouteDefinition[];
  /** The app's root component; the same one the server renders. Default: renders its children. */
  readonly App?: DuskAppComponent;
  /**
   * Loads the code of the routes with these ids before the first render, so the markup the
   * browser builds equals the server's. Pass `preloadRoutes` from the generated route tree.
   */
  readonly preload?: (ids: readonly string[]) => Promise<void>;
  /** The element the server rendered the app into, or a selector. Default `#app`. */
  readonly container?: Element | string;
  /** Mount base of the app, the same as the server's (`""` or `/app`). */
  readonly base?: string;
  /** Prefix of the hydration keys; equals the server's `renderId`. Default `"0"`. */
  readonly renderId?: string;
  /**
   * More router options (context, trailing slash policy, pending delays), and the two that are features:
   * `cache` (the loader cache limits) and `viewTransitions` (`true` turns view transitions on).
   * The trailing slash policy inherits the server document unless overridden here.
   */
  readonly router?: Omit<RouterOptions, "routes" | "history" | "base" | "window" | "features"> & {
    readonly cache?: RouterCacheOptions;
    readonly viewTransitions?: boolean;
  };
  /** Load the data of a link's page when the pointer or focus reaches it. Default `true`. */
  readonly prefetch?: boolean;
  /** The route announcer: a client navigation announces the page title and moves focus to the page. Default `true`. */
  readonly announcer?: boolean;
  /** The document to read and hydrate. Default: the global one. */
  readonly document?: Document;
  /** The window for history and events. Default: the global one. */
  readonly window?: Window;
  /** Receives problems that do not stop the page: a payload that cannot be read. Default `console.error`. */
  readonly onError?: (error: unknown) => void;
}

/** What {@link hydrateDusk} resolves to. @since 1.0.0 */
export interface DuskClient {
  /** The browser router. */
  readonly router: Router;
  /** Detaches the app, removes the listeners and stops the router. Safe to call twice. */
  dispose(): void;
}

const MAX_PREFETCHED = 500;

function defaultOnError(error: unknown): void {
  console.error(error);
}

/** Reads the text of the first element matching `selector`, or undefined. */
function textOf(doc: Document, selector: string): string | undefined {
  const element = doc.querySelector(selector);
  if (element === null) return undefined;
  const text = element.textContent;
  return text === null || text === "" ? undefined : text;
}

/** An anchor the prefetch may load: same origin, same window, not a download. */
function prefetchTarget(event: Event, origin: string): string | undefined {
  const target = event.target;
  if (typeof Element === "undefined" || !(target instanceof Element)) return undefined;
  const anchor = target.closest("a[href]");
  if (anchor === null || !(anchor instanceof HTMLAnchorElement)) return undefined;
  const frame = anchor.getAttribute("target");
  if ((frame !== null && frame !== "" && frame !== "_self") || anchor.hasAttribute("download")) {
    return undefined;
  }
  if (anchor.dataset["noPrefetch"] !== undefined) return undefined;
  if (anchor.origin !== origin) return undefined;
  return `${anchor.pathname}${anchor.search}`;
}

/**
 * Starts the app in the browser on top of the server's markup.
 *
 * Steps: read the router payload (`<script id="__shadow_router">`) and the resource payload
 * (`<script data-sh>`); create the router on the browser history and seed it, so loaders that the
 * server ran are not run again; await the first load; load the lazy code of the routes on screen;
 * hydrate. A missing or broken payload is reported and the page falls back to loading its data in
 * the browser; the page is never left blank. When the container is empty (the server sent no app
 * markup: a route with `ssr = false` or `"data-only"`, or a single-page-app shell) there is
 * nothing to claim, so the app is rendered into it, from the router payload when there is one.
 *
 * @param options The route tree and the root component. See {@link HydrateDuskOptions}.
 * @returns The router and a `dispose` function.
 * @throws TypeError when the container element does not exist.
 * @example
 * // src/entry-client.ts
 * import { hydrateDusk } from "@shadow-js/dusk/client";
 * import { preloadRoutes, routeTree } from "./routeTree.gen";
 * import App from "./app";
 * await hydrateDusk({ routes: routeTree, App, preload: preloadRoutes });
 * @since 1.0.0
 */
export async function hydrateDusk(options: HydrateDuskOptions): Promise<DuskClient> {
  configureDeployment(
    options.deploymentId,
    options.reloadOnSkew === false ? undefined : reloadPage,
  );
  const doc = options.document ?? document;
  const win = options.window ?? window;
  const report = options.onError ?? defaultOnError;
  const renderId = options.renderId ?? "0";
  const found =
    typeof options.container === "string"
      ? doc.querySelector(options.container)
      : (options.container ?? doc.getElementById("app"));
  if (found === null) {
    throw new TypeError("hydrateDusk(): the container element was not found (default: #app)");
  }
  const container = found;

  const { cache, viewTransitions, ...routerOptions } = options.router ?? {};
  // The policy can come from executable server-entry options, so the rendered document carries it.
  const serverPolicy = container.getAttribute("data-dusk-trailing-slash");
  const router = createRouter({
    ...(serverPolicy === "always" || serverPolicy === "preserve"
      ? { trailingSlash: serverPolicy }
      : {}),
    ...routerOptions,
    features: duskFeatures({
      ...(cache === undefined ? {} : { cache }),
      ...(viewTransitions === undefined ? {} : { viewTransitions }),
      ...(options.announcer === undefined ? {} : { announcer: options.announcer }),
    }),
    // Top-level routes whose subtree runs server middleware ask the server first (see server-gate.ts).
    routes: gateServerNavigations(options.routes, {
      base: options.base ?? "",
      origin: win.location.origin,
      fetch: (input, init) => globalThis.fetch(input, init),
      leave: (href) => win.location.replace(href),
    }),
    history: createBrowserHistory(win),
    ...(options.base === undefined ? {} : { base: options.base }),
    // A browser window has every member RouterWindow names; TypeScript cannot see that through
    // the DOM typings' overloads (the router makes the same cast for its own default).
    window: win as unknown as RouterWindow,
  });

  // Single-flight answers apply their loader data to this router (see single-flight.ts).
  const unregisterRevalidation = registerRevalidation(
    (data) => router.applyHydration(data),
    report,
  );
  // The page's mutation state: submissions, fetchers and the flash the server carried to this page.
  const submissions = createSubmissionStore({
    onRevalidate: () => router.invalidate(),
    // A target the app's own submissions and redirects produced: a same-origin path (checked in development).
    navigate: (to, navigation) => router.navigate(unsafeHref(to), navigation),
  });
  bindSubmissions(router, submissions);
  const flashText = textOf(doc, `script[type="application/json"]#${FLASH_ELEMENT_ID}`);
  if (flashText !== undefined) {
    try {
      const flash: unknown = deserialize(flashText);
      if (typeof flash === "object" && flash !== null) submissions.seed(flash as FlashPayload);
    } catch (error) {
      // The page still works: the value is shown as if it had not been carried.
      report(error);
    }
  }

  const routerPayload = textOf(doc, `script[type="application/json"]#${ROUTER_PAYLOAD_ID}`);
  if (routerPayload !== undefined) {
    try {
      router.hydrate(parseHydrationData(routerPayload));
    } catch (error) {
      // The page still works: the router loads the data again in the browser.
      report(error);
    }
  }
  let data: Record<string, unknown> | undefined;
  const resourcePayload = textOf(
    doc,
    `script[type="application/json"][${RESOURCE_PAYLOAD_ATTRIBUTE}="${renderId}"]`,
  );
  if (resourcePayload !== undefined) {
    try {
      const decoded = deserialize(resourcePayload);
      if (typeof decoded === "object" && decoded !== null) {
        data = decoded as Record<string, unknown>;
      }
    } catch (error) {
      report(error);
    }
  }

  await router.ready();
  if (options.preload !== undefined) {
    await options.preload(router.state.matches().map((match) => match.id));
  }

  const App = options.App;
  const app = (): unknown =>
    createComponent((App ?? Identity) as (props: unknown) => unknown, {
      get children() {
        return createComponent(RouterProvider, {
          router,
          get children() {
            return createComponent(Outlet, {});
          },
        });
      },
    });
  // An empty container is a document without app markup (a route with `ssr = false` or
  // `"data-only"`, or a single-page app shell): there is nothing to claim, so the app is built.
  let dispose: () => void;
  try {
    dispose =
      container.firstChild === null
        ? render(app, container)
        : hydrate(app, container, { renderId, ...(data === undefined ? {} : { data }) });
    // The app is attached: the timing marks for RUM and benchmarks (see `HYDRATION_MARK`).
    markHydrated();
    // The app mounted: a later failure in this session may ask the server again.
    if (options.globalError !== undefined) clearGlobalErrorMark(win, report);
  } catch (error) {
    if (options.globalError === undefined) throw error;
    report(error);
    dispose = reloadForGlobalError(win, report);
  }

  const cleanups: (() => void)[] = [];
  if (options.prefetch !== false) {
    const seen = new Set<string>();
    const onIntent = (event: Event): void => {
      const href = prefetchTarget(event, win.location.origin);
      if (href === undefined || seen.has(href)) return;
      if (seen.size >= MAX_PREFETCHED) seen.clear();
      seen.add(href);
      // The anchor's own pathname and search: same origin by the check in `prefetchTarget`.
      router.preload(unsafeHref(href)).catch(report);
    };
    for (const type of ["pointerover", "focusin", "touchstart"] as const) {
      doc.addEventListener(type, onIntent, { passive: true });
      cleanups.push(() => doc.removeEventListener(type, onIntent));
    }
  }
  // A server function that answered with a redirect rejects its promise with the router's redirect
  // signal. Loaders hand it to the router; for the calls nobody caught (an event handler), follow it.
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (!isRedirect(event.reason)) return;
    event.preventDefault();
    // The target of a redirect the app's server code returned: a same-origin path (checked in development).
    void router.navigate(unsafeHref(event.reason.to), { replace: event.reason.replace });
  };
  win.addEventListener("unhandledrejection", onRejection);
  cleanups.push(() => win.removeEventListener("unhandledrejection", onRejection));

  let disposed = false;
  return {
    router,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      unregisterRevalidation();
      dispose();
      router.dispose();
    },
  };
}

/** The session marker of a global-error reload: set when the page asked the server again, cleared by a good mount. */
const GLOBAL_ERROR_MARK = "dusk:global-error-reload";

/**
 * The browser side of the global error. The page's own markup cannot be drawn here from the module's `<html>` and
 * `<body>`: the DOM renderer builds elements from template markup, which drops those two tags. So the browser asks the
 * server for the page again: the server renders the `_global-error` document when the app fails there too (it has no
 * script, so it does not mount again). A second failure in the same session is not retried (the marker stops the loop),
 * and the error stays reported. A mount that succeeds clears the marker (see `hydrateDusk`).
 *
 * @returns The dispose of the (absent) render: a no-op.
 */
function reloadForGlobalError(win: Window, report: (error: unknown) => void): () => void {
  try {
    if (win.sessionStorage.getItem(GLOBAL_ERROR_MARK) === "1") return () => undefined;
    win.sessionStorage.setItem(GLOBAL_ERROR_MARK, "1");
  } catch (error) {
    // Storage can be unavailable (private windows, blocked storage): the reload still happens, without the loop guard.
    report(error);
  }
  win.location.reload();
  return () => undefined;
}

/** Clears the global-error marker after a mount that succeeded. */
function clearGlobalErrorMark(win: Window, report: (error: unknown) => void): void {
  try {
    win.sessionStorage.removeItem(GLOBAL_ERROR_MARK);
  } catch (error) {
    report(error);
  }
}

function Identity(props: { readonly children?: unknown }): unknown {
  return props.children;
}
