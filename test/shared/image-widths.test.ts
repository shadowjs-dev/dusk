import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_WIDTHS,
  IMAGE_WIDTHS,
  type ImageWidths,
  imageProps,
  preloadImageTag,
  SMALL_WIDTHS,
} from "../../src/shared/image";
import { configureImageWidths, imageWidthSet } from "../../src/shared/image-check";

/**
 * The widths the optimizer offers and how `imageProps` picks from them. The optimizer answers 400 for any `w` that
 * is not in its list, so every URL `imageProps` writes must name one of them (IMG-W1 to IMG-W11).
 */

/** The `w` values of every URL in a srcset or a src, as numbers. */
function widthsIn(text: string): number[] {
  return [...text.matchAll(/[?&]w=(\d+)/g)].map((match) => Number(match[1]));
}

/** The width descriptors (`640w`) of a srcset, as numbers. */
function descriptorsIn(srcset: string): number[] {
  return srcset.split(", ").map((candidate) => Number(candidate.split(" ")[1]?.replace("w", "")));
}

afterEach(() => configureImageWidths(undefined));

describe("image widths", () => {
  it("[IMG-W1] the default offer is the small widths plus the device widths, ascending", () => {
    expect(DEVICE_WIDTHS).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    expect(SMALL_WIDTHS).toEqual([32, 48, 64, 96, 128, 256, 384]);
    expect(IMAGE_WIDTHS).toEqual([...SMALL_WIDTHS, ...DEVICE_WIDTHS]);
  });

  it("[IMG-W12] the built-in default set is what the two default lists resolve to: configuring them changes no attribute", () => {
    const props = { src: "/a.jpg", width: 300, height: 200, alt: "", sizes: "50vw" };
    const byDefault = imageProps(props);
    configureImageWidths({ deviceSizes: [...DEVICE_WIDTHS], imageSizes: [...SMALL_WIDTHS] });
    expect(imageProps(props)).toEqual(byDefault);
  });

  it("[IMG-W2] a width that is not offered is snapped up to the next offered width (no 400 from the optimizer)", () => {
    const props = imageProps({ src: "/hero.jpg", width: 300, height: 200, alt: "" });
    expect(widthsIn(props.src)).toEqual([384]);
    // The display width 300 and its 2x (600) snap to 384 and 640.
    expect(descriptorsIn(props.srcset)).toEqual([384, 640]);
    expect(widthsIn(props.srcset)).toEqual([384, 640]);
  });

  it("[IMG-W3] a fixed width offers its own snapped width and the snapped 2x width, with the widths between", () => {
    const props = imageProps({ src: "/hero.jpg", width: 1200, height: 630, alt: "" });
    expect(widthsIn(props.src)).toEqual([1200]);
    expect(descriptorsIn(props.srcset)).toEqual([1200, 1920, 2048, 3840]);
  });

  it("[IMG-W4] a width above the largest offered width snaps to it, and the src is that width", () => {
    const props = imageProps({ src: "/wide.jpg", width: 5000, height: 2000, alt: "" });
    expect(widthsIn(props.src)).toEqual([3840]);
    expect(descriptorsIn(props.srcset)).toEqual([3840]);
  });

  it("[IMG-W5] a sizes attribute with vw offers every width from the smallest device width times the smallest vw ratio", () => {
    expect(
      descriptorsIn(
        imageProps({ src: "/a.jpg", width: 700, height: 400, alt: "", sizes: "100vw" }).srcset,
      ),
    ).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    // 50vw on a small screen: 640 x 0.5 = 320, so 384 is offered too.
    expect(
      descriptorsIn(
        imageProps({
          src: "/a.jpg",
          width: 700,
          height: 400,
          alt: "",
          sizes: "(max-width: 600px) 50vw, 100vw",
        }).srcset,
      ),
    ).toEqual([384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    // The src is still the snapped intrinsic width.
    expect(
      widthsIn(imageProps({ src: "/a.jpg", width: 700, height: 400, alt: "", sizes: "100vw" }).src),
    ).toEqual([750]);
  });

  it("[IMG-W6] a sizes attribute without vw is the same fixed-width offer as no sizes", () => {
    const props = imageProps({ src: "/a.jpg", width: 300, height: 200, alt: "", sizes: "300px" });
    expect(descriptorsIn(props.srcset)).toEqual([384, 640]);
    expect(props.sizes).toBe("300px");
  });

  it("[IMG-W7] configured deviceSizes and imageSizes replace the defaults for both the src and the candidates", () => {
    const widths: ImageWidths = { deviceSizes: [500, 1000], imageSizes: [50] };
    configureImageWidths(widths);
    const small = imageProps({ src: "/a.png", width: 300, height: 100, alt: "" });
    expect(widthsIn(small.src)).toEqual([500]);
    expect(descriptorsIn(small.srcset)).toEqual([500, 1000]);
    const tiny = imageProps({ src: "/a.png", width: 40, height: 40, alt: "" });
    expect(widthsIn(tiny.src)).toEqual([50]);
    expect(imageWidthSet(widths).all).toEqual([50, 500, 1000]);
  });

  it("[IMG-W8] a configuration that is not a list of positive whole widths is refused, naming the key", () => {
    const bad: readonly [unknown, RegExp, new (message: string) => Error][] = [
      [{ deviceSizes: [] }, /images\.widths\.deviceSizes/, RangeError],
      [{ deviceSizes: [0] }, /images\.widths\.deviceSizes/, RangeError],
      [{ deviceSizes: [1.5] }, /images\.widths\.deviceSizes/, RangeError],
      [{ deviceSizes: [8193] }, /images\.widths\.deviceSizes/, RangeError],
      [{ imageSizes: [-32] }, /images\.widths\.imageSizes/, RangeError],
      [{ deviceSizes: "640" }, /images\.widths\.deviceSizes/, TypeError],
      [{ deviceSizes: [640, "750"] }, /images\.widths\.deviceSizes/, TypeError],
      [
        { deviceSizes: Array.from({ length: 65 }, (_, i) => i + 1) },
        /images\.widths\.deviceSizes/,
        RangeError,
      ],
      [{ deviceSize: [640] }, /images\.widths/, TypeError],
    ];
    for (const [value, pattern, kind] of bad) {
      expect(() => imageWidthSet(value as ImageWidths)).toThrow(kind);
      expect(() => imageWidthSet(value as ImageWidths)).toThrow(pattern);
    }
    expect(imageWidthSet(undefined).all).toEqual(IMAGE_WIDTHS);
  });

  it("[IMG-W9] every URL imageProps writes names an offered width, for any display width and sizes (property, fixed seed)", () => {
    const sizes = fc.constantFrom(undefined, "100vw", "(max-width: 600px) 50vw, 100vw", "300px");
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9000 }), sizes, (width, sizesValue) => {
        const props = imageProps({
          src: "/a.jpg",
          width,
          height: 10,
          alt: "",
          ...(sizesValue === undefined ? {} : { sizes: sizesValue }),
        });
        const offered = imageWidthSet(undefined).all;
        for (const w of [...widthsIn(props.src), ...widthsIn(props.srcset)]) {
          expect(offered).toContain(w);
        }
        const descriptors = descriptorsIn(props.srcset);
        expect([...descriptors].sort((a, b) => a - b)).toEqual(descriptors);
      }),
      { seed: 20261010, numRuns: 400 },
    );
  });

  it("[IMG-W10] configured widths are checked by the same property (random valid lists, fixed seed)", () => {
    const list = fc.uniqueArray(fc.integer({ min: 1, max: 8192 }), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(list, list, fc.integer({ min: 1, max: 9000 }), (device, small, width) => {
        const widths: ImageWidths = { deviceSizes: device, imageSizes: small };
        const offered = imageWidthSet(widths).all;
        configureImageWidths(widths);
        const props = imageProps({ src: "/a.jpg", width, height: 10, alt: "" });
        for (const w of [...widthsIn(props.src), ...widthsIn(props.srcset)]) {
          expect(offered).toContain(w);
        }
      }),
      { seed: 20261011, numRuns: 300 },
    );
  });

  it("[IMG-W11] configureImageWidths sets the widths for every imageProps call that gives none, and undefined restores the defaults", () => {
    configureImageWidths({ deviceSizes: [500], imageSizes: [50] });
    expect(widthsIn(imageProps({ src: "/a.jpg", width: 300, height: 10, alt: "" }).src)).toEqual([
      500,
    ]);
    expect(
      widthsIn(
        preloadImageTag({ src: "/a.jpg", width: 300, height: 10, alt: "" }).props?.[
          "href"
        ] as string,
      ),
    ).toEqual([500]);
    configureImageWidths(undefined);
    expect(widthsIn(imageProps({ src: "/a.jpg", width: 300, height: 10, alt: "" }).src)).toEqual([
      384,
    ]);
  });
});
