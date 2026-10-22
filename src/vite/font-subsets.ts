import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { checkedPath, type FontDefinition, type FontFile } from "./fonts";

/**
 * Build-time font subsetting. A family that ships one file with every script it supports makes each visitor download all of
 * it. `subsetFonts` cuts such a file into slices by Unicode range (`latin`, `latin-ext`, `arabic`, ...), writes each slice as
 * a WOFF2 file under `public/`, and returns the family with one `@font-face` per slice and its `unicode-range`: the browser
 * then fetches only the slices whose characters the page uses. Build time only (Node). The cutting is done by `subset-font`
 * (HarfBuzz), an optional peer: without it the call throws an error that says how to install it.
 * @packageDocumentation
 */

/**
 * The Unicode ranges of the usual scripts, the same slices Google Fonts serves, as `unicode-range` values. The keys name the
 * slices in {@link SubsetFontsOptions.subsets}.
 * @since 1.0.0
 * @example
 * ```ts
 * import { FONT_SUBSETS } from "@shadow-js/dusk/vite";
 *
 * console.log(Object.keys(FONT_SUBSETS).includes("latin")); // true
 * ```
 */
export const FONT_SUBSETS: Readonly<Record<string, string>> = Object.freeze({
  latin:
    "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  "latin-ext":
    "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
  vietnamese:
    "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
  cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
  "cyrillic-ext": "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F",
  greek: "U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF",
  arabic:
    "U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0898-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC",
  hebrew: "U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F",
  devanagari:
    "U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+20F0, U+25CC, U+A830-A839, U+A8E0-A8FF, U+11B00-11B09",
});

/**
 * The function that cuts a font down to the characters of a string, in the shape of `subset-font`: the font file, the text
 * whose glyphs stay, and the options. It answers the new font.
 * @since 1.0.0
 */
export type SubsetFontFn = (
  font: Uint8Array,
  text: string,
  options: { readonly targetFormat: "woff2" },
) => Promise<Uint8Array>;

/** One slice to make: a name for the file, and the `unicode-range` it covers. @since 1.0.0 */
export interface FontSubset {
  /** Letters, digits and dashes: it is part of the file's name. */
  readonly name: string;
  /** A CSS `unicode-range` value such as `U+0000-00FF, U+0131`. */
  readonly unicodeRange: string;
}

/** Options of {@link subsetFonts}. @since 1.0.0 */
export interface SubsetFontsOptions {
  /** The `public/` folder the font files are read from and the slices are written to. */
  readonly publicDir: string;
  /**
   * The slices to make: names from {@link FONT_SUBSETS}, or your own `{ name, unicodeRange }`. Default `["latin", "latin-ext"]`.
   */
  readonly subsets?: readonly (string | FontSubset)[];
  /** Names of the slices a page preloads. Default: the first slice. A slice that is not preloaded is fetched when its characters are used. */
  readonly preload?: readonly string[];
  /** The folder of the slices under `publicDir`. Default `fonts/subset`. */
  readonly directory?: string;
  /** Where finished slices are kept between builds. Default: `node_modules/.cache/dusk/font-subsets` under `root`. */
  readonly cacheDir?: string;
  /** The project root, for the default cache folder. Default `process.cwd()`. */
  readonly root?: string;
  /** The cutting function, or the name of the module to import it from. Default `"subset-font"`, an optional peer. */
  readonly subsetFont?: string | SubsetFontFn;
}

const CACHE_VERSION = "1";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RANGE =
  /^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:\s*,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/i;
/** Most characters one slice may hold: the widest range of the table is about 25,000. */
const MAX_CODE_POINTS = 70_000;

/** Loads the cutting function from a module name, or explains how to install it. */
async function loadSubsetFont(specifier: string): Promise<SubsetFontFn> {
  let loaded: { default?: unknown };
  try {
    loaded = (await import(specifier)) as { default?: unknown };
  } catch (cause) {
    throw new Error(
      `subsetFonts: cannot load "${specifier}". Install it with "npm install --save-dev ${specifier}", or pass your own function as subsetFont.`,
      { cause },
    );
  }
  if (typeof loaded.default !== "function") {
    throw new TypeError(`subsetFonts: the module "${specifier}" has no default function.`);
  }
  const factory = loaded.default;
  return (font, text, options) =>
    Reflect.apply(factory, undefined, [Buffer.from(font), text, options]) as Promise<Uint8Array>;
}

