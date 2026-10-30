import { type Accessor, isDev, useExternalStore } from "@shadow-js/core";

/**
 * The page side of `pwa()`: registers the generated service worker and tells the page when a new version is waiting.
 * Nothing here runs on the server or in development unless asked, and an app that does not import this subpath ships none
 * of it. The worker itself is generated at build time (see `pwa()` of `@shadow-js/dusk/vite`).
 */

/** The message the worker waits for before it takes over (the same text as the worker's `SKIP_WAITING_MESSAGE`). */
const SKIP_WAITING = "dusk:skip-waiting";

/**
 * Options of {@link registerServiceWorker}.
 * @since 1.0.0
 */
export interface RegisterServiceWorkerOptions {
  /** The mount base of the app (`/app`). Default `/`. The worker's URL and scope derive from it. */
  readonly base?: string;
  /** The worker's path on this origin. Default: `sw.js` under the base. */
  readonly url?: string;
  /** The scope. Default: the base. A scope wider than the worker's folder needs `Service-Worker-Allowed`. */
  readonly scope?: string;
  /** Register in development too. Default false: a development server would answer from stale caches. */
  readonly dev?: boolean;
}

/**
 * The state of updates, as the page sees it.
 * @since 1.0.0
 */
export interface ServiceWorkerUpdate {
  /** True while a new version of the worker is installed and waiting. */
  readonly waiting: Accessor<boolean>;
  /** Applies the waiting version and reloads the page once it controls it. Does nothing when none is waiting. */
  update(): void;
}

/** How long `update()` waits for the new worker to take control before it lets the page try again. */
const APPLY_TIMEOUT_MS = 10_000;

/**
 * What the page knows about updates. It belongs to the page's `ServiceWorkerContainer` (one per window), held in a
 * `WeakMap`, so two pages of one test run, or a page that is torn down, never share a stale "waiting" flag.
 */
interface UpdateState {
  tracked: ServiceWorkerRegistration | undefined;
  waiting: boolean;
  /** The waiting worker `update()` asked to take over; `undefined` when no `update()` is in flight. */
  applying: ServiceWorker | undefined;
  readonly listeners: Set<() => void>;
  readonly followed: WeakSet<ServiceWorkerRegistration>;
  /** Drops the `controllerchange` listener and the timeout of an `update()` that is in flight. */
  cancelApply: (() => void) | undefined;
}

const states = new WeakMap<ServiceWorkerContainer, UpdateState>();

function containerOf(): ServiceWorkerContainer | undefined {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return undefined;
  return navigator.serviceWorker;
}

function stateOf(container: ServiceWorkerContainer): UpdateState {
  let state = states.get(container);
  if (state === undefined) {
    state = {
      tracked: undefined,
      waiting: false,
      applying: undefined,
      listeners: new Set(),
      followed: new WeakSet(),
      cancelApply: undefined,
    };
    states.set(container, state);
  }
  return state;
}

function publish(state: UpdateState, next: boolean): void {
  if (next === state.waiting) return;
  state.waiting = next;
  for (const listener of [...state.listeners]) listener();
}

/** Ends an `update()` that did not finish, so a later `update()` can try again. */
function resetApplying(state: UpdateState): void {
  state.cancelApply?.();
  state.cancelApply = undefined;
  state.applying = undefined;
}

function subscribe(notify: () => void): () => void {
  const container = containerOf();
  // No service workers here (the server, an old browser): nothing to follow, nothing to release.
  if (container === undefined) return () => undefined;
  const { listeners } = stateOf(container);
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Follows a registration: a worker that finishes installing while another one controls the page is an update. */
function track(container: ServiceWorkerContainer, registration: ServiceWorkerRegistration): void {
  const state = stateOf(container);
  state.tracked = registration;
  const sync = (event?: Event): void => {
    const waiting = registration.waiting !== null;
    // The worker being applied was replaced or discarded (`redundant`): it can no longer take over, let the page try
    // again. One that leaves `waiting` by activating is the update going through, and its `controllerchange` (the
    // reload) comes next. Any other worker going redundant (the old one that the new worker replaces on activation,
    // right before that `controllerchange`) is not the update failing, and must keep the listener.
    const from = event?.target;
    if (
      from !== null &&
      from !== undefined &&
      from === state.applying &&
      Reflect.get(from, "state") === "redundant"
    )
      resetApplying(state);
    publish(state, waiting);
  };
  // Registering twice returns the same registration; listening twice would run `sync` twice per event.
  if (!state.followed.has(registration)) {
    state.followed.add(registration);
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", sync);
    });
  }
  sync();
}

/** A path on this origin for the worker or its scope. */
function checkedPath(value: string, name: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    throw new TypeError(
      `registerServiceWorker: ${name} must be a path on this origin that starts with a single "/".`,
    );
  }
  return value;
}

