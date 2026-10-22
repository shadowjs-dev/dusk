/**
 * `imageVariants()`: an opt-in build step that prepares responsive AVIF and WebP files for the images of `public/` that the
 * app's source mentions, so the browser is served files that already exist instead of asking the optimizer endpoint to
 * make them. The files are content-hashed (they are served with the long cache lifetime of the build's assets folder),
 * `<Image>` writes `<picture>` sources that point at them, and the optimizer stays as the fallback for everything else.
 * Build time only (Node). `sharp` is an optional peer: without it the build warns once and the images are served as they are.
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import type { PrebuiltImage, PrebuiltImages } from "../components/image-prebuilt";
import { compileGlob, matchesAny } from "./glob";

/**
 * Options of {@link imageVariants}.
 * @since 1.0.0
 */
export interface ImageVariantsOptions {
  /** The widths to make, in CSS pixels. A width at or above the image's own is replaced by the image's width. Default `[640, 960, 1280, 1920]`. */
  readonly widths?: readonly number[];
  /** The formats to make. Default `["avif", "webp"]`. */
  readonly formats?: readonly ("avif" | "webp")[];
  /** Encoder quality, 1 to 100. Default 50 for AVIF and 75 for WebP. */
  readonly quality?: { readonly avif?: number; readonly webp?: number };
  /**
   * Globs of paths under `public/` that are prepared even when no source file mentions them (`images/hero/**`). By
   * default only an image whose path appears in the source (`src/`, `index.html`) is prepared.
   */
  readonly include?: readonly string[];
  /** Files smaller than this many bytes are left alone: a variant would save nothing. Default 4096. */
  readonly minBytes?: number;
  /**
   * An original over this many bytes is named in a warning at the end of the build. `0` turns the warning off.
   * Default 1 MiB.
   */
  readonly maxOriginalBytes?: number;
  /** The folder of the files under the build's assets folder. Default `img`. */
  readonly directory?: string;
  /** Where finished files are kept between builds. Default: `dusk-images` in Vite's cache folder. */
  readonly cacheDir?: string;
  /**
   * The image library: a factory (your own `sharp` instance), or the name of the module to import it from. Default
   * `"sharp"`, an optional peer dependency.
   */
  readonly sharp?: string | SharpOpen;
}

/** Options with every default applied. @internal */
export interface ResolvedImageVariants {
  readonly widths: readonly number[];
  readonly formats: readonly ("avif" | "webp")[];
  readonly quality: { readonly avif: number; readonly webp: number };
  readonly include: readonly string[];
  readonly minBytes: number;
  readonly maxOriginalBytes: number;
  readonly directory: string;
  readonly cacheDir: string | undefined;
  readonly sharp: string | SharpOpen;
}

const DEFAULT_WIDTHS: readonly number[] = [640, 960, 1280, 1920];
const MAX_WIDTH = 8192;
const MAX_WIDTHS = 16;
const RASTER = /\.(?:jpe?g|png|webp)$/i;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|mdx?|html|css|json|svelte|vue|astro)$/i;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_FILES = 20_000;
/** Most pixels sharp decodes for one source (the same bound as the runtime optimizer). */
const MAX_INPUT_PIXELS = 100_000_000;

function checkedQuality(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError(`imageVariants: quality.${name} must be a whole number from 1 to 100.`);
  }
  return value;
}

/**
 * Applies the defaults of {@link ImageVariantsOptions} and refuses a value that cannot work.
 *
 * @param options The options as written.
 * @returns The options with every default applied.
 * @throws TypeError or RangeError for a bad value, naming the option.
 * @example
 * resolveImageVariants({}).widths; // [640, 960, 1280, 1920]
 * @since 1.0.0
 */
