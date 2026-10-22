/**
 * The header reader of the static metadata images (`opengraph-image.png`, `twitter-image.jpg`, ...): the real size and
 * type of a PNG, a JPEG or a GIF, read from the first bytes of the file. Build time only (Node); nothing here is part of
 * a runtime bundle, and no pixel is decoded.
 * @packageDocumentation
 */

/** The header of an image the reader understood. @since 1.0.0 */
export interface ImageHeader {
  readonly ok: true;
  /** The MIME type the signature says (the file name is not trusted). */
  readonly type: "image/png" | "image/jpeg" | "image/gif";
  readonly width: number;
  readonly height: number;
}

/** A header the reader could not use, with the reason in plain words. @since 1.0.0 */
export interface ImageHeaderFailure {
  readonly ok: false;
  readonly reason: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** "IHDR": the chunk that must come first in a PNG and holds the size. */
const IHDR = [0x49, 0x48, 0x44, 0x52];

const fail = (reason: string): ImageHeaderFailure => ({ ok: false, reason });

function startsWith(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** A size the card can show: both sides above zero. */
function sized(
  type: ImageHeader["type"],
  width: number,
  height: number,
): ImageHeader | ImageHeaderFailure {
  if (width === 0 || height === 0) {
    return fail(`its header says a size of ${width} by ${height} (a zero width or height)`);
  }
  return { ok: true, type, width, height };
}

function readPng(bytes: Uint8Array): ImageHeader | ImageHeaderFailure {
  // 8 bytes of signature, 4 of chunk length, 4 of chunk type, then width and height (4 bytes each).
  if (bytes.byteLength < 24) return fail("the PNG ends inside its header");
  if (!startsWith(bytes, IHDR, 12)) return fail("the PNG's first chunk is not IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return sized("image/png", view.getUint32(16), view.getUint32(20));
}

function readGif(bytes: Uint8Array): ImageHeader | ImageHeaderFailure {
  // 6 bytes of version, then the logical screen: width and height as little-endian 16-bit numbers.
  if (bytes.byteLength < 10) return fail("the GIF ends inside its logical screen");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return sized("image/gif", view.getUint16(6, true), view.getUint16(8, true));
}

/** Frame headers: SOF0 to SOF15 without DHT (0xC4), JPG (0xC8) and DAC (0xCC), which share the range. */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(bytes: Uint8Array): ImageHeader | ImageHeaderFailure {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 1 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return fail("the JPEG has bytes between its segments");
    // Any number of 0xFF fill bytes may come before a marker.
    let marker = bytes[offset + 1] ?? 0xff;
    offset += 1;
    while (marker === 0xff && offset + 1 < bytes.byteLength) {
      offset += 1;
      marker = bytes[offset] ?? 0xff;
    }
    offset += 1;
    // Markers without a length: TEM, the restart markers, SOI and EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0xd9) continue;
    // The scan starts here and no frame header came before it.
    if (marker === 0xda) return fail("the JPEG has no frame header before its scan");
    if (offset + 2 > bytes.byteLength) break;
    const length = view.getUint16(offset);
    if (isFrameMarker(marker)) {
      // Length, precision (1 byte), height, width (2 bytes each).
      if (length < 7 || offset + 7 > bytes.byteLength) break;
      return sized("image/jpeg", view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    if (length < 2) return fail("the JPEG has a segment with an impossible length");
    offset += length;
  }
  return fail("the JPEG ends before its frame header");
}

/**
 * Reads the size and type of a PNG, a JPEG or a GIF from its header.
 *
 * The type comes from the signature, not from the file name, so a JPEG named `.png` is described as a JPEG. A header
 * that cannot be used (an unknown format, a file cut short, a PNG without IHDR, a JPEG without a frame header, a zero
 * side) is a result with a reason; the caller decides what to do with it.
 *
 * @param bytes The file, or at least its first bytes (a JPEG may hold large segments before its frame header).
 * @returns The type and size, or why the header is unreadable.
 * @since 1.0.0
 * @example
 * const header = readImageHeader(readFileSync("opengraph-image.png"));
 * if (header.ok) console.log(header.width, header.height); // 1200 630
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | ImageHeaderFailure {
  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return readGif(bytes);
  }
  return fail("it is not a PNG, JPEG or GIF image");
}
