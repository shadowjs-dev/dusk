import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineFonts, type FontDefinition } from "../../src/vite/fonts";
import { AVERAGE_CHARACTERS, expectedAverage, latinFont } from "./support/font-files";

/*
 * The defaults of `defineFonts`, which follow `next/font`: a font is preloaded (the first declared subset of a Google
 * family), the size-adjusted fallback is built whenever the file's metrics can be read, and a CDN origin gets a
 * preconnect. Explicit options (`preload: false`, `preload: ["latin"]`, `fallback: []`, `fallbackFace: false`) still win.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A public directory holding the given files under `fonts/`. */
function publicWith(files: Readonly<Record<string, Uint8Array | string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "dusk-fonts-defaults-"));
  dirs.push(dir);
  mkdirSync(join(dir, "fonts"));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, "fonts", name), bytes);
  return dir;
}

/** The Arial and Times New Roman a-z averages Next.js measured, per em (934.51 / 2048 and 854.40 / 2048). */
const ARIAL_EM = 934.5116279069767 / 2048;
const TIMES_EM = 854.3953488372093 / 2048;

function sizeAdjustOf(css: string): number {
  return Number(/size-adjust: ([\d.]+)%/.exec(css)?.[1]);
}

const sans: FontDefinition = {
  family: "Sans Test",
  variable: "--font-sans",
  files: [{ file: "fonts/Sans.ttf", weight: 400 }],
};

describe("defineFonts defaults: preload", () => {
  it("[FNT-D01] a self-hosted file is preloaded by default, with no preload option", () => {
    const dir = publicWith({ "Sans.ttf": "bytes" });
    const out = defineFonts({ sans }, { publicDir: dir });
    expect(out.preloads).toEqual([
      {
        tag: "link",
        props: {
          rel: "preload",
          as: "font",
          href: "/fonts/Sans.ttf",
          type: "font/ttf",
          crossorigin: "anonymous",
        },
      },
    ]);
  });

  it("[FNT-D02] preload: false turns it off for a file, or for the family; a file's own value wins over the family's", () => {
    const dir = publicWith({ "A.woff2": "a", "B.woff2": "b" });
    const off = defineFonts(
      { sans: { family: "S", files: [{ file: "fonts/A.woff2", preload: false }] } },
      { publicDir: dir },
    );
    expect(off.preloads).toEqual([]);
    const familyOff = defineFonts(
      {
        sans: {
          family: "S",
          preload: false,
          files: [{ file: "fonts/A.woff2" }, { file: "fonts/B.woff2", preload: true }],
        },
      },
      { publicDir: dir },
    );
    expect(familyOff.preloads.map((tag) => tag.props?.["href"])).toEqual(["/fonts/B.woff2"]);
  });

  it("[FNT-D03] a file that covers only a unicode-range slice is not preloaded by default (it is fetched only when used)", () => {
    const dir = publicWith({ "Latin.woff2": "a", "Cyrillic.woff2": "b" });
    const out = defineFonts(
      {
        sans: {
          family: "S",
          files: [
            { file: "fonts/Latin.woff2" },
            { file: "fonts/Cyrillic.woff2", unicodeRange: "U+0400-045F" },
          ],
        },
      },
      { publicDir: dir },
    );
    expect(out.preloads.map((tag) => tag.props?.["href"])).toEqual(["/fonts/Latin.woff2"]);
    const explicit = defineFonts(
      {
        sans: {
          family: "S",
          files: [{ file: "fonts/Cyrillic.woff2", unicodeRange: "U+0400-045F", preload: true }],
        },
      },
      { publicDir: dir },
    );
    expect(explicit.preloads).toHaveLength(1);
  });
});

