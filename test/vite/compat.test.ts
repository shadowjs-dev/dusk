import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Loads `src/vite/compat` against a stand-in for the `vite` module with the given release, so both sides of the
 * version switch run in one test file. The real module cannot be switched: its release is fixed at install.
 */
async function loadCompat(version: string) {
  // Only a Rolldown based Vite (8 and later) exports `rolldownVersion`; `version` is exported by Vite 8 only.
  const rolldown = Number.parseInt(version, 10) >= 8;
  vi.resetModules();
  const transformWithOxc = vi.fn(async (code: string) => ({ code: `oxc:${code}` }));
  const transformWithEsbuild = vi.fn(async (code: string) => ({ code: `esbuild:${code}` }));
  vi.doMock("vite", () => ({
    ...(rolldown ? { version, rolldownVersion: "1.0.0" } : { rollupVersion: "4.0.0" }),
    transformWithOxc,
    transformWithEsbuild,
  }));
  const compat = await import("../../src/vite/compat");
  return { compat, transformWithOxc, transformWithEsbuild };
}

afterEach(() => {
  vi.doUnmock("vite");
  vi.resetModules();
});

describe("[DUSK-VITE-COMPAT] one plugin, two Vite releases", () => {
  it("[DUSK-VITE-COMPAT-1] Vite 8 gets rolldownOptions with the Rolldown only settings", async () => {
    for (const version of ["8.0.0", "8.3.3", "9.1.0"]) {
      const { compat } = await loadCompat(version);
      expect(compat.bundlesWithRolldown, version).toBe(true);
      expect(compat.bundlerOptions({ input: "a.ts" }, { cwd: "/app" }), version).toEqual({
        rolldownOptions: { input: "a.ts", cwd: "/app" },
      });
    }
  });

  it("[DUSK-VITE-COMPAT-2] Vite 7 gets rollupOptions and no Rolldown only setting", async () => {
    for (const version of ["7.0.0", "7.3.7"]) {
      const { compat } = await loadCompat(version);
      expect(compat.bundlesWithRolldown, version).toBe(false);
      expect(compat.bundlerOptions({ input: "a.ts" }, { cwd: "/app" }), version).toEqual({
        rollupOptions: { input: "a.ts" },
      });
    }
  });

  it("[DUSK-VITE-COMPAT-3] the dependency scan reads the ShadowJS JSX runtime under the key each Vite reads, and an app's own choice wins", async () => {
    const eight = (await loadCompat("8.3.3")).compat;
    expect(eight.scanJsxOptions(undefined)).toEqual({
      rolldownOptions: {
        transform: { jsx: { runtime: "automatic", importSource: "@shadow-js/web" } },
      },
    });
    expect(eight.scanJsxOptions({ rolldownOptions: { transform: { jsx: "preserve" } } })).toEqual(
      {},
    );
    const seven = (await loadCompat("7.3.7")).compat;
    expect(seven.scanJsxOptions(undefined)).toEqual({
      esbuildOptions: { jsx: "automatic", jsxImportSource: "@shadow-js/web" },
    });
    expect(seven.scanJsxOptions({ esbuildOptions: { jsx: "preserve" } })).toEqual({});
  });

  it("[DUSK-VITE-COMPAT-4] a module is transformed by Oxc on Vite 8 and by esbuild on Vite 7", async () => {
    const eight = await loadCompat("8.3.3");
    expect(await eight.compat.transformSource("x", "entry.ts")).toEqual({ code: "oxc:x" });
    expect(eight.transformWithEsbuild).not.toHaveBeenCalled();
    const seven = await loadCompat("7.3.7");
    expect(await seven.compat.transformSource("x", "entry.ts")).toEqual({ code: "esbuild:x" });
    expect(seven.transformWithOxc).not.toHaveBeenCalled();
  });
});