export function resolveImageVariants(options: ImageVariantsOptions = {}): ResolvedImageVariants {
  const widths = options.widths ?? DEFAULT_WIDTHS;
  if (!Array.isArray(widths) || widths.length === 0 || widths.length > MAX_WIDTHS) {
    throw new TypeError(`imageVariants: widths must be a list of 1 to ${MAX_WIDTHS} widths.`);
  }
  for (const width of widths) {
    if (!Number.isInteger(width) || width < 16 || width > MAX_WIDTH) {
      throw new RangeError(
        `imageVariants: every width must be a whole number from 16 to ${MAX_WIDTH}.`,
      );
    }
  }
  const formats = options.formats ?? ["avif", "webp"];
  if (
    !Array.isArray(formats) ||
    formats.length === 0 ||
    formats.some((format) => format !== "avif" && format !== "webp")
  ) {
    throw new TypeError('imageVariants: formats must be a list of "avif" and "webp".');
  }
  const directory = options.directory ?? "img";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(directory)) {
    throw new TypeError('imageVariants: directory must be a plain folder name such as "img".');
  }
  for (const key of ["minBytes", "maxOriginalBytes"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new RangeError(`imageVariants: ${key} must be a whole number of 0 or more.`);
    }
  }
  const include = options.include ?? [];
  for (const pattern of include) compileGlob(pattern);
  return {
    widths: [...new Set(widths)].sort((a, b) => a - b),
    formats: [...new Set(formats)],
    quality: {
      avif: checkedQuality(options.quality?.avif, 50, "avif"),
      webp: checkedQuality(options.quality?.webp, 75, "webp"),
    },
    include,
    minBytes: options.minBytes ?? 4096,
    maxOriginalBytes: options.maxOriginalBytes ?? 1024 * 1024,
    directory,
    cacheDir: options.cacheDir,
    sharp: options.sharp ?? "sharp",
  };
}

/**
 * The widths to make for an image: every configured width below the image's own, and the image's own width when it is not
 * above the largest configured one (so a small image still gets the lighter formats at its full size).
 *
 * @param imageWidth The image's width in pixels.
 * @param widths The configured widths, ascending.
 * @returns The widths, ascending.
 * @example
 * ladderFor(1000, [640, 960, 1280]); // [640, 960, 1000]
 * @since 1.0.0
 */
export function ladderFor(imageWidth: number, widths: readonly number[]): readonly number[] {
  const largest = widths[widths.length - 1] ?? 0;
  const below = widths.filter((width) => width < imageWidth);
  return imageWidth <= largest ? [...below, imageWidth] : below;
}

const IMAGE_PATH = /(?<![\w:/.])\/[\w@%.~+/-]+\.(?:jpe?g|png|webp)(?![\w-])/gi;

/**
 * The paths of raster images that a text mentions as a URL path (`"/images/hero.jpg"`).
 *
 * @param text A source file.
 * @returns The paths (each starts with `/`).
 * @example
 * [...imageReferences('<Image src="/images/hero.jpg" />')]; // ["/images/hero.jpg"]
 * @since 1.0.0
 */
export function imageReferences(text: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH)) {
    let path = match[0];
    try {
      path = decodeURIComponent(path);
    } catch {
      // A path with a stray `%` is matched as written; it names no file and is dropped later.
    }
    found.add(path);
  }
  return found;
}

/** The part of a sharp instance this step uses. */
interface SharpImage {
  rotate(): SharpImage;
  resize(options: { readonly width: number; readonly withoutEnlargement: true }): SharpImage;
  avif(options: { readonly quality: number }): SharpImage;
  webp(options: { readonly quality: number }): SharpImage;
  metadata(): Promise<{
    readonly format?: string | undefined;
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly orientation?: number | undefined;
  }>;
  toBuffer(): Promise<Uint8Array>;
}

/** Opens an image from its bytes. @since 1.0.0 */
export type SharpOpen = (
  bytes: Uint8Array,
  options: {
    readonly limitInputPixels: number;
    readonly sequentialRead: true;
    readonly animated: false;
  },
) => SharpImage;

