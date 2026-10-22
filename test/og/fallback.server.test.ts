import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { h } from "../../src/og/element";
import { ImageResponse, type OgFont } from "../../src/og/image-response";

/**
 * The font stack of `ImageResponse`: several faces, each glyph drawn with the first face that has it. The Latin face is
 * Noto Sans and the Arabic one Noto Sans Arabic (both OFL, in `test/fixtures/og`; the Arabic one is the static Regular, since
 * the variable font does not parse in satori's font reader). The wasm is the one `@resvg/resvg-wasm` ships.
 */
const require = createRequire(import.meta.url);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "og");
const latin: OgFont = {
  name: "Noto Sans",
  data: new Uint8Array(readFileSync(join(fixtures, "NotoSans-Regular.ttf"))),
  weight: 400,
};
const arabic: OgFont = {
  name: "Noto Sans Arabic",
  data: new Uint8Array(readFileSync(join(fixtures, "NotoSansArabic-Regular.ttf"))),
  weight: 400,
};
const wasm = new Uint8Array(
  readFileSync(join(dirname(require.resolve("@resvg/resvg-wasm")), "index_bg.wasm")),
);

const ARABIC = "مرحبا بالعالم";

/** A card whose text names `fontFamily` (or nothing, when undefined). */
function card(text: string, fontFamily?: string) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        background: "#ffffff",
        color: "#111111",
        padding: 48,
        fontSize: 64,
        ...(fontFamily === undefined ? {} : { fontFamily }),
      },
    },
    text,
  );
}

async function draw(tree: ReturnType<typeof card>, fonts: readonly OgFont[]): Promise<Uint8Array> {
  const response = new ImageResponse(tree, { width: 800, height: 240, fonts, resvgWasm: wasm });
  expect(response.headers.get("content-type")).toBe("image/png");
  return new Uint8Array(await response.arrayBuffer());
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe("ImageResponse: a font stack for non-Latin text", () => {
  it("[OG-27] several faces draw Arabic text; the Latin face alone draws none of it", async () => {
    const latinOnly = await draw(card(ARABIC), [latin]);
    const stacked = await draw(card(ARABIC), [latin, arabic]);
    expect(Array.from(stacked.slice(0, 8))).toEqual(PNG_SIGNATURE);
    expect(stacked).not.toEqual(latinOnly);
  });

  it("[OG-28] a mixed title falls back per glyph: Latin from the first face, Arabic from the next, with no font named in the tree", async () => {
    const mixed = `Hello ${ARABIC}`;
    const withoutNames = await draw(card(mixed), [latin, arabic]);
    const onlyLatinNamed = await draw(card(mixed, "Noto Sans"), [latin, arabic]);
    const explicitStack = await draw(card(mixed, '"Noto Sans", "Noto Sans Arabic"'), [
      latin,
      arabic,
    ]);
    // Every spelling of the same stack draws the same pixels: the fallback is the framework's, not the tree's.
    expect(onlyLatinNamed).toEqual(withoutNames);
    expect(explicitStack).toEqual(withoutNames);
    // And the Latin-only font draws less of the title than the stack does.
    expect(await draw(card(mixed), [latin])).not.toEqual(withoutNames);
  });
});
