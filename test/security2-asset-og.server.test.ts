import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  expandTree,
  h,
  MAX_OG_DATA_LENGTH,
  MAX_OG_NODES,
  MAX_OG_STRING_LENGTH,
  MAX_OG_TEXT_LENGTH,
  type OgNode,
} from "../src/og/element";
import {
  checkedSize,
  defaultRenderers,
  ImageResponse,
  MAX_OG_SIDE,
  type OgRenderers,
} from "../src/og/image-response";

/**
 * PASS 2 audit, area ASSET (ImageResponse and OG): what a request-controlled value in an element tree can make the
 * drawing code do. Ids are SEC2-ASSET-nn. The drawing path is real (satori and resvg-wasm from the optional peers);
 * the network is never touched, and a spy on `fetch` proves nothing asks for it.
 */

const SEED = 20_261_010;
const require = createRequire(import.meta.url);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "og");
const font = new Uint8Array(readFileSync(join(fixtures, "NotoSans-Regular.ttf")));
const wasm = new Uint8Array(
  readFileSync(join(dirname(require.resolve("@resvg/resvg-wasm")), "index_bg.wasm")),
);

function recording() {
  const calls: unknown[] = [];
  const renderers: OgRenderers = {
    async svg(tree) {
      calls.push(tree);
      return "<svg xmlns='http://www.w3.org/2000/svg'/>";
    },
    async png() {
      return new Uint8Array([137, 80, 78, 71]);
    },
  };
  return { renderers, calls };
}

