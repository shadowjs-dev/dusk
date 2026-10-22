import { afterEach, describe, expect, it } from "vitest";
import { imageProps } from "../../src/shared/image";
import { configureImageBase } from "../../src/shared/image-check";

/**
 * An app mounted under a base path (`base: "/app"`) serves its optimizer at `/app/_dusk/image`. The default loader
 * writes that prefix, so the `src` of `<Image>` is one the handler routes (IMG-B1 to IMG-B3).
 */

afterEach(() => configureImageBase(""));

describe("image URLs under a mounted base", () => {
  it("[IMG-B1] with no base the optimizer is at /_dusk/image (unchanged)", () => {
    const props = imageProps({ src: "/hero.jpg", width: 1200, height: 630, alt: "" });
    expect(props.src.startsWith("/_dusk/image?")).toBe(true);
    expect(props.srcset.split(", ").every((c) => c.startsWith("/_dusk/image?"))).toBe(true);
  });

  it("[IMG-B2] with base /app the src and every candidate are under /app/_dusk/image", () => {
    configureImageBase("/app");
    const props = imageProps({ src: "/hero.jpg", width: 1200, height: 630, alt: "" });
    expect(props.src.startsWith("/app/_dusk/image?url=%2Fhero.jpg&w=1200")).toBe(true);
    for (const candidate of props.srcset.split(", ")) {
      expect(candidate.startsWith("/app/_dusk/image?")).toBe(true);
    }
  });

  it("[IMG-B3] a bad base is refused: a path with a leading slash, no trailing slash, no dot segments or protocol-relative", () => {
    for (const base of [
      "app",
      "/app/",
      "//evil.example",
      "/a/../b",
      "/a?x",
      "/a\\b",
      "https://x.example",
    ]) {
      expect(() => configureImageBase(base), base).toThrow(TypeError);
    }
    expect(() => configureImageBase("/app")).not.toThrow();
    expect(() => configureImageBase("")).not.toThrow();
  });
});
