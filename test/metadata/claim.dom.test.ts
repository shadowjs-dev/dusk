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
import {
  CLAIM_LAYOUT_METADATA,
  CLAIM_PAGE_METADATA,
  CLAIM_PATH,
  SERVER_HEAD,
} from "./support/claim-head";

/**
 * Hydration of a server-rendered page with metadata: the head the server wrote is in the document, the client
 * renders the same route, and it claims those elements. There is one title, one description and one canonical,
 * and a navigation away and back does not add copies.
 */

async function settle(): Promise<void> {
  for (let tick = 0; tick < 80; tick += 1) await Promise.resolve();
  flushSync();
}

function appAt(path: string) {
  const layout = defineRoute("", {
    id: "root",
    metadata: CLAIM_LAYOUT_METADATA,
    component: () => Outlet(),
    children: [
      defineRoute("/docs", { id: "docs", metadata: CLAIM_PAGE_METADATA, component: () => "docs" }),
      defineRoute("/other", {
        id: "other",
        metadata: { title: "Other" },
        component: () => "other",
      }),
    ],
  });
  return createRouter({
    routes: [layout],
    features: duskFeatures(),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("hydrating a page whose head the server wrote", () => {
  it("[MD-CLAIM-02] the client claims the server's head elements: no duplicate title, description or canonical", async () => {
    document.head.innerHTML = SERVER_HEAD;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const router = appAt(CLAIM_PATH);
    render(
      () =>
        createComponent(RouterProvider, {
          router,
          get children(): unknown {
            return createComponent(Outlet, {});
          },
        }),
      host,
    );
    await router.ready();
    await settle();
    expect(document.head.querySelectorAll("title")).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector("title")?.textContent).toBe("Docs · Malaf");
    expect(document.head.querySelector("title")?.hasAttribute("data-shadow-head")).toBe(true);
  });

  it("[MD-CLAIM-03] a round trip to another page and back leaves one copy of each head element", async () => {
    document.head.innerHTML = SERVER_HEAD;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const router = appAt(CLAIM_PATH);
    render(
      () =>
        createComponent(RouterProvider, {
          router,
          get children(): unknown {
            return createComponent(Outlet, {});
          },
        }),
      host,
    );
    await router.ready();
    await settle();
    void router.navigate("/other");
    await settle();
    expect(document.head.querySelector("title")?.textContent).toBe("Other · Malaf");
    void router.navigate("/docs");
    await settle();
    expect(document.head.querySelectorAll("title")).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.head.querySelector("title")?.textContent).toBe("Docs · Malaf");
  });
});