const DATA_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("SEC2-ASSET OG: nothing request-controlled becomes a fetched URL", () => {
  const remote = [
    "http://169.254.169.254/latest/meta-data/",
    "https://evil.example/x.png",
    "HTTP://127.0.0.1:8080/x.png",
    " http://127.0.0.1/x.png",
    "//evil.example/x.png",
    "/relative/x.png",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://evil.example/x.png",
    "data:text/html,<script>alert(1)</script>",
    "data:application/octet-stream;base64,AAAA",
  ];

  it("[SEC2-ASSET-40] an img src that is not a data:image URI is refused before any drawing", () => {
    for (const src of remote) {
      const { renderers, calls } = recording();
      expect(
        () => new ImageResponse(h("img", { src, width: 10, height: 10 }), { renderers, fonts: [] }),
        src,
      ).toThrow(TypeError);
      expect(calls).toHaveLength(0);
    }
  });

  it("[SEC2-ASSET-41] href, xlink:href and the other fetching attributes follow the same rule", () => {
    for (const name of ["href", "xlink:href", "xlinkHref", "srcSet", "srcset", "poster"]) {
      expect(() => expandTree(h("image", { [name]: "http://evil.example/x.png" })), name).toThrow(
        TypeError,
      );
    }
    // A fragment reference inside an svg is not a fetch.
    expect(() => expandTree(h("use", { href: "#shape" }))).not.toThrow();
  });

  it("[SEC2-ASSET-42] a CSS url() in any style value or tw class is refused unless it is a data:image URI", () => {
    const hostile = [
      "url(http://169.254.169.254/x.png)",
      'url("https://evil.example/x.png")',
      "url( 'https://evil.example/x.png' )",
      "URL(//evil.example/x.png)",
      "linear-gradient(red, blue), url(//evil.example/x.png)",
      "image-set('https://evil.example/x.png' 1x)",
      "-webkit-image-set(url(https://evil.example/x.png) 1x)",
      "\\75rl(http://evil.example/x.png)",
      "url(file:///etc/passwd)",
    ];
    for (const value of hostile) {
      for (const name of ["backgroundImage", "background", "maskImage", "borderImage"]) {
        expect(
          () => expandTree(h("div", { style: { [name]: value } })),
          `${name}: ${value}`,
        ).toThrow(TypeError);
      }
    }
    expect(() => expandTree(h("div", { tw: "bg-[url(http://evil.example/x.png)]" }))).toThrow(
      TypeError,
    );
  });

  it("[SEC2-ASSET-43] a data:image URI is allowed in src and in url(), and reaches the renderer untouched", async () => {
    const { renderers, calls } = recording();
    const tree = h(
      "div",
      { style: { display: "flex", backgroundImage: `url(${DATA_PNG})` } },
      h("img", { src: DATA_PNG, width: 10, height: 10 }),
    );
    const response = new ImageResponse(tree, { renderers });
    await response.arrayBuffer();
    expect(JSON.stringify(calls[0])).toContain(DATA_PNG);
  });

  it("[SEC2-ASSET-44] allowRemoteImages is the one way to a remote image, and still only http(s)", () => {
    const { renderers } = recording();
    const draw = (src: string) =>
      new ImageResponse(h("img", { src, width: 1, height: 1 }), {
        renderers,
        allowRemoteImages: true,
      });
    expect(() => draw("https://cdn.example/x.png")).not.toThrow();
    for (const src of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "//evil.example/x.png",
      "ftp://x/y",
    ]) {
      expect(() => draw(src), src).toThrow(TypeError);
    }
  });

  it("[SEC2-ASSET-45] fuzz: whatever the style strings are, an accepted tree holds no url() that is not data: or a fragment", () => {
    const piece = fc.constantFrom(
      "url(",
      "URL (",
      "http://x",
      "data:image/png;base64,AAAA",
      "#id",
      ")",
      "'",
      '"',
      " ",
      "\\",
      "image-set(",
      "red",
      "src(",
    );
    return fc.assert(
      fc.property(fc.array(piece, { maxLength: 8 }), fc.array(piece, { maxLength: 8 }), (a, b) => {
        const value = `${a.join("")}${b.join("")}`;
        let tree: unknown;
        try {
          tree = expandTree(h("div", { style: { backgroundImage: value } }));
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
          return;
        }
        const text = JSON.stringify(tree);
        for (const match of text.matchAll(/url\s*\(\s*\\?["']?([^)"'\\]*)/gi)) {
          const target = match[1] ?? "";
          expect(target.startsWith("data:image/") || target.startsWith("#")).toBe(true);
        }
        // `redimage-set(` is one (unknown) function name; only a function named image-set fetches.
        expect(text).not.toMatch(/(?:^|[^a-z0-9_-])(?:-webkit-)?image-set\s*\(/i);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});

describe("SEC2-ASSET OG: the SVG handed to resvg", () => {
  const size = { width: 100, height: 100 };

  it("[SEC2-ASSET-50] an SVG that references anything but data: or a fragment is refused, with no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const renderers = defaultRenderers({ resvgWasm: wasm });
    const hostile = [
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="http://169.254.169.254/x.png"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///etc/passwd"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><image HREF='//evil.example/x.png'/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(http://evil.example/p)"/></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("http://evil.example/a.css");</style></svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg"><style>@import "http://evil.example/a.css";</style></svg>`,
    ];
    for (const svg of hostile) {
      await expect(renderers.png(svg, size), svg).rejects.toThrow(TypeError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("[SEC2-ASSET-51] the SVG satori writes (data: images, #fragments) passes the same check and rasterizes", async () => {
    const response = new ImageResponse(
      h(
        "div",
        { style: { display: "flex", width: "100%", height: "100%" } },
        h("img", { src: DATA_PNG, width: 10, height: 10 }),
        "ok",
      ),
      { fonts: [{ name: "Noto", data: font }], resvgWasm: wasm, width: 120, height: 60 },
    );
    const png = new Uint8Array(await response.arrayBuffer());
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("[SEC2-ASSET-52] resvgWasm is bytes or a module, never a URL: a string, URL or Response would make initWasm fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const bad of [
      "https://evil.example/resvg.wasm",
      new URL("https://evil.example/resvg.wasm"),
      new Response(new Uint8Array([0, 97, 115, 109])),
      { href: "https://evil.example/resvg.wasm" },
      42,
    ]) {
      const renderers = defaultRenderers({ resvgWasm: bad as never });
      await expect(
        renderers.png("<svg xmlns='http://www.w3.org/2000/svg'/>", size),
      ).rejects.toThrow(TypeError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("SEC2-ASSET OG: hostile text and attributes through the real satori", () => {
  it("[SEC2-ASSET-53] markup in text, a font-family and attribute values never becomes markup in the SVG", async () => {
    const renderers = defaultRenderers({ resvgWasm: wasm });
    const evil = `</text></svg><script>alert(1)</script><!--]]>" onload="alert(1)' &amp;`;
    const svg = await renderers.svg(
      h(
        "div",
        { style: { display: "flex", fontFamily: `Noto" onload="alert(1)` }, "data-x": evil },
        evil,
        h("span", { style: { color: `red" onload="alert(1)` } }, evil),
      ),
      { width: 400, height: 200 },
      [{ name: "Noto", data: font }],
    );
    expect(svg).not.toContain("<script");
    // With every attribute value blanked, what is left is the markup: it has no event-handler attribute, so the quote
    // in the hostile value was escaped (`&quot;`) and did not end the attribute.
    expect(svg.replace(/"[^"]*"/g, '""')).not.toMatch(/\sonload\s*=/i);
    const png = await renderers.png(svg, { width: 400, height: 200 });
    expect([...png.slice(1, 4)]).toEqual([80, 78, 71]);
  });

  it("[SEC2-ASSET-54] an embedded svg element keeps its attributes inside a data: image, where they are inert", async () => {
    const renderers = defaultRenderers({ resvgWasm: wasm });
    const svg = await renderers.svg(
      h("svg", { width: 10, height: 10, onload: "alert(1)" }, h("circle", { r: 5 })),
      { width: 50, height: 50 },
      [{ name: "Noto", data: font }],
    );
    expect(svg.replace(/"[^"]*"/g, '""')).not.toMatch(/\sonload\s*=/i);
    await expect(renderers.png(svg, { width: 50, height: 50 })).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("SEC2-ASSET OG: fonts, glyphs and the response", () => {
  it("[SEC2-ASSET-55] a glyph no font has (an emoji) is drawn without a request: no emoji CDN is asked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const renderers = defaultRenderers({ resvgWasm: wasm });
    const svg = await renderers.svg(
      h("div", { style: { display: "flex" } }, "ok 😀 \u{1F1F8}\u{1F1E6}"),
      {
        width: 200,
        height: 80,
      },
      [{ name: "Noto", data: font }],
    );
    expect(svg).toContain("<svg");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("[SEC2-ASSET-56] the answer is a nosniff PNG whatever headers the caller passes", async () => {
    const { renderers } = recording();
    const response = new ImageResponse(h("div", null), {
      renderers,
      headers: { "content-type": "text/html", "x-content-type-options": "sniff" },
    });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await response.arrayBuffer();
  });

  it("[SEC2-ASSET-69] a font's data is bytes: a string, URL or Response is a TypeError, and nothing is fetched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const renderers = defaultRenderers({ resvgWasm: wasm });
    for (const data of [
      "https://evil.example/font.ttf",
      new URL("https://evil.example/font.ttf"),
      new Response(new Uint8Array([1, 2, 3])),
      { href: "https://evil.example/font.ttf" },
    ]) {
      await expect(
        renderers.svg(h("div", null, "x"), { width: 10, height: 10 }, [
          { name: "Evil", data: data as never },
        ]),
      ).rejects.toThrow(TypeError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("SEC2-ASSET OG: size, node, depth and text bounds", () => {
  it("[SEC2-ASSET-60] dimensions: only whole numbers from 1 to 4096; NaN, Infinity, strings and huge values are refused", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4097, 1e9, 2 ** 53]) {
      expect(() => checkedSize(bad, 100), String(bad)).toThrow(RangeError);
      expect(() => checkedSize(100, bad), String(bad)).toThrow(RangeError);
    }
    for (const bad of ["1200", null, undefined, {}, [100]]) {
      expect(() => checkedSize(bad as never, 100)).toThrow(RangeError);
    }
    expect(checkedSize(MAX_OG_SIDE, MAX_OG_SIDE)).toEqual({ width: 4096, height: 4096 });
  });

  it("[SEC2-ASSET-61] fuzz: any size outside the range is refused before any renderer runs", () => {
    return fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: MAX_OG_SIDE + 1, max: 2 ** 31 }),
          fc.integer({ min: -(2 ** 31), max: 0 }),
          fc.double({ noInteger: true }),
        ),
        (bad) => {
          const { renderers, calls } = recording();
          expect(() => new ImageResponse(h("div", null), { renderers, width: bad })).toThrow(
            RangeError,
          );
          expect(() => new ImageResponse(h("div", null), { renderers, height: bad })).toThrow(
            RangeError,
          );
          expect(calls).toHaveLength(0);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("[SEC2-ASSET-62] the node count is bounded, however the nodes are arranged", () => {
    const wide = h("div", null, ...Array.from({ length: MAX_OG_NODES + 1 }, () => "x"));
    expect(() => expandTree(wide)).toThrow(RangeError);
    const arrays: OgNode = Array.from({ length: 100 }, () =>
      Array.from({ length: 100 }, () => "x"),
    );
    expect(() => expandTree(arrays)).toThrow(RangeError);
    // The same small child referenced many times is still counted once per place it is drawn.
    const shared = h("span", null, "x");
    expect(() => expandTree(h("div", null, ...Array.from({ length: 6000 }, () => shared)))).toThrow(
      RangeError,
    );
    expect(() =>
      expandTree(h("div", null, ...Array.from({ length: 1000 }, () => "x"))),
    ).not.toThrow();
  });

  it("[SEC2-ASSET-63] depth is bounded: a deep chain, a cyclic tree and a component that renders itself end in a RangeError", () => {
    let deep: OgNode = "leaf";
    for (let index = 0; index < 1000; index += 1) deep = h("div", null, deep);
    expect(() => expandTree(deep)).toThrow(RangeError);

    const cyclic: { type: string; props: { children?: unknown } } = { type: "div", props: {} };
    cyclic.props.children = cyclic;
    expect(() => expandTree(cyclic as never)).toThrow(RangeError);

    const Loop = (): OgNode => h(Loop);
    expect(() => expandTree(h(Loop))).toThrow(RangeError);

    const Forever = (): OgNode => [h(Forever), h(Forever)];
    expect(() => expandTree(h(Forever))).toThrow(RangeError);
  });

  it("[SEC2-ASSET-64] text is bounded: one huge string, or many strings whose total is huge, are refused", () => {
    expect(() => expandTree(h("div", null, "x".repeat(MAX_OG_TEXT_LENGTH + 1)))).toThrow(
      RangeError,
    );
    const piece = "y".repeat(10_000);
    expect(() =>
      expandTree(h("div", null, ...Array.from({ length: 20 }, () => h("span", null, piece)))),
    ).toThrow(RangeError);
    expect(() => expandTree(h("div", null, "x".repeat(MAX_OG_TEXT_LENGTH)))).not.toThrow();
  });

  it("[SEC2-ASSET-65] a single prop or style string longer than the limit is refused; a data: image has its own, larger limit", () => {
    expect(() =>
      expandTree(h("div", { style: { fontFamily: "a".repeat(MAX_OG_STRING_LENGTH + 1) } })),
    ).toThrow(RangeError);
    expect(() => expandTree(h("div", { "data-x": "a".repeat(MAX_OG_STRING_LENGTH + 1) }))).toThrow(
      RangeError,
    );
    const bigData = `data:image/png;base64,${"A".repeat(MAX_OG_DATA_LENGTH)}`;
    expect(() => expandTree(h("img", { src: bigData }))).toThrow(RangeError);
    const okData = `data:image/png;base64,${"A".repeat(200_000)}`;
    expect(() => expandTree(h("img", { src: okData }))).not.toThrow();
    // Several data images share one total.
    expect(() =>
      expandTree(
        h(
          "div",
          null,
          ...Array.from({ length: 12 }, () =>
            h("img", { src: `data:image/png;base64,${"A".repeat(1_000_000)}` }),
          ),
        ),
      ),
    ).toThrow(RangeError);
  });

  it("[SEC2-ASSET-66] NaN and Infinity in a style number or a numeric prop are refused (they would reach the layout engine)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => expandTree(h("div", { style: { width: bad } }))).toThrow(TypeError);
      expect(() => expandTree(h("img", { src: DATA_PNG, width: bad }))).toThrow(TypeError);
    }
    expect(() => expandTree(h("div", { style: { width: 100, opacity: 0.5 } }))).not.toThrow();
  });

  it("[SEC2-ASSET-67] a function, symbol or bigint in a prop is refused, not passed to the renderer", () => {
    expect(() => expandTree(h("div", { onClick: () => 1 }))).toThrow(TypeError);
    expect(() => expandTree(h("div", { x: Symbol("s") }))).toThrow(TypeError);
    expect(() => expandTree(h("div", { x: 10n }))).toThrow(TypeError);
  });

  it("[SEC2-ASSET-68] tag names are lower-case letters and digits only", () => {
    for (const tag of ["Script", "a b", "div>", "x-y", "", "1a", "__proto__"]) {
      expect(() => h(tag, null), tag).toThrow(TypeError);
    }
  });
});
