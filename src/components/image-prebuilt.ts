/**
 * The shape of the images the build prepared ahead of time (`imageVariants()` of `@shadow-js/dusk/vite`) and the functions
 * that turn one entry into `<picture>` sources. The build writes the map into the bundles; `<Image>` reads it. The format
 * is compact on purpose (it ships to the browser): the file names are rebuilt from a prefix, a width and a hash.
 */

/**
 * One prepared image: where its files live, the widths that were made, and a content hash for each file.
 * @since 1.0.0
 */
export interface PrebuiltImage {
  /** The URL prefix of the files, with the mount base: `/assets/img/hero`. A file is `<d>-<width>w-<hash>.<format>`. */
  readonly d: string;
  /** The widths made, ascending. */
  readonly w: readonly number[];
  /** The content hashes of the AVIF files, in the order of `w`; absent when no AVIF was made. */
  readonly a?: readonly string[];
  /** The content hashes of the WebP files, in the order of `w`; absent when no WebP was made. */
  readonly p?: readonly string[];
}

/**
 * The prepared images by the URL the app writes in `src` (`/images/hero.jpg`).
 * @since 1.0.0
 */
export type PrebuiltImages = Readonly<Record<string, PrebuiltImage>>;

/**
 * One `<source>` of a prepared image.
 * @since 1.0.0
 */
export interface PrebuiltSource {
  readonly type: "image/avif" | "image/webp";
  readonly srcset: string;
}

/**
 * The URL of one prepared file.
 *
 * @param image The prepared image.
 * @param index The position in `image.w`.
 * @param extension `avif` or `webp`.
 * @param hash The file's content hash.
 * @returns The URL path.
 * @example
 * prebuiltFileUrl({ d: "/assets/img/hero", w: [640] }, 0, "avif", "ab12cd34"); // "/assets/img/hero-640w-ab12cd34.avif"
 * @since 1.0.0
 */
export function prebuiltFileUrl(
  image: PrebuiltImage,
  index: number,
  extension: "avif" | "webp",
  hash: string,
): string {
  return `${image.d}-${image.w[index]}w-${hash}.${extension}`;
}

function srcsetOf(
  image: PrebuiltImage,
  hashes: readonly string[],
  extension: "avif" | "webp",
): string {
  return hashes
    .map((hash, index) => `${prebuiltFileUrl(image, index, extension, hash)} ${image.w[index]}w`)
    .join(", ");
}

/**
 * The `<source>` elements of a prepared image, best format first (AVIF, then WebP).
 *
 * @param image The prepared image.
 * @returns The sources; empty when the entry holds no file.
 * @example
 * prebuiltSources({ d: "/a/x", w: [640, 960], p: ["11111111", "22222222"] })[0]?.type; // "image/webp"
 * @since 1.0.0
 */
export function prebuiltSources(image: PrebuiltImage): readonly PrebuiltSource[] {
  const sources: PrebuiltSource[] = [];
  if (image.a !== undefined && image.a.length > 0) {
    sources.push({ type: "image/avif", srcset: srcsetOf(image, image.a, "avif") });
  }
  if (image.p !== undefined && image.p.length > 0) {
    sources.push({ type: "image/webp", srcset: srcsetOf(image, image.p, "webp") });
  }
  return sources;
}