/**
 * Loads `sharp`, an optional peer of Dusk.
 *
 * @param specifier The module to import it from. Default `"sharp"`.
 * @returns The factory, or `undefined` when the package is not installed.
 * @since 1.0.0
 * @example
 * ```ts
 * import { loadSharp } from "./image-variants";
 *
 * const sharp = await loadSharp();
 * console.log(sharp === undefined ? "sharp is not installed" : "sharp is ready");
 * ```
 */
export async function loadSharp(specifier: string = "sharp"): Promise<SharpOpen | undefined> {
  let loaded: unknown;
  try {
    // The name is a variable, so the bundler leaves the import alone.
    loaded = await import(/* @vite-ignore */ specifier);
  } catch {
    return undefined;
  }
  const factory: unknown =
    typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (typeof factory !== "function") return undefined;
  return (bytes, options) => Reflect.apply(factory, undefined, [bytes, options]) as SharpImage;
}

/** One file to write into the build output. @since 1.0.0 */
export interface VariantFile {
  /** The path in the output folder: `assets/img/hero-640w-ab12cd34.avif`. */
  readonly fileName: string;
  /** The path of the finished file in the cache folder. */
  readonly cached: string;
}

/** What {@link prepareImages} made. @since 1.0.0 */
export interface PreparedImages {
  readonly map: PrebuiltImages;
  readonly files: readonly VariantFile[];
  /** Originals over `maxOriginalBytes`: public path and size. */
  readonly oversize: readonly { readonly path: string; readonly bytes: number }[];
  /** Images that were prepared, and how many bytes the modern formats at the largest width save over the original. */
  readonly prepared: number;
}

/**
 * An image the app's code imports (`import hero from "./hero.jpg"`): the bundler has renamed it, so the URL in `src` is
 * the bundle's, and its bytes come from the bundle, not from `public/`.
 * @since 1.0.0
 */
export interface ImportedImage {
  /** The URL the code holds in `src`, as the bundler wrote it (`/assets/hero-AbCd1234.jpg`, with the base or the CDN). */
  readonly url: string;
  /** The file's own name in the source (`src/images/hero.jpg`): it names the variants and the warnings. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Inputs of {@link prepareImages}. @since 1.0.0 */
export interface PrepareInput {
  /** The folder the images are read from (`public/`). */
  readonly publicDir: string;
  /** The public paths to prepare, relative to `publicDir` with `/` separators. */
  readonly sources: readonly string[];
  /** Images the code imports, prepared from the bytes the bundle holds. */
  readonly imported?: readonly ImportedImage[];
  /**
   * The URL prefix of the variants of an imported image, given their path in the output (`assets/img/hero`): it is where a
   * CDN or a base path of the build applies. Default: the mount base and the path.
   */
  readonly urlPrefix?: (path: string) => string;
  readonly options: ResolvedImageVariants;
  /** The mount base without a trailing slash (`""`, `/app`). */
  readonly mountBase: string;
  /** The build's assets folder (`assets`). */
  readonly assetsDir: string;
  /** Where finished files are kept. */
  readonly cacheDir: string;
  readonly sharp: SharpOpen;
}

const CACHE_VERSION = "1";

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** A file stem that is safe in a URL and a file name. */
function stemOf(path: string): string {
  const base = posix.basename(path, posix.extname(path));
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return clean === "" ? "image" : clean.slice(0, 64);
}

interface CacheEntry {
  readonly width: number;
  readonly outputs: readonly {
    readonly w: number;
    readonly f: "avif" | "webp";
    readonly hash: string;
  }[];
}

async function readCache(file: string): Promise<CacheEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray(Reflect.get(parsed, "outputs"))
    ) {
      return parsed as CacheEntry;
    }
  } catch {
    // No entry, or one that was cut short by an earlier crash: the image is made again.
  }
  return undefined;
}

async function filesExist(dir: string, entry: CacheEntry): Promise<boolean> {
  for (const output of entry.outputs) {
    try {
      await stat(join(dir, `${output.hash}.${output.f}`));
    } catch {
      return false;
    }
  }
  return true;
}

