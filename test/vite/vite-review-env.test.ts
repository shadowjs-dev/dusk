import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFiles, resolvedValues } from "../../src/vite/env";

describe("env review", () => {
  it("[DUSK-VITE-REV-7] variables named like Object.prototype members are read like any other", () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-env-review-"));
    try {
      writeFileSync(join(dir, ".env"), "constructor=a\ntoString=b\n__proto__=c\nSAFE=d\n");
      writeFileSync(join(dir, ".env.local"), "constructor=e\n");
      const files = readEnvFiles("development", dir);
      expect(files.values["constructor"]).toBe("e");
      expect(files.values["toString"]).toBe("b");
      expect(files.declaredIn["constructor"]).toEqual([".env", ".env.local"]);
      expect(files.sources["constructor"]).toBe(".env.local");
      expect(files.serverNames).toContain("toString");
      expect(Object.getPrototypeOf(files.declaredIn)).toBe(null);
      expect(resolvedValues(files, {})["SAFE"]).toBe("d");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
