/**
 * Byte builders for the image tests: just the header a reader looks at (a few dozen bytes), never pixel data. The
 * builders are small on purpose, so a test shows exactly which bytes make a size.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG: the signature and an IHDR chunk (the CRC is not checked by the reader, so it is left zero). */
export function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  const view = new DataView(bytes.buffer);
  bytes.set(PNG_SIGNATURE, 0);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

/** A GIF: the version and the logical screen descriptor. */
export function gifBytes(width: number, height: number, version: "GIF87a" | "GIF89a"): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(new TextEncoder().encode(version), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** Options of {@link jpegBytes}. */
export interface JpegOptions {
  /** The SOF marker byte (default `0xC0`), or `"none"` for a file whose scan starts before any SOF. */
  readonly marker?: number | "none";
  /** `"dht-and-fill"` puts a DHT segment and fill bytes before the SOF marker. */
  readonly before?: "dht-and-fill";
}

/** A JPEG: SOI, an APP0 segment, optional segments, the SOF marker with the size, and a SOS marker. */
export function jpegBytes(width: number, height: number, options: JpegOptions = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  // APP0 (JFIF): length 16 counts itself and the 14 bytes after.
  out.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0);
  if (options.before === "dht-and-fill") {
    // A DHT segment: its marker byte (0xC4) sits in the SOF range but is not a frame header.
    out.push(0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02);
    // Fill bytes: any number of 0xFF may precede a marker.
    out.push(0xff, 0xff);
  }
  const marker = options.marker ?? 0xc0;
  if (marker !== "none") {
    // SOF: length 17 (3 components), precision, height, width, component count, 3 x (id, sampling, table).
    out.push(0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff);
    out.push(0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  }
  // SOS: the entropy-coded data follows, so no SOF can come after it.
  out.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  return new Uint8Array(out);
}
