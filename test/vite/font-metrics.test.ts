import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readFontMetrics } from "../../src/vite/font-metrics";
import { expectedAverage, latinFontTables } from "./support/font-files";

/*
 * The metrics reader reads the tables the size-adjusted fallback needs, from TrueType (sfnt), WOFF and WOFF2 files. The
 * fixtures are built here (no font file is vendored): a font with known head, hhea and OS/2 values.
 */

interface Table {
  readonly tag: string;
  readonly data: Uint8Array;
}

function fontTables(): Table[] {
  const head = new Uint8Array(54);
  new DataView(head.buffer).setUint16(18, 1000); // unitsPerEm
  const hhea = new Uint8Array(36);
  const hv = new DataView(hhea.buffer);
  hv.setInt16(4, 900); // ascender
  hv.setInt16(6, -300); // descender
  hv.setInt16(8, 40); // lineGap
  const os2 = new Uint8Array(96);
  new DataView(os2.buffer).setInt16(2, 512); // xAvgCharWidth
  const maxp = new Uint8Array(6);
  return [
    { tag: "OS/2", data: os2 },
    { tag: "head", data: head },
    { tag: "hhea", data: hhea },
    { tag: "maxp", data: maxp },
  ];
}

function sfnt(tables: Table[]): Uint8Array {
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

function woff2(tables: Table[]): Uint8Array {
  // Known tags use their index in the WOFF2 list (head = 1, hhea = 2, maxp = 4, OS/2 = 6); the stream is Brotli.
  const index: Record<string, number> = { "OS/2": 6, cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4 };
  const directory: number[] = [];
  const base128 = (value: number): number[] => {
    const bytes = [value & 0x7f];
    for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
    return bytes;
  };
  for (const table of tables) {
    directory.push(index[table.tag] ?? 63, ...base128(table.data.byteLength));
  }
  const stream = brotliCompressSync(Buffer.concat(tables.map((table) => Buffer.from(table.data))));
  const header = new Uint8Array(48);
  const hv = new DataView(header.buffer);
  for (let i = 0; i < 4; i += 1) header[i] = "wOF2".charCodeAt(i);
  hv.setUint16(12, tables.length);
  hv.setUint32(20, stream.byteLength);
  return Buffer.concat([Buffer.from(header), Buffer.from(directory), stream]);
}

function woff(tables: Table[]): Uint8Array {
  const headerLength = 44 + tables.length * 20;
  const parts = tables.map((table) => Buffer.from(table.data));
  const out: Buffer[] = [];
  const header = Buffer.alloc(headerLength);
  header.write("wOFF", 0);
  header.writeUInt16BE(tables.length, 12);
  let offset = headerLength;
  tables.forEach((table, index) => {
    const entry = 44 + index * 20;
    header.write(table.tag, entry, "latin1");
    header.writeUInt32BE(offset, entry + 4);
    header.writeUInt32BE(table.data.byteLength, entry + 8); // stored, not compressed
    header.writeUInt32BE(table.data.byteLength, entry + 12);
    offset += table.data.byteLength;
  });
  out.push(header, ...parts);
  return Buffer.concat(out);
}

const EXPECTED = { unitsPerEm: 1000, ascender: 900, descender: -300, lineGap: 40, xWidthAvg: 512 };

describe("readFontMetrics", () => {
  it("[FONT-M1] reads units per em, the hhea values and the OS/2 average width from a TrueType file", () => {
    expect(readFontMetrics(sfnt(fontTables()))).toEqual(EXPECTED);
  });

  it("[FONT-M2] reads the same values from a WOFF file (stored tables)", () => {
    expect(readFontMetrics(woff(fontTables()))).toEqual(EXPECTED);
  });

  it("[FONT-M3] reads the same values from a WOFF2 file (a Brotli stream of the tables)", () => {
    expect(readFontMetrics(woff2(fontTables()))).toEqual(EXPECTED);
  });

  it("[FONT-M4] a file that is not a font, or lacks a table the metrics need, is an error that says why", () => {
    expect(() => readFontMetrics(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(
      /not a TrueType, OpenType, WOFF or WOFF2/,
    );
    const withoutOs2 = fontTables().filter((table) => table.tag !== "OS/2");
    expect(() => readFontMetrics(sfnt(withoutOs2))).toThrow(/OS\/2 table is missing/);
  });

  it("[FONT-M5] a damaged table directory or a table outside the file is a RangeError, not a guess", () => {
    const bytes = sfnt(fontTables());
    const cut = bytes.slice(0, 40);
    expect(() => readFontMetrics(cut)).toThrow(RangeError);
  });
});

/** A WOFF file whose tables are zlib-compressed, as real ones are. */
function compressedWoff(tables: Table[]): Uint8Array {
  const headerLength = 44 + tables.length * 20;
  const header = Buffer.alloc(headerLength);
  header.write("wOFF", 0);
  header.writeUInt16BE(tables.length, 12);
  const bodies: Buffer[] = [];
  let offset = headerLength;
  tables.forEach((table, index) => {
    const original = Buffer.from(table.data);
    const packed = deflateSync(original);
    const stored = packed.byteLength < original.byteLength ? packed : original;
    const entry = 44 + index * 20;
    header.write(table.tag, entry, "latin1");
    header.writeUInt32BE(offset, entry + 4);
    header.writeUInt32BE(stored.byteLength, entry + 8);
    header.writeUInt32BE(original.byteLength, entry + 12);
    bodies.push(stored);
    offset += stored.byteLength;
  });
  return Buffer.concat([header, ...bodies]);
}

describe("readFontMetrics: the a-z average width", () => {
  it("[FONT-M6] measures the average advance of Next's sample string (letters by frequency, spaces) from cmap and hmtx", () => {
    const measured = readFontMetrics(sfnt(latinFontTables())).azAvgWidth;
    expect(measured).toBeCloseTo(expectedAverage(), 6);
  });

  it("[FONT-M7] reads the same average from a WOFF file with compressed tables and from a WOFF2 file", () => {
    expect(readFontMetrics(compressedWoff(latinFontTables())).azAvgWidth).toBeCloseTo(
      expectedAverage(),
      6,
    );
    expect(readFontMetrics(woff2(latinFontTables())).azAvgWidth).toBeCloseTo(expectedAverage(), 6);
  });

  it("[FONT-M8] a font without a glyph for one of the letters, or without cmap or hmtx, has no average (undefined, not a guess)", () => {
    expect(readFontMetrics(sfnt(latinFontTables({ lastLetter: "y" }))).azAvgWidth).toBeUndefined();
    const withoutCmap = latinFontTables().filter((table) => table.tag !== "cmap");
    const metrics = readFontMetrics(sfnt(withoutCmap));
    expect(metrics.azAvgWidth).toBeUndefined();
    expect(metrics.xWidthAvg).toBe(512);
    const withoutHmtx = latinFontTables().filter((table) => table.tag !== "hmtx");
    expect(readFontMetrics(sfnt(withoutHmtx)).azAvgWidth).toBeUndefined();
  });

  it("[FONT-M9] a damaged cmap or hmtx (a table cut short) gives no average and does not break the other metrics", () => {
    const tables = latinFontTables().map((table) =>
      table.tag === "cmap" ? { tag: table.tag, data: table.data.slice(0, 20) } : table,
    );
    const metrics = readFontMetrics(sfnt(tables));
    expect(metrics.azAvgWidth).toBeUndefined();
    expect(metrics.unitsPerEm).toBe(1000);
  });

  it("[FONT-M10] on a real font (Noto Sans) the a-z average and the OS/2 xAvgCharWidth differ by 17%, which is why the fallback uses the first", () => {
    const bytes = new Uint8Array(
      readFileSync(join(import.meta.dirname, "..", "fixtures", "og", "NotoSans-Regular.ttf")),
    );
    const metrics = readFontMetrics(bytes);
    expect(metrics.unitsPerEm).toBe(1000);
    expect(metrics.azAvgWidth).toBeCloseTo(485.81, 2);
    expect(metrics.xWidthAvg).toBe(571);
  });
});
