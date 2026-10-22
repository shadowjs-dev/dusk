import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subsetFont from "subset-font";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codePointsOf } from "../../src/vite/font-subsets";
import { defineFonts, FONT_SUBSETS, type SubsetFontFn, subsetFonts } from "../../src/vite/index";

/** Epunda Sans 400 (SIL Open Font License, see fixtures/fonts): Basic Latin and a little more, no Cyrillic, Greek or Arabic. */
const FONT = readFileSync(join(import.meta.dirname, "fixtures", "fonts", "EpundaSans-400.ttf"));

let root: string;
let publicDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dusk-subsets-"));
  publicDir = join(root, "public");
  mkdirSync(join(publicDir, "fonts"), { recursive: true });
  writeFileSync(join(publicDir, "fonts", "Epunda.ttf"), FONT);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const family = {
  sans: {
    family: "Epunda Sans",
    variable: "--font-sans",
    files: [{ file: "fonts/Epunda.ttf", weight: 400 }],
  },
};

/** The real cutting function, counting its calls. */
function counted(): { cut: SubsetFontFn; calls(): number } {
  let calls = 0;
  const cut: SubsetFontFn = (font, text, options) => {
    calls += 1;
    return subsetFont(Buffer.from(font), text, options);
  };
  return { cut, calls: () => calls };
}

describe("codePointsOf", () => {
  it("[FSUB-1] reads single points, ranges and wildcard blocks, and drops what is not a character", () => {
    expect(codePointsOf("U+0041")).toBe("A");
    expect(codePointsOf("U+0041-0043, U+0061")).toBe("ABCa");
    expect(codePointsOf("U+004?")).toHaveLength(16);
    expect(codePointsOf("U+D7FF-E000")).toBe("퟿");
    expect(codePointsOf("U+10FFFE-110005")).toBe("\u{10FFFE}\u{10FFFF}");
  });

  it("[FSUB-2] a range that runs backwards, or one far too wide, is refused", () => {
    expect(() => codePointsOf("U+0050-0040")).toThrow(RangeError);
    expect(() => codePointsOf("U+0000-FFFFF")).toThrow(/the most is 70000/);
  });

  it("[FSUB-3] every named slice parses and holds characters", () => {
    for (const [name, range] of Object.entries(FONT_SUBSETS)) {
      expect(codePointsOf(range).length, name).toBeGreaterThan(5);
    }
  });
});

