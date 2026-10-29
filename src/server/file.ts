import { selectRange } from "../shared/byte-range";

/** Options of {@link file}. @since 1.0.0 */
export interface FileOptions {
  /**
   * The request the file answers. Its `Range` (single range, with `If-Range`), `If-None-Match` and `If-Modified-Since`
   * decide the answer: 206, 416 or 304. Without it the file is always a 200.
   */
  readonly request?: Request;
  /**
   * The download name: `Content-Disposition: attachment`. A non-ASCII name gets an ASCII fallback and an RFC 5987
   * `filename*`. A name with CR or LF is refused (a header injection).
   */
  readonly filename?: string;
  /** The media type. Default `application/octet-stream`. */
  readonly type?: string;
  /** The `Cache-Control` value, sent as given. */
  readonly cacheControl?: string;
  /** The entity tag, quotes included (`"v1"` or `W/"v1"`). Sent as `ETag` and matched by `If-None-Match`. */
  readonly etag?: string;
  /** The modification time. Sent as `Last-Modified` and matched by `If-Modified-Since`. */
  readonly lastModified?: Date;
}

/**
 * A file answer: the bytes (or a `Blob`) with the headers a download needs, and the conditional and range requests
 * answered from the request. The file is read by the caller (a platform-neutral helper does not read paths); on Node the
 * static file server already serves `public/` with the same rules.
 *
 * @param source The bytes or a `Blob`.
 * @param options The name, media type, validators and the request.
 * @returns The response: 200, 206, 304 or 416.
 * @throws TypeError when the filename holds CR or LF.
 * @example
 * export const GET = async ({ request }) =>
 *   file(await readReport(), { request, filename: "report 2026.pdf", type: "application/pdf", etag: '"r1"' });
 * @since 1.0.0
 */
export function file(
  source: Uint8Array<ArrayBuffer> | ArrayBuffer | Blob,
  options: FileOptions = {},
): Response {
  const body: Uint8Array<ArrayBuffer> | Blob =
    source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  const size = body instanceof Blob ? body.size : body.byteLength;
  const headers = new Headers({
    "content-type": options.type ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  if (options.filename !== undefined)
    headers.set("content-disposition", dispositionOf(options.filename));
  if (options.cacheControl !== undefined) headers.set("cache-control", options.cacheControl);
  if (options.etag !== undefined) headers.set("etag", options.etag);
  if (options.lastModified !== undefined) {
    headers.set("last-modified", options.lastModified.toUTCString());
  }
  const request = options.request;
  const readable = request !== undefined && (request.method === "GET" || request.method === "HEAD");
  const head = request?.method === "HEAD";

  if (request !== undefined && readable && notModified(request, options)) {
    return new Response(null, { status: 304, headers });
  }

  let range: { start: number; end: number } | undefined;
  if (request !== undefined && readable) {
    // `If-Range` needs a strong validator: a weak entity tag never matches, and a date only counts when the file did not
    // change in the last second. A header that is not one valid range is ignored (the whole file); a range outside the
    // file is 416.
    const selected = selectRange(
      request.headers.get("range") ?? undefined,
      request.headers.get("if-range") ?? undefined,
      options.etag,
      options.lastModified?.getTime(),
      size,
      Date.now(),
    );
    if (selected === "unsatisfiable") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (selected !== null) range = selected;
  }

  if (range !== undefined) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(head ? null : slice(body, range.start, range.end), {
      status: 206,
      headers,
    });
  }
  headers.set("content-length", String(size));
  return new Response(head ? null : body, { status: 200, headers });
}

/** Lone surrogates: not text, and `encodeURIComponent` throws on them. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * The `Content-Disposition` of a download named `filename` (see {@link FileOptions.filename}): always `attachment`, an
 * ASCII `filename` that any client reads, and, when the name is not plain ASCII, an RFC 6266 / 5987 `filename*` with the
 * exact name. The name is a leaf, never a path: `/` and `\` become `_`, so `../../x` cannot be taken for a folder by a
 * client that saves it; controls become `_`; a `%` makes the name take the `filename*` form because some clients
 * percent-decode the plain parameter. @internal
 */
export function dispositionOf(filename: string): string {
  // CR and LF would end the header early: a name holding either is refused, not sanitized.
  if (/[\r\n]/.test(filename)) {
    throw new TypeError("file(): the filename must not contain CR or LF.");
  }
  const leaf = filename
    .replace(LONE_SURROGATE, "\ufffd")
    .replace(/[\\/]/g, "_")
    .replace(CONTROL, "_");
  const name = leaf === "" ? "download" : leaf;
  const quote = (text: string): string => text.replace(/["\\]/g, "\\$&");
  if (/^[\x20-\x7e]*$/.test(name) && !name.includes("%")) {
    return `attachment; filename="${quote(name)}"`;
  }
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]|%/g, "_");
  return `attachment; filename="${quote(ascii)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** The RFC 5987 `value-chars` encoding: UTF-8 percent-encoded, with `'`, `(`, `)` and `*` escaped too. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Whether the request's `If-None-Match` or `If-Modified-Since` says the client has the file. */
function notModified(request: Request, options: FileOptions): boolean {
  const noneMatch = request.headers.get("if-none-match");
  if (noneMatch !== null) {
    return options.etag !== undefined && noneMatches(noneMatch, options.etag);
  }
  const since = request.headers.get("if-modified-since");
  if (since === null || options.lastModified === undefined) return false;
  const time = Date.parse(since);
  if (Number.isNaN(time)) return false;
  // Whole seconds: an HTTP date has no finer precision.
  return Math.floor(options.lastModified.getTime() / 1000) <= Math.floor(time / 1000);
}

/** Weak comparison of an `If-None-Match` list with an entity tag; `*` matches any. */
function noneMatches(header: string, etag: string): boolean {
  const strip = (tag: string): string => tag.trim().replace(/^W\//, "");
  return (
    header.trim() === "*" || header.split(",").some((candidate) => strip(candidate) === strip(etag))
  );
}

/** The bytes (or the blob) from `start` to `end`, both inclusive. */
function slice(
  body: Uint8Array<ArrayBuffer> | Blob,
  start: number,
  end: number,
): Uint8Array<ArrayBuffer> | Blob {
  return body instanceof Blob ? body.slice(start, end + 1) : body.subarray(start, end + 1);
}
