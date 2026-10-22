import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import { assertKnownOptions } from "../internal/known-options";

/** Options of response compression. @since 1.0.0 */
export interface CompressOptions {
  /** Smallest response worth compressing, in bytes (when the length is known). Default 1024. */
  readonly minBytes?: number;
  /** Compression level, 1 to 9, for gzip and zstd. `gzipLevel` overrides it for gzip. Default: gzip 6, zstd 3. */
  readonly level?: number;
  /** Brotli quality, 0 to 5 (higher is slower; dynamic responses stay at or below 5). Default 4. */
  readonly brotliQuality?: number;
  /** gzip level, 1 to 9. Default `level`, or 6. */
  readonly gzipLevel?: number;
  /** Most compressions running at once; further responses are sent uncompressed. Default 256. */
  readonly maxConcurrent?: number;
  /**
   * The content types worth compressing. A string is a media type (`"application/x-custom"`) or a family
   * (`"image/*"`), compared without parameters and ignoring case; a regular expression is tested against that
   * same media type. The list replaces the default one (text, JSON, JavaScript, XML, SVG, WebAssembly).
   * `text/event-stream` is never compressed.
   */
  readonly types?: readonly (string | RegExp)[];
  /**
   * Asked once per response that would be compressed; `true` allows it, anything else (including a thrown error or a
   * promise) skips compression. Use it to skip responses that reflect a secret next to attacker-controlled text, which
   * compression can leak (BREACH). It must answer synchronously.
   */
  readonly filter?: (request: Request, response: Response) => boolean;
}

/** A content coding this server produces. `"zstd"` only where `node:zlib` has it. @since 1.0.0 */
export type Encoding = "br" | "zstd" | "gzip";

const MAX_ACCEPT_LENGTH = 1024;
const MAX_ACCEPT_ELEMENTS = 16;
/** Node 22.12 has no zstd in `node:zlib`; later releases do. */
const ZSTD = typeof zlib.createZstdCompress === "function";
const PREFERENCE: readonly Encoding[] = ZSTD ? ["br", "zstd", "gzip"] : ["br", "gzip"];
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|x-javascript|xml|manifest\+json|ld\+json|wasm)|image\/svg\+xml|[^;]+\+(?:json|xml))/i;

/**
 * Chooses a content coding from `Accept-Encoding`: the highest q-value wins, and a tie goes to brotli, then zstd
 * (only where `node:zlib` has it), then gzip. `q=0` refuses a coding. The header is bounded (1 KiB, 16 elements);
 * anything beyond is ignored, so it cannot cost CPU.
 *
 * @param header The `Accept-Encoding` value.
 * @returns The coding to use, or `undefined` for identity.
 * @example
 * negotiateEncoding("gzip, deflate, br;q=0.9"); // "gzip" has q=1, br has 0.9 -> "gzip"
 * @since 1.0.0
 */
export function negotiateEncoding(header: string | null | undefined): Encoding | undefined {
  if (header === null || header === undefined || header.length > MAX_ACCEPT_LENGTH)
    return undefined;
  const quality = new Map<string, number>();
  for (const element of header.split(",", MAX_ACCEPT_ELEMENTS)) {
    const [name = "", ...parameters] = element.trim().toLowerCase().split(";");
    let q = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.trim().split("=");
      if (key === "q" && value !== undefined) q = Number(value);
    }
    if (Number.isFinite(q) && !quality.has(name.trim())) quality.set(name.trim(), q);
  }
  const wildcard = quality.get("*");
  let best: Encoding | undefined;
  let top = 0;
  for (const name of PREFERENCE) {
    const score = quality.get(name) ?? wildcard ?? 0;
    if (score > top) {
      best = name;
      top = score;
    }
  }
  return best;
}

/**
 * Whether a content type is worth compressing: text, JSON, JavaScript, XML, SVG, WebAssembly.
 *
 * @param contentType A `Content-Type` value.
 * @returns True for compressible types.
 * @example
 * isCompressible("text/html; charset=utf-8"); // true
 * @since 1.0.0
 */
export function isCompressible(contentType: string | null | undefined): boolean {
  return contentType !== null && contentType !== undefined && COMPRESSIBLE.test(contentType.trim());
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "minBytes",
  "level",
  "brotliQuality",
  "gzipLevel",
  "maxConcurrent",
  "types",
  "filter",
]);

/** Creates compression streams within a concurrency bound. @internal */
export interface Compressor {
  readonly minBytes: number;
  /** Whether a `Content-Type` is on the list of types worth compressing. */
  readonly compressible: (contentType: string | null | undefined) => boolean;
  /**
   * Runs the app's `filter` for a response that would be compressed. `true` only when there is no filter or it
   * answered `true`; a throw is reported and counts as `false`.
   */
  permits(
    request: Request | undefined,
    response: Response,
    report: (error: unknown) => void,
  ): boolean;
  /** A stream for `encoding`, or `undefined` when the concurrency bound is reached. */
  open(
    encoding: Encoding,
  ): { readonly stream: Transform; flush(): void; release(): void } | undefined;
  /** Compressions running now. */
  readonly active: number;
}

