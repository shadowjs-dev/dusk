import { describe, expect, it } from "vitest";
import { type ServerEntryInput, serverEntrySource } from "../../src/vite/virtual";

const BASE: Omit<ServerEntryInput, "dev" | "baked"> = {
  base: "",
  entryServerFile: undefined,
  generatedTree: "/app/src/routeTree.gen.ts",
  appFile: undefined,
  apiRoutes: [],
  serverFns: [],
  assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
};

/** The `duskFeatures` line of a generated entry. */
function featureLine(source: string): string {
  const line = source.split("\n").find((text) => text.startsWith("const duskFeatures = ["));
  if (line === undefined) throw new Error("the entry has no duskFeatures list");
  return line;
}

describe("the generated server entry passes the features the app uses", () => {
  it("[VFG-1] an app with no routing, no revalidate and no draft config passes none of routing(), isr() or draftMode()", () => {
    const source = serverEntrySource({ ...BASE, dev: false });
    expect(featureLine(source)).not.toMatch(/duskRouting|duskIsr|duskDraftMode/);
    expect(source).not.toContain("@shadow-js/dusk/features/routing");
  });

  it("[VFG-2] baked routing passes routing() and imports it from its subpath", () => {
    const source = serverEntrySource({
      ...BASE,
      dev: false,
      baked: {
        skew: { reload: true },
        instrumentation: true,
        routing: { redirects: [{ source: "/old", destination: "/new" }] },
      },
    });
    expect(source).toContain(
      'import { routing as duskRouting } from "@shadow-js/dusk/features/routing";',
    );
    expect(featureLine(source)).toContain("duskRouting()");
  });

  it("[VFG-3] an entry file keeps routing(), isr() and draftMode(), because its options may set them", () => {
    const source = serverEntrySource({
      ...BASE,
      dev: false,
      entryServerFile: "/app/src/entry-server.ts",
    });
    expect(featureLine(source)).toMatch(/duskRouting\(\)/);
    expect(featureLine(source)).toMatch(/duskIsr\(\)/);
    expect(featureLine(source)).toMatch(/duskDraftMode\(\)/);
  });

  it("[VFG-4] a page that revalidates passes isr()", () => {
    const source = serverEntrySource({ ...BASE, dev: false, revalidates: true });
    expect(featureLine(source)).toContain("duskIsr()");
  });

  it("[VFG-5] baked draft config passes draftMode()", () => {
    const source = serverEntrySource({
      ...BASE,
      dev: false,
      baked: {
        skew: { reload: true },
        instrumentation: true,
        draftMode: { secretEnv: "PREVIEW_SECRET" },
      },
    });
    expect(featureLine(source)).toContain("duskDraftMode()");
  });
});