/** Makes, or finds in the cache, the variants of one source. */
async function variantsOf(bytes: Uint8Array, input: PrepareInput): Promise<CacheEntry | undefined> {
  const { options } = input;
  const key = createHash("sha256")
    .update(bytes)
    .update(JSON.stringify([CACHE_VERSION, options.widths, options.formats, options.quality]))
    .digest("hex")
    .slice(0, 24);
  const metaFile = join(input.cacheDir, `${key}.json`);
  const cached = await readCache(metaFile);
  if (cached !== undefined && (await filesExist(input.cacheDir, cached))) return cached;
  const image = input
    .sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: false,
    })
    .rotate();
  const details = await image.metadata();
  if (details.format !== "jpeg" && details.format !== "png" && details.format !== "webp")
    return undefined;
  const turned = (details.orientation ?? 1) >= 5;
  const width = (turned ? details.height : details.width) ?? 0;
  if (width < 1) return undefined;
  const outputs: { w: number; f: "avif" | "webp"; hash: string }[] = [];
  for (const target of ladderFor(width, options.widths)) {
    for (const format of options.formats) {
      const resized = input
        .sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true, animated: false })
        .rotate()
        .resize({ width: target, withoutEnlargement: true });
      const encoded = await (format === "avif"
        ? resized.avif({ quality: options.quality.avif })
        : resized.webp({ quality: options.quality.webp })
      ).toBuffer();
      const hash = hashOf(encoded);
      await writeFile(join(input.cacheDir, `${hash}.${format}`), encoded);
      outputs.push({ w: target, f: format, hash });
    }
  }
  const entry: CacheEntry = { width, outputs };
  await writeFile(metaFile, JSON.stringify(entry));
  return entry;
}

/**
 * Makes the variants of the given images and describes them: the map `<Image>` reads, the files to write, and the originals
 * that are too big.
 *
 * @param input The sources, the options, and where files go.
 * @returns The map, the files and the warnings.
 * @throws Error when a source cannot be decoded (the message names the file).
 * @since 1.0.0
 * @example
 * ```ts
 * import { prepareImages } from "./image-variants";
 *
 * export async function run(input: Parameters<typeof prepareImages>[0]) {
 *   const prepared = await prepareImages(input);
 *   return prepared.warnings;
 * }
 * ```
 */
