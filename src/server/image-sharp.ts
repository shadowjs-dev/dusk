import { HttpError } from "../internal/http-error";
import type { ImageFormat } from "../shared/image";
import type { ImageProcessor, ImageProcessorInput, ImageSource } from "./image-route";

/**
 * The Node image processor: decodes, rotates by EXIF, resizes (never enlarging) and encodes with `sharp`, an
 * optional peer. The package is loaded when the first image is processed, through a specifier the bundler does
 * not see, so an app that never optimizes an image does not need it. Runtimes without `sharp` (Workers, Deno Deploy)
 * use another processor (the adapter's own, or `passthroughProcessor`).
 */

/** The part of `sharp`'s instance this processor uses. @internal */
interface SharpInstance {
  rotate(): SharpInstance;
  resize(options: { readonly width: number; readonly withoutEnlargement: boolean }): SharpInstance;
  webp(options: { readonly quality: number }): SharpInstance;
  avif(options: { readonly quality: number }): SharpInstance;
  jpeg(options: { readonly quality: number }): SharpInstance;
  png(): SharpInstance;
  metadata(): Promise<{
    readonly format?: string | undefined;
    readonly width?: number | undefined;
    readonly height?: number | undefined;
  }>;
  toBuffer(): Promise<Uint8Array>;
}

/** The input options this processor passes to `sharp`. @internal */
export interface SharpInputOptions {
  /** Most pixels (width x height) sharp decodes; a larger image is refused from its header, before any pixel is read. */
  readonly limitInputPixels: number;
  /** Read the input as a stream of rows instead of holding the whole decoded image. */
  readonly sequentialRead: true;
  /** Only the first frame of an animated image is decoded. */
  readonly animated: false;
}

/** Creates an instance from the encoded bytes of an image. @internal */
export type SharpFactory = (input: Uint8Array, options?: SharpInputOptions) => SharpInstance;

/** Options of {@link sharpProcessor}. @since 1.0.0 */
export interface SharpProcessorOptions {
  /** The `sharp` factory. Default: the installed `sharp` package, loaded on first use. */
  readonly sharp?: SharpFactory;
  /**
   * Most pixels a source may decode to. Default 25 000 000 (a 6000 x 4000 photo). A tiny PNG can declare billions of
   * pixels, so the size on the wire (`maxSourceBytes`) bounds nothing about the memory a decode takes; this does.
   */
  readonly maxInputPixels?: number;
}

/** The default of {@link SharpProcessorOptions.maxInputPixels}. @since 1.0.0 */
export const DEFAULT_MAX_INPUT_PIXELS = 25_000_000;

/** The decoded formats sharp may report for a source this processor accepts (vector and document formats are not). */
const RASTER_FORMATS: ReadonlySet<string> = new Set([
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heif",
  "tiff",
  "jp2",
  "jxl",
]);

/**
 * True when the bytes open like an XML or SVG document: optional BOM and white space, then `<`. A raster file never does.
 * Judged on the bytes, because a source's declared type is whatever its origin said.
 */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  let at = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
  // UTF-16 text with a BOM is markup too; a decoder for it would have to be named, so it is simply not an image here.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return true;
  }
  const limit = Math.min(bytes.length, at + 512);
  for (; at < limit; at += 1) {
    const byte = bytes[at];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x3c;
  }
  return false;
}

const OUTPUT: Readonly<Record<string, string>> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** The module name, held in a variable so the bundler leaves the import alone. */
const SHARP_MODULE: string = "sharp";

async function importSharp(): Promise<SharpFactory> {
  let loaded: unknown;
  try {
    loaded = await import(/* @vite-ignore */ SHARP_MODULE);
  } catch (cause) {
    throw new Error(
      "The image processor needs the sharp package: install it (npm install sharp) to optimize images.",
      { cause },
    );
  }
  const factory: unknown =
    typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (typeof factory !== "function") {
    throw new TypeError("The sharp package does not export its factory as the default export.");
  }
  return (input, options) => Reflect.apply(factory, undefined, [input, options]) as SharpInstance;
}

/**
 * A processor that resizes and converts raster images with `sharp`. An SVG, or a source format it does not encode
 * (GIF, TIFF) under `f=original`, is returned unchanged: the endpoint then serves the source at its own size.
 *
 * @param options The factory (for a test or an app that loads sharp itself).
 * @returns A processor for `createHandler({ images: { processor } })`.
 * @example
 * createHandler({ manifest, features: [pages(), images()], images: { processor: sharpProcessor(), remotePatterns: ["https://cdn.example"] } });
 * @since 1.0.0
 */
export function sharpProcessor(options: SharpProcessorOptions = {}): ImageProcessor {
  let factory: Promise<SharpFactory> | undefined;
  const load = (): Promise<SharpFactory> => {
    if (options.sharp !== undefined) return Promise.resolve(options.sharp);
    factory ??= importSharp();
    return factory;
  };
  const maxPixels = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;
  if (!Number.isInteger(maxPixels) || maxPixels < 1)
    throw new RangeError("sharpProcessor: maxInputPixels must be a positive integer.");
  return {
    async process(input: ImageProcessorInput): Promise<ImageSource | undefined> {
      // A declared SVG is a vector file served as it is (sandboxed, as a download); it is never handed to a decoder.
      if (input.source.contentType === "image/svg+xml") return undefined;
      // Markup under a raster type would be rendered by sharp's SVG loader (entities, external references). It is not
      // an image this processor handles, whatever the origin called it.
      if (looksLikeMarkup(input.source.bytes)) {
        throw new HttpError(415, "Unsupported Media Type: the source is not a raster image.");
      }
      const sharp = await load();
      const image = sharp(input.source.bytes, {
        limitInputPixels: maxPixels,
        sequentialRead: true,
        animated: false,
      }).rotate();
      let details: Awaited<ReturnType<SharpInstance["metadata"]>>;
      try {
        // The header only: sharp itself refuses a source over `limitInputPixels` here, before any pixel is decoded.
        details = await image.metadata();
      } catch (error) {
        // sharp reports the limit only as a message; any other failure (a corrupt file) stays a reported 500.
        if (error instanceof Error && /pixel limit/i.test(error.message)) {
          throw new HttpError(413, "Payload Too Large: the source has too many pixels.", {
            cause: error,
          });
        }
        throw error;
      }
      const sourceFormat = details.format;
      if (sourceFormat !== undefined && !RASTER_FORMATS.has(sourceFormat)) {
        throw new HttpError(415, "Unsupported Media Type: the source is not a raster image.");
      }
      if ((details.width ?? 0) * (details.height ?? 0) > maxPixels) {
        throw new HttpError(413, "Payload Too Large: the source has too many pixels.");
      }
      const target = input.format === "original" ? (sourceFormat ?? "") : input.format;
      if (!Object.hasOwn(OUTPUT, target)) return undefined;
      const resized = image.resize({ width: input.width, withoutEnlargement: true });
      const encoded = encode(resized, target as ImageFormat, input.quality);
      return { bytes: new Uint8Array(await encoded.toBuffer()), contentType: OUTPUT[target] ?? "" };
    },
  };
}

function encode(image: SharpInstance, format: ImageFormat, quality: number): SharpInstance {
  switch (format) {
    case "webp":
      return image.webp({ quality });
    case "avif":
      return image.avif({ quality });
    case "jpeg":
      return image.jpeg({ quality });
    default:
      return image.png();
  }
}
