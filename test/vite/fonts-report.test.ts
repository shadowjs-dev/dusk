import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fontPreloadsFor, formatFontReport } from "../../src/vite/font-report";
import { defineFonts, type FontDefinition } from "../../src/vite/fonts";

/*
 * What `defineFonts` adds on top of the defaults it already had (font-display, preloads, the size-adjusted fallback):
 * preloads for some routes only, and a report of every file with its size.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A public directory holding files of the given sizes under `fonts/`. */
function publicWith(sizes: Readonly<Record<string, number>>): string {
  const dir = mkdtempSync(join(tmpdir(), "dusk-fonts-report-"));
  dirs.push(dir);
  mkdirSync(join(dir, "fonts"));
  for (const [name, size] of Object.entries(sizes)) {
    writeFileSync(join(dir, "fonts", name), Buffer.alloc(size, 1));
  }
  return dir;
}

const body: FontDefinition = {
  family: "Body",
  files: [
    { file: "fonts/Body.woff2", weight: 400 },
    { file: "fonts/Body-Italic.woff2", weight: 400, style: "italic", preload: false },
  ],
  metrics: false,
};
const display: FontDefinition = {
  family: "Display",
  preload: false,
  files: [{ file: "fonts/Display.woff2", weight: "700" }],
  metrics: false,
};
const mono: FontDefinition = {
  family: "Mono",
  preload: false,
  files: [
    { file: "fonts/Mono.woff2", weight: 400 },
    { file: "fonts/Mono-Latin-Ext.woff2", weight: 400, unicodeRange: "U+0100-024F" },
  ],
  metrics: false,
};
const SIZES = {
  "Body.woff2": 20_480,
  "Body-Italic.woff2": 22_528,
  "Display.woff2": 10_240,
  "Mono.woff2": 5_120,
  "Mono-Latin-Ext.woff2": 2_048,
};

describe("defineFonts: report", () => {
  it("[FNT-R01] the report lists every file with its size and says which ones every page preloads", () => {
    const dir = publicWith(SIZES);
    const { report } = defineFonts({ body, display, mono }, { publicDir: dir });
    expect(report.files.map((file) => [file.key, file.url, file.bytes, file.preloaded])).toEqual([
      ["body", "/fonts/Body.woff2", 20_480, true],
      ["body", "/fonts/Body-Italic.woff2", 22_528, false],
      ["display", "/fonts/Display.woff2", 10_240, false],
      ["mono", "/fonts/Mono.woff2", 5_120, false],
      ["mono", "/fonts/Mono-Latin-Ext.woff2", 2_048, false],
    ]);
    expect(report.totalBytes).toBe(60_416);
    expect(report.preloadedBytes).toBe(20_480);
    expect(report.files[1]).toMatchObject({ family: "Body", style: "italic", weight: "400" });
    expect(report.files[2]?.weight).toBe("700");
  });

  it("[FNT-R02] the text report has a line per file and the totals", () => {
    const dir = publicWith(SIZES);
    const text = formatFontReport(defineFonts({ body, display }, { publicDir: dir }).report);
    const lines = text.split("\n");
    expect(lines[0]).toBe("fonts: 3 files, 52.0 KiB (20.0 KiB preloaded)");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("Body 400");
    expect(lines[1]).toContain("20.0 KiB");
    expect(lines[1]).toContain("preloaded");
    expect(lines[1]).toContain("/fonts/Body.woff2");
    expect(lines[2]).toContain("Body 400 italic");
    expect(lines[2]).not.toContain("preloaded");
    expect(formatFontReport({ files: [], totalBytes: 0, preloadedBytes: 0 })).toBe(
      "fonts: no files",
    );
  });

  it("[FNT-R03] report: a function receives the text, true writes it to the console, absent writes nothing", () => {
    const dir = publicWith(SIZES);
    const received: string[] = [];
    defineFonts({ body }, { publicDir: dir, report: (text) => received.push(text) });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("fonts: 2 files");
    const original = console.info;
    const logged: string[] = [];
    console.info = (message: string) => {
      logged.push(message);
    };
    try {
      defineFonts({ body }, { publicDir: dir, report: true });
      defineFonts({ body }, { publicDir: dir });
    } finally {
      console.info = original;
    }
    expect(logged).toHaveLength(1);
  });
});

