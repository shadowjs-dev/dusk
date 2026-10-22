import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  EMPTY_STATE,
  type MetadataState,
  mergeMetadata,
  mergeViewport,
  viewportContent,
} from "../../src/metadata/merge";
import type { Metadata } from "../../src/metadata/types";

/** Merges a list of layers outermost first and returns the final state. */
function chain(...layers: Metadata[]): MetadataState {
  return layers.reduce((state, layer) => mergeMetadata(state, layer), EMPTY_STATE);
}

describe("title templates", () => {
  it("[MD-MERGE-01] a page title is wrapped in the template of the layout above it", () => {
    const state = chain({ title: { default: "Malaf", template: "%s · Malaf" } }, { title: "Docs" });
    expect(state.metadata.title).toBe("Docs · Malaf");
  });

  it("[MD-MERGE-02] without a page title the layout's default is used", () => {
    const state = chain({ title: { default: "Malaf", template: "%s · Malaf" } }, {});
    expect(state.metadata.title).toBe("Malaf");
  });

  it("[MD-MERGE-03] absolute skips the template and wins over the default", () => {
    const state = chain(
      { title: { default: "Malaf", template: "%s · Malaf" } },
      { title: { absolute: "Raw title" } },
    );
    expect(state.metadata.title).toBe("Raw title");
  });

  it("[MD-MERGE-04] template null clears the inherited template for the layers below", () => {
    const state = chain(
      { title: { default: "A", template: "%s | A" } },
      { title: { template: null } },
      { title: "Plain" },
    );
    expect(state.metadata.title).toBe("Plain");
  });

  it("[MD-MERGE-05] the nearest template wins, and the deepest explicit title wins over a shallower one", () => {
    const state = chain(
      { title: { template: "%s · Root" } },
      { title: { template: "%s · Section" } },
      { title: "Page" },
    );
    expect(state.metadata.title).toBe("Page · Section");
    expect(chain({ title: "First" }, { title: "Second" }).metadata.title).toBe("Second");
  });

  it("[MD-MERGE-06] a template without %s is used as the whole title", () => {
    expect(applyTemplate("Fixed", "ignored")).toBe("Fixed");
    expect(applyTemplate("%s!", "hi")).toBe("hi!");
    expect(applyTemplate(undefined, "plain")).toBe("plain");
  });

  it("[MD-MERGE-07] a % in the page title is not treated as a replacement pattern", () => {
    expect(chain({ title: { template: "%s · X" } }, { title: "100%$& done" }).metadata.title).toBe(
      "100%$& done · X",
    );
  });
});

describe("field merging", () => {
  it("[MD-MERGE-10] a field set by a child replaces the field above it as a whole", () => {
    const state = chain(
      { openGraph: { type: "website", title: "Root", siteName: "Malaf" } },
      { openGraph: { type: "article", title: "Page" } },
    );
    expect(state.metadata.openGraph).toEqual({ type: "article", title: "Page" });
  });

  it("[MD-MERGE-11] unset fields are kept, null removes a field", () => {
    const state = chain({ description: "Root", keywords: ["a"] }, { description: null });
    expect(state.metadata.description).toBeUndefined();
    expect(state.metadata.keywords).toEqual(["a"]);
  });

  it("[MD-MERGE-12] other merges key by key; the child's keys win", () => {
    const state = chain({ other: { a: "1", b: "2" } }, { other: { b: "3" } });
    expect(state.metadata.other).toEqual({ a: "1", b: "3" });
  });

  it("[MD-MERGE-13] the merge does not change the layers it was given", () => {
    const root: Metadata = { description: "Root" };
    const page: Metadata = { description: "Page" };
    chain(root, page);
    expect(root.description).toBe("Root");
    expect(page.description).toBe("Page");
  });

  it("[MD-MERGE-14] a title-less chain has no title key at all", () => {
    expect("title" in chain({ description: "x" }).metadata).toBe(false);
  });
});

describe("viewport", () => {
  it("[MD-MERGE-20] viewport fields merge per field, and null removes one", () => {
    const merged = mergeViewport(
      { width: "device-width", initialScale: 1, themeColor: "#000" },
      { initialScale: 2, themeColor: null },
    );
    expect(merged).toEqual({ width: "device-width", initialScale: 2 });
  });

  it("[MD-MERGE-21] viewportContent builds the meta content in a fixed order", () => {
    expect(
      viewportContent({
        width: "device-width",
        initialScale: 1,
        maximumScale: 5,
        userScalable: false,
        viewportFit: "cover",
      }),
    ).toBe(
      "width=device-width, initial-scale=1, maximum-scale=5, user-scalable=no, viewport-fit=cover",
    );
    expect(viewportContent({})).toBeUndefined();
    expect(viewportContent("width=device-width")).toBe("width=device-width");
    expect(viewportContent("")).toBeUndefined();
  });
});
