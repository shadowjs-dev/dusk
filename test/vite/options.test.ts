import { describe, expect, it } from "vitest";
import { dusk } from "../../src/vite/index";
import { type DuskOptions, resolveOptions } from "../../src/vite/options";

describe("dusk options", () => {
  it("[SPLG-01] the plugin set, in the order the transforms must run", () => {
    const names = dusk().map((plugin) => plugin.name);
    expect(names).toEqual([
      "shadowjs:start:server-fn",
      "shadowjs:router",
      "shadowjs:start",
      "shadowjs:start:import-protection",
      "shadowjs",
    ]);
  });

  it("[SPLG-02] import protection can be turned off", () => {
    const names = dusk({ importProtection: false }).map((plugin) => plugin.name);
    expect(names).not.toContain("shadowjs:start:import-protection");
  });

  it.each<[unknown, RegExp]>([
    [{ srcDirectory: "src" }, /unknown option "srcDirectory"; did you mean "srcDir"\?/],
    [{ outdir: "dist" }, /unknown option "outdir"; did you mean "outDir"\?/],
    [{ whatever: 1 }, /unknown option "whatever"$/],
    [{ srcDir: "../outside" }, /srcDir must be a folder inside the project/],
    [{ srcDir: "/abs" }, /srcDir must be a folder inside the project/],
    [{ outDir: "" }, /outDir must be a folder inside the project/],
    [{ maxPreloadsPerRoute: 0 }, /maxPreloadsPerRoute must be an integer from 1 to 1024/],
    [{ maxPreloadsPerRoute: 2.5 }, /maxPreloadsPerRoute/],
    [{ prerender: { concurrency: 0 } }, /prerender.concurrency/],
    [{ prerender: { origin: "not a url" } }, /prerender.origin must be an absolute URL/],
  ])("[SPLG-03] %j is rejected", (options, message) => {
    expect(() => resolveOptions(options as DuskOptions)).toThrow(message);
  });

  it("[SPLG-04] defaults: src, dist, routes inside src, 24 preloads, prerender on", () => {
    const resolved = resolveOptions();
    expect(resolved.srcDir).toBe("src");
    expect(resolved.outDir).toBe("dist");
    expect(resolved.router).toEqual({
      routesDir: "src/routes",
      generatedTree: "src/routeTree.gen.ts",
    });
    expect(resolved.maxPreloadsPerRoute).toBe(24);
    expect(resolved.prerender).toEqual({});
  });

  it("[SPLG-05] srcDir moves the routes and the generated tree with it; explicit router options win", () => {
    expect(resolveOptions({ srcDir: "app" }).router).toEqual({
      routesDir: "app/routes",
      generatedTree: "app/routeTree.gen.ts",
    });
    expect(resolveOptions({ srcDir: "app", router: { routesDir: "pages" } }).router.routesDir).toBe(
      "pages",
    );
    expect(resolveOptions({ srcDir: "app/" }).srcDir).toBe("app");
  });
});