describe("defineFonts: preloads per route", () => {
  const options = (dir: string) => ({
    publicDir: dir,
    routes: { "/": ["display"], "/blog/**": ["display", "mono"], "/docs": ["mono"] },
  });

  it("[FNT-R04] a route preloads the files of the families it names, in the order of its list", () => {
    const fonts = defineFonts({ body, display, mono }, options(publicWith(SIZES)));
    const hrefs = (path: string): (string | undefined)[] =>
      fontPreloadsFor(fonts.routePreloads, path, fonts.preloads).map(
        (tag) => tag.props?.["href"] as string,
      );
    expect(hrefs("/")).toEqual(["/fonts/Display.woff2"]);
    expect(hrefs("/blog/post")).toEqual(["/fonts/Display.woff2", "/fonts/Mono.woff2"]);
    expect(hrefs("/docs")).toEqual(["/fonts/Mono.woff2"]);
    expect(hrefs("/pricing")).toEqual([]);
    // The preloads of every page stay as they were: only the family that is preloaded everywhere.
    expect(fonts.preloads.map((tag) => tag.props?.["href"])).toEqual(["/fonts/Body.woff2"]);
  });

  it("[FNT-R05] a unicode-range slice is preloaded on a route only when its file says so, and a tag is never repeated", () => {
    const dir = publicWith(SIZES);
    const plain = defineFonts({ body, mono }, { publicDir: dir, routes: { "/a": ["mono"] } });
    expect(
      fontPreloadsFor(plain.routePreloads, "/a", plain.preloads).map((tag) => tag.props?.["href"]),
    ).toEqual(["/fonts/Mono.woff2"]);
    const sliceOn: FontDefinition = {
      ...mono,
      preload: false,
      files: [
        { file: "fonts/Mono.woff2", weight: 400 },
        { file: "fonts/Mono-Latin-Ext.woff2", unicodeRange: "U+0100-024F", preload: true },
      ],
    };
    // The slice is preloaded by its own setting, so every page has it already; the route adds only the main file.
    const withSlice = defineFonts(
      { body, mono: sliceOn },
      { publicDir: dir, routes: { "/a/**": ["mono"], "/a/b": ["mono"] } },
    );
    expect(withSlice.preloads.map((tag) => tag.props?.["href"])).toEqual([
      "/fonts/Body.woff2",
      "/fonts/Mono-Latin-Ext.woff2",
    ]);
    expect(
      fontPreloadsFor(withSlice.routePreloads, "/a/b", withSlice.preloads).map(
        (tag) => tag.props?.["href"],
      ),
    ).toEqual(["/fonts/Mono.woff2"]);
  });

  it("[FNT-R06] a family that every page already preloads is not repeated for a route", () => {
    const dir = publicWith(SIZES);
    const fonts = defineFonts(
      { body, display },
      { publicDir: dir, routes: { "/**": ["body", "display"] } },
    );
    expect(
      fontPreloadsFor(fonts.routePreloads, "/x/y", fonts.preloads).map(
        (tag) => tag.props?.["href"],
      ),
    ).toEqual(["/fonts/Display.woff2"]);
  });

  it("[FNT-R07] a route that is not a path, a bad glob or an unknown family is refused with its name", () => {
    const dir = publicWith(SIZES);
    expect(() => defineFonts({ body }, { publicDir: dir, routes: { blog: ["body"] } })).toThrow(
      /must start with "\/"/,
    );
    expect(() => defineFonts({ body }, { publicDir: dir, routes: { "/{a": ["body"] } })).toThrow(
      /unbalanced/,
    );
    expect(() => defineFonts({ body }, { publicDir: dir, routes: { "/a": ["nope"] } })).toThrow(
      /"nope".*keys: body/,
    );
    expect(defineFonts({ body }, { publicDir: dir }).routePreloads).toEqual([]);
  });
});
