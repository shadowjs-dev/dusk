import { describe, expect, it } from "vitest";
import { clientEntrySource, serverEntrySource } from "../../src/vite/virtual";

/**
 * The generated client entry configures the image widths only when `dusk.config.ts` sets them. An app without them
 * gets the same entry as before, with no import of the components (IMG-E1, IMG-E2).
 */
describe("the generated client entry and the image widths", () => {
  const base = {
    base: "",
    generatedTree: "/app/src/routeTree.gen.ts",
    appFile: "/app/src/app.tsx",
  };

  it("[IMG-E1] without configured widths the entry has no image import and no configuration call", () => {
    const source = clientEntrySource(base);
    expect(source).not.toContain("configureImageWidths");
    expect(source).not.toContain("@shadow-js/dusk/components");
  });

  it("[IMG-E2] with configured widths the entry configures them before hydration, with the same numbers the server reads", () => {
    const source = clientEntrySource({ ...base, imageWidths: { deviceSizes: [500, 1000] } });
    expect(source).toContain('import { configureImageWidths } from "@shadow-js/dusk/components";');
    expect(source).toContain('configureImageWidths({"deviceSizes":[500,1000]});');
    expect(source.indexOf("configureImageWidths({")).toBeLessThan(
      source.indexOf("await hydrateDusk("),
    );
  });
});

describe("the generated entries and the mount base", () => {
  const base = { generatedTree: "/app/src/routeTree.gen.ts", appFile: "/app/src/app.tsx" };

  it("[IMG-B5] a mounted client entry sets the image base before hydration; an unmounted one does not", () => {
    const mounted = clientEntrySource({ ...base, base: "/app" });
    expect(mounted).toContain('configureImageBase("/app");');
    expect(mounted.indexOf("configureImageBase(")).toBeLessThan(
      mounted.indexOf("await hydrateDusk("),
    );
    expect(clientEntrySource({ ...base, base: "" })).not.toContain("configureImageBase");
  });

  it("[IMG-B6] a mounted server entry sets the image base before the handler is created", () => {
    const manifestOf = (mount: string) =>
      serverEntrySource({
        dev: false,
        base: mount,
        generatedTree: "/app/src/routeTree.gen.ts",
        appFile: undefined,
        entryServerFile: undefined,
        apiRoutes: [],
        serverFns: [],
        assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      });
    const mounted = manifestOf("/app");
    expect(mounted).toContain('configureImageBase("/app");');
    expect(mounted.indexOf("configureImageBase(")).toBeLessThan(mounted.indexOf("createHandler("));
    expect(manifestOf("")).not.toContain("configureImageBase");
  });
});
