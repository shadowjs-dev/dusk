import MagicString from "magic-string";
import { describe, expect, it } from "vitest";
import { offsetAt, originalPosition } from "../../src/vite/source-position";

describe("source positions", () => {
  it("[SSPO-01] maps a position after removed and replaced text back to the source line and column", () => {
    const source = [
      "const a = 1;",
      "function gone() {",
      "  return 2;",
      "}",
      "export const k = import.meta.env.X;",
      "",
    ].join("\n");
    const magic = new MagicString(source);
    magic.remove(source.indexOf("function gone"), source.indexOf("export const"));
    magic.prepend("import x from 'y';\n");
    const code = magic.toString();
    const map = magic.generateMap({ hires: "boundary", includeContent: false });
    const generatedOffset = code.indexOf("import.meta.env.X");
    const before = code.slice(0, generatedOffset).split("\n");
    const line = before.length;
    const column = (before[before.length - 1] ?? "").length;
    expect(originalPosition(map, line, column)).toEqual({
      line: 5,
      column: source.split("\n")[4]?.indexOf("import.meta"),
    });
  });

  it("[SSPO-02] text the transform added has no source position", () => {
    const magic = new MagicString("a = 1;\n");
    magic.prepend("import z from 'z';\n");
    const map = magic.generateMap({ hires: "boundary" });
    expect(originalPosition(map, 1, 0)).toBeUndefined();
    expect(originalPosition(map, 9, 0)).toBeUndefined();
  });

  it("[SSPO-03] a malformed mapping is a TypeError, not a wrong answer", () => {
    expect(() => originalPosition({ mappings: "A!AA" }, 1, 0)).toThrow(TypeError);
  });

  it("[SSPO-04] offsetAt inverts line and column, clamped to the text", () => {
    const text = "ab\ncd\nef";
    expect(offsetAt(text, 1, 0)).toBe(0);
    expect(offsetAt(text, 2, 1)).toBe(4);
    expect(offsetAt(text, 3, 1)).toBe(7);
    expect(offsetAt(text, 9, 0)).toBe(text.length);
    expect(offsetAt(text, 1, 99)).toBe(text.length);
  });
});
