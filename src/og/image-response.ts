import { expandTree, type OgNode } from "./element";
import type { SatoriFont, SatoriOptions } from "./satori-types";

/**
 * `ImageResponse`: draws an element tree to a PNG and answers with it. The tree goes through two steps: satori lays
 * it out and writes SVG, and resvg rasterizes the SVG. Both are optional peer dependencies, loaded only when an
 * image is drawn; a test or a host can inject its own renderers instead.
 */

/** A font face satori draws text with: TrueType, OpenType or WOFF bytes (WOFF2 is not supported by satori). @since 1.0.0 */
export interface OgFont {
  readonly name: string;
  readonly data: ArrayBuffer | Uint8Array;
  readonly weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  readonly style?: "normal" | "italic";
}

/** The size of an image in pixels. @since 1.0.0 */
export interface OgSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The two steps of drawing. `svg` lays the tree out; `png` rasterizes the SVG. The defaults are satori and resvg;
 * a test passes its own.
 * @since 1.0.0
 */
export interface OgRenderers {
  svg(tree: unknown, size: OgSize, fonts: readonly OgFont[]): Promise<string>;
  png(svg: string, size: OgSize): Promise<Uint8Array>;
}

/** Options of {@link ImageResponse}. @since 1.0.0 */
export interface ImageResponseOptions {
  /** Default 1200. */
  readonly width?: number;
  /** Default 630. */
  readonly height?: number;
  /** Fonts for the text. At least one is needed when the tree has text. */
  readonly fonts?: readonly OgFont[];
  /** Response headers; `cache-control` defaults to a day of shared caching. */
  readonly headers?: HeadersInit;
  /** Default 200. */
  readonly status?: number;
  /** The WebAssembly module or bytes of resvg (`@resvg/resvg-wasm/index_bg.wasm`), for the default rasterizer. */
  readonly resvgWasm?: BufferSource | WebAssembly.Module;
  /** Replaces the default renderers (satori and resvg). */
  readonly renderers?: OgRenderers;
  /**
   * Let an `img` `src`, an svg `href` or a CSS `url()` name an http(s) URL, which satori then fetches while it draws.
   * Default false: only `data:image/...` URIs are accepted, so no value in the tree can make the server fetch anything.
   * Turn it on only for URLs written in code, never for one built from a request (a path, a query, a header, a database
   * row): that is a server-side request forgery. Fetch the image yourself, check it, and pass it as a `data:` URI.
   */
  readonly allowRemoteImages?: boolean;
}

/** Largest image side in pixels: a bound on the work one request can ask for. @since 1.0.0 */
export const MAX_OG_SIDE = 4096;

const DEFAULT_CACHE = "public, max-age=3600, stale-while-revalidate=86400";

/**
 * Checks a size: whole numbers between 1 and {@link MAX_OG_SIDE}.
 *
 * @param width The width.
 * @param height The height.
 * @returns The size.
 * @throws RangeError for a side that is not a whole number in range.
 * @since 1.0.0
 */
export function checkedSize(width: number, height: number): OgSize {
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_OG_SIDE) {
      throw new RangeError(
        `ImageResponse: ${name} must be a whole number from 1 to ${MAX_OG_SIDE}, got ${String(value)}.`,
      );
    }
  }
  return { width, height };
}

/** A font in satori's shape, with the bytes copied into an ArrayBuffer. */
function satoriFonts(fonts: readonly OgFont[]): SatoriFont[] {
  return fonts.map((font) => {
    // Bytes only: a string, URL or Response here would be turned into an empty font, or (by a renderer that accepts one)
    // into a request.
    if (!(font.data instanceof ArrayBuffer) && !ArrayBuffer.isView(font.data)) {
      throw new TypeError("ImageResponse: a font's data must be an ArrayBuffer or a Uint8Array.");
    }
    const bytes =
      font.data instanceof Uint8Array
        ? font.data
        : ArrayBuffer.isView(font.data)
          ? new Uint8Array(font.data.buffer, font.data.byteOffset, font.data.byteLength)
          : new Uint8Array(font.data);
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    return {
      name: font.name,
      data: copy,
      weight: font.weight ?? 400,
      style: font.style ?? "normal",
    };
  });
}

/** The optional satori package, by name. */
const SATORI_PACKAGE = "satori";

/** The default export of an optional module, checked: a missing package is a clear error. */
function optionalDefault(
  loaded: unknown,
  name: string,
): (tree: unknown, options: SatoriOptions) => Promise<string> {
  const value: unknown =
    typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "default") : undefined;
  if (typeof value !== "function") {
    throw new TypeError(
      `ImageResponse: the optional package "${name}" is not installed (npm install ${name}).`,
    );
  }
  return value as (tree: unknown, options: SatoriOptions) => Promise<string>;
}

/**
 * Checks the SVG satori wrote before resvg reads it: every reference must be a `data:` image or a `#fragment`. satori
 * already inlines what it fetched, so this only fails when a renderer other than the one tested here (an older satori,
 * a custom one) wrote a reference the rasterizer might resolve, and the text of the failure names the reference.
 */