describe("subsetFonts", () => {
  it("[FSUB-4] writes one WOFF2 file per slice the font has glyphs for, with its unicode-range, and preloads the first", async () => {
    const made = await subsetFonts(family, {
      publicDir,
      root,
      subsets: ["latin", "latin-ext", { name: "arabic-letters", unicodeRange: "U+0627-063A" }],
    });
    const files = made["sans"]?.files ?? [];
    // Epunda has no Arabic letters: that slice is left out.
    expect(files.map((file) => file.unicodeRange)).toEqual([
      FONT_SUBSETS["latin"],
      FONT_SUBSETS["latin-ext"],
    ]);
    expect(files.map((file) => file.preload)).toEqual([true, false]);
    for (const file of files) {
      expect(file.file).toMatch(/^fonts\/subset\/Epunda-(latin|latin-ext)-[0-9a-f]{8}\.woff2$/);
      expect(file.format).toBe("woff2");
      expect(file.weight).toBe(400);
      const bytes = readFileSync(join(publicDir, file.file));
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
    const latin = readFileSync(join(publicDir, files[0]?.file ?? ""));
    expect(latin.length).toBeLessThan(FONT.length);
  });

  it("[FSUB-5] the families go to defineFonts: one @font-face per slice with its unicode-range, and only the preloaded slice is preloaded", async () => {
    const made = await subsetFonts(family, { publicDir, root, subsets: ["latin", "latin-ext"] });
    const output = defineFonts(made, { publicDir });
    expect(output.css.match(/@font-face/g)?.length).toBeGreaterThanOrEqual(2);
    expect(output.css).toContain(`unicode-range: ${FONT_SUBSETS["latin"]}`);
    expect(output.css).toContain(`unicode-range: ${FONT_SUBSETS["latin-ext"]}`);
    expect(output.preloads).toHaveLength(1);
    expect(JSON.stringify(output.preloads)).toContain("latin-");
    expect(JSON.stringify(output.preloads)).not.toContain("latin-ext");
  });

  it("[FSUB-6] a second call with the same font cuts nothing again, and writes the same files", async () => {
    const first = counted();
    const one = await subsetFonts(family, {
      publicDir,
      root,
      subsets: ["latin"],
      subsetFont: first.cut,
    });
    const callsAfterFirst = first.calls();
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = counted();
    const two = await subsetFonts(family, {
      publicDir,
      root,
      subsets: ["latin"],
      subsetFont: second.cut,
    });
    // Only the call that measures an empty font is made again; no slice is cut.
    expect(second.calls()).toBe(1);
    expect(two["sans"]?.files.map((file) => file.file)).toEqual(
      one["sans"]?.files.map((file) => file.file),
    );
  });

  it("[FSUB-7] your own slices, and which ones to preload", async () => {
    const made = await subsetFonts(family, {
      publicDir,
      root,
      subsets: [{ name: "digits", unicodeRange: "U+0030-0039" }, "latin"],
      preload: ["latin"],
    });
    const files = made["sans"]?.files ?? [];
    expect(files.map((file) => file.unicodeRange)).toEqual(["U+0030-0039", FONT_SUBSETS["latin"]]);
    expect(files.map((file) => file.preload)).toEqual([false, true]);
    expect(files[0]?.file).toMatch(/Epunda-digits-/);
  });

  it("[FSUB-8] a slice name, a range, a path, a missing file and a family without any glyph are refused, naming what is wrong", async () => {
    await expect(subsetFonts(family, { publicDir, root, subsets: ["klingon"] })).rejects.toThrow(
      /"klingon" is not a known slice/,
    );
    await expect(
      subsetFonts(family, {
        publicDir,
        root,
        subsets: [{ name: "Bad Name", unicodeRange: "U+0041" }],
      }),
    ).rejects.toThrow(/lower-case letters, digits and dashes/);
    await expect(
      subsetFonts(family, {
        publicDir,
        root,
        subsets: [{ name: "x", unicodeRange: "U+0041; color: red" }],
      }),
    ).rejects.toThrow(/not a list of U\+ ranges/);
    await expect(
      subsetFonts(family, { publicDir, root, subsets: ["latin", "latin"] }),
    ).rejects.toThrow(/named twice/);
    await expect(subsetFonts(family, { publicDir, root, subsets: [] })).rejects.toThrow(
      /at least one slice/,
    );
    await expect(
      subsetFonts(family, { publicDir, root, subsets: ["latin"], preload: ["greek"] }),
    ).rejects.toThrow(/preload names "greek"/);
    await expect(
      subsetFonts(
        { sans: { family: "X", files: [{ file: "../secret.ttf" }] } },
        { publicDir, root, subsets: ["latin"] },
      ),
    ).rejects.toThrow(/relative path under public/);
    await expect(
      subsetFonts(
        { sans: { family: "X", files: [{ file: "fonts/missing.ttf" }] } },
        { publicDir, root, subsets: ["latin"] },
      ),
    ).rejects.toThrow(/"fonts\/missing\.ttf" of "X" is not under/);
    await expect(
      subsetFonts(family, {
        publicDir,
        root,
        subsets: [{ name: "arabic-letters", unicodeRange: "U+0627-063A" }],
      }),
    ).rejects.toThrow(/no slice of "Epunda Sans" holds a glyph/);
  });

  it("[FSUB-9] a font that cannot be cut names the file, and a missing library says how to install it", async () => {
    writeFileSync(join(publicDir, "fonts", "Broken.ttf"), "not a font at all");
    await expect(
      subsetFonts(
        { broken: { family: "Broken", files: [{ file: "fonts/Broken.ttf" }] } },
        { publicDir, root, subsets: ["latin"] },
      ),
    ).rejects.toThrow(/cannot cut "fonts\/Broken\.ttf" \(Broken\)/);
    await expect(
      subsetFonts(family, {
        publicDir,
        root,
        subsets: ["latin"],
        subsetFont: "subset-font-is-not-installed",
      }),
    ).rejects.toThrow(/npm install --save-dev subset-font-is-not-installed/);
  });

  it("[FSUB-10] no file is written outside the folder of the slices, and the original is left alone", async () => {
    await subsetFonts(family, { publicDir, root, subsets: ["latin"], directory: "fonts/cut" });
    expect(existsSync(join(publicDir, "fonts", "cut"))).toBe(true);
    expect(readFileSync(join(publicDir, "fonts", "Epunda.ttf")).equals(FONT)).toBe(true);
    await expect(
      subsetFonts(family, { publicDir, root, subsets: ["latin"], directory: "../out" }),
    ).rejects.toThrow(/relative path under public/);
  });
});
