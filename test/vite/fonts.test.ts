import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineFonts, type FontDefinition } from "../../src/vite/fonts";

/**
 * The offline font path: the files live in `public/` (vendored, no network at build time), and `defineFonts` writes
 * the CSS, the variables and the preloads from them.
 */
let publicDir: string;

beforeEach(() => {
  publicDir = mkdtempSync(join(tmpdir(), "dusk-fonts-"));
  mkdirSync(join(publicDir, "fonts"), { recursive: true });
  for (const name of ["InstrumentSans.woff2", "InstrumentSerif-Italic.woff2", "GeistMono.ttf"]) {
    writeFileSync(join(publicDir, "fonts", name), "font bytes");
  }
});

afterEach(() => {
  rmSync(publicDir, { recursive: true, force: true });
});

const sans: FontDefinition = {
  family: "Instrument Sans",
  variable: "--font-sans",
  files: [
    { file: "fonts/InstrumentSans.woff2", weight: "400 700", stretch: "75% 100%", preload: true },
  ],
  metrics: {
    local: "Arial",
    font: { unitsPerEm: 1000, xWidthAvg: 500, ascender: 960, descender: 240, lineGap: 0 },
    fallback: { unitsPerEm: 2048, xWidthAvg: 904 },
  },
};

describe("defineFonts: the offline path", () => {
  it("[FNT-01] each file becomes an @font-face with its format, weight range, width axis and font-display swap", () => {
    const out = defineFonts({ sans }, { publicDir });
    expect(out.css).toContain(
      '@font-face { font-family: "Instrument Sans"; src: url("/fonts/InstrumentSans.woff2") format("woff2");',
    );
    expect(out.css).toContain("font-weight: 400 700");
    expect(out.css).toContain("font-stretch: 75% 100%");
    expect(out.css).toContain("font-display: swap");
    expect(out.urls).toEqual(["/fonts/InstrumentSans.woff2"]);
  });

  it("[FNT-02] the variable is a font stack: the web font, its size-adjusted fallback, then the generic fallback", () => {
    const out = defineFonts({ sans }, { publicDir });
    expect(out.variables).toEqual({
      "--font-sans": '"Instrument Sans", "Instrument Sans fallback", sans-serif',
    });
    expect(out.css).toContain(
      ':root {\n  --font-sans: "Instrument Sans", "Instrument Sans fallback", sans-serif;\n}',
    );
  });

  it("[FNT-03] the metrics produce a size-adjusted local fallback face", () => {
    const out = defineFonts({ sans }, { publicDir });
    expect(out.css).toContain('font-family: "Instrument Sans fallback"; src: local("Arial");');
    expect(out.css).toContain("size-adjust:");
    expect(out.css).toContain("ascent-override:");
  });

  it("[FNT-04] preload tags are emitted for the files marked preload, with their MIME type and crossorigin", () => {
    const out = defineFonts({ sans }, { publicDir });
    expect(out.preloads).toEqual([
      {
        tag: "link",
        props: {
          rel: "preload",
          as: "font",
          href: "/fonts/InstrumentSans.woff2",
          type: "font/woff2",
          crossorigin: "anonymous",
        },
      },
    ]);
  });

  it("[FNT-05] a Google-style family set (variable sans, italic and normal serif, mono) is one stylesheet", () => {
    const out = defineFonts(
      {
        sans,
        serif: {
          family: "Instrument Serif",
          variable: "--font-serif",
          files: [
            { file: "fonts/InstrumentSerif-Italic.woff2", style: "italic", weight: 400 },
            { file: "fonts/InstrumentSerif-Italic.woff2", style: "normal", weight: 400 },
          ],
          fallback: ["Georgia", "serif"],
        },
        mono: {
          family: "Geist Mono",
          variable: "--font-mono",
          files: [{ file: "fonts/GeistMono.ttf", weight: 400 }],
        },
      },
      { publicDir },
    );
    // Five faces: the sans file, its size-adjusted fallback, the two serif styles, and the mono file.
    expect(out.css.match(/@font-face/g)).toHaveLength(5);
    expect(out.css).toContain('font-family: "Instrument Serif"');
    expect(out.css).toContain("font-style: italic");
    expect(out.css).toContain('format("truetype")');
    expect(out.variables["--font-serif"]).toBe('"Instrument Serif", Georgia, serif');
    expect(out.variables["--font-mono"]).toBe('"Geist Mono", sans-serif');
  });

  it("[FNT-06] a missing file is a build error that names the file and says what to do", () => {
    expect(() =>
      defineFonts(
        { x: { family: "Missing", files: [{ file: "fonts/Nope.woff2" }] } },
        { publicDir },
      ),
    ).toThrow(/public\/fonts\/Nope\.woff2.*Vendor/);
  });

  it("[FNT-07] a file path that could leave public/ is refused before the file is looked at", () => {
    for (const file of [
      "../secret.woff2",
      "/etc/passwd",
      "fonts\\x.woff2",
      "fonts//x.woff2",
      "fonts/./x.woff2",
    ]) {
      expect(() => defineFonts({ x: { family: "Bad", files: [{ file }] } }, { publicDir })).toThrow(
        TypeError,
      );
    }
  });

  it("[FNT-08] the format comes from the extension, and an unknown one needs an explicit format", () => {
    writeFileSync(join(publicDir, "fonts", "InstrumentSans.bin"), "bytes");
    expect(() =>
      defineFonts(
        { x: { family: "Odd", files: [{ file: "fonts/InstrumentSans.bin" }] } },
        { publicDir },
      ),
    ).toThrow(/set format/);
    const out = defineFonts(
      { x: { family: "Odd", files: [{ file: "fonts/InstrumentSans.bin", format: "woff" }] } },
      { publicDir },
    );
    expect(out.css).toContain('format("woff")');
  });

  it("[FNT-09] a variable name that is not a custom property, a repeated one, and an empty family are refused", () => {
    expect(() => defineFonts({ x: { ...sans, variable: "font-sans" } }, { publicDir })).toThrow(
      TypeError,
    );
    expect(() => defineFonts({ a: sans, b: { ...sans, family: "Other" } }, { publicDir })).toThrow(
      /set by two/,
    );
    expect(() => defineFonts({ x: { family: "Empty", files: [] } }, { publicDir })).toThrow(
      /lists no files/,
    );
  });

  it("[FNT-10] the URL prefix is a path under the origin; a protocol-relative prefix is refused", () => {
    expect(defineFonts({ sans }, { publicDir, urlPrefix: "/static" }).urls).toEqual([
      "/static/fonts/InstrumentSans.woff2",
    ]);
    expect(() => defineFonts({ sans }, { publicDir, urlPrefix: "//cdn.example" })).toThrow(
      TypeError,
    );
  });

  it("[FNT-11] a family name that could break the stylesheet is refused by the @font-face rule", () => {
    expect(() =>
      defineFonts(
        { x: { family: 'Bad"; x', files: [{ file: "fonts/InstrumentSans.woff2" }] } },
        { publicDir },
      ),
    ).toThrow(TypeError);
  });

  it("[FNT-12] a bad stretch value is refused (it would be written into the stylesheet)", () => {
    expect(() =>
      defineFonts(
        {
          x: {
            family: "Wide",
            files: [{ file: "fonts/InstrumentSans.woff2", stretch: "wide; x: y" }],
          },
        },
        { publicDir },
      ),
    ).toThrow(TypeError);
  });
});
