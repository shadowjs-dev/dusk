import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dusk } from "../../src/vite";
import type { DuskCorePlugin } from "../../src/vite/plugin";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dusk-plugin-review-"));
  mkdirSync(join(root, "src", "routes"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function coreOf(plugins: Plugin[]): DuskCorePlugin {
  const core = plugins.find((plugin) => plugin.name === "shadowjs:start");
  if (core === undefined) throw new Error("the core plugin is missing");
  return core as DuskCorePlugin;
}

async function configure(userConfig: {
  root: string;
  envDir?: string | false;
}): Promise<DuskCorePlugin> {
  const core = coreOf(dusk());
  const hook = core.config;
  if (typeof hook !== "function") throw new Error("the core plugin has no config hook");
  await hook.call({} as never, userConfig, { mode: "development", command: "serve" });
  return core;
}

describe("core plugin review", () => {
  it("[DUSK-VITE-REV-10] a relative envDir is read from the project root, not from the working folder", async () => {
    mkdirSync(join(root, "envs"));
    writeFileSync(join(root, "envs", ".env"), "REVIEW_ONLY_NAME=1\n");
    const core = await configure({ root, envDir: "envs" });
    expect(core.api.envFiles).toEqual([".env"]);
  });
});
