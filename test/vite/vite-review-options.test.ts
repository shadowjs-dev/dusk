import { describe, expect, it } from "vitest";
import { resolveOptions } from "../../src/vite/options";

describe("options review", () => {
  it("[DUSK-VITE-REV-2] an outDir that is the project root is refused (the build empties outDir)", () => {
    for (const outDir of [".", "./", "./.", ".//"]) {
      expect(() => resolveOptions({ outDir }), outDir).toThrow(
        /outDir must be a folder of its own/,
      );
    }
  });

  it("[DUSK-VITE-REV-2] an outDir that is, or holds, the source folder is refused", () => {
    expect(() => resolveOptions({ outDir: "src" })).toThrow(/holds the source folder/);
    expect(() => resolveOptions({ outDir: "./src/" })).toThrow(/holds the source folder/);
    expect(() => resolveOptions({ srcDir: "app/src", outDir: "app" })).toThrow(
      /holds the source folder/,
    );
  });

  it("[DUSK-VITE-REV-2] a folder next to or inside the source folder is still a fine outDir", () => {
    expect(resolveOptions({ outDir: "build" }).outDir).toBe("build");
    expect(resolveOptions({ srcDir: "app", outDir: "app-dist" }).outDir).toBe("app-dist");
    expect(resolveOptions({ srcDir: "src", outDir: "src-out" }).outDir).toBe("src-out");
  });

  it("[DUSK-VITE-REV-3] a Windows drive path is not a folder inside the project, on any OS", () => {
    expect(() => resolveOptions({ outDir: "C:\\out" })).toThrow(/inside the project/);
    expect(() => resolveOptions({ srcDir: "D:/code" })).toThrow(/inside the project/);
  });
});
