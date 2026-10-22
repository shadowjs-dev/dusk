/**
 * Font files built in memory for the font tests: a TrueType (sfnt) file with the tables the metrics reader reads, and,
 * when asked, a `cmap` and an `hmtx` for the Latin letters so the a-z average width can be measured. No font file is
 * vendored for these; the numbers are known because the test chose them.
 */

export interface Table {
  readonly tag: string;
  readonly data: Uint8Array;
}

/** The characters Next.js averages over (letter frequency and word length), spaces included. */
export const AVERAGE_CHARACTERS = "aaabcdeeeefghiijklmnnoopqrrssttuvwxyz      ";

/** Wraps tables in an sfnt directory. */
export function sfnt(tables: readonly Table[]): Uint8Array<ArrayBuffer> {
  const headerLength = 12 + tables.length * 16;
  const total = tables.reduce((sum, table) => sum + table.data.byteLength, headerLength);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000);
  dv.setUint16(4, tables.length);
  let offset = headerLength;
  tables.forEach((table, index) => {
    const entry = 12 + index * 16;
    for (let i = 0; i < 4; i += 1) out[entry + i] = table.tag.charCodeAt(i);
    dv.setUint32(entry + 8, offset);
    dv.setUint32(entry + 12, table.data.byteLength);
    out.set(table.data, offset);
    offset += table.data.byteLength;
  });
  return out;
}

export interface LatinFontOptions {
  readonly unitsPerEm?: number;
  /** The OS/2 `xAvgCharWidth`. Default 512. */
  readonly os2Average?: number;
  readonly ascender?: number;
  readonly descender?: number;
  readonly lineGap?: number;
  /** The last lower-case letter the `cmap` maps (default `z`); a letter after it has no glyph. */
  readonly lastLetter?: string;
}

/** The advance width of letter number `index` (0 for `a`) and of the space, in a font built by {@link latinFontTables}. */
export function letterWidth(index: number): number {
  return 400 + index * 10;
}
export const SPACE_WIDTH = 300;

/** The a-z average a font from {@link latinFontTables} must measure (every letter of `AVERAGE_CHARACTERS` mapped). */
export function expectedAverage(): number {
  let total = 0;
  for (const character of AVERAGE_CHARACTERS) {
    total += character === " " ? SPACE_WIDTH : letterWidth(character.charCodeAt(0) - 97);
  }
  return total / AVERAGE_CHARACTERS.length;
}

/** Tables of a Latin-only font: head, hhea, OS/2, maxp, a format 4 `cmap` (space, a to z) and an `hmtx`. */
export function latinFontTables(options: LatinFontOptions = {}): Table[] {
  const last = (options.lastLetter ?? "z").charCodeAt(0);
  const head = new Uint8Array(54);
  new DataView(head.buffer).setUint16(18, options.unitsPerEm ?? 1000);
  const hhea = new Uint8Array(36);
  const hv = new DataView(hhea.buffer);
  hv.setInt16(4, options.ascender ?? 900);
  hv.setInt16(6, options.descender ?? -300);
  hv.setInt16(8, options.lineGap ?? 40);
  const glyphCount = 28; // .notdef, a to z, space
  hv.setUint16(34, glyphCount); // numberOfHMetrics
  const os2 = new Uint8Array(96);
  new DataView(os2.buffer).setInt16(2, options.os2Average ?? 512);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint16(4, glyphCount);

  const hmtx = new Uint8Array(glyphCount * 4);
  const mv = new DataView(hmtx.buffer);
  mv.setUint16(0, 600);
  for (let index = 0; index < 26; index += 1) mv.setUint16((index + 1) * 4, letterWidth(index));
  mv.setUint16(27 * 4, SPACE_WIDTH);

  // Segments, ascending by end code: space (glyph 27), a to the last letter (glyph 1 up), and the 0xFFFF terminator.
  const segments = [
    { start: 32, end: 32, delta: 27 - 32 },
    { start: 97, end: last, delta: 1 - 97 },
    { start: 0xffff, end: 0xffff, delta: 1 },
  ];
  const count = segments.length;
  const subtable = new Uint8Array(16 + count * 8);
  const sv = new DataView(subtable.buffer);
  sv.setUint16(0, 4); // format
  sv.setUint16(2, subtable.byteLength);
  sv.setUint16(6, count * 2);
  segments.forEach((segment, index) => {
    sv.setUint16(14 + index * 2, segment.end);
    sv.setUint16(16 + count * 2 + index * 2, segment.start);
    sv.setInt16(16 + count * 4 + index * 2, segment.delta);
    sv.setUint16(16 + count * 6 + index * 2, 0); // idRangeOffset
  });
  const cmap = new Uint8Array(12 + subtable.byteLength);
  const cv = new DataView(cmap.buffer);
  cv.setUint16(2, 1); // one encoding record
  cv.setUint16(4, 3); // platform: Windows
  cv.setUint16(6, 1); // encoding: Unicode BMP
  cv.setUint32(8, 12);
  cmap.set(subtable, 12);

  return [
    { tag: "OS/2", data: os2 },
    { tag: "cmap", data: cmap },
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "hmtx", data: hmtx },
    { tag: "maxp", data: maxp },
  ];
}

/** A whole sfnt file of a Latin-only font. */
export function latinFont(options: LatinFontOptions = {}): Uint8Array<ArrayBuffer> {
  return sfnt(latinFontTables(options));
}
