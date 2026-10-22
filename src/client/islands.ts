import { hydrate, render } from "@shadow-js/web";
import { IslandPropsError } from "../shared/island";

/**
 * The browser side of islands. The server wrote each island as an element with `data-island`,
 * `data-client` and `data-props` (see `islandAttributes`). This module finds them and, for each, calls the
 * loader its id names in the registry when its strategy says so. The loader is the island's only code the
 * page needs: a `() => import("./Chart")` in the registry makes the island its own chunk. The island's
 * markup is then replaced by the component's own output (the server's static markup is what the page shows
 * until then; a component is not hydrated into it in this version).
 */

/** A component an island renders. @since 1.0.0 */
export type IslandComponent = (props: Readonly<Record<string, unknown>>) => unknown;

/** What an island's module exports: the component, as default or as the module itself. @since 1.0.0 */
export type IslandModule = { readonly default: IslandComponent } | IslandComponent;

/** The islands of an app: each id to the loader of its module. @since 1.0.0 */
export type IslandRegistry = Readonly<Record<string, () => Promise<IslandModule>>>;

/** Options of {@link hydrateIslands}. @since 1.0.0 */
export interface HydrateIslandsOptions {
  /** The loader of each island id. */
  readonly registry: IslandRegistry;
  /** The part of the page to look in. Default: the document. */
  readonly root?: ParentNode;
  /** Receives a problem that does not stop the other islands (an unknown id, props that are not JSON, a failed load). */
  readonly onError?: (error: unknown) => void;
}

/** What {@link hydrateIslands} returns. @since 1.0.0 */
export interface IslandsHandle {
  /** Islands that have mounted their component so far. */
  readonly hydrated: number;
  /** Stops waiting for the islands that have not started, and removes the listeners. Mounted islands stay. */
  dispose(): void;
}

/** The props attribute, read back: plain data written by `islandAttributes`. */
function readProps(text: string | null): Readonly<Record<string, unknown>> {
  if (text === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new IslandPropsError("the props of an island are not valid JSON", cause);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IslandPropsError("the props of an island must be a JSON object", undefined);
  }
  return value as Readonly<Record<string, unknown>>;
}

/** The first top-level island under `root` (an island inside another island is left to its outer one). */
function isTopLevel(element: Element): boolean {
  const parent = element.parentElement?.closest("[data-island]");
  return parent === null || parent === undefined;
}

/**
 * Starts the islands of the page. Each island mounts when its strategy fires: at once, when visible, when
 * the browser is idle, on its first interaction, or when its media query matches. An island is mounted
 * once. Nothing is loaded for an island that never fires.
 *
 * @param options The registry, the part of the page and the error sink.
 * @returns A handle with the count of mounted islands and `dispose`.
 * @example
 * hydrateIslands({ registry: { chart: () => import("./Chart") } });
 * @since 1.0.0
 */
export function hydrateIslands(options: HydrateIslandsOptions): IslandsHandle {
  const root: ParentNode = options.root ?? document;
  const report = options.onError ?? ((error: unknown) => console.error("[dusk] island", error));
  const disposers: (() => void)[] = [];
  let hydrated = 0;
  let disposed = false;

  const mount = async (
    element: Element,
    id: string,
    props: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    // `only` islands have no server markup: they are rendered, not hydrated.
    const serverRendered = element.getAttribute("data-client") !== "only";
    const load = Object.hasOwn(options.registry, id) ? options.registry[id] : undefined;
    if (load === undefined) {
      report(new Error(`island "${id}" is not in the registry`));
      return;
    }
    try {
      const loaded = await load();
      const component = typeof loaded === "function" ? loaded : loaded.default;
      if (typeof component !== "function")
        throw new TypeError(`island "${id}" does not export a component`);
      if (disposed) return;
      if (serverRendered) {
        // The server's markup is the island's first render: the component claims it (no second copy of the page).
        disposers.push(hydrate(() => component(props), element));
      } else {
        element.replaceChildren();
        disposers.push(render(() => component(props), element));
      }
      hydrated += 1;
    } catch (error) {
      report(error);
    }
  };

  /** Runs `start` once, when the strategy of the element fires. */
  const schedule = (
    element: Element,
    strategy: string,
    media: string | undefined,
    start: () => void,
  ): void => {
    let started = false;
    const once = (): void => {
      if (started || disposed) return;
      started = true;
      start();
    };
    if (strategy === "load" || strategy === "only") {
      once();
    } else if (strategy === "visible" && typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          once();
        }
      });
      observer.observe(element);
      disposers.push(() => observer.disconnect());
    } else if (strategy === "idle") {
      const handle =
        typeof requestIdleCallback === "function" ? requestIdleCallback(once) : setTimeout(once, 1);
      disposers.push(() => {
        if (typeof handle === "number") clearTimeout(handle);
      });
    } else if (strategy === "interaction") {
      const events = ["pointerdown", "focusin", "keydown"] as const;
      const fire = (): void => {
        for (const type of events) element.removeEventListener(type, fire);
        once();
      };
      for (const type of events) element.addEventListener(type, fire, { passive: true });
      disposers.push(() => {
        for (const type of events) element.removeEventListener(type, fire);
      });
    } else if (strategy === "media" && media !== undefined && typeof matchMedia === "function") {
      const query = matchMedia(media);
      const check = (): void => {
        if (query.matches) {
          query.removeEventListener("change", check);
          once();
        }
      };
      check();
      if (!started) query.addEventListener("change", check);
      disposers.push(() => query.removeEventListener("change", check));
    } else {
      // visible without an IntersectionObserver, or an unknown media query: mount now rather than never.
      once();
    }
  };

  for (const element of root.querySelectorAll("[data-island]")) {
    if (!isTopLevel(element)) continue;
    const id = element.getAttribute("data-island") ?? "";
    const strategy = element.getAttribute("data-client") ?? "visible";
    let props: Readonly<Record<string, unknown>>;
    try {
      props = readProps(element.getAttribute("data-props"));
    } catch (error) {
      report(error);
      continue;
    }
    schedule(element, strategy, element.getAttribute("data-media") ?? undefined, () => {
      void mount(element, id, props);
    });
  }

  return {
    get hydrated() {
      return hydrated;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}
