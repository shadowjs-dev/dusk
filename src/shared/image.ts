import type { HeadTag } from "@shadow-js/web";

/**
 * Image attributes for `<img>`: responsive candidates, lazy or priority loading, and a box that keeps its
 * aspect ratio before the file arrives (no layout shift). The result is plain data, so the server and the
 * browser produce the same attributes; spread it on the element: `<img {...imageProps({ ... })} />`.
 * The optimizer endpoint it points at is `/_dusk/image` (see the server's `images` option).
 *
 * This module is the component path, so it holds no validation: the checks of a width configuration live in
 * `image-check.ts`, which the build, the server and `configureImageWidths` use.
 */

/**
 * The device widths: the widths of phone, tablet, laptop and large screens, the list responsive images (`sizes`
 * with `vw`, `fill`) draw from. Next's `deviceSizes`.
 * @example
 * DEVICE_WIDTHS.filter((width) => width >= 1920); // [1920, 2048, 3840]
 * @since 1.0.0
 */
export const DEVICE_WIDTHS: readonly number[] = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];

/**
 * The small widths for icons and thumbnails, which no device needs at full size. Next's `imageSizes`.
 * @example
 * SMALL_WIDTHS.filter((width) => width <= 64); // [32, 48, 64]
 * @since 1.0.0
 */
export const SMALL_WIDTHS: readonly number[] = [32, 48, 64, 96, 128, 256, 384];

/**
 * Every width the optimizer offers by default, ascending. The optimizer serves only these.
 *
 * @example
 * import { IMAGE_WIDTHS } from "@shadow-js/dusk";
 * IMAGE_WIDTHS.includes(1200); // true
 * IMAGE_WIDTHS.includes(1000); // false
 * @since 1.0.0
 */
export const IMAGE_WIDTHS: readonly number[] = [...SMALL_WIDTHS, ...DEVICE_WIDTHS];

/**
 * The widths an app offers: `images.widths` in `dusk.config.ts`, or `widths` of `createHandler({ images })`. A list
 * given replaces its default; a missing one keeps it. The components and the optimizer read the same list, so an
 * image never asks for a width the optimizer refuses.
 * @since 1.0.0
 */
export interface ImageWidths {
  /** Widths for responsive images (`sizes` with `vw`, and `fill`). Default: {@link DEVICE_WIDTHS}. */
  readonly deviceSizes?: readonly number[];
  /** Small fixed widths (icons, thumbnails). Default: {@link SMALL_WIDTHS}. */
  readonly imageSizes?: readonly number[];
}

/**
 * The widths in use: the device list, the whole offer (both ascending, unique), and the largest offered width, which
 * is the optimizer's maximum. @internal
 */
export interface ImageWidthSet {
  readonly device: readonly number[];
  readonly all: readonly number[];
  readonly largest: number;
}

/**
 * The widths in use from a device list and a small list. The caller has checked both (see `image-check.ts`).
 * @internal
 */
export function resolveImageWidths(
  device: readonly number[],
  small: readonly number[],
): ImageWidthSet {
  const all = [...new Set([...device, ...small])].sort((a, b) => a - b);
  return { device: [...device].sort((a, b) => a - b), all, largest: Math.max(...all) };
}

/**
 * The default widths, already resolved (what {@link resolveImageWidths} returns for the two default lists; a test pins
 * that). Written out so the module does not sort and merge the lists at start-up.
 */
const DEFAULT_SET: ImageWidthSet = { device: DEVICE_WIDTHS, all: IMAGE_WIDTHS, largest: 3840 };

/** The widths `imageProps` uses. Replaced once at startup by `configureImageWidths` (the generated entries call it). */
let active: ImageWidthSet = DEFAULT_SET;

/**
 * Replaces the widths `imageProps` uses. Called by `configureImageWidths`, which checks the configuration first.
 * @internal
 */
export function setImageWidthSet(set: ImageWidthSet): void {
  active = set;
}

/** The output formats the optimizer knows. `original` keeps the source's format. @since 1.0.0 */
export type ImageFormat = "original" | "webp" | "avif" | "jpeg" | "png";

/**
 * Builds the URL of one candidate. The default points at the optimizer; a loader replaces it (a CDN's own
 * resizing URL, for example).
 * @since 1.0.0
 */
export type ImageLoader = (details: {
  readonly src: string;
  readonly width: number;
  readonly quality: number;
  readonly format: ImageFormat | undefined;
}) => string;

/** Options of {@link imageProps}. @since 1.0.0 */
export interface ImagePropsOptions {
  /** A path on this origin (`/images/a.jpg`) or an http(s) URL. */
  readonly src: string;
  /** The width the image is displayed at, in CSS pixels. */
  readonly width: number;
  /** The height it is displayed at, in CSS pixels; with `width` it reserves the box. */
  readonly height: number;
  /** Alternative text. Required: an empty string marks the image decorative. */
  readonly alt: string;
  /** The `sizes` attribute. Default: the display width in pixels. */
  readonly sizes?: string;
  /** Load now, not when the image nears the viewport, with a high fetch priority (the largest image of a page). */
  readonly priority?: boolean;
  /** Quality, 1 to 100 (values above 100 are 100). Default 75. */
  readonly quality?: number;
  /** Output format for the default optimizer URL. Default: the source's own. */
  readonly format?: ImageFormat;
  /** Builds the candidate URLs. Default: the optimizer endpoint. */
  readonly loader?: ImageLoader;
}

/** The attributes {@link imageProps} returns; every key is an attribute name of `<img>`. @since 1.0.0 */
export interface ImageProps {
  readonly src: string;
  readonly srcset: string;
  readonly sizes: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  readonly loading: "lazy" | "eager";
  readonly decoding: "async";
  readonly fetchpriority: "high" | "auto";
  readonly style: string;
}

