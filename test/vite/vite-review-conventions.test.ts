import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverConventions } from "../../src/vite/conventions";

let src: string;
beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "dusk-conv-review-"));
  mkdirSync(join(src, "routes"), { recursive: true });
});
afterEach(() => {
  rmSync(src, { recursive: true, force: true });
});

describe("conventions review", () => {
  it("[DUSK-VITE-REV-5] a source file named like an Object.prototype member is not a convention", async () => {
    for (const name of ["constructor.ts", "toString.ts", "valueOf.png", "hasOwnProperty.js"]) {
      writeFileSync(join(src, name), "export default 1;\n");
    }
    writeFileSync(join(src, "robots.ts"), "export default () => ({ rules: [] });\n");
    const found = await discoverConventions(src, []);
    expect(found.entries.map((entry) => entry.fullPath)).toEqual(["/robots.txt"]);
  });

  it("[DUSK-VITE-REV-6] a dangling symbolic link at the top of src does not fail the scan", async () => {
    symlinkSync(join(src, "does-not-exist.ts"), join(src, "stale.ts"));
    writeFileSync(join(src, "robots.ts"), "export default () => ({ rules: [] });\n");
    const found = await discoverConventions(src, []);
    expect(found.entries.map((entry) => entry.fullPath)).toEqual(["/robots.txt"]);
  });
});