describe("defineFonts defaults: the size-adjusted fallback", () => {
  it("[FNT-D04] a font whose metrics can be read gets a size-adjusted fallback face by default, from the a-z average width", () => {
    const dir = publicWith({ "Sans.ttf": latinFont() });
    const out = defineFonts({ sans }, { publicDir: dir });
    expect(out.css).toContain('font-family: "Sans Test fallback"; src: local("Arial");');
    expect(sizeAdjustOf(out.css)).toBeCloseTo((expectedAverage() / 1000 / ARIAL_EM) * 100, 1);
    expect(out.variables["--font-sans"]).toBe('"Sans Test", "Sans Test fallback", sans-serif');
  });

  it("[FNT-D05] a serif stack builds the fallback from Times New Roman, any other stack from Arial", () => {
    const dir = publicWith({ "Sans.ttf": latinFont() });
    const serif = defineFonts(
      { sans: { ...sans, fallback: ["Georgia", "serif"] } },
      { publicDir: dir },
    );
    expect(serif.css).toContain('src: local("Times New Roman")');
    expect(sizeAdjustOf(serif.css)).toBeCloseTo((expectedAverage() / 1000 / TIMES_EM) * 100, 1);
    const mono = defineFonts(
      { sans: { ...sans, fallback: ["ui-monospace", "monospace"] } },
      { publicDir: dir },
    );
    expect(mono.css).toContain('src: local("Arial")');
  });

  it("[FNT-D06] metrics: false turns the fallback face off", () => {
    const dir = publicWith({ "Sans.ttf": latinFont() });
    const out = defineFonts({ sans: { ...sans, metrics: false } }, { publicDir: dir });
    expect(out.css).not.toContain("fallback");
    expect(out.variables["--font-sans"]).toBe('"Sans Test", sans-serif');
  });

  it("[FNT-D07] a file that is not a readable font is not an error by default: no fallback face, the family still builds", () => {
    const dir = publicWith({ "Sans.ttf": "not a font" });
    const out = defineFonts({ sans }, { publicDir: dir });
    expect(out.css).not.toContain("fallback");
    expect(out.urls).toEqual(["/fonts/Sans.ttf"]);
  });

  it("[FNT-D08] a missing file is still the build error that names it (the default fallback does not hide it)", () => {
    const dir = publicWith({});
    expect(() => defineFonts({ sans }, { publicDir: dir })).toThrow(/public\/fonts\/Sans\.ttf/);
  });

  it("[FNT-D09] an explicit metrics.local on an unreadable file is still an error (only the default is lenient)", () => {
    const dir = publicWith({ "Sans.ttf": "not a font" });
    expect(() =>
      defineFonts({ sans: { ...sans, metrics: { local: "Arial" } } }, { publicDir: dir }),
    ).toThrow(/not a TrueType, OpenType, WOFF or WOFF2/);
  });

  it("[FNT-D10] a font without the Latin letters keeps the fallback at 100% width, with the vertical overrides scaled by it", () => {
    const dir = publicWith({ "Sans.ttf": latinFont({ lastLetter: "y" }) });
    const out = defineFonts({ sans }, { publicDir: dir });
    expect(sizeAdjustOf(out.css)).toBe(100);
    expect(out.css).toContain("ascent-override: 90%");
  });

  it("[FNT-D11] the face with the Latin letters measures the fallback: a file without them is skipped for one that has them", () => {
    const dir = publicWith({
      "Cyrillic.ttf": latinFont({ lastLetter: "y" }),
      "Sans.ttf": latinFont(),
    });
    const out = defineFonts(
      {
        sans: {
          ...sans,
          files: [
            { file: "fonts/Cyrillic.ttf", unicodeRange: "U+0400-045F" },
            { file: "fonts/Sans.ttf" },
          ],
        },
      },
      { publicDir: dir },
    );
    expect(sizeAdjustOf(out.css)).toBeCloseTo((expectedAverage() / 1000 / ARIAL_EM) * 100, 1);
  });

  it("[FNT-D12] the average characters are Next's, spaces included", () => {
    expect(AVERAGE_CHARACTERS).toBe("aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ");
  });
});

describe("defineFonts defaults: preconnect", () => {
  it("[FNT-D13] without assetOrigin there is no preconnect and the URLs stay on the app's origin", () => {
    const dir = publicWith({ "Sans.ttf": "bytes" });
    const out = defineFonts({ sans }, { publicDir: dir });
    expect(out.preconnects).toEqual([]);
    expect(out.urls).toEqual(["/fonts/Sans.ttf"]);
  });

  it("[FNT-D14] with assetOrigin the files are served from it, and one preconnect link (CORS mode, as fonts are) opens the connection", () => {
    const dir = publicWith({ "Sans.ttf": "bytes" });
    const out = defineFonts({ sans }, { publicDir: dir, assetOrigin: "https://cdn.example/" });
    expect(out.preconnects).toEqual([
      {
        tag: "link",
        props: { rel: "preconnect", href: "https://cdn.example", crossorigin: "anonymous" },
      },
    ]);
    expect(out.urls).toEqual(["https://cdn.example/fonts/Sans.ttf"]);
    expect(out.preloads.map((tag) => tag.props?.["href"])).toEqual([
      "https://cdn.example/fonts/Sans.ttf",
    ]);
    expect(out.css).toContain('url("https://cdn.example/fonts/Sans.ttf")');
  });

  it("[FNT-D15] an assetOrigin that is not a bare http(s) origin is a TypeError", () => {
    const dir = publicWith({ "Sans.ttf": "bytes" });
    for (const assetOrigin of [
      "cdn.example",
      "https://cdn.example/path",
      "ftp://cdn.example",
      "https://u:p@cdn.example",
    ]) {
      expect(() => defineFonts({ sans }, { publicDir: dir, assetOrigin })).toThrow(TypeError);
    }
  });
});
