import { brotliDecompressSync, inflateSync } from "node:zlib";

/**
 * A small reader of the metrics a font file declares (the build-time input of the size-adjusted fallback face). It
 * reads the table directory of a TrueType or OpenType file (`sfnt`), a WOFF file and a WOFF2 file, and only the tables the
 * metrics need: `head` (units per em), `hhea` (ascender, descender, line gap) and `OS/2` (the average character width),
 * plus `cmap` and `hmtx` to measure the a-z average width (the measure the size-adjusted fallback uses).
 * Pure JavaScript and `node:zlib` (the Brotli decoder of WOFF2): no dependency. A file it cannot read is an error that
 * names the problem; nothing is guessed.
 * @packageDocumentation
 */

/** The metrics a font file declares, in font units. @since 1.0.0 */
export interface FontFileMetrics {
  readonly unitsPerEm: number;
  /** The typographic ascender (positive). */
  readonly ascender: number;
  /** The typographic descender (negative in the file). */
  readonly descender: number;
  readonly lineGap: number;
  /** The average character width (`OS/2` `xAvgCharWidth`). Its meaning depends on the OS/2 version, so it is not comparable between fonts. */
  readonly xWidthAvg: number;
  /**
   * The average advance of the sample text Next.js averages over (`aaabcdeeeefghiijklmnnoopqrrssttuvwxyz` and six spaces:
   * letters by frequency, with word gaps), in font units. Absent when the font has no glyph for one of those characters
   * or its `cmap` or `hmtx` cannot be read. This is the measure of the size-adjusted fallback.
   */
  readonly azAvgWidth: number | undefined;
}

/**
 * The tags WOFF2 names by index (its table directory stores a 6-bit index for the common ones). The list is the one of
 * the WOFF2 specification, section 5.1; index 63 means an arbitrary tag follows.
 */
const WOFF2_TAGS: readonly string[] = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];

/** Tables of a font file, by tag, as byte ranges of the decoded file. */
type Tables = ReadonlyMap<string, Uint8Array>;

/** The tables the metrics cannot do without; a compressed file's other tables (glyphs, outlines) are never inflated. */
const REQUIRED_TABLES: ReadonlySet<string> = new Set(["head", "hhea", "OS/2"]);

/**
 * The tables that only the a-z average needs. A file whose copy of them is too large or does not inflate still gives
 * its other metrics; the average is then absent rather than the whole read failing.
 */
const OPTIONAL_TABLES: ReadonlySet<string> = new Set(["cmap", "hmtx"]);

/** Largest a required table may inflate to. They are 36 to about 100 bytes; this is generous, not tight. */
const MAX_NEEDED_TABLE = 64 * 1024;

/** Largest an optional table may inflate to: `hmtx` is four bytes per glyph (at most 65 535), `cmap` a few hundred KiB. */
const MAX_OPTIONAL_TABLE = 2 * 1024 * 1024;

/** The sample text Next.js averages the advance over to measure how wide a font sets running text. */
const AVERAGE_CHARACTERS = "aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ";

/** Largest a WOFF2 Brotli stream may decode to (the biggest CJK fonts are around 30 MiB). */
const MAX_WOFF2_BYTES = 64 * 1024 * 1024;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tagAt(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.byteLength) throw new RangeError("font file: a table tag is cut short");
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function slice(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new RangeError("font file: a table lies outside the file");
  }
  return bytes.subarray(offset, offset + length);
}

/** The sfnt table directory of a TrueType or OpenType file. */
function sfntTables(bytes: Uint8Array): Tables {
  const dv = view(bytes);
  const count = dv.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const entry = 12 + index * 16;
    const offset = dv.getUint32(entry + 8);
    const length = dv.getUint32(entry + 12);
    tables.set(tagAt(bytes, entry), slice(bytes, offset, length));
  }
  return tables;
}

