import { flushSync } from "@shadow-js/core";
import {
  createMemoryHistory,
  createRouter,
  defineRoute,
  Outlet,
  RouterProvider,
} from "@shadow-js/router";
import { createComponent, render } from "@shadow-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { duskFeatures } from "../../src/shared/router";

/*
 * Client navigation into the not-found UI: the layout's `notFound` renders for an unknown path, and its
 * `notFoundMetadata` is merged over the layout's chain in the document head, as the server does. A navigation back to a
 * page removes it again.
 */

async function settle(): Promise<void> {
  for (let tick = 0; tick < 80; tick += 1) await Promise.resolve();
  flushSync();
}

afterEach(() => {
  document.body.innerHTML = "";
  for (const node of Array.from(
    document.head.querySelectorAll("[data-shadow-head], [data-shadow-jsonld]"),
  ))
    node.remove();
  document.title = "";
});

function appAt(path: string) {
  const layout = defineRoute("", {
    id: "root",
    metadata: { title: { default: "Site", template: "%s · Site" } },
    component: () => Outlet(),
    notFound: () => "nothing here",
    notFoundMetadata: { title: "Not found", robots: { index: false } },
    children: [
      defineRoute("/docs", {
        id: "docs",
        metadata: { title: "Docs" },
        component: () => "docs",
      }),
    ],
  });
  return createRouter({
    routes: [layout],
    features: duskFeatures(),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

function mount(router: ReturnType<typeof appAt>): void {
  const element = document.createElement("div");
  document.body.appendChild(element);
  render(
    () =>
      createComponent(RouterProvider, {
        router,
        get children(): unknown {
          return createComponent(Outlet, {});
        },
      }),
    element,
  );
}

describe("client navigation: the not-found UI's metadata", () => {
  it("[NFM-9] a navigation to an unknown path merges the not-found metadata; a page navigation removes it", async () => {
    const router = appAt("/docs");
    mount(router);
    await router.ready();
    await settle();
    expect(document.head.querySelector("title")?.textContent).toBe("Docs · Site");
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();

    await router.navigate("/nothing-here");
    await settle();
    expect(document.head.querySelector("title")?.textContent).toBe("Not found · Site");
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex",
    );

    await router.navigate("/docs");
    await settle();
    expect(document.head.querySelector("title")?.textContent).toBe("Docs · Site");
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });
});
