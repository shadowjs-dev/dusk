import { describe, expect, it } from "vitest";
import { fallbackFontFace, fontFace, fontPreloadTag } from "../../src/shared/font";

/**
 * Font loading: the preload link, the `@font-face` rule with `font-display`, and the fallback face whose
 * size and vertical metrics match the web font, so text does not jump when the web font arrives.
 */
describe("font helpers", () => {
  it("[FNT-01] a preload link for a font names its type and sends the request in CORS mode", () => {
    expect(fontPreloadTag({ href: "/fonts/inter.woff2" })).toEqual({
      tag: "link",
      props: {
        rel: "preload",
        as: "font",
        href: "/fonts/inter.woff2",
        type: "font/woff2",
        crossorigin: "anonymous",
      },
    });
    expect(fontPreloadTag({ href: "/f/x.woff", type: "font/woff" }).props?.["type"]).toBe(
      "font/woff",
    );
  });

  it("[FNT-02] a font face has font-display swap by default and lists its sources in order", () => {
    const css = fontFace({
      family: "Inter",
      src: [
        { url: "/fonts/inter.woff2", format: "woff2" },
        { url: "/fonts/inter.woff", format: "woff" },
      ],
      weight: "100 900",
      style: "normal",
    });
    expect(css).toBe(
      '@font-face { font-family: "Inter"; src: url("/fonts/inter.woff2") format("woff2"), url("/fonts/inter.woff") format("woff"); font-weight: 100 900; font-style: normal; font-display: swap; }',
    );
    expect(
      fontFace({ family: "X", src: [{ url: "/x.woff2", format: "woff2" }], display: "optional" }),
    ).toContain("font-display: optional;");
  });

  it("[FNT-03] names, urls and display values that could break out of the CSS are refused", () => {
    expect(() =>
      fontFace({ family: 'Inter"; } body { x: y', src: [{ url: "/x.woff2", format: "woff2" }] }),
    ).toThrow(TypeError);
    expect(() =>
      fontFace({ family: "Inter", src: [{ url: '/x.woff2") ; }', format: "woff2" }] }),
    ).toThrow(TypeError);
    expect(() =>
      fontFace({
        family: "Inter",
        src: [{ url: "/x.woff2", format: "woff2" }],
        display: "bogus" as never,
      }),
    ).toThrow(TypeError);
    expect(() => fontFace({ family: "Inter", src: [] })).toThrow(TypeError);
  });

  it("[FNT-04] the fallback face scales a local font so its average character width and vertical metrics match", () => {
    // Web font: 1000 units per em, average lowercase width 500 (0.5 em), ascender 800, descender -200.
    // Fallback: 1000 units per em, average width 250 (0.25 em). The fallback must be drawn at twice its size.
    const css = fallbackFontFace({
      family: "Inter fallback",
      local: "Arial",
      font: { unitsPerEm: 1000, xWidthAvg: 500, ascender: 800, descender: -200, lineGap: 0 },
      fallback: { unitsPerEm: 1000, xWidthAvg: 250 },
    });
    expect(css).toBe(
      '@font-face { font-family: "Inter fallback"; src: local("Arial"); size-adjust: 200%; ascent-override: 40%; descent-override: 10%; line-gap-override: 0%; }',
    );
  });

  it("[FNT-05] a fallback needs both metric sets: a zero width is refused, not divided by", () => {
    expect(() =>
      fallbackFontFace({
        family: "F",
        local: "Arial",
        font: { unitsPerEm: 1000, xWidthAvg: 500, ascender: 800, descender: -200, lineGap: 0 },
        fallback: { unitsPerEm: 1000, xWidthAvg: 0 },
      }),
    ).toThrow(RangeError);
  });
});