/** A WOFF file: every table is zlib-compressed unless storing it is smaller. Only the tables the metrics read are inflated. */
function woffTables(bytes: Uint8Array): Tables {
  const dv = view(bytes);
  const count = dv.getUint16(12);
  const tables = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const entry = 44 + index * 20;
    const tag = tagAt(bytes, entry);
    const required = REQUIRED_TABLES.has(tag);
    if (!required && !OPTIONAL_TABLES.has(tag)) {
      // The entry must still lie inside the file, but its bytes are not read.
      slice(bytes, entry, 20);
      continue;
    }
    const offset = dv.getUint32(entry + 4);
    const compressed = dv.getUint32(entry + 8);
    const original = dv.getUint32(entry + 12);
    const limit = required ? MAX_NEEDED_TABLE : MAX_OPTIONAL_TABLE;
    if (original > limit) {
      if (!required) continue; // only the a-z average needs it: skipping it costs the average, not the file
      throw new RangeError(
        `WOFF: the ${tag.trim()} table claims ${original} bytes, larger than ${limit}`,
      );
    }
    const data = slice(bytes, offset, compressed);
    let decoded: Uint8Array;
    if (compressed === original) {
      decoded = data;
    } else {
      try {
        // The claimed size is also the ceiling of the inflate: a stream that says more than it said is cut off.
        decoded = new Uint8Array(inflateSync(data, { maxOutputLength: Math.max(original, 1) }));
      } catch (cause) {
        if (!required) continue; // an optional table that does not inflate is treated as absent
        throw new RangeError(
          `WOFF: the ${tag.trim()} table does not inflate to its stated length`,
          {
            cause,
          },
        );
      }
    }
    if (decoded.byteLength !== original) {
      if (!required) continue;
      throw new RangeError("WOFF: a table has the wrong length");
    }
    tables.set(tag, decoded);
  }
  return tables;
}

/** A base-128 integer of the WOFF2 directory (at most five bytes). */
function readBase128(bytes: Uint8Array, cursor: { at: number }): number {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = bytes[cursor.at];
    if (byte === undefined) throw new RangeError("WOFF2: the table directory is cut short");
    cursor.at += 1;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return value;
  }
  throw new RangeError("WOFF2: a length in the table directory is too long");
}

/**
 * A WOFF2 file: the directory names the tables, and one Brotli stream holds them all, in directory order. `glyf` and
 * `loca` are transformed in version 0, `hmtx` in version 1; the metrics read none of them, so a transformed table is
 * skipped rather than rebuilt (its entry is still consumed, to keep the offsets right).
 */
function woff2Tables(bytes: Uint8Array): Tables {
  const dv = view(bytes);
  const count = dv.getUint16(12);
  const compressedTotal = dv.getUint32(20);
  const cursor = { at: 48 };
  const entries: { tag: string; length: number; transformed: boolean }[] = [];
  for (let index = 0; index < count; index += 1) {
    const flags = bytes[cursor.at];
    if (flags === undefined) throw new RangeError("WOFF2: the table directory is cut short");
    cursor.at += 1;
    const known = flags & 0x3f;
    let tag: string;
    if (known === 63) {
      tag = tagAt(bytes, cursor.at);
      cursor.at += 4;
    } else {
      const name = WOFF2_TAGS[known];
      if (name === undefined) throw new RangeError("WOFF2: an unknown table index");
      tag = name;
    }
    const version = (flags >> 6) & 3;
    const original = readBase128(bytes, cursor);
    const transformed =
      tag === "glyf" || tag === "loca" ? version === 0 : tag === "hmtx" ? version === 1 : false;
    const length = transformed ? readBase128(bytes, cursor) : original;
    entries.push({ tag, length, transformed });
  }
  const stream = slice(bytes, cursor.at, compressedTotal);
  let decoded: Uint8Array;
  try {
    decoded = new Uint8Array(brotliDecompressSync(stream, { maxOutputLength: MAX_WOFF2_BYTES }));
  } catch (cause) {
    throw new RangeError(
      `WOFF2: the table stream does not decode, or is larger than ${MAX_WOFF2_BYTES} bytes`,
      { cause },
    );
  }
  const tables = new Map<string, Uint8Array>();
  let offset = 0;
  for (const entry of entries) {
    if (!entry.transformed) tables.set(entry.tag, slice(decoded, offset, entry.length));
    offset += entry.length;
  }
  return tables;
}

/** The tables of a font file, whatever its container. */
function tablesOf(bytes: Uint8Array): Tables {
  const signature = tagAt(bytes, 0);
  if (signature === "wOF2") return woff2Tables(bytes);
  if (signature === "wOFF") return woffTables(bytes);
  if (signature === "\u0000\u0001\u0000\u0000" || signature === "OTTO" || signature === "true") {
    return sfntTables(bytes);
  }
  throw new TypeError("font file: not a TrueType, OpenType, WOFF or WOFF2 file");
}

function requiredTable(tables: Tables, tag: string): Uint8Array {
  const table = tables.get(tag);
  if (table === undefined) throw new TypeError(`font file: the ${tag.trim()} table is missing`);
  return table;
}