/** One `unicode-range` item as a start and an end code point; a `?` stands for any digit (a block of 16, 256, ...). */
function boundsOf(part: string): [number, number] {
  const text = part.trim().slice(2);
  const [from, to] = text.includes("?")
    ? [text.replaceAll("?", "0"), text.replaceAll("?", "F")]
    : text.split("-");
  const start = Number.parseInt(from ?? "", 16);
  const end = to === undefined ? start : Number.parseInt(to, 16);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new RangeError(`subsetFonts: "${part.trim()}" is not a range.`);
  }
  return [start, end];
}

/**
 * The characters a `unicode-range` value names, as a string. A point that is not a character (a surrogate, or one past
 * U+10FFFF) is left out.
 *
 * @param range A list of `U+` points and ranges.
 * @returns The characters, in the order of the list.
 * @throws RangeError for a range that runs backwards or one that names more than 70,000 characters.
 * @example codePointsOf("U+0041-0043, U+0061"); // "ABCa"
 * @since 1.0.0
 */
export function codePointsOf(range: string): string {
  const bounds = range.split(",").map(boundsOf);
  const total = bounds.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
  if (total > MAX_CODE_POINTS) {
    throw new RangeError(
      `subsetFonts: a range holds ${total} characters; the most is ${MAX_CODE_POINTS}.`,
    );
  }
  let text = "";
  for (const [start, end] of bounds) {
    for (let point = start; point <= end; point += 1) {
      if (point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff))
        text += String.fromCodePoint(point);
    }
  }
  return text;
}

function resolveSubsets(subsets: readonly (string | FontSubset)[]): FontSubset[] {
  if (subsets.length === 0)
    throw new TypeError("subsetFonts: subsets must name at least one slice.");
  const seen = new Set<string>();
  return subsets.map((subset) => {
    const resolved: FontSubset =
      typeof subset === "string"
        ? { name: subset, unicodeRange: FONT_SUBSETS[subset] ?? "" }
        : subset;
    if (resolved.unicodeRange === "") {
      throw new TypeError(
        `subsetFonts: "${String(subset)}" is not a known slice (${Object.keys(FONT_SUBSETS).join(", ")}); give { name, unicodeRange } for your own.`,
      );
    }
    if (!NAME.test(resolved.name)) {
      throw new TypeError(
        `subsetFonts: the slice name ${JSON.stringify(resolved.name)} must be lower-case letters, digits and dashes.`,
      );
    }
    if (!RANGE.test(resolved.unicodeRange)) {
      throw new TypeError(
        `subsetFonts: the unicode-range of "${resolved.name}" is not a list of U+ ranges: ${JSON.stringify(resolved.unicodeRange)}.`,
      );
    }
    if (seen.has(resolved.name))
      throw new TypeError(`subsetFonts: the slice "${resolved.name}" is named twice.`);
    seen.add(resolved.name);
    return resolved;
  });
}