/**
 * The default URL of the optimizer endpoint for one candidate.
 *
 * @example
 * defaultImageLoader({ src: "/hero.jpg", width: 640, quality: 75, format: undefined }); // "/_dusk/image?url=%2Fhero.jpg&w=640&q=75"
 * @since 1.0.0
 */
export const defaultImageLoader: ImageLoader = ({ src, width, quality, format }) => {
  const query = `url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
  return `${activeBase}/_dusk/image?${format === undefined ? query : `${query}&f=${format}`}`;
};

/**
 * The mount point of the app (`/app`, or `""`). The optimizer lives under it, so the default loader writes it first: the
 * handler routes an image URL only after it strips the mount point. Replaced once at startup by `configureImageBase`.
 */
let activeBase = "";

/**
 * Replaces the mount point the default loader writes. Called by `configureImageBase`, which checks the value first.
 * @internal
 */
export function setImageBase(base: string): void {
  activeBase = base;
}

const VW_PERCENT = /(^|\s)(1?\d?\d)vw/g;

/** The smallest offered width that covers `want`, or the largest offered width when none does. */
function cover(set: ImageWidthSet, want: number): number {
  return set.all.find((width) => width >= want) ?? set.largest;
}

/**
 * The candidates of a srcset, ascending. A `vw` sizes attribute draws from every offered width above the smallest device
 * width times the smallest viewport share (Next's rule). Otherwise the image is a fixed size: the widths from the one that
 * covers its display width to the one that covers twice it.
 */
function candidateWidths(
  set: ImageWidthSet,
  width: number,
  sizes: string | undefined,
): readonly number[] {
  const percents =
    sizes === undefined ? [] : [...sizes.matchAll(VW_PERCENT)].map((m) => Number(m[2]));
  if (percents.length > 0) {
    const floor = (Math.min(...set.device) * Math.min(...percents)) / 100;
    const responsive = set.all.filter((candidate) => candidate >= floor);
    if (responsive.length > 0) return responsive;
  }
  const low = cover(set, width);
  const high = cover(set, width * 2);
  return set.all.filter((candidate) => candidate >= low && candidate <= high);
}

/** A source that may be used: a path on this origin, or an absolute http(s) URL. */
function checkSource(src: string): void {
  if (src.startsWith("/") && !src.startsWith("//") && !src.startsWith("/\\")) return;
  if (URL.canParse(src)) {
    const { protocol } = new URL(src);
    if (protocol === "http:" || protocol === "https:") return;
  }
  throw new TypeError(
    `imageProps: the src ${JSON.stringify(src)} must be a path on this origin or an http(s) URL.`,
  );
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`imageProps: ${name} must be a positive integer.`);
}

/**
 * The attributes of an `<img>` for an image. Without `sizes` (or with a fixed one), the candidates are the offered
 * widths that cover the display width and twice it, so a 2x screen gets a sharp image and a small one does not download
 * a big file. A `sizes` with `vw` offers every width from the smallest device width times its viewport share. The `src`
 * is the offered width that covers the display width (the largest when none does). Every width written is one the
 * optimizer serves: a width the app does not offer is snapped up to the next one that it does.
 *
 * @param options The source, its displayed size, and the loading and quality choices.
 * @returns The attributes (spread them on `<img>`).
 * @throws TypeError for a source that is not a path or an http(s) URL, or an `alt` that is not a string.
 * @throws RangeError for a width, height or quality that is out of range.
 * @example
 * <img {...imageProps({ src: "/hero.jpg", width: 1200, height: 630, alt: "", priority: true, sizes: "100vw" })} />
 * @since 1.0.0
 */
export function imageProps(options: ImagePropsOptions): ImageProps {
  checkSource(options.src);
  positiveInteger("width", options.width);
  positiveInteger("height", options.height);
  if (typeof options.alt !== "string")
    throw new TypeError("imageProps: alt is required (an empty string for decorative images).");
  const quality = options.quality ?? 75;
  if (!Number.isInteger(quality) || quality < 1)
    throw new RangeError("imageProps: quality must be an integer from 1 to 100.");
  const q = Math.min(quality, 100);
  const loader = options.loader ?? defaultImageLoader;
  const format = options.format;
  // Only an offered width may be written: the optimizer answers 400 for any other `w`.
  const widths = candidateWidths(active, options.width, options.sizes);
  const url = (width: number): string => loader({ src: options.src, width, quality: q, format });
  const priority = options.priority === true;
  return {
    src: url(cover(active, options.width)),
    srcset: widths.map((width) => `${url(width)} ${width}w`).join(", "),
    sizes: options.sizes ?? `${options.width}px`,
    width: options.width,
    height: options.height,
    alt: options.alt,
    loading: priority ? "eager" : "lazy",
    decoding: "async",
    fetchpriority: priority ? "high" : "auto",
    style: `aspect-ratio: ${options.width} / ${options.height}`,
  };
}

/**
 * A head `<link rel="preload">` for a priority image, with the same candidates, so the browser starts the
 * download before the markup is parsed. Register it with `useHead` or put it in `document.head`.
 *
 * @param options The same options as {@link imageProps}.
 * @returns A head tag.
 * @example
 * import { preloadImageTag } from "@shadow-js/dusk";
 * preloadImageTag({ src: "/hero.jpg", width: 1200, height: 630, alt: "" }).props.fetchpriority; // "high"
 * @since 1.0.0
 */
export function preloadImageTag(options: ImagePropsOptions): HeadTag {
  const props = imageProps({ ...options, priority: true });
  return {
    tag: "link",
    props: {
      rel: "preload",
      as: "image",
      href: props.src,
      imagesrcset: props.srcset,
      imagesizes: props.sizes,
      fetchpriority: "high",
    },
  };
}
