import { type HeadTag, useHead } from "@shadow-js/web";
import { hasControl } from "../internal/text";
import {
  type ImageFormat,
  type ImageLoader,
  type ImageProps,
  type ImagePropsOptions,
  imageProps,
  loadingAttributes,
  preloadImageTag,
} from "../shared/image";
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
) => { readonly sources: readonly SourceAttributes[]; readonly preload: HeadTag } | undefined;

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
      sources: sources.map((source) => ({ media: undefined, ...source, sizes })),
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

/**
 * What the `<img>` is written with. The element names every attribute, so a bundle holds the few lines that set them and not
 * the general code that spreads an object of attributes. A member that is undefined is not written.
 */
interface ImgAttributes {
  readonly src: string;
  readonly srcset: string | undefined;
  readonly sizes: string | undefined;
  readonly alt: string | undefined;
  readonly loading: "lazy" | "eager";
  readonly decoding: "async";
  readonly fetchpriority: "high" | "auto";
  readonly style: string;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly class: string | undefined;
}

/** What a `<source>` is written with (see {@link ImgAttributes}). */
interface SourceAttributes {
  readonly media: string | undefined;
  readonly type: string | undefined;
  readonly srcset: string;
  readonly sizes: string | undefined;
}

/** The attributes of an image that is not optimized: no candidates, the file as given. */
type PlainImage = Omit<ImageProps, "srcset" | "sizes"> & {
  readonly srcset?: undefined;
  readonly sizes?: string;
};

function placeholderStyle(props: ImageComponentProps): string {
  if (props.placeholder === "blur") {
    if (props.blurDataURL === undefined || !BLUR_URL.test(props.blurDataURL)) {
      throw new TypeError(
        __DEV__
          ? 'Image: placeholder="blur" needs blurDataURL, a data:image/*;base64 URL of up to 8 KiB.'
          : "DUSK_IMAGE_1",
      );
    }
    return `background-image: url("${props.blurDataURL}"); background-size: cover;`;
  }
  if (props.placeholder === "color") {
    if (props.placeholderColor === undefined || !COLOR.test(props.placeholderColor)) {
      throw new TypeError(
        __DEV__
          ? 'Image: placeholder="color" needs placeholderColor, a hex color or a color name.'
          : "DUSK_IMAGE_2",
      );
    }
    return `background-color: ${props.placeholderColor};`;
  }
  return "";
}

/** The attributes of the main `<img>`: optimized through `imageProps`, or the source exactly as given. */
function imageAttributes(props: ImageComponentProps): ImgAttributes {
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
  const fill = props.fill === true;
  // An empty class, sizes or candidate list is left out, not written as "". An empty `alt` is kept: it marks the image
  // decorative, and an `<img>` without `alt` is announced by its file name instead.
  const written = (value: string | undefined): string | undefined =>
    value === "" ? undefined : value;
  return {
    src: base.src,
    srcset: written(base.srcset),
    sizes: written(base.sizes),
    alt: base.alt,
    loading: base.loading,
    decoding: base.decoding,
    fetchpriority: base.fetchpriority,
    style,
    width: fill ? undefined : base.width,
    height: fill ? undefined : base.height,
    class: written(props.class),
  };
}

/**
 * A source an unoptimized image may write, read as a browser reads it (after the blanks around it): a relative reference
 * (no scheme), `http(s):`, `blob:` or `data:image/*`. Every other scheme (`javascript:`, `vbscript:`, `data:text/html`,
 * `file:`) fails.
 */
const PLAIN_SRC = /^(?![a-z][a-z0-9+.-]*:)|^(?:https?|blob):|^data:image\/[a-z0-9.+-]+[;,]/i;

/**
 * Checks what an unoptimized image writes. The file is served exactly as given, so nothing downstream looks at the source:
 * a script-bearing scheme is refused here, and so are control characters (a browser drops tabs and line breaks, so
 * `java<TAB>script:` is `javascript:`). The size must be a finite positive number (the aspect-ratio box divides by it).
 */
function checkPlainImage(props: ImageComponentProps): void {
  const { src } = props;
  if (typeof src !== "string" || src === "" || hasControl(src) || !PLAIN_SRC.test(src.trim())) {
    throw new TypeError(
      __DEV__
        ? `Image: the src ${JSON.stringify(src)} must be a relative path, an http(s), blob: or data:image/* URL, without control characters.`
        : "DUSK_IMAGE_4",
    );
  }
  for (const name of ["width", "height"] as const) {
    const value: unknown = props[name];
    if (typeof value !== "number" || !(value > 0 && value < Number.POSITIVE_INFINITY)) {
      throw new RangeError(
        __DEV__
          ? `Image: ${name} must be a finite number greater than 0 (got ${String(value)}).`
          : `DUSK_IMAGE_3 ${name}`,
      );
    }
  }
}

/** The plain `<img>` attributes for a source that is not optimized: no candidates, the file as given. */
function plainAttributes(props: ImageComponentProps): PlainImage {
  checkPlainImage(props);
  return {
    src: props.src,
    width: props.width,
    height: props.height,
    alt: props.alt,
    ...(props.sizes === undefined ? {} : { sizes: props.sizes }),
    ...loadingAttributes(props),
  };
}

/** The attributes of one `<source>` of an art-directed picture. */
function sourceAttributes(
  source: ArtDirectionSource,
  quality: number | undefined,
): SourceAttributes {
  // `imageProps` reads only its own keys and treats an absent one like an undefined one, so the source passes through.
  const built = imageProps({ ...source, alt: "", quality } as ImagePropsOptions);
  const { format } = source;
  return {
    media: source.media,
    srcset: built.srcset,
    sizes: built.sizes,
    // Every format but `original` is the MIME type `image/<format>`.
    type: format === undefined || format === "original" ? undefined : `image/${format}`,
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
  const found = props.art === undefined ? prepared?.(props, String(attributes.sizes)) : undefined;
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
  if (sources.length === 0)
    return (
      <img
        src={attributes.src}
        srcset={attributes.srcset}
        sizes={attributes.sizes}
        alt={attributes.alt}
        loading={attributes.loading}
        decoding={attributes.decoding}
        fetchpriority={attributes.fetchpriority}
        style={attributes.style}
        width={attributes.width}
        height={attributes.height}
        class={attributes.class}
      />
    );
  return (
    <picture>
      {sources.map((source) => (
        <source
          media={source.media}
          type={source.type}
          srcset={source.srcset}
          sizes={source.sizes}
        />
      ))}
      <img
        src={attributes.src}
        srcset={attributes.srcset}
        sizes={attributes.sizes}
        alt={attributes.alt}
        loading={attributes.loading}
        decoding={attributes.decoding}
        fetchpriority={attributes.fetchpriority}
        style={attributes.style}
        width={attributes.width}
        height={attributes.height}
        class={attributes.class}
      />
    </picture>
  );
}