/**
 * A lookup from a code point to a glyph index, over the best Unicode subtable of a `cmap`: format 12 (the full range)
 * when there is one, else format 4 (the Basic Multilingual Plane). Other formats are not read. Glyph 0 means "no glyph".
 */
function glyphLookup(cmap: DataView): ((codePoint: number) => number) | undefined {
  const records = cmap.getUint16(2);
  let best: { offset: number; rank: number; format: number } | undefined;
  for (let index = 0; index < records; index += 1) {
    const platform = cmap.getUint16(4 + index * 8);
    const encoding = cmap.getUint16(6 + index * 8);
    const offset = cmap.getUint32(8 + index * 8);
    const format = cmap.getUint16(offset);
    if (format !== 4 && format !== 12) continue;
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const rank = format === 12 ? 2 : 1;
    if (best === undefined || rank > best.rank) best = { offset, rank, format };
  }
  if (best === undefined) return undefined;
  const { offset } = best;
  if (best.format === 12) {
    return (codePoint) => {
      const groups = cmap.getUint32(offset + 12);
      for (let group = 0; group < groups; group += 1) {
        const at = offset + 16 + group * 12;
        const first = cmap.getUint32(at);
        const last = cmap.getUint32(at + 4);
        if (codePoint >= first && codePoint <= last)
          return cmap.getUint32(at + 8) + codePoint - first;
        if (codePoint < first) return 0;
      }
      return 0;
    };
  }
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    const segments = cmap.getUint16(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment += 1) {
      if (codePoint > cmap.getUint16(ends + segment * 2)) continue;
      const start = cmap.getUint16(starts + segment * 2);
      if (codePoint < start) return 0;
      const delta = cmap.getInt16(deltas + segment * 2);
      const rangeOffset = cmap.getUint16(ranges + segment * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyph = cmap.getUint16(ranges + segment * 2 + rangeOffset + (codePoint - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/**
 * The average advance, in font units, of the sample text Next.js averages (see `AVERAGE_CHARACTERS`). Undefined when a
 * table is missing, a character has no glyph (the average of a font that cannot set the text would mean nothing), or a
 * table is cut short. Anything else that goes wrong is a bug and is thrown.
 */
function averageAdvance(tables: Tables, hhea: DataView): number | undefined {
  const cmapBytes = tables.get("cmap");
  const hmtxBytes = tables.get("hmtx");
  if (cmapBytes === undefined || hmtxBytes === undefined) return undefined;
  try {
    const glyphOf = glyphLookup(view(cmapBytes));
    const hmtx = view(hmtxBytes);
    // The last advance repeats for every glyph after the long metrics; a font with no long metrics has no widths.
    const long = hhea.getUint16(34);
    if (glyphOf === undefined || long === 0) return undefined;
    let total = 0;
    for (const character of AVERAGE_CHARACTERS) {
      const glyph = glyphOf(character.codePointAt(0) ?? 0);
      if (glyph === 0) return undefined;
      total += hmtx.getUint16(Math.min(glyph, long - 1) * 4);
    }
    return total / AVERAGE_CHARACTERS.length;
  } catch (error) {
    // A DataView read past the end of a table: the table is damaged, so there is no average (the other metrics stand).
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * The metrics of a font file: units per em, the hhea ascender, descender and line gap, the OS/2 average character
 * width, and the a-z average advance. A WOFF2 file's Brotli stream is decoded to read them.
 *
 * @param bytes The font file.
 * @returns The metrics, in font units.
 * @throws TypeError when the file is not a font, or a table the metrics need is missing.
 * @throws RangeError when the file is damaged (a table outside the file, a short directory).
 * @example readFontMetrics(readFileSync("public/fonts/InstrumentSans.woff2")).unitsPerEm
 * @since 1.0.0
 */
export function readFontMetrics(bytes: Uint8Array): FontFileMetrics {
  const tables = tablesOf(bytes);
  const head = view(requiredTable(tables, "head"));
  const hhea = view(requiredTable(tables, "hhea"));
  const os2 = view(requiredTable(tables, "OS/2"));
  const unitsPerEm = head.getUint16(18);
  if (unitsPerEm === 0) throw new RangeError("font file: unitsPerEm is zero");
  return {
    unitsPerEm,
    ascender: hhea.getInt16(4),
    descender: hhea.getInt16(6),
    lineGap: hhea.getInt16(8),
    xWidthAvg: os2.getInt16(2),
    azAvgWidth: averageAdvance(tables, hhea),
  };
}