/** Resolves when the page has finished loading, so the registration does not compete with the page's own requests. */
function loaded(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
}

/**
 * Registers the service worker that `pwa()` generated. Safe to call anywhere: on the server, in a browser without service
 * workers, and in development (unless `dev` is set) it does nothing and resolves `undefined`. The registration waits for
 * the page to finish loading. The worker never takes over a page on its own after the first install: a new version waits
 * until the page calls `update()` of {@link useServiceWorkerUpdate}.
 *
 * @param options The base, the URL and scope, and whether to register in development.
 * @returns The registration, or `undefined` when nothing was registered.
 * @throws TypeError when `url`, `scope` or `base` is not a path on this origin.
 * @example
 * import { onMount } from "@shadow-js/core";
 * import { registerServiceWorker } from "@shadow-js/dusk/features/pwa";
 *
 * function App() {
 *   onMount(() => {
 *     void registerServiceWorker();
 *   });
 *   return <main>Hello</main>;
 * }
 * @since 1.0.0
 */
export async function registerServiceWorker(
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration | undefined> {
  const base = checkedPath(options.base ?? "/", "base");
  const folder = base.endsWith("/") ? base : `${base}/`;
  const url = checkedPath(options.url ?? `${folder}sw.js`, "url");
  const scope = checkedPath(options.scope ?? folder, "scope");
  if (typeof window === "undefined" || typeof navigator === "undefined") return undefined;
  if (!("serviceWorker" in navigator) || (isDev && options.dev !== true)) return undefined;
  await loaded();
  // `updateViaCache: "none"`: the worker script itself is always checked against the network.
  const registration = await navigator.serviceWorker.register(url, {
    scope,
    updateViaCache: "none",
  });
  track(navigator.serviceWorker, registration);
  return registration;
}

/**
 * Removes the service worker of this origin and the caches the app made, for a kill switch or a sign-out.
 *
 * @param cacheNamePrefix The `cacheNamePrefix` given to `pwa()`. Default `dusk`.
 * @returns True when a worker was unregistered.
 * @example
 * import { unregisterServiceWorker } from "@shadow-js/dusk/features/pwa";
 * await unregisterServiceWorker();
 * @since 1.0.0
 */
export async function unregisterServiceWorker(cacheNamePrefix = "dusk"): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  const registrations = await navigator.serviceWorker.getRegistrations();
  const results = await Promise.all(registrations.map((registration) => registration.unregister()));
  if (typeof caches !== "undefined") {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${cacheNamePrefix}-`))
        .map((name) => caches.delete(name)),
    );
  }
  const container = navigator.serviceWorker;
  const state = stateOf(container);
  state.tracked = undefined;
  resetApplying(state);
  publish(state, false);
  return results.some(Boolean);
}

function applyUpdate(): void {
  const container = containerOf();
  if (container === undefined) return;
  const state = stateOf(container);
  const worker = state.tracked?.waiting;
  if (worker === null || worker === undefined || state.applying !== undefined) return;
  state.applying = worker;
  // The page reloads once, when the new worker controls it, so the markup and the cached assets are one version.
  const onChange = (): void => {
    resetApplying(state);
    location.reload();
  };
  container.addEventListener("controllerchange", onChange, { once: true });
  // `controllerchange` never fires when the worker ignores the message or was discarded meanwhile; without this the
  // page would stay "applying" and every later `update()` would do nothing.
  const timer = setTimeout(() => resetApplying(state), APPLY_TIMEOUT_MS);
  state.cancelApply = () => {
    clearTimeout(timer);
    container.removeEventListener("controllerchange", onChange);
  };
  try {
    worker.postMessage({ type: SKIP_WAITING });
  } catch (error) {
    resetApplying(state);
    throw error;
  }
}

/**
 * Whether a new version of the app is waiting, and the way to apply it. Use it to show a "new version available" prompt;
 * the worker takes over only when `update()` is called.
 *
 * @returns `waiting`, an accessor that is true while a new version waits, and `update`, which applies it.
 * @example
 * import { useServiceWorkerUpdate } from "@shadow-js/dusk/features/pwa";
 *
 * function UpdatePrompt() {
 *   const { waiting, update } = useServiceWorkerUpdate();
 *   return (
 *     <Show when={waiting()}>
 *       <button type="button" onClick={update}>New version available. Reload</button>
 *     </Show>
 *   );
 * }
 * @since 1.0.0
 */
export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
  const waiting = useExternalStore(
    subscribe,
    () => {
      const container = containerOf();
      return container !== undefined && stateOf(container).waiting;
    },
    { getServerSnapshot: () => false },
  );
  return { waiting, update: applyUpdate };
}