export async function prepareImages(input: PrepareInput): Promise<PreparedImages> {
  await mkdir(input.cacheDir, { recursive: true });
  const map: Record<string, PrebuiltImage> = {};
  const files = new Map<string, VariantFile>();
  const oversize: { path: string; bytes: number }[] = [];
  let prepared = 0;
  const folder = posix.join(input.assetsDir, input.options.directory);
  interface Item {
    /** The key of the map: the URL the code holds in `src`. */
    readonly key: string;
    /** The name the variants are made from. */
    readonly name: string;
    /** How warnings and errors name the image: the public path, or the source file of an imported one. */
    readonly label: string;
    /** The URL prefix of the variants. */
    readonly prefix: (stem: string) => string;
    readonly bytes: () => Promise<Uint8Array>;
  }
  const items: Item[] = [
    ...[...input.sources].sort().map(
      (path): Item => ({
        key: `/${path}`,
        name: path,
        label: `/${path}`,
        prefix: (stem) => `${input.mountBase}/${folder}/${stem}`,
        bytes: () => readFile(join(input.publicDir, ...path.split("/"))),
      }),
    ),
    ...[...(input.imported ?? [])]
      .sort((left, right) => (left.url < right.url ? -1 : left.url > right.url ? 1 : 0))
      .map(
        (image): Item => ({
          key: image.url,
          name: image.name,
          label: image.name,
          prefix: (stem) =>
            input.urlPrefix?.(`${folder}/${stem}`) ?? `${input.mountBase}/${folder}/${stem}`,
          bytes: async () => image.bytes,
        }),
      ),
  ];
  for (const item of items) {
    const bytes = await item.bytes();
    if (input.options.maxOriginalBytes > 0 && bytes.length > input.options.maxOriginalBytes) {
      oversize.push({
        path: item.label,
        bytes: bytes.length,
      });
    }
    if (bytes.length < input.options.minBytes) continue;
    let entry: CacheEntry | undefined;
    try {
      entry = await variantsOf(bytes, input);
    } catch (cause) {
      throw new Error(
        `imageVariants: cannot prepare ${item.label}: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
        },
      );
    }
    if (entry === undefined) continue;
    const stem = stemOf(item.name);
    const widths = [...new Set(entry.outputs.map((output) => output.w))].sort((a, b) => a - b);
    const hashes = (format: "avif" | "webp"): string[] =>
      widths.map((width) => entry.outputs.find((o) => o.w === width && o.f === format)?.hash ?? "");
    const avif = input.options.formats.includes("avif") ? hashes("avif") : undefined;
    const webp = input.options.formats.includes("webp") ? hashes("webp") : undefined;
    map[item.key] = {
      d: item.prefix(stem),
      w: widths,
      ...(avif === undefined ? {} : { a: avif }),
      ...(webp === undefined ? {} : { p: webp }),
    };
    for (const output of entry.outputs) {
      const fileName = `${folder}/${stem}-${output.w}w-${output.hash}.${output.f}`;
      files.set(fileName, { fileName, cached: join(input.cacheDir, `${output.hash}.${output.f}`) });
    }
    prepared += 1;
  }
  return { map, files: [...files.values()], oversize, prepared };
}

/** The files under a folder, as `/`-separated paths relative to it. */
async function walk(
  dir: string,
  accept: (path: string) => boolean,
  limit: number,
): Promise<string[]> {
  const out: string[] = [];
  const pending = [""];
  while (pending.length > 0 && out.length < limit) {
    const folder = pending.pop() ?? "";
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(dir, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && accept(path)) out.push(path);
    }
  }
  return out.sort();
}

/**
 * The public images the app mentions: the paths found in the source files that name a raster file of `public/`, plus the
 * files the `include` globs match.
 *
 * @param root The project root.
 * @param publicDir The `public/` folder.
 * @param include The extra globs.
 * @returns Paths relative to `public/`, with `/` separators.
 * @since 1.0.0
 * @example
 * ```ts
 * import { referencedImages } from "./image-variants";
 *
 * const files = await referencedImages(process.cwd(), "public", []);
 * console.log(files.length);
 * ```
 */
export async function referencedImages(
  root: string,
  publicDir: string,
  include: readonly string[],
): Promise<readonly string[]> {
  const available = new Set(await walk(publicDir, (path) => RASTER.test(path), 100_000));
  const wanted = new Set<string>();
  const globs = include.map((pattern) => compileGlob(pattern));
  for (const path of available) if (matchesAny(globs, path)) wanted.add(path);
  const texts = [
    ...(await walk(join(root, "src"), (path) => SOURCE_FILE.test(path), MAX_SOURCE_FILES)).map(
      (path) => join(root, "src", ...path.split("/")),
    ),
    join(root, "index.html"),
  ];
  for (const file of texts) {
    let text: string;
    try {
      if ((await stat(file)).size > MAX_SOURCE_BYTES) continue;
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const reference of imageReferences(text)) {
      const path = reference.slice(1);
      if (available.has(path)) wanted.add(path);
    }
  }
  return [...wanted].sort();
}

/** `bytes` as a short size: `3.2 MiB`. */
function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

/**
 * The warning for originals over the budget, or `undefined` when there are none. @since 1.0.0
 * @example
 * ```ts
 * import { oversizeMessage } from "./image-variants";
 *
 * console.log(oversizeMessage([], 1_000_000)); // undefined: no original is over the budget
 * ```
 */
export function oversizeMessage(
  oversize: readonly { readonly path: string; readonly bytes: number }[],
  limit: number,
): string | undefined {
  if (oversize.length === 0) return undefined;
  const list = oversize.map((item) => `${item.path} (${sizeText(item.bytes)})`).join(", ");
  return `imageVariants: ${oversize.length} original image${oversize.length === 1 ? " is" : "s are"} over ${sizeText(limit)}: ${list}. Compress or resize the file; the variants are made from it.`;
}

/** The module that gives `<Image>` the prepared images, and the package it registers them with. */
/** What the browser bundle holds in place of the map of imported images, until the bundle is complete. */
const IMPORTS_TOKEN = "dusk-imported-images-5f3c9a1e";
const VIRTUAL_ID = "virtual:dusk/image-variants";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;
const COMPONENTS = "@shadow-js/dusk/components";

/** The mount base of a Vite `base` without a trailing slash. */
function mountOf(base: string): string {
  return base === "/" ? "" : base.replace(/\/+$/, "");
}

/**
 * The `imageVariants()` Vite plugin. At the start of a production build it prepares the responsive AVIF and WebP files of
 * the images of `public/` that the source mentions and writes them into the client output, and it gives `<Image>` (of
 * `@shadow-js/dusk/components`) the map of what was made, in both the browser and the server bundle. Nothing runs in
 * `vite dev`, where the optimizer endpoint serves every image.
 *
 * Add it next to `dusk()` in `vite.config.ts`. An image that is imported from the source (and so hashed by the bundler) is
 * not prepared: it is served by the optimizer like any other image.
 *
 * @param options See {@link ImageVariantsOptions}.
 * @returns A Vite plugin.
 * @throws TypeError or RangeError for a bad option.
 * @example
 * // vite.config.ts
 * import { dusk, imageVariants } from "@shadow-js/dusk/vite";
 * export default { plugins: [dusk(), imageVariants({ widths: [480, 960, 1440] })] };
 * @since 1.0.0
 */
export function imageVariants(options: ImageVariantsOptions = {}): Plugin {
  const resolved = resolveImageVariants(options);
  let config: ResolvedConfig | undefined;
  let result: Promise<PreparedImages | undefined> | undefined;
  let imageLibrary: Promise<SharpOpen | undefined> | undefined;
  let warnedAboutLibrary = false;
  /** The images the code imports, by the URL in `src`: known when the client bundle is made, before the server's. */
  let importedMap: PrebuiltImages = {};

  /** The image library, loaded once. Warns once, naming how many images are served as they are, when it is missing. */
  const library = async (count: number): Promise<SharpOpen | undefined> => {
    imageLibrary ??=
      typeof resolved.sharp === "string"
        ? loadSharp(resolved.sharp)
        : Promise.resolve(resolved.sharp);
    const sharp = await imageLibrary;
    if (sharp === undefined && !warnedAboutLibrary) {
      warnedAboutLibrary = true;
      config?.logger.warn(
        `imageVariants: sharp is not installed, so ${count} image${count === 1 ? " is" : "s are"} served as they are (the optimizer endpoint still resizes them on request). Install it with "npm install sharp" to prepare AVIF and WebP files at build time.`,
      );
    }
    return sharp;
  };

  const prepare = (): Promise<PreparedImages | undefined> => {
    result ??= (async (): Promise<PreparedImages | undefined> => {
      if (config === undefined || config.publicDir === "") return undefined;
      const sources = await referencedImages(config.root, config.publicDir, resolved.include);
      if (sources.length === 0) return undefined;
      const sharp = await library(sources.length);
      if (sharp === undefined) return undefined;
      const prepared = await prepareImages({
        publicDir: config.publicDir,
        sources,
        options: resolved,
        mountBase: mountOf(config.base),
        assetsDir: config.build.assetsDir,
        cacheDir: resolved.cacheDir ?? join(config.cacheDir, "dusk-images"),
        sharp,
      });
      const warning = oversizeMessage(prepared.oversize, resolved.maxOriginalBytes);
      if (warning !== undefined) config.logger.warn(warning);
      return prepared;
    })();
    return result;
  };

  /** The URL the bundler writes for a file of the output: the base, or what the app's `renderBuiltUrl` says (a CDN). */
  const builtUrl = (fileName: string): string => {
    const render = config?.experimental?.renderBuiltUrl;
    if (render !== undefined) {
      const url = render(fileName, {
        type: "asset",
        hostType: "js",
        hostId: "index.js",
        ssr: false,
      });
      if (typeof url === "string") return url;
    }
    return `${config?.base ?? "/"}${fileName}`;
  };

  return {
    name: "dusk:image-variants",
    apply: "build",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
      if (!resolvedConfig.base.startsWith("/") || resolvedConfig.base.startsWith("//")) {
        throw new TypeError(
          `imageVariants: the Vite base must be a path such as "/" or "/app/" (got ${JSON.stringify(resolvedConfig.base)}).`,
        );
      }
    },
    async buildStart() {
      await prepare();
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;
      const prepared = await prepare();
      const map = prepared === undefined || prepared.prepared === 0 ? {} : prepared.map;
      // The browser bundle is made before the images it imports have their final names, so it carries a token that
      // `generateBundle` replaces with the map; the server bundle is made after, and holds the map itself.
      const imported =
        this.environment?.name === "client"
          ? JSON.stringify(IMPORTS_TOKEN)
          : JSON.stringify(importedMap);
      return `import { configureImageVariants } from ${JSON.stringify(COMPONENTS)};\nconfigureImageVariants(${JSON.stringify(map)});\nconfigureImageVariants(${imported});\n`;
    },
    async transform(code, id) {
      // Every module that imports the components registers the prepared images first, so the markup is the same in
      // every bundle (the server's and the browser's) and an app with its own entry files needs no wiring.
      if (id === RESOLVED_VIRTUAL_ID || !code.includes(COMPONENTS)) return null;
      return { code: `import ${JSON.stringify(VIRTUAL_ID)};\n${code}`, map: null };
    },
    async generateBundle(_output, bundle) {
      if (this.environment?.name !== "client" || config === undefined) return;
      const prepared = await prepare();
      if (prepared !== undefined) {
        for (const file of prepared.files) {
          this.emitFile({
            type: "asset",
            fileName: file.fileName,
            source: await readFile(file.cached),
          });
        }
      }
      // The images the code imports: the bundle holds them under their final names.
      const imported: ImportedImage[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== "asset" || !RASTER.test(item.fileName)) continue;
        const original = item.originalFileNames?.[0];
        if (original === undefined) continue;
        imported.push({
          url: builtUrl(item.fileName),
          name: relative(config.root, join(config.root, original)).split(sep).join("/"),
          bytes: typeof item.source === "string" ? Buffer.from(item.source) : item.source,
        });
      }
      let importedPrepared: PreparedImages | undefined;
      if (imported.length > 0) {
        const sharp = await library(imported.length);
        if (sharp !== undefined) {
          importedPrepared = await prepareImages({
            publicDir: config.publicDir,
            sources: [],
            imported,
            urlPrefix: builtUrl,
            options: resolved,
            mountBase: mountOf(config.base),
            assetsDir: config.build.assetsDir,
            cacheDir: resolved.cacheDir ?? join(config.cacheDir, "dusk-images"),
            sharp,
          });
          const warning = oversizeMessage(importedPrepared.oversize, resolved.maxOriginalBytes);
          if (warning !== undefined) config.logger.warn(warning);
          for (const file of importedPrepared.files) {
            this.emitFile({
              type: "asset",
              fileName: file.fileName,
              source: await readFile(file.cached),
            });
          }
        }
      }
      importedMap = importedPrepared?.map ?? {};
      // Put the map where the browser bundle expects it.
      const literal = new RegExp(`(["'\`])${IMPORTS_TOKEN}\\1`, "g");
      const text = JSON.stringify(importedMap);
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk" && item.code.includes(IMPORTS_TOKEN)) {
          item.code = item.code.replace(literal, () => text);
        }
      }
    },
  };
}
