import { type HeadTag, useHead } from "@shadow-js/web";
import { type ImageFormat, type ImageLoader, imageProps, preloadImageTag } from "../shared/image";
import { type PrebuiltImages, prebuiltSources } from "./image-prebuilt";

/**
 * `<Image>`: an image with the markup `imageProps` computes (candidates, lazy or priority loading, the aspect
 * ratio box), a placeholder while it loads, a fill mode for a positioned parent, art direction through `<picture>`,
 * and a `priority` image preloaded in the head. It renders the same markup on the server and in the browser.
 */

/**
 * One source of an art-directed image: shown where its media query matches (a phone crop, a wide banner).
 * @since 1.0.0
 */
export interface ArtDirectionSource {
  /** The media query (`(max-width: 640px)`). */
  readonly media: string;
  /** A path on this origin or an http(s) URL. */
  readonly src: string;
  /** The intrinsic width of this crop, in CSS pixels (the candidates are built from it). */
  readonly width: number;
  /** The intrinsic height of this crop. */
  readonly height: number;
  /** The output format. Default: the source's own. */
  readonly format?: ImageFormat;
  /** The `sizes` of this crop. Default: its width in pixels. */
  readonly sizes?: string;
}

/**
 * The props of {@link Image}. `width` and `height` are the intrinsic size of the file; with `fill` they are used
 * for the candidate widths only.
 * @since 1.0.0
 */
export interface ImageComponentProps {
  /** A path on this origin or an http(s) URL. */
  readonly src: string;
  /** The intrinsic width (CSS pixels). With `fill`, the largest candidate. */
  readonly width: number;
  /** The intrinsic height (CSS pixels). */
  readonly height: number;
  /** Alternative text. An empty string marks the image decorative. */
  readonly alt: string;
  /** The `sizes` attribute. Default: the width in pixels, or `100vw` with `fill`. */
  readonly sizes?: string;
  /** Load now with a high fetch priority, and preload it in the head. */
  readonly priority?: boolean;
  /** Quality from 1 to 100. Default 75. */
  readonly quality?: number;
  /** Output format for the optimizer. Default: the source's own. */
  readonly format?: ImageFormat;
  /** Builds the candidate URLs (a CDN's own resizing URL, for example). */
  readonly loader?: ImageLoader;
  /** Serve `src` exactly as given: no candidates, no optimizer. */
  readonly unoptimized?: boolean;
  /**
   * Fill the nearest positioned parent (`position: relative` on it). The image is absolutely placed and covers the
   * box; `width` and `height` still give the aspect ratio of the file.
   */
  readonly fill?: boolean;
  /** `blur`: a tiny image shown until the real one loads (`blurDataURL`). `color`: a background color. Default: none. */
  readonly placeholder?: "blur" | "color";
  /** A `data:image/*;base64,` URL of a small blurred version (`placeholder="blur"`). */
  readonly blurDataURL?: string;
  /** A CSS color (`#1a1a1a`, `silver`) shown until the image loads (`placeholder="color"`). */
  readonly placeholderColor?: string;
  /** Other crops by media query, rendered as `<source>` of a `<picture>`. */
  readonly art?: readonly ArtDirectionSource[];
  /** The class of the `<img>`. */
  readonly class?: string;
}

/** What prepared files add to an image: the `<source>` elements and the head link that preloads the best format. */
type Prepared = (
  props: ImageComponentProps,
  sizes: string,
) => { readonly sources: readonly Attributes[]; readonly preload: HeadTag } | undefined;

/** Set by {@link configureImageVariants}; an app that prepared no images never sets it, and its bundle holds none of that code. */
let prepared: Prepared | undefined;
/** Every image {@link configureImageVariants} was given, by `src`. */
let known: PrebuiltImages = {};

/**
 * Gives `<Image>` the images the build prepared (`imageVariants()` of `@shadow-js/dusk/vite`), so it writes `<picture>`
 * sources that point at them. The build calls it for you; it is public for an app that wires its entries by hand. Call it
 * before anything renders, with the same maps on the server and in the browser. A second call adds its images to the first
 * one's (a later entry for the same `src` replaces the earlier one). An image in the map is used unless the props ask for
 * something the files cannot give (`unoptimized`, `loader`, `format`, `art`).
 *
 * @param images The prepared images by the URL written in `src`.
 * @example
 * configureImageVariants({ "/hero.jpg": { d: "/assets/img/hero", w: [640], a: ["ab12cd34"] } });
 * @since 1.0.0
 */
export function configureImageVariants(images: PrebuiltImages): void {
  known = { ...known, ...images };
  const table = known;
  prepared = (props, sizes) => {
    if (props.unoptimized === true || props.loader !== undefined || props.format !== undefined) {
      return undefined;
    }
    const image = Object.hasOwn(table, props.src) ? table[props.src] : undefined;
    const sources = image === undefined ? [] : prebuiltSources(image);
    const best = sources[0];
    if (best === undefined) return undefined;
    return {
      sources: sources.map((source) => ({ ...source, sizes })),
      // A browser that cannot decode the type skips the preload and loads the image normally.
      preload: {
        tag: "link",
        props: {
          rel: "preload",
          as: "image",
          type: best.type,
          imagesrcset: best.srcset,
          imagesizes: sizes,
          fetchpriority: "high",
        },
      },
    };
  };
}

