import { describe, expect, it } from "vitest";
import { fontFace } from "../src/shared/font";

const src = [{ url: "/fonts/a.woff2", format: "woff2" as const }];

describe("fontFace: every descriptor is checked before it reaches the CSS", () => {
  it("[DUSK-REST-REV-7] a weight or a style that could end the declaration or the style element is refused", () => {
    for (const weight of [
      "400; } body { background: url(//evil.example/x) } @font-face { font-family: y",
      "400</style><script>alert(1)</script>",
      "bold; color: red",
      "",
      Number.NaN,
    ]) {
      expect(() => fontFace({ family: "A", src, weight })).toThrow(TypeError);
    }
    expect(() =>
      fontFace({ family: "A", src, style: "italic; } * { display: none" as "italic" }),
    ).toThrow(TypeError);
  });

  it("[DUSK-REST-REV-8] a number, a keyword, a number pair and the three styles are still written", () => {
    expect(fontFace({ family: "A", src, weight: 700 })).toContain("font-weight: 700;");
    expect(fontFace({ family: "A", src, weight: "bold" })).toContain("font-weight: bold;");
    expect(fontFace({ family: "A", src, weight: "100 900" })).toContain("font-weight: 100 900;");
    expect(fontFace({ family: "A", src, weight: "350.5" })).toContain("font-weight: 350.5;");
    for (const style of ["normal", "italic", "oblique"] as const) {
      expect(fontFace({ family: "A", src, style })).toContain(`font-style: ${style};`);
    }
  });
});

describe("script and image sources: a browser removes tabs and line breaks from a URL", () => {
  it("[DUSK-REST-REV-9] a path with a tab or line break inside (it would read as //host) is refused", async () => {
    const { scriptTag } = await import("../src/shared/script");
    const { imageProps } = await import("../src/shared/image");
    for (const src of ["/\t/evil.example/x.js", "/\n/evil.example/x.js", "/\r/evil.example/x.js"]) {
      expect(() => scriptTag({ src })).toThrow(TypeError);
      expect(() => imageProps({ src, width: 10, height: 10, alt: "" })).toThrow(TypeError);
    }
    expect(scriptTag({ src: "/a/b.js" })).toContain('src="/a/b.js"');
  });
});
