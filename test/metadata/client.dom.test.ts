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
import { metadataFeature } from "../../src/metadata/feature";
import { chainHead, resolveChain } from "../../src/metadata/resolve";
import { duskFeatures } from "../../src/shared/router";

/**
 * Client navigation of the metadata API: the leaf of the matched chain applies the merged metadata to the
 * document head, a navigation replaces it, an async generator lands when it resolves, and JSON-LD scripts follow
 * the page. The layout's metadata is applied once, by the leaf (no duplicate title elements).
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

afterEach(() => {
  document.body.innerHTML = "";
  for (const node of Array.from(
    document.head.querySelectorAll("[data-shadow-head], [data-shadow-jsonld]"),
  ))
    node.remove();
  document.title = "";
});

/** The router with the layout and the given pages, on a memory history at `path`. */
function appAt(path: string, pages: ReturnType<typeof defineRoute>[]) {
  const layout = defineRoute("", {
    id: "root",
    metadata: {
      title: { default: "Malaf", template: "%s · Malaf" },
      description: "Root description",
      alternates: { canonical: "https://malaf.test/" },
    },
    component: () => Outlet(),
    children: pages,
  });
  return createRouter({
    routes: [layout],
    features: duskFeatures(),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
}

function mount(router: ReturnType<typeof appAt>): void {
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

function headTitle(): string | null {
  return document.head.querySelector("title")?.textContent ?? null;
}

function headMeta(name: string): string | null {
  return document.head.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
}

describe("client navigation: metadata in the document head", () => {
  it("[MD-DOM-01] the first render writes the leaf's merged title and description, with data-shadow-head marks", async () => {
    const router = appAt("/docs", [
      defineRoute("/docs", {
        id: "docs",
        metadata: { title: "Docs", description: "How to use it" },
        component: () => "docs",
      }),
    ]);
    mount(router);
    await router.ready();
    await settle();
    expect(headTitle()).toBe("Docs · Malaf");
    expect(headMeta("description")).toBe("How to use it");
    expect(document.head.querySelectorAll("title")).toHaveLength(1);
    expect(document.head.querySelector("title")?.hasAttribute("data-shadow-head")).toBe(true);
  });

  it("[MD-DOM-02] a navigation replaces the title; a description the new page does not set is removed", async () => {
    const router = appAt("/docs", [
      defineRoute("/docs", {
        id: "docs",
        metadata: { title: "Docs", description: "How to use it" },
        component: () => "docs",
      }),
      defineRoute("/about", {
        id: "about",
        metadata: { title: "About" },
        component: () => "about",
      }),
    ]);
    mount(router);
    await router.ready();
    await settle();
    void router.navigate("/about");
    await settle();
    expect(headTitle()).toBe("About · Malaf");
    expect(headMeta("description")).toBe("Root description");
  });

  it("[MD-DOM-03] an async generateMetadata lands when its promise resolves, and only the leaf is applied", async () => {
    const router = appAt("/", [
      defineRoute("/", { id: "home", metadata: { title: "Home" }, component: () => "home" }),
      defineRoute("/posts/:id", {
        id: "post",
        generateMetadata: async ({ params }: { params: Readonly<Record<string, string>> }) => ({
          title: `Post ${params["id"]}`,
        }),
        component: () => "post",
      }),
    ]);
    mount(router);
    await router.ready();
    await settle();
    void router.navigate("/posts/7");
    await settle();
    expect(headTitle()).toBe("Post 7 · Malaf");
    expect(document.head.querySelectorAll("title")).toHaveLength(1);
  });

  it("[MD-DOM-04] JSON-LD scripts follow the page: a page with jsonLd writes one script, and leaving it removes the script", async () => {
    const router = appAt("/", [
      defineRoute("/", { id: "home", metadata: { title: "Home" }, component: () => "home" }),
      defineRoute("/product", {
        id: "product",
        metadata: {
          title: "Product",
          jsonLd: {
            "@context": "https://schema.org",
            "@type": "Product",
            name: "A </script> thing",
          },
        },
        component: () => "product",
      }),
    ]);
    mount(router);
    await router.ready();
    await settle();
    expect(document.head.querySelectorAll("script[data-shadow-jsonld]")).toHaveLength(0);
    void router.navigate("/product");
    await settle();
    const scripts = document.head.querySelectorAll(
      'script[type="application/ld+json"][data-shadow-jsonld]',
    );
    expect(scripts).toHaveLength(1);
    expect(JSON.parse(scripts[0]?.textContent ?? "null")).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "A </script> thing",
    });
    void router.navigate("/");
    await settle();
    expect(document.head.querySelectorAll("script[data-shadow-jsonld]")).toHaveLength(0);
  });

  it("[MD-DOM-05] the client writes the same tags the server's chain produces for the same route", async () => {
    const page = defineRoute("/docs", {
      id: "docs",
      metadata: {
        title: "Docs",
        description: "How to use it",
        openGraph: { images: ["/a.png", "/b.png"] },
      },
      component: () => "docs",
    });
    const router = appAt("/docs", [page]);
    mount(router);
    await router.ready();
    await settle();
    const expected = chainHead(
      await resolveChain(
        [
          {
            id: "root",
            params: {},
            loaderData: undefined,
            metadata: {
              title: { default: "Malaf", template: "%s · Malaf" },
              description: "Root description",
              alternates: { canonical: "https://malaf.test/" },
            },
          },
          {
            id: "docs",
            params: {},
            loaderData: undefined,
            metadata: {
              title: "Docs",
              description: "How to use it",
              openGraph: { images: ["/a.png", "/b.png"] },
            },
          },
        ],
        { search: {} },
        () => undefined,
      ),
    );
    const ogImages = Array.from(document.head.querySelectorAll('meta[property="og:image"]')).map(
      (node) => node.getAttribute("content"),
    );
    expect(ogImages).toEqual(
      expected.tags
        .filter((tag) => tag.props?.["property"] === "og:image")
        .map((tag) => tag.props?.["content"]),
    );
    expect(headTitle()).toBe("Docs · Malaf");
  });

  it("[MD-DOM-06] a router without the metadata feature refuses a route that exports metadata", () => {
    expect(() =>
      createRouter({
        routes: [
          defineRoute("/", { id: "home", metadata: { title: "Home" }, component: () => "home" }),
        ],
        history: createMemoryHistory({ initialEntries: ["/"] }),
        features: [],
      }),
    ).toThrow(/metadata/);
  });

  it("[MD-DOM-07] the feature installs into any router; metadataFeature() alone applies metadata", async () => {
    const layout = defineRoute("", {
      id: "root",
      metadata: { title: "Only" },
      component: () => Outlet(),
      children: [defineRoute("/", { id: "home", component: () => "home" })],
    });
    const router = createRouter({
      routes: [layout],
      features: [metadataFeature()],
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    mount(router);
    await router.ready();
    await settle();
    expect(headTitle()).toBe("Only");
  });
});