const BLUR_URL = /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]{1,8192}$/;
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const MIME: Readonly<Record<ImageFormat, string | undefined>> = {
  original: undefined,
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** The attributes of the `<img>` (and of a `<source>`), as plain data. */
interface Attributes {
  readonly [name: string]: string | number | boolean | undefined;
}

function placeholderStyle(props: ImageComponentProps): string {
  if (props.placeholder === "blur") {
    if (props.blurDataURL === undefined || !BLUR_URL.test(props.blurDataURL)) {
      throw new TypeError(
        'Image: placeholder="blur" needs blurDataURL, a data:image/*;base64 URL of up to 8 KiB.',
      );
    }
    return `background-image: url("${props.blurDataURL}"); background-size: cover;`;
  }
  if (props.placeholder === "color") {
    if (props.placeholderColor === undefined || !COLOR.test(props.placeholderColor)) {
      throw new TypeError(
        'Image: placeholder="color" needs placeholderColor, a hex color or a color name.',
      );
    }
    return `background-color: ${props.placeholderColor};`;
  }
  return "";
}

/** The attributes of the main `<img>`: optimized through `imageProps`, or the source exactly as given. */
function imageAttributes(props: ImageComponentProps): Attributes {
  const placeholder = placeholderStyle(props);
  const fillStyle = "position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;";
  const base =
    props.unoptimized === true
      ? plainAttributes(props)
      : imageProps(
          // imageProps reads only its own keys, so the component props pass through; a fill image defaults to 100vw.
          props.fill === true && props.sizes === undefined ? { ...props, sizes: "100vw" } : props,
        );
  const style = [props.fill === true ? fillStyle : base.style, placeholder]
    .filter((part) => part !== "")
    .join(" ");
  const { width, height, ...rest } = base;
  // An empty candidate list (an unoptimized image) and an absent class are left out, not written as "".
  const attributes: Record<string, string | number | undefined> = {
    ...rest,
    ...(props.fill === true ? {} : { width, height }),
    style,
    class: props.class,
  };
  for (const name of Object.keys(attributes)) {
    if (attributes[name] === "" || attributes[name] === undefined) delete attributes[name];
  }
  return attributes;
}

/** The plain `<img>` attributes for a source that is not optimized: no candidates, the file as given. */
function plainAttributes(props: ImageComponentProps): {
  src: string;
  width: number;
  height: number;
  alt: string;
  sizes?: string;
  loading: "lazy" | "eager";
  decoding: "async";
  fetchpriority: "high" | "auto";
  style: string;
} {
  const priority = props.priority === true;
  return {
    src: props.src,
    width: props.width,
    height: props.height,
    alt: props.alt,
    ...(props.sizes === undefined ? {} : { sizes: props.sizes }),
    loading: priority ? "eager" : "lazy",
    decoding: "async",
    fetchpriority: priority ? "high" : "auto",
    style: `aspect-ratio: ${props.width} / ${props.height}`,
  };
}

/** The attributes of one `<source>` of an art-directed picture. */
function sourceAttributes(source: ArtDirectionSource, quality: number | undefined): Attributes {
  const built = imageProps({
    src: source.src,
    width: source.width,
    height: source.height,
    alt: "",
    ...(source.sizes === undefined ? {} : { sizes: source.sizes }),
    ...(source.format === undefined ? {} : { format: source.format }),
    ...(quality === undefined ? {} : { quality }),
  });
  const type = source.format === undefined ? undefined : MIME[source.format];
  return {
    media: source.media,
    srcset: built.srcset,
    sizes: built.sizes,
    ...(type === undefined ? {} : { type }),
  };
}

/**
 * An image. The props are checked when it renders (a bad source, a placeholder without its value, a width that is
 * not a whole number): the error names the prop.
 *
 * @param props The image's props.
 * @returns The `<img>`, or a `<picture>` with its sources when `art` is given.
 * @throws TypeError or RangeError for props that cannot produce markup (see `imageProps`).
 * @example
 * <Image src="/hero.jpg" width={1200} height={630} alt="" priority sizes="100vw" />
 * @since 1.0.0
 */
export function Image(props: ImageComponentProps): unknown {
  const attributes = imageAttributes(props);
  const found =
    props.art === undefined ? prepared?.(props, String(attributes["sizes"])) : undefined;
  if (props.priority === true && props.unoptimized === true) {
    // The file itself is the preload target: there are no candidates to offer.
    useHead({
      tag: "link",
      props: { rel: "preload", as: "image", href: props.src, fetchpriority: "high" },
    });
  } else if (props.priority === true) {
    useHead(found?.preload ?? preloadImageTag(props));
  }
  const sources =
    found?.sources ?? (props.art ?? []).map((source) => sourceAttributes(source, props.quality));
  // `alt` is a required prop (an empty string marks the image decorative), so every <img> here has one.
  // biome-ignore lint/a11y/useAltText: the attributes carry the required alt prop.
  if (sources.length === 0) return <img {...attributes} />;
  return (
    <picture>
      {sources.map((source) => (
        <source {...source} />
      ))}
      {/* biome-ignore lint/a11y/useAltText: the attributes carry the required alt prop. */}
      <img {...attributes} />
    </picture>
  );
}