/** Throws a RangeError unless `value` is an integer from `min` to `max`. */
function checkInteger(name: string, value: unknown, min: number, max: number): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return;
  const range = max === Number.POSITIVE_INFINITY ? `${min} or more` : `${min} to ${max}`;
  throw new RangeError(
    `serve: compress.${name} must be an integer from ${range}, got ${String(value)}.`,
  );
}

/** The media type of a `Content-Type` value: no parameters, trimmed, lower case. */
function mediaTypeOf(contentType: string): string {
  return (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

/** Checks `types` and turns it into a predicate; a regular expression keeps no `lastIndex` between calls. */
function matcherOf(types: unknown): (contentType: string | null | undefined) => boolean {
  if (!Array.isArray(types))
    throw new TypeError(
      "serve: compress.types must be an array of media types and regular expressions.",
    );
  const exact = new Set<string>();
  const families: string[] = [];
  const patterns: RegExp[] = [];
  types.forEach((entry: unknown, index) => {
    if (entry instanceof RegExp) {
      patterns.push(new RegExp(entry.source, entry.flags.replace(/[gy]/g, "")));
    } else if (typeof entry === "string" && entry.trim() !== "") {
      const media = mediaTypeOf(entry);
      if (media.endsWith("/*")) families.push(media.slice(0, -1));
      else exact.add(media);
    } else {
      throw new TypeError(
        `serve: compress.types[${index}] must be a non-empty string or a RegExp.`,
      );
    }
  });
  return (contentType) => {
    if (contentType === null || contentType === undefined) return false;
    const media = mediaTypeOf(contentType);
    return (
      exact.has(media) ||
      families.some((family) => media.startsWith(family)) ||
      patterns.some((pattern) => pattern.test(media))
    );
  };
}

/**
 * The compressor of one server: the bound is per server, not per process. Validates the options.
 * @throws TypeError for an unknown option, or a `types` or `filter` of the wrong kind.
 * @throws RangeError for a number out of range.
 * @internal
 */
export function createCompressor(options: CompressOptions = {}): Compressor {
  if (typeof options !== "object" || options === null)
    throw new TypeError("serve: compress must be false or an options object.");
  assertKnownOptions("serve: compress", options, KNOWN_OPTIONS);
  const { level, filter } = options;
  const minBytes = options.minBytes ?? 1024;
  checkInteger("minBytes", minBytes, 0, Number.POSITIVE_INFINITY);
  if (level !== undefined) checkInteger("level", level, 1, 9);
  if (options.brotliQuality !== undefined)
    checkInteger("brotliQuality", options.brotliQuality, 0, 5);
  if (options.gzipLevel !== undefined) checkInteger("gzipLevel", options.gzipLevel, 1, 9);
  const quality = options.brotliQuality ?? 4;
  const gzipLevel = options.gzipLevel ?? level ?? 6;
  const maxConcurrent = options.maxConcurrent ?? 256;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new RangeError("serve: compress.maxConcurrent must be a positive integer.");
  if (filter !== undefined && typeof filter !== "function")
    throw new TypeError("serve: compress.filter must be a function.");
  const compressible = options.types === undefined ? isCompressible : matcherOf(options.types);
  let active = 0;
  return {
    minBytes,
    compressible,
    permits(request, response, report) {
      if (filter === undefined) return true;
      if (request === undefined) return false;
      try {
        // Only a plain `true` allows it: a promise, `undefined` or any other value fails closed.
        return filter(request, response) === true;
      } catch (error) {
        report(error);
        return false;
      }
    },
    get active() {
      return active;
    },
    open(encoding) {
      if (active >= maxConcurrent) return undefined;
      active += 1;
      let released = false;
      const stream: Transform & { flush(mode?: number, callback?: () => void): void } =
        encoding === "br"
          ? zlib.createBrotliCompress({
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality },
            })
          : encoding === "zstd"
            ? zlib.createZstdCompress(
                level === undefined
                  ? {}
                  : { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } },
              )
            : zlib.createGzip({ level: gzipLevel });
      return {
        stream,
        // Without a flush, a streamed page would sit in the compressor's buffer until it is full.
        flush: () =>
          stream.flush(
            encoding === "br"
              ? zlib.constants.BROTLI_OPERATION_FLUSH
              : encoding === "zstd"
                ? zlib.constants.ZSTD_e_flush
                : zlib.constants.Z_SYNC_FLUSH,
          ),
        release: () => {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
  };
}
