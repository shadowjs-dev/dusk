import { describe, expect, it } from "vitest";
import { readImageHeader } from "../../src/vite/image-header";
import { gifBytes, jpegBytes, pngBytes } from "./support/images";

/**
 * The build-time reader of a static image's header: PNG (IHDR), JPEG (the first SOF marker) and GIF (the logical
 * screen). It reads a few dozen bytes and never decodes pixels; an unreadable header is a result with a reason, which
 * the convention scan turns into an error that names the file.
 */

describe("readImageHeader: the sizes and types of the formats", () => {
  it("[IMG-01] a PNG gives its IHDR width and height", () => {
    expect(readImageHeader(pngBytes(1200, 630))).toEqual({
      ok: true,
      type: "image/png",
      width: 1200,
      height: 630,
    });
  });

  it("[IMG-02] a JPEG gives the size of its first SOF marker, past the segments before it", () => {
    expect(readImageHeader(jpegBytes(800, 418))).toEqual({
      ok: true,
      type: "image/jpeg",
      width: 800,
      height: 418,
    });
  });

  it("[IMG-03] a progressive JPEG (SOF2) is read like a baseline one", () => {
    expect(readImageHeader(jpegBytes(640, 480, { marker: 0xc2 }))).toMatchObject({
      ok: true,
      width: 640,
      height: 480,
    });
  });

  it("[IMG-04] a DHT segment (0xC4) is not mistaken for a SOF marker, and fill bytes before a marker are skipped", () => {
    const bytes = jpegBytes(321, 123, { before: "dht-and-fill" });
    expect(readImageHeader(bytes)).toMatchObject({ ok: true, width: 321, height: 123 });
  });

  it("[IMG-05] a GIF (87a and 89a) gives its logical screen size", () => {
    expect(readImageHeader(gifBytes(480, 270, "GIF89a"))).toEqual({
      ok: true,
      type: "image/gif",
      width: 480,
      height: 270,
    });
    expect(readImageHeader(gifBytes(16, 9, "GIF87a"))).toMatchObject({ width: 16, height: 9 });
  });
});

describe("readImageHeader: what it refuses", () => {
  it("[IMG-06] an empty file, an unknown signature and a text file are unreadable, with a reason", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
      new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    ]) {
      const result = readImageHeader(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/PNG, JPEG or GIF/);
    }
  });

  it("[IMG-07] a PNG cut inside its IHDR, or whose first chunk is not IHDR, is unreadable", () => {
    const full = pngBytes(10, 10);
    const cut = readImageHeader(full.subarray(0, 20));
    expect(cut).toMatchObject({ ok: false });
    const wrong = pngBytes(10, 10);
    wrong.set(new TextEncoder().encode("IDAT"), 12);
    const result = readImageHeader(wrong);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/IHDR/);
  });

  it("[IMG-08] a JPEG with no SOF marker before the scan, or cut inside a segment, is unreadable", () => {
    expect(readImageHeader(jpegBytes(10, 10, { marker: "none" }))).toMatchObject({ ok: false });
    expect(readImageHeader(jpegBytes(10, 10).subarray(0, 12))).toMatchObject({ ok: false });
  });

  it("[IMG-09] a GIF cut inside its logical screen is unreadable", () => {
    expect(readImageHeader(gifBytes(10, 10, "GIF89a").subarray(0, 8))).toMatchObject({
      ok: false,
    });
  });

  it("[IMG-10] a zero width or height is unreadable: no card can show it", () => {
    for (const bytes of [pngBytes(0, 10), pngBytes(10, 0), gifBytes(0, 5, "GIF89a")]) {
      const result = readImageHeader(bytes);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/zero|0/);
    }
  });
});
