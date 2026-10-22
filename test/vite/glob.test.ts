import { describe, expect, it } from "vitest";
import { compileGlob } from "../../src/vite/glob";

describe("compileGlob", () => {
  it.each<[string, string, boolean]>([
    ["src/**/*.server.ts", "src/a/b/db.server.ts", true],
    ["src/**/*.server.ts", "src/db.server.ts", true],
    ["src/**/*.server.ts", "src/db.client.ts", false],
    ["src/**/*.server.ts", "lib/db.server.ts", false],
    ["**/*.server.{ts,tsx}", "x/y.server.tsx", true],
    ["**/*.server.{ts,tsx}", "x/y.server.jsx", false],
    ["*.ts", "a.ts", true],
    ["*.ts", "dir/a.ts", false],
    ["secrets/**", "secrets/key.txt", true],
    ["secrets/**", "secrets", false],
    ["**/secrets/**", "a/b/secrets/c/d", true],
    ["a?c", "abc", true],
    ["a?c", "a/c", false],
    ["a?c", "ac", false],
    ["file.name+x", "file.name+x", true],
    ["file.name+x", "fileXname+x", false],
    ["(group)/*", "(group)/page", true],
    ["a|b", "a|b", true],
    ["a|b", "a", false],
    ["[id].ts", "[id].ts", true],
    ["[id].ts", "i.ts", false],
    ["**", "any/thing/at/all", true],
    ["{a,b}/c", "a/c", true],
    ["{a,b}/c", "c/c", false],
  ])("[SGLOB-01] %s against %s is %s", (pattern, path, expected) => {
    expect(compileGlob(pattern)(path)).toBe(expected);
  });

  it("[SGLOB-02] an unbalanced brace is an error", () => {
    expect(() => compileGlob("a/{b,c")).toThrow(/unbalanced/);
  });

  it("[SGLOB-03] a hostile pattern cannot make matching slow (linear, no nested quantifiers)", () => {
    const test = compileGlob("**/**/**/**/**/**/x");
    const started = performance.now();
    expect(test(`${"a/".repeat(2000)}y`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
