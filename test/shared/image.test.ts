import { describe, expect, it } from "vitest";
import { IMAGE_WIDTHS, imageProps, preloadImageTag } from "../../src/shared/image";

/**
 * `imageProps` is the attribute set of an `<img>`, computed the same on the server and in the browser
 * (it is plain data, so SSR and hydration produce identical attributes).
 */
describe("imageProps", () => {
  it("[IMG-01] width and height are required; the aspect ratio is written so the box keeps its shape", () => {
    expect(() => imageProps({ src: "/a.png", width: 0, height: 10, alt: "x" })).toThrow(RangeError);
    const props = imageProps({ src: "/a.png", width: 800, height: 600, alt: "x" });
    expect(props.width).toBe(800);
    expect(props.height).toBe(600);
    expect(props.style).toBe("aspect-ratio: 800 / 600");
  });

  it("[IMG-02] lazy by default; priority loads eagerly with a high fetch priority", () => {
    expect(imageProps({ src: "/a.png", width: 10, height: 10, alt: "" }).loading).toBe("lazy");
    const priority = imageProps({ src: "/a.png", width: 10, height: 10, alt: "", priority: true });
    expect(priority.loading).toBe("eager");
    expect(priority.fetchpriority).toBe("high");
    expect(priority.decoding).toBe("async");
  });

  it("[IMG-03] a responsive sizes offers every device width from the smallest, through the optimizer; the src is the snapped width", () => {
    const props = imageProps({
      src: "/hero.jpg",
      width: 700,
      height: 400,
      alt: "",
      sizes: "100vw",
    });
    const candidates = props.srcset.split(", ");
    expect(candidates).toEqual([
      "/_dusk/image?url=%2Fhero.jpg&w=640&q=75 640w",
      "/_dusk/image?url=%2Fhero.jpg&w=750&q=75 750w",
      "/_dusk/image?url=%2Fhero.jpg&w=828&q=75 828w",
      "/_dusk/image?url=%2Fhero.jpg&w=1080&q=75 1080w",
      "/_dusk/image?url=%2Fhero.jpg&w=1200&q=75 1200w",
      "/_dusk/image?url=%2Fhero.jpg&w=1920&q=75 1920w",
      "/_dusk/image?url=%2Fhero.jpg&w=2048&q=75 2048w",
      "/_dusk/image?url=%2Fhero.jpg&w=3840&q=75 3840w",
    ]);
    expect(props.sizes).toBe("100vw");
    // 700 is not offered: the src is the offered width that covers it (750).
    expect(props.src).toBe("/_dusk/image?url=%2Fhero.jpg&w=750&q=75");
  });

  it("[IMG-04] without sizes the image is taken to be its own width: the widths run from its display width to twice it", () => {
    const props = imageProps({
      src: "/icon.svg",
      width: 48,
      height: 48,
      alt: "logo",
      format: "original",
    });
    expect(props.sizes).toBe("48px");
    expect(props.srcset).toBe(
      [
        "/_dusk/image?url=%2Ficon.svg&w=48&q=75&f=original 48w",
        "/_dusk/image?url=%2Ficon.svg&w=64&q=75&f=original 64w",
        "/_dusk/image?url=%2Ficon.svg&w=96&q=75&f=original 96w",
      ].join(", "),
    );
  });

  it("[IMG-05] a custom loader replaces the optimizer URL; quality is clamped to 1 to 100", () => {
    const props = imageProps({
      src: "https://cdn.example/a.jpg",
      width: 300,
      height: 200,
      alt: "",
      quality: 500,
      loader: ({ src, width, quality }) =>
        `https://img.example/${width}/${quality}?src=${encodeURIComponent(src)}`,
    });
    // 300 is not an offered width: the loader is asked for the next one that is (384), never for 300.
    expect(props.src).toBe("https://img.example/384/100?src=https%3A%2F%2Fcdn.example%2Fa.jpg");
    expect(() => imageProps({ src: "/a", width: 1, height: 1, alt: "", quality: 0 })).toThrow(
      RangeError,
    );
  });

  it("[IMG-06] a source that is not a path or an http(s) URL is refused (no javascript:, data:, or protocol-relative)", () => {
    for (const src of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "//evil.example/x.png",
      "file:///etc/passwd",
    ]) {
      expect(() => imageProps({ src, width: 10, height: 10, alt: "" })).toThrow(TypeError);
    }
  });

  it("[IMG-07] the width candidates are the small and device widths, and alt is required", () => {
    expect(IMAGE_WIDTHS).toEqual([
      32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
    ]);
    expect(() =>
      imageProps({ src: "/a.png", width: 10, height: 10, alt: undefined as unknown as string }),
    ).toThrow(TypeError);
  });

  it("[IMG-08] preloadImageTag is a head link with the same candidates, for a priority image", () => {
    const tag = preloadImageTag({
      src: "/hero.jpg",
      width: 700,
      height: 400,
      alt: "",
      sizes: "100vw",
    });
    expect(tag.tag).toBe("link");
    expect(tag.props).toMatchObject({
      rel: "preload",
      as: "image",
      imagesizes: "100vw",
      fetchpriority: "high",
    });
    expect(String(tag.props?.["imagesrcset"])).toContain("w=640&q=75 640w");
  });
});
