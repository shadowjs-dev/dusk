import { describe, expect, it } from "vitest";
import { buildDirLabel, buildDirOf } from "../../src/cli/build";

describe("dusk build: where the build wrote", () => {
  it("[DUSK-CLI-REV-1] the output folder is the parent of the client build's folder, wherever dusk({ outDir }) put it", () => {
    const at = (outDir: string) => ({
      root: "/app",
      environments: { client: { build: { outDir } } },
    });
    expect(buildDirOf(at("/app/dist/client"))).toBe("/app/dist");
    expect(buildDirOf(at("/app/out/client"))).toBe("/app/out");
    expect(buildDirOf(at("build/client"))).toBe("/app/build");
  });

  it("[DUSK-CLI-REV-1] without a client environment the default folder is read", () => {
    expect(buildDirOf({ root: "/app", environments: {} })).toBe("/app/dist");
  });
});

describe("dusk build: the folder the summary prints", () => {
  it("[DUSK-R5-3] the label is the build folder relative to the app, with / separators; dist by default", () => {
    expect(buildDirLabel("/app", "/app/dist")).toBe("dist");
    expect(buildDirLabel("/app", "/app/build/out")).toBe("build/out");
    expect(buildDirLabel("/app/web", "/app/shared/out")).toBe("../shared/out");
  });
});
