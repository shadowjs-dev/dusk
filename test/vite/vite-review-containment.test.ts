import { describe, expect, it } from "vitest";
import { adapterOutDirConflict } from "../../src/vite/containment";

describe("adapter outDir review", () => {
  const build = "/app/dist";
  const src = "/app/src";

  it("[DUSK-VITE-REV-4] an adapter folder that is or holds the build output, or the sources, is a conflict", () => {
    expect(adapterOutDirConflict("/app/dist", build, src)).toMatch(/build output/);
    expect(adapterOutDirConflict("/app", build, src)).toMatch(/build output/);
    expect(adapterOutDirConflict("/app/src", build, src)).toMatch(/source folder/);
    expect(adapterOutDirConflict("/app/dist/client", build, src)).toMatch(/bundle/);
    expect(adapterOutDirConflict("/app/dist/server/node", build, src)).toMatch(/bundle/);
  });

  it("[DUSK-VITE-REV-4] the first-party layouts (dist/node, .vercel/output) are not conflicts", () => {
    expect(adapterOutDirConflict("/app/dist/node", build, src)).toBeUndefined();
    expect(adapterOutDirConflict("/app/.vercel/output", build, src)).toBeUndefined();
    expect(adapterOutDirConflict("/app/dist-node", build, src)).toBeUndefined();
    expect(adapterOutDirConflict("/app/src-out", build, src)).toBeUndefined();
  });
});
