import { flushSync } from "@shadow-js/core";
import {
  createMemoryHistory,
  createRouter,
  defineRoute,
  Outlet,
  type RouterFeature,
  RouterProvider,
} from "@shadow-js/router";
import { createComponent, render } from "@shadow-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { duskFeatures } from "../../src/shared/router";

/**
 * The Dusk client's route announcer: a client navigation announces the leaf's merged title (the title the metadata
 * writes) and moves focus to the page heading. `duskFeatures({ announcer: false })` leaves it out.
 */

/** Lets pending promises and the scheduler finish. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 80; tick += 1) await Promise.resolve();
  flushSync();
}

function host(): HTMLElement {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

/** A page whose markup is a `main` landmark holding an h1, as an app's page renders. */
function heading(text: string): Element {
  const main = document.createElement("main");
  const h1 = document.createElement("h1");
  h1.textContent = text;
  main.appendChild(h1);
  return main;
}

afterEach(() => {
  document.body.innerHTML = "";
  for (const node of Array.from(
    document.head.querySelectorAll("[data-shadow-head], [data-shadow-jsonld]"),
  ))
    node.remove();
  document.title = "";
});

/** The router with a layout (the title template) and two pages, on a memory history at `/docs`. */
function appWith(features: RouterFeature[]) {
  const layout = defineRoute("", {
    id: "root",
    metadata: { title: { default: "Malaf", template: "%s · Malaf" } },
    component: () => Outlet(),
    children: [
      defineRoute("/docs", {
        id: "docs",
        metadata: { title: "Docs" },
        component: () => heading("Docs"),
      }),
      defineRoute("/about", {
        id: "about",
        metadata: { title: "About" },
        component: () => heading("About"),
      }),
    ],
  });
  return createRouter({
    routes: [layout],
    features,
    history: createMemoryHistory({ initialEntries: ["/docs"] }),
  });
}

function mount(router: ReturnType<typeof appWith>): void {
  render(
    () =>
      createComponent(RouterProvider, {
        router,
        get children(): unknown {
          return createComponent(Outlet, {});
        },
      }),
    host(),
  );
}

function liveRegion(): Element | null {
  return document.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]');
}

describe("Dusk client: route announcer", () => {
  it("[DUSK-ANN-01 2.4.2 2.4.3] a client navigation announces the merged page title and focuses the page heading", async () => {
    const router = appWith(duskFeatures());
    mount(router);
    await router.ready();
    await settle();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    void router.navigate("/about");
    await settle();
    expect(document.title).toBe("About · Malaf");
    expect(liveRegion()?.textContent).toBe("About · Malaf");
    const heading1 = document.querySelector("h1");
    expect(heading1?.textContent).toBe("About");
    expect(document.activeElement).toBe(heading1);
    router.dispose();
  });

  it("[DUSK-ANN-02] duskFeatures({ announcer: false }) adds no live region and leaves focus alone", async () => {
    const router = appWith(duskFeatures({ announcer: false }));
    mount(router);
    await router.ready();
    await settle();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    void router.navigate("/about");
    await settle();
    expect(document.title).toBe("About · Malaf");
    expect(liveRegion()).toBeNull();
    expect(document.activeElement).toBe(button);
    router.dispose();
  });
});