/** A file stem that is safe in a URL and a file name. */
function stemOf(file: string): string {
  const base = posix.basename(file, posix.extname(file));
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return clean === "" ? "font" : clean.slice(0, 64);
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * Cuts the local font files of some families into slices by Unicode range, and returns the families with the slices as their
 * files. The slices are WOFF2 files written under `public/` (named from the file, the slice and a hash of its content), so
 * `defineFonts` preloads, measures and serves them like any other local file; each carries its `unicode-range`, so a browser
 * downloads only the slices a page needs. A slice the font has no glyph for (a Latin font has no Arabic) is left out. The
 * finished slices are kept in a cache folder, keyed by the font's bytes and the slice, so an unchanged font is not cut again.
 *
 * @param fonts The families, as `defineFonts` takes them; each file is a font under `public/`.
 * @param options The `public/` folder, the slices and where things go.
 * @returns The same families with the slices as files, in the order of the slices.
 * @throws TypeError for a slice name or range that is not valid, or a file path that leaves `public/`.
 * @throws Error when a file is missing or cannot be cut, naming it, or when the cutting library is not installed.
 * @example
 * import { defineFonts, subsetFonts } from "@shadow-js/dusk/vite";
 *
 * const families = await subsetFonts(
 *   { sans: { family: "Inter", variable: "--font-sans", files: [{ file: "fonts/Inter.ttf", weight: "100 900" }] } },
 *   { publicDir: "public", subsets: ["latin", "latin-ext", "arabic"] },
 * );
 * export const fonts = defineFonts(families, { publicDir: "public" });
 * @since 1.0.0
 */
export async function subsetFonts(
  fonts: Readonly<Record<string, FontDefinition>>,
  options: SubsetFontsOptions,
): Promise<Record<string, FontDefinition>> {
  const subsets = resolveSubsets(options.subsets ?? ["latin", "latin-ext"]);
  const preloaded = new Set(options.preload ?? [subsets[0]?.name ?? ""]);
  for (const name of preloaded) {
    if (!subsets.some((subset) => subset.name === name)) {
      throw new TypeError(`subsetFonts: preload names "${name}", which is not one of the slices.`);
    }
  }
  const directory = options.directory ?? "fonts/subset";
  checkedPath(`${directory}/x`, "subsetFonts directory");
  const cacheDir =
    options.cacheDir ??
    join(options.root ?? process.cwd(), "node_modules", ".cache", "dusk", "font-subsets");
  const cut =
    typeof options.subsetFont === "function"
      ? options.subsetFont
      : await loadSubsetFont(options.subsetFont ?? "subset-font");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(options.publicDir, ...directory.split("/")), { recursive: true });
  const characters = new Map(
    subsets.map((subset) => [subset.name, codePointsOf(subset.unicodeRange)]),
  );
  const made: Record<string, FontDefinition> = {};
  for (const [key, definition] of Object.entries(fonts)) {
    const files: FontFile[] = [];
    for (const file of definition.files) {
      checkedPath(file.file, definition.family);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(join(options.publicDir, ...file.file.split("/")));
      } catch (cause) {
        throw new Error(
          `subsetFonts: the file ${JSON.stringify(file.file)} of "${definition.family}" is not under ${options.publicDir}.`,
          { cause },
        );
      }
      // What a font keeps for no characters at all: a slice no bigger than this holds no glyph.
      let empty: number;
      try {
        empty = (await cut(bytes, "", { targetFormat: "woff2" })).length;
      } catch (cause) {
        throw new Error(
          `subsetFonts: cannot cut ${JSON.stringify(file.file)} (${definition.family}): ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      const stem = stemOf(file.file);
      for (const subset of subsets) {
        const text = characters.get(subset.name) ?? "";
        const cacheKey = createHash("sha256")
          .update(bytes)
          .update(JSON.stringify([CACHE_VERSION, subset.name, subset.unicodeRange]))
          .digest("hex")
          .slice(0, 24);
        const cached = join(cacheDir, `${cacheKey}.woff2`);
        let slice: Uint8Array | undefined;
        try {
          slice = await readFile(cached);
        } catch {
          // Not cut yet.
        }
        if (slice === undefined) {
          try {
            slice = await cut(bytes, text, { targetFormat: "woff2" });
          } catch (cause) {
            throw new Error(
              `subsetFonts: cannot cut ${JSON.stringify(file.file)} (${definition.family}): ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            );
          }
          await writeFile(cached, slice);
        }
        if (slice.length <= empty + 8) continue;
        const name = `${stem}-${subset.name}-${hashOf(slice)}.woff2`;
        const target = `${directory}/${name}`;
        const path = join(options.publicDir, ...target.split("/"));
        try {
          if ((await stat(path)).size !== slice.length) throw new Error("another size");
        } catch {
          await writeFile(path, slice);
        }
        files.push({
          ...file,
          file: target,
          format: "woff2",
          unicodeRange: subset.unicodeRange,
          preload: preloaded.has(subset.name),
        });
      }
    }
    if (files.length === 0) {
      throw new Error(
        `subsetFonts: no slice of "${definition.family}" holds a glyph: its files cover none of ${subsets.map((subset) => subset.name).join(", ")}.`,
      );
    }
    made[key] = { ...definition, files };
  }
  return made;
}
