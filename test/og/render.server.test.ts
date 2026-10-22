import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { h } from "../../src/og/element";
import { ImageResponse } from "../../src/og/image-response";

/**
 * The real drawing path: satori lays the tree out, resvg rasterizes it. The font is Noto Sans (OFL, in
 * `test/fixtures/og`), the wasm is the one the optional `@resvg/resvg-wasm` package ships.
 */
const require = createRequire(import.meta.url);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "og");
const font = new Uint8Array(readFileSync(join(fixtures, "NotoSans-Regular.ttf")));
// The package's exports do not list its package.json, so the wasm is found from its entry point.
const wasm = new Uint8Array(
  readFileSync(join(dirname(require.resolve("@resvg/resvg-wasm")), "index_bg.wasm")),
);

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Width and height from the IHDR chunk of a PNG (bytes 16 to 23, big-endian). */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function card(title: string) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        background: "#0b0b0a",
        color: "#f1f0ec",
        padding: 72,
        fontSize: 64,
      },
    },
    title,
  );
}

async function draw(
  title: string,
  options: { width?: number; height?: number } = {},
): Promise<Uint8Array> {
  const response = new ImageResponse(card(title), {
    ...options,
    fonts: [{ name: "Noto Sans", data: font, weight: 400 }],
    resvgWasm: wasm,
  });
  expect(response.headers.get("content-type")).toBe("image/png");
  return new Uint8Array(await response.arrayBuffer());
}

describe("ImageResponse: a real render", () => {
  it("[OG-30] the body is a PNG of the requested size (1200 by 630 by default)", async () => {
    const bytes = await draw("Malaf");
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("[OG-31] a custom size is honored", async () => {
    const bytes = await draw("Small", { width: 300, height: 200 });
    expect(pngSize(bytes)).toEqual({ width: 300, height: 200 });
  });

  it("[OG-32] the same tree draws the same bytes (no clock, no randomness in the output)", async () => {
    const first = await draw("Stable");
    const second = await draw("Stable");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("[OG-33] the text is part of the image: a different title draws different bytes", async () => {
    const first = await draw("Alpha");
    const second = await draw("Omega");
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
  });
});