function assertSelfContained(svg: string): void {
  for (const match of svg.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gis)) {
    const target = match[2] ?? "";
    if (!target.startsWith("#") && !/^data:/i.test(target)) {
      throw new TypeError(
        "ImageResponse: the drawing references a file or URL, which is not rasterized.",
      );
    }
  }
  for (const match of svg.matchAll(/url\s*\(\s*(['"]?)([^)'"]*)/gi)) {
    const target = match[2] ?? "";
    if (!target.startsWith("#") && !/^data:/i.test(target)) {
      throw new TypeError(
        "ImageResponse: the drawing references a file or URL, which is not rasterized.",
      );
    }
  }
  if (/@import\b/i.test(svg)) {
    throw new TypeError(
      "ImageResponse: the drawing imports a stylesheet, which is not rasterized.",
    );
  }
}

/** Whether a value is what `initWasm` may be given: bytes or a compiled module. A string, URL or Response makes it fetch. */
function isWasmSource(value: unknown): value is BufferSource | WebAssembly.Module {
  return (
    value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof WebAssembly.Module
  );
}

/** Wasm bytes for resvg, once per object (a WeakMap, so a dropped module is collected). */
const initialized = new WeakMap<object, Promise<void>>();

/**
 * The default renderers: satori for the layout, resvg (wasm) for the PNG. The modules are imported when first used.
 *
 * @param options The resvg wasm module or bytes.
 * @returns The renderers.
 * @throws Error (on use) when the optional packages are not installed or no wasm is given.
 * @since 1.0.0
 */
export function defaultRenderers(options: {
  readonly resvgWasm?: BufferSource | WebAssembly.Module | undefined;
}): OgRenderers {
  return {
    async svg(tree, size, fonts) {
      if (fonts.length === 0) {
        throw new TypeError(
          "ImageResponse: pass at least one font (fonts: [{ name, data }]) to draw text.",
        );
      }
      // The specifier is a runtime value on purpose: satori's own declarations import React, which Dusk does not
      // depend on, so the module is typed here by the narrow shape this package uses (see satori-types.ts).
      const loaded: unknown = await import(/* @vite-ignore */ SATORI_PACKAGE);
      const satori = optionalDefault(loaded, SATORI_PACKAGE);
      const options: SatoriOptions = {
        width: size.width,
        height: size.height,
        fonts: satoriFonts(fonts),
      };
      return satori(tree, options);
    },
    async png(svg) {
      const wasm = options.resvgWasm;
      if (wasm === undefined) {
        throw new TypeError(
          "ImageResponse: pass resvgWasm (the bytes or module of @resvg/resvg-wasm/index_bg.wasm).",
        );
      }
      // The wasm is code the server runs: it comes from bytes or a module the app holds, never from a URL (resvg's
      // initWasm would fetch a string, URL or Response).
      if (!isWasmSource(wasm)) {
        throw new TypeError("ImageResponse: resvgWasm must be the bytes or the module, not a URL.");
      }
      assertSelfContained(svg);
      const resvg = await import("@resvg/resvg-wasm");
      if (!initialized.has(wasm)) {
        initialized.set(wasm, resvg.initWasm(wasm as never));
      }
      await initialized.get(wasm);
      const rendered = new resvg.Resvg(svg, { fitTo: { mode: "original" } }).render();
      try {
        return rendered.asPng();
      } finally {
        rendered.free();
      }
    },
  };
}

/**
 * A PNG response drawn from an element tree. The status line and the headers are set at once; the body is the PNG,
 * produced when the response is read. A render error ends the body with an error (the status has been sent).
 *
 * @example
 * export const GET = () =>
 *   new ImageResponse(h("div", { style: { display: "flex", fontSize: 64 } }, "Example"), {
 *     fonts: [{ name: "Sans", data: sansBytes, weight: 400 }],
 *     resvgWasm: resvgBytes,
 *   });
 * @since 1.0.0
 */
export class ImageResponse extends Response {
  /**
   * @param node The tree to draw (see `h`).
   * @param options Size, fonts, headers, status and the renderers.
   * @throws RangeError for a size out of range or a tree past the node limit (before any work starts).
   */
  constructor(node: OgNode, options: ImageResponseOptions = {}) {
    const size = checkedSize(options.width ?? 1200, options.height ?? 630);
    const fonts = options.fonts ?? [];
    const renderers = options.renderers ?? defaultRenderers({ resvgWasm: options.resvgWasm });
    // The tree is expanded now, so an invalid tree is a synchronous error, not a broken body.
    const tree = expandTree(node, { allowRemoteImages: options.allowRemoteImages === true });
    const png = (async (): Promise<Uint8Array> => {
      const svg = await renderers.svg(tree, size, fonts);
      return renderers.png(svg, size);
    })();
    // The body's `start` awaits the promise as soon as the stream is built, so a failure is handled
    // there and reaches whoever reads the body as its error (see the ImageResponse tests).
    const body = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        try {
          controller.enqueue(await png);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    const headers = new Headers(options.headers);
    // The body is always a PNG, whatever the caller's headers say; `nosniff` keeps a browser from guessing otherwise.
    headers.set("content-type", "image/png");
    headers.set("x-content-type-options", "nosniff");
    if (!headers.has("cache-control")) headers.set("cache-control", DEFAULT_CACHE);
    super(body, { status: options.status ?? 200, headers });
  }
}
