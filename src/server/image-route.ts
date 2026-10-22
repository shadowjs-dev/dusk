import { HttpError } from "../internal/http-error";
import type { ImageFormat, ImageWidths } from "../shared/image";
import { imageWidthSet } from "../shared/image-check";
import { addressKey } from "./client-address";
import type { EventState } from "./event";
import { isRefusedImageHost } from "./image-hosts";
import { createFetchLimiter } from "./image-limit";
import { safeImageFetch } from "./image-safe-fetch";

export { isRefusedImageAddress, isRefusedImageHost } from "./image-hosts";

/**
 * The image optimizer endpoint, `GET /_dusk/image?url=<src>&w=<width>&q=<quality>&f=<format>`. It serves
 * the sources the app allows (its own files through `source`, or an origin in `remotePatterns`) at the
 * widths `imageProps` asks for, through a pluggable {@link ImageProcessor}. The package ships no native
 * image code: the built-in processors pass the source through, and an app or an adapter that can resize
 * supplies its own.
 */

/** An image as the optimizer holds it. @since 1.0.0 */
export interface ImageSource {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** What a processor is asked to do. @since 1.0.0 */
export interface ImageProcessorInput {
  readonly source: ImageSource;
  readonly width: number;
  readonly quality: number;
  readonly format: ImageFormat;
}

/**
 * Turns a source into the requested width, quality and format. Returning `undefined` serves the source
 * unchanged. A throw is reported and answered with a 500 that names no detail.
 * @since 1.0.0
 */
export interface ImageProcessor {
  process(input: ImageProcessorInput): Promise<ImageSource | undefined>;
}

/** Never transforms: every request gets the source as it is. @since 1.0.0 */
export const passthroughProcessor: ImageProcessor = {
  process: () => Promise.resolve(undefined),
};

/**
 * SVG is a vector format: the source is served as it is at any width. A raster source needs a processor
 * that can resize it, so this one refuses it with 415 instead of serving a file at the wrong size.
 * @since 1.0.0
 */
export const svgProcessor: ImageProcessor = {
  process: ({ source }) => {
    if (source.contentType === "image/svg+xml") return Promise.resolve(source);
    return Promise.reject(
      new HttpError(415, "Unsupported Media Type: this processor only passes SVG through."),
    );
  },
};

/** Options of the image endpoint. @since 1.0.0 */
export interface ImagesOptions {
  /** Reads a local file for a path (`/hero.png`). Default: none, so a local path is 404. */
  readonly source?: (path: string) => Promise<ImageSource | undefined>;
  /** Origins (`https://cdn.example`) an absolute `url` may point at. Default: none. */
  readonly remotePatterns?: readonly string[];
  /** The transform. Default {@link passthroughProcessor}. */
  readonly processor?: ImageProcessor;
  /**
   * The widths served: the device and small lists `imageProps` snaps to (see {@link ImageWidths}). Default: the
   * framework's lists, the same ones `<Image>` uses. Any other `w` is a `400`.
   */
  readonly widths?: ImageWidths;
  /** Largest width served. Default: the largest of `widths` (3840 with the defaults). */
  readonly maxWidth?: number;
  /** Largest source read, in bytes. Default 8 MiB. */
  readonly maxSourceBytes?: number;
  /** `Cache-Control` of an answer. Default `public, max-age=86400`. */
  readonly cacheControl?: string;
  /** Timeout of a remote fetch, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  /** The `fetch` for remote sources. Default: the global one. */
  readonly fetch?: typeof fetch;
  /** The formats a request may ask for (`original` is the source's own). Default: all of them. */
  readonly formats?: readonly ImageFormat[];
  /**
   * The qualities a request may ask for. Default `[75]`, the `imageProps` default, so the number of variants an image can
   * have stays bounded; list the others here to serve them.
   */
  readonly qualities?: readonly number[];
  /**
   * Most source reads (a local `source` call or a remote fetch, and the processing of what it returned) in flight at the
   * same time over all clients. A request over the cap is answered `503` with `Retry-After` and its source is not read.
   * Default 32.
   */
  readonly maxConcurrentFetches?: number;
  /**
   * Most source reads in flight for one client address (the same address and `/64` IPv6 grouping the rate limiter keys on,
   * so `security.trustProxy` applies). A request over the cap is answered `429` with `Retry-After`. A request with no
   * client address is held to the global cap only. Default 16.
   */
  readonly maxConcurrentFetchesPerClient?: number;
}

const DEFAULT_MAX_SOURCE = 8 * 1024 * 1024;
const DEFAULT_CACHE = "public, max-age=86400";
const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_MAX_FETCHES = 32;
const DEFAULT_MAX_FETCHES_PER_CLIENT = 16;
const RETRY_AFTER_SECONDS = "1";
const MAX_URL = 2048;
const FORMATS_LIST: readonly ImageFormat[] = ["original", "webp", "avif", "jpeg", "png"];
const FORMATS: ReadonlySet<string> = new Set(FORMATS_LIST);
const QUERY_KEYS: ReadonlySet<string> = new Set(["url", "w", "q", "f"]);
const WIDTH_TEXT = /^[1-9]\d{0,4}$/;
const QUALITY_TEXT = /^[1-9]\d{0,2}$/;
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Creates the endpoint. Validates the options at startup: a remote pattern must be an http(s) origin.
 *
 * @param options The endpoint's options.
 * @param report Receives a processor failure.
 * @returns The request handler for `/_dusk/image`.
 * @throws TypeError for a remote pattern that is not an http(s) origin; RangeError for a bad limit.
 * @internal
 */
export function createImageRoute(
  options: ImagesOptions | undefined,
  report: (error: unknown) => void,
): (event: EventState) => Promise<Response> {
  // Checked here, once, so a bad list fails at startup. The same set answers the component (`imageProps`).
  const widthSet = imageWidthSet(options?.widths);
  const maxWidth = options?.maxWidth ?? widthSet.largest;
  const maxSource = options?.maxSourceBytes ?? DEFAULT_MAX_SOURCE;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(maxWidth) || maxWidth < 1)
    throw new RangeError("images.maxWidth must be a positive integer.");
  if (!Number.isInteger(maxSource) || maxSource < 1)
    throw new RangeError("images.maxSourceBytes must be a positive integer.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("images.timeoutMs must be a positive integer.");
  const maxFetches = options?.maxConcurrentFetches ?? DEFAULT_MAX_FETCHES;
  const maxFetchesPerClient =
    options?.maxConcurrentFetchesPerClient ?? DEFAULT_MAX_FETCHES_PER_CLIENT;
  if (!Number.isInteger(maxFetches) || maxFetches < 1)
    throw new RangeError("images.maxConcurrentFetches must be a positive integer.");
  if (!Number.isInteger(maxFetchesPerClient) || maxFetchesPerClient < 1)
    throw new RangeError("images.maxConcurrentFetchesPerClient must be a positive integer.");
  const limiter = createFetchLimiter({ global: maxFetches, perClient: maxFetchesPerClient });
  const origins = new Set<string>();
  for (const pattern of options?.remotePatterns ?? []) {
    const parsed = URL.canParse(pattern) ? new URL(pattern) : undefined;
    if (
      parsed === undefined ||
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.pathname !== "/"
    ) {
      throw new TypeError(
        `images.remotePatterns: ${JSON.stringify(pattern)} must be an http(s) origin such as https://cdn.example.`,
      );
    }
    // Allow-listing an origin does not make a private address fetchable: the pattern itself is refused.
    if (isRefusedImageHost(parsed.hostname)) {
      throw new TypeError(
        `images.remotePatterns: ${JSON.stringify(pattern)} names a private, loopback or internal host, which the optimizer never fetches.`,
      );
    }
    origins.add(parsed.origin);
  }
  const processor = options?.processor ?? passthroughProcessor;
  const formats: readonly ImageFormat[] = options?.formats ?? FORMATS_LIST;
  const qualities: readonly number[] = options?.qualities ?? [75];
  const send = options?.fetch ?? defaultImageFetch();
  const cacheControl = options?.cacheControl ?? DEFAULT_CACHE;

  /** The source of a url: a local file the app allows, or a remote image from an allowed origin. */
  const sourceOf = async (url: string): Promise<ImageSource> => {
    if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) {
      // The app's `source` maps a path to a file, so it must never see a path that leaves its directory: dot
      // segments (in any spelling), backslashes and control characters are refused before it is called.
      if (!isPlainLocalPath(url))
        throw new HttpError(400, "Bad Request: url is not a path of this app.");
      const local = options?.source === undefined ? undefined : await options.source(url);
      if (local === undefined) throw new HttpError(404, "Not Found");
      if (local.bytes.byteLength > maxSource) throw new HttpError(502, "Bad Gateway");
      // A local file is served under its declared type, same origin: only an image may leave here, never HTML.
      const localType = mediaType(local.contentType);
      if (!localType.startsWith("image/")) {
        throw new HttpError(415, "Unsupported Media Type: a local source must be an image.");
      }
      return { bytes: local.bytes, contentType: localType };
    }
    if (!URL.canParse(url))
      throw new HttpError(400, "Bad Request: url must be a path or an absolute URL.");
    const target = new URL(url);
    if (isRefusedImageHost(target.hostname))
      throw new HttpError(403, "Forbidden: the image host is not allowed.");
    // Credentials in the URL would be sent to the origin as Basic auth, and mean the author did not write this URL.
    if (!origins.has(target.origin) || target.username !== "" || target.password !== "")
      throw new HttpError(403, "Forbidden: the image host is not allowed.");
    const response = await send(target.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 || response.body === null) throw new HttpError(502, "Bad Gateway");
    // A `fetch` that followed a redirect on its own (a custom one, or a platform that ignores `manual`) has already
    // talked to the redirect target; the allow-list was not applied to it, so the answer is refused.
    if (
      response.redirected ||
      (response.url !== "" && responseOrigin(response.url) !== target.origin)
    )
      throw new HttpError(502, "Bad Gateway");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxSource) throw new HttpError(502, "Bad Gateway");
    const bytes = await readBounded(response.body, maxSource);
    const contentType = mediaType(
      response.headers.get("content-type") ?? "application/octet-stream",
    );
    if (!contentType.startsWith("image/"))
      throw new HttpError(415, "Unsupported Media Type: the source is not an image.");
    return { bytes, contentType };
  };

  return async (event: EventState): Promise<Response> => {
    if (event.method !== "GET")
      throw new HttpError(405, "Method Not Allowed", { headers: { allow: "GET" } });
    const query = event.url.searchParams;
    // One spelling per image: `imageProps` writes exactly url, w, q and f. Another key, a repeated key or a number in
    // another form (`6.4e2`, `0640`, `+640`) would be a new cache key for the same bytes, so a client (or a CDN in front
    // of this route) could make the server fetch and encode one image without end.
    const seen = new Set<string>();
    for (const key of query.keys()) {
      if (!QUERY_KEYS.has(key) || seen.has(key))
        throw new HttpError(400, "Bad Request: the query holds an unknown or repeated key.");
      seen.add(key);
    }
    const url = query.get("url") ?? "";
    if (url === "" || url.length > MAX_URL)
      throw new HttpError(400, "Bad Request: url is missing or too long.");
    const widthText = query.get("w") ?? "";
    const width = WIDTH_TEXT.test(widthText) ? Number(widthText) : Number.NaN;
    if (!widthSet.all.includes(width) || width > maxWidth) {
      throw new HttpError(400, "Bad Request: w must be one of the widths the app offers.");
    }
    const qualityText = query.get("q") ?? "75";
    const quality = QUALITY_TEXT.test(qualityText) ? Number(qualityText) : Number.NaN;
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new HttpError(400, "Bad Request: q must be an integer from 1 to 100.");
    }
    if (qualities !== undefined && !qualities.includes(quality)) {
      throw new HttpError(400, "Bad Request: q is not one of the qualities the app allows.");
    }
    const requested = query.get("f");
    if (requested !== null && !FORMATS.has(requested)) {
      throw new HttpError(400, "Bad Request: f is not a known format.");
    }
    if (requested !== null && !formats.includes(requested as ImageFormat)) {
      throw new HttpError(400, "Bad Request: f is not one of the formats the app allows.");
    }
    // Without f the format follows the client's Accept header (AVIF, then WebP, then the source's own).
    const format: ImageFormat =
      requested !== null
        ? (requested as ImageFormat)
        : negotiate(event.request.headers.get("accept"), formats);

    // Past the cheap checks and before any source is read: a request over a cap never starts a read. The permit is
    // held until the processor is done too, because the source bytes stay in memory until then.
    const permit = limiter.acquire(
      event.clientAddress === undefined ? undefined : addressKey(event.clientAddress),
    );
    if (typeof permit === "string") {
      const refusal = permit === "client" ? 429 : 503;
      throw new HttpError(
        refusal,
        permit === "client"
          ? "Too Many Requests: too many images are being prepared for this client."
          : "Service Unavailable: too many images are being prepared.",
        { headers: { "retry-after": RETRY_AFTER_SECONDS, "cache-control": "no-store" } },
      );
    }
    let source: ImageSource;
    let out: ImageSource | undefined;
    try {
      source = await sourceOf(url);
      try {
        out = await processor.process({ source, width, quality, format });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        report(error);
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
    } finally {
      permit();
    }
    const answer = out ?? source;
    const svg = isSvgType(answer.contentType);
    const etag = await strongEtag(answer.bytes);
    const headers = new Headers({
      "content-type": svg ? mediaType(answer.contentType) : answer.contentType,
      "cache-control": cacheControl,
      "content-disposition": svg ? "attachment" : "inline",
      etag,
      "x-content-type-options": "nosniff",
    });
    // The answer depends on the Accept header whenever the format was negotiated.
    if (requested === null) headers.set("vary", "accept");
    if (svg) headers.set("content-security-policy", SVG_CSP);
    if (ifNoneMatch(event.request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(answer.bytes.slice(), { status: 200, headers });
  };
}

/**
 * The `fetch` of remote sources when the app gives none. On Node it is `safeImageFetch`, which refuses a name that resolves
 * to a private address at the connect step (DNS rebinding); elsewhere (Bun, Deno, Workers) it is the platform's `fetch`,
 * which the egress rules of that platform must restrict.
 */
function defaultImageFetch(): typeof fetch {
  const host: unknown = Reflect.get(globalThis, "process");
  const versions: unknown =
    typeof host === "object" && host !== null ? Reflect.get(host, "versions") : undefined;
  const has = (name: string): boolean =>
    typeof versions === "object" && versions !== null && Reflect.get(versions, name) !== undefined;
  return has("node") && !has("bun") && !has("deno") ? safeImageFetch() : globalThis.fetch;
}

/** The origin of a response URL, or the empty string for text that is not a URL. */
function responseOrigin(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : "";
}

/** The media type of a `Content-Type` value: parameters removed, trimmed, lower-case (type names are case-insensitive). */
function mediaType(value: string): string {
  return (value.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * True for a type a browser could render as an SVG document (which can run script when it is navigated to). Judged on the
 * media type alone, whatever its spelling, and generously: any `svg` type or XML suffix counts.
 */
function isSvgType(value: string): boolean {
  const type = mediaType(value);
  return type.includes("svg") || type.endsWith("+xml") || type.endsWith("/xml");
}

/**
 * The format for a request without `f`: AVIF when the client takes it, else WebP, else the source's own (`original`).
 * Only formats the app allows are offered.
 */
function negotiate(accept: string | null, allowed: readonly ImageFormat[]): ImageFormat {
  const offers = (accept ?? "").toLowerCase();
  if (offers.includes("image/avif") && allowed.includes("avif")) return "avif";
  if (offers.includes("image/webp") && allowed.includes("webp")) return "webp";
  return "original";
}

/** A strong ETag: the SHA-256 of the answer's bytes, shortened. The same answer always has the same tag. */
async function strongEtag(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  let hex = "";
  for (const byte of digest.subarray(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return `"${hex}"`;
}

/** True when `If-None-Match` names the tag (or `*`). */
function ifNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((candidate) => {
    const tag = candidate.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

/**
 * True for a path of this app that names no parent or current directory in any spelling: no `.` or `..` segment,
 * no encoded dot, slash or backslash (`%2e`, `%2f`, `%5c`, in any case), no backslash, no control character.
 */
function isPlainLocalPath(path: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\u0000-\u001f\u007f\\]/.test(path) || /%(?:2e|2f|5c)/i.test(path)) return false;
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

/** Reads a stream of at most `limit` bytes; anything more is a 502 (the source is too large). */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(502, "Bad Gateway");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
