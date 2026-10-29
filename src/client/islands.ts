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

/** The props attribute, read back: plain data written by `islandAttributes`. A bad value goes to `report`. */
function readProps(
  text: string | null,
  report: (error: unknown) => void,
): Readonly<Record<string, unknown>> | undefined {
  let cause: unknown;
  try {
    const value: unknown = text === null ? {} : JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    cause = error;
  }
  // Only a parse failure has a cause: a value that parsed but is not an object has none.
  report(
    new IslandPropsError(
      __DEV__
        ? cause === undefined
          ? "the props of an island must be a JSON object"
          : "the props of an island are not valid JSON"
        : "DUSK_ISLAND_2",
      cause,
    ),
  );
  return undefined;
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

  /** Mounts the island of `element` once, when its strategy fires. */
  const schedule = (element: Element, props: Readonly<Record<string, unknown>>): void => {
    // The selector of the loop below guarantees `data-island`.
    const id = element.getAttribute("data-island") as string;
    const strategy = element.getAttribute("data-client") ?? "visible";
    let started = false;
    // What waits for the strategy to fire (an observer, a listener, a timer). Every wait is released when the island
    // starts or the handle is disposed; releasing twice is harmless.
    let stop: (() => void) | undefined;
    const once = (): void => {
      if (started || disposed) return;
      started = true;
      stop?.();
      void mount();
    };
    const mount = async (): Promise<void> => {
      try {
        const load = Object.hasOwn(options.registry, id) ? options.registry[id] : undefined;
        if (load === undefined)
          throw new Error(
            __DEV__ ? `island "${id}" is not in the registry` : `DUSK_ISLAND_3 ${id}`,
          );
        const loaded = await load();
        const component = typeof loaded === "function" ? loaded : loaded.default;
        if (typeof component !== "function")
          throw new TypeError(
            __DEV__ ? `island "${id}" does not export a component` : `DUSK_ISLAND_1 ${id}`,
          );
        if (disposed) return;
        // `only` islands have no server markup: they are rendered, not hydrated.
        if (strategy !== "only") {
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
    const media = element.getAttribute("data-media");
    if (strategy === "visible" && typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) once();
      });
      observer.observe(element);
      stop = () => observer.disconnect();
    } else if (strategy === "idle") {
      // An idle handle and a timer handle live in different id spaces: each is canceled by its own function, or
      // `clearTimeout` could cancel an unrelated timer of the page that happens to hold the same number.
      const idle = typeof requestIdleCallback === "function";
      const handle = idle ? requestIdleCallback(once) : setTimeout(once, 1);
      stop = () => (idle ? cancelIdleCallback(handle as number) : clearTimeout(handle));
    } else if (strategy === "interaction") {
      const events = ["pointerdown", "focusin", "keydown"] as const;
      for (const type of events) element.addEventListener(type, once, { passive: true });
      stop = () => {
        for (const type of events) element.removeEventListener(type, once);
      };
    } else if (strategy === "media" && media !== null && typeof matchMedia === "function") {
      const query = matchMedia(media);
      const check = (): void => {
        if (query.matches) once();
      };
      query.addEventListener("change", check);
      stop = () => query.removeEventListener("change", check);
      check();
    } else {
      // `load`, `only`, visible without an IntersectionObserver, or a media strategy without a usable query: mount now
      // rather than never.
      once();
      return;
    }
    disposers.push(stop);
  };

  for (const element of root.querySelectorAll("[data-island]")) {
    // An island inside another island is left to its outer one.
    if (element.parentElement?.closest("[data-island]")) continue;
    const props = readProps(element.getAttribute("data-props"), report);
    if (props !== undefined) schedule(element, props);
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
