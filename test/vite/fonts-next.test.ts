import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineFonts, type FontDefinition } from "../../src/vite/fonts";
import { expectedAverage, latinFont } from "./support/font-files";

/*
 * `defineFonts` as Next.js's `next/font` is used: the variables can be set on `<body>` (or any element or class), a
 * size-adjusted fallback is built from the file's own metrics, and every family has class helpers (a font class and a
 * variable class). The local family is a file vendored under a temporary `public/`.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A public directory with one font file: a TrueType file whose OS/2 average width is 512 of 1000 units. */
function publicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dusk-fonts-"));
  dirs.push(dir);
  mkdirSync(join(dir, "fonts"));
  writeFileSync(join(dir, "fonts", "Sans.ttf"), latinFont());
  return dir;
}

// The tests on the variable target and the class helpers are about those, not the fallback face (which is on by default).
const family: FontDefinition = {
  family: "Sans Test",
  variable: "--font-sans",
  files: [{ file: "fonts/Sans.ttf", weight: 400 }],
  metrics: false,
};

describe("defineFonts: the variable target", () => {
  it("[FONT-1] the variables go on :root by default; html, body and a class are the other targets", () => {
    const dir = publicDir();
    const css = (target?: string) =>
      defineFonts(
        { sans: family },
        { publicDir: dir, ...(target === undefined ? {} : { variableTarget: target as never }) },
      ).css;
    expect(css()).toMatch(/^:root \{\n {2}--font-sans: "Sans Test", sans-serif;\n\}/m);
    expect(css("body")).toMatch(/^body \{\n {2}--font-sans:/m);
    expect(css("html")).toMatch(/^html \{\n {2}--font-sans:/m);
    expect(css(".font-vars")).toMatch(/^\.font-vars \{\n {2}--font-sans:/m);
  });

  it("[FONT-1b] a target that is not :root, html, body or a class name is a TypeError", () => {
    const dir = publicDir();
    expect(() =>
      defineFonts({ sans: family }, { publicDir: dir, variableTarget: "div" as never }),
    ).toThrow(/variableTarget/);
    expect(() =>
      defineFonts(
        { sans: family },
        { publicDir: dir, variableTarget: ".a { color: red }" as never },
      ),
    ).toThrow(/variableTarget/);
  });
});

describe("defineFonts: the size-adjusted fallback from the file's metrics", () => {
  it("[FONT-2] metrics.local alone reads the file's metrics and uses the system font's measured width", () => {
    const dir = publicDir();
    const out = defineFonts(
      { sans: { ...family, metrics: { local: "Arial" } } },
      { publicDir: dir },
    );
    // The file: its a-z average over 1000 units per em; Arial's (Next's table): 934.51/2048 em.
    const expected = (expectedAverage() / 1000 / (934.5116279069767 / 2048)) * 100;
    const sizeAdjust = Number(/size-adjust: ([\d.]+)%/.exec(out.css)?.[1]);
    expect(sizeAdjust).toBeCloseTo(expected, 1);
    expect(out.css).toMatch(/font-family: "Sans Test fallback"|font-family: "Sans Test fallback";/);
    expect(out.css).toContain('src: local("Arial")');
    // The fallback is in the stack, before the generic family.
    expect(out.variables["--font-sans"]).toBe('"Sans Test", "Sans Test fallback", sans-serif');
  });

  it("[FONT-2b] a system font without measured values is a TypeError that lists the ones that have them", () => {
    const dir = publicDir();
    expect(() =>
      defineFonts({ sans: { ...family, metrics: { local: "Verdana" } } }, { publicDir: dir }),
    ).toThrow(/Verdana.*Arial.*Times New Roman/);
  });

  it("[FONT-2c] explicit metrics are used as given (Next's table can be passed in)", () => {
    const dir = publicDir();
    const out = defineFonts(
      {
        sans: {
          ...family,
          metrics: {
            local: "Arial",
            font: { unitsPerEm: 1000, xWidthAvg: 458, ascender: 970, descender: -250, lineGap: 0 },
            fallback: { unitsPerEm: 2048, xWidthAvg: 913 },
          },
        },
      },
      { publicDir: dir },
    );
    const expected = (458 / 1000 / (913 / 2048)) * 100;
    expect(Number(/size-adjust: ([\d.]+)%/.exec(out.css)?.[1])).toBeCloseTo(expected, 1);
  });
});

describe("defineFonts: class helpers", () => {
  it("[FONT-4] every family has a font class and, with a variable, a variable class that sets it on the element", () => {
    const dir = publicDir();
    const out = defineFonts(
      {
        sans: family,
        mono: { family: "Mono Test", files: [{ file: "fonts/Sans.ttf" }], metrics: false },
      },
      { publicDir: dir },
    );
    expect(out.classes).toEqual({
      sans: { className: "__dusk_font_sans", variableClass: "__dusk_var_sans" },
      mono: { className: "__dusk_font_mono" },
    });
    expect(out.css).toContain('.__dusk_font_sans { font-family: "Sans Test", sans-serif; }');
    expect(out.css).toContain('.__dusk_var_sans { --font-sans: "Sans Test", sans-serif; }');
    expect(out.css).toContain('.__dusk_font_mono { font-family: "Mono Test", sans-serif; }');
  });

  it("[FONT-4b] two families whose keys give one class name are a TypeError (no silent overwrite)", () => {
    const dir = publicDir();
    expect(() =>
      defineFonts(
        { "Sans!": family, "sans-": { ...family, variable: "--other" } },
        { publicDir: dir },
      ),
    ).toThrow(/same class name/);
  });

  it("[FONT-6] the same input gives the same stylesheet (the build stays deterministic)", () => {
    const dir = publicDir();
    const input = { sans: { ...family, metrics: { local: "Arial" } } };
    expect(defineFonts(input, { publicDir: dir }).css).toBe(
      defineFonts(input, { publicDir: dir }).css,
    );
  });
});
