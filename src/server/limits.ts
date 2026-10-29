import { HttpError } from "../internal/http-error";

/** Default limits. Each has an option in `security.limits`. @since 1.0.0 */
export const DEFAULT_LIMITS: Readonly<{
  maxUrlLength: number;
  maxBodyBytes: number;
  maxRouteBodyBytes: number;
  requestTimeoutMs: number;
  streamTimeoutMs: number;
}> = Object.freeze({
  maxUrlLength: 8192,
  maxBodyBytes: 1024 * 1024,
  // The largest body a route may ask for with `apiHandler({ maxBodyBytes })`: the hard ceiling of a route's own limit.
  maxRouteBodyBytes: 512 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  streamTimeoutMs: 120_000,
});

/** Caps on the entries of a parsed form (`readFormLimited`). Each has an option in `security.limits.form`. @since 1.0.0 */
export interface FormLimits {
  /** Most entries (fields and files) a form may hold. */
  readonly maxFields: number;
  /** Most `File` entries a form may hold. */
  readonly maxFileCount: number;
  /** Largest single file, in bytes. */
  readonly maxFileBytes: number;
  /** Largest single text field, in UTF-8 bytes. */
  readonly maxFieldBytes: number;
  /** Largest total of all text fields, in UTF-8 bytes. */
  readonly maxTotalFieldBytes: number;
}

/** The default form caps. @since 1.0.0 */
export const DEFAULT_FORM_LIMITS: Readonly<FormLimits> = Object.freeze({
  maxFields: 1000,
  maxFileCount: 20,
  maxFileBytes: 10 * 1024 * 1024,
  maxFieldBytes: 64 * 1024,
  maxTotalFieldBytes: 1024 * 1024,
});

/**
 * The byte limit of a request body and the form caps of its reader. A bounded request reads `limit` for every chunk, so a
 * route that raises it before reading (the handler does, from `apiHandler({ maxBodyBytes })`) is not cut off at the app's
 * limit. @internal
 */
export interface BodyCap {
  limit: number;
  readonly form: FormLimits;
  /**
   * In development a second read of a bounded request's body is the clear 500 of {@link bodyAlreadyReadError}. Outside
   * development the request object is left as the runtime made it (no own readers), so the runtime's own error is thrown.
   */
  readonly dev?: boolean;
}

/**
 * Thrown while a request body is read when it grows past the limit. The handler turns it into
 * a 413 response, whichever route was reading the body.
 * @example
 * try { await request.text(); } catch (error) { if (error instanceof BodyTooLargeError) console.log(error.limit); }
 * @since 1.0.0
 */
export class BodyTooLargeError extends HttpError {
  /** The limit in bytes. */
  readonly limit: number;

  /** @param limit The configured maximum, in bytes. */
  constructor(limit: number) {
    super(413, "Payload Too Large", { expose: true });
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

/** A problem with the framing headers of a request, with the status to answer. @since 1.0.0 */
export interface FramingProblem {
  readonly status: number;
  readonly message: string;
}

const DIGITS = /^\d{1,16}$/;
/** The `Content-Encoding` values a request body may carry: none, identity, gzip and deflate (decoded, see `boundRequest`). */
const CODINGS: ReadonlySet<string> = new Set(["", "identity", "gzip", "deflate"]);

/**
 * Checks the headers that frame the body. It rejects what request smuggling relies on: a
 * `Content-Length` that is not one plain number (duplicate headers are joined with a comma by the
 * Fetch API, so they fail here), `Content-Length` together with `Transfer-Encoding`, and any
 * transfer coding other than a single `chunked`. A declared length over the limit gives 413
 * before a byte is read.
 *
 * @param headers Request headers.
 * @param maxBodyBytes The body limit.
 * @returns The problem, or `undefined` when the framing is acceptable.
 * @example
 * checkFraming(request.headers, 1_048_576);
 * @since 1.0.0
 */
export function checkFraming(headers: Headers, maxBodyBytes: number): FramingProblem | undefined {
  const length = headers.get("content-length");
  const encoding = headers.get("transfer-encoding");
  if (length !== null && encoding !== null) {
    return { status: 400, message: "Content-Length and Transfer-Encoding together" };
  }
  if (encoding !== null && encoding.trim().toLowerCase() !== "chunked") {
    return { status: 400, message: "Unsupported Transfer-Encoding" };
  }
  // A body coded with anything but gzip or deflate (br, zstd, a list of codings) cannot be decoded here: 415.
  const coding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (!CODINGS.has(coding)) return { status: 415, message: "Unsupported Content-Encoding" };
  if (length !== null) {
    if (!DIGITS.test(length)) return { status: 400, message: "Invalid Content-Length" };
    if (Number(length) > maxBodyBytes) return { status: 413, message: "Payload Too Large" };
  }
  return undefined;
}

/**
 * Returns a request whose body errors with {@link BodyTooLargeError} as soon as more than
 * `maxBodyBytes` have been read. This enforces the limit for chunked bodies and for clients that
 * lie in `Content-Length`; the body is never buffered here.
 *
 * @param request The original request.
 * @param maxBodyBytes The limit in bytes.
 * @param signal The signal the new request should carry.
 * @returns A request that behaves like `request`, with a bounded body.
 * @example
 * const bounded = limitBody(request, 1024, new AbortController().signal);
 * @since 1.0.0
 */
export function limitBody(request: Request, maxBodyBytes: number, signal: AbortSignal): Request {
  return boundRequest(request, { limit: maxBodyBytes, form: DEFAULT_FORM_LIMITS }, signal);
}

/**
 * The request a handler reads. Its body is decoded first when `Content-Encoding` is `gzip` or `deflate` (a corrupt
 * stream is a 400), then counted in decoded bytes against `cap.limit`, so a zip bomb is cut off at the limit too. A
 * decoded copy drops `Content-Encoding` and `Content-Length`, which describe the coded bytes. The copy is guarded: a
 * second read of its body is a clear 500 (see {@link bodyAlreadyReadError}).
 *
 * @param request The original request.
 * @param cap The limit and the form caps; the handler raises `cap.limit` per route.
 * @param signal The signal the new request should carry.
 * @returns A request that behaves like `request`, with a bounded and decoded body.
 * @internal
 */
export function boundRequest(request: Request, cap: BodyCap, signal: AbortSignal): Request {
  const carried = followed(signal);
  const coding = decodingOf(request.headers);
  const original = request.body;
  const copy =
    original === null
      ? sameHeaders(new Request(request, { signal: carried }), request)
      : sameHeaders(
          new Request(request, {
            body: limitedStream(
              coding === undefined ? original : decodedBody(original, coding),
              cap,
            ),
            signal: carried,
            duplex: "half",
          } as RequestInit),
          request,
        );
  if (coding !== undefined && original !== null) {
    copy.headers.delete("content-encoding");
    copy.headers.delete("content-length");
  }
  capOf.set(copy, cap);
  if (__DEV__ && cap.dev === true) guardReads(copy);
  return copy;
}

/**
 * A signal that aborts when `source` does and references nothing but its own controller. undici keeps the signal given to
 * `new Request` strongly, in a finalization registry, until that request is collected. The request signal of a page has
 * listeners that reach the router, the event and so the request itself (the page's dispose hook), so passing it directly
 * kept every streamed page alive until the process ended.
 */
function followed(source: AbortSignal): AbortSignal {
  if (source.aborted) return AbortSignal.abort(source.reason);
  const controller = new AbortController();
  source.addEventListener("abort", () => controller.abort(source.reason), { once: true });
  return controller.signal;
}

/** The codings a body is decoded with, or `undefined` for an identity body. */
function decodingOf(headers: Headers): "gzip" | "deflate" | undefined {
  const coding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (coding === "gzip" || coding === "deflate") return coding;
  return undefined;
}

/** A stream of the same chunks that errors with {@link BodyTooLargeError} once more than `cap.limit` bytes pass. */
function limitedStream(
  stream: ReadableStream<Uint8Array>,
  cap: BodyCap,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > cap.limit) {
          controller.error(new BodyTooLargeError(cap.limit));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The decoded chunks of a coded body. The decoder is loaded the first time a chunk is pulled (`./body-coding`), so a
 * handler whose requests are never coded does not carry it at start-up; the request itself stays synchronous.
 */
function decodedBody(
  body: ReadableStream<BufferSource>,
  coding: "gzip" | "deflate",
): ReadableStream<Uint8Array> {
  let decoded: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      decoded ??= (await import("./body-coding")).decodeBody(body, coding).getReader();
      const step = await decoded.read();
      if (step.done) controller.close();
      else controller.enqueue(step.value);
    },
    cancel(reason) {
      return decoded?.cancel(reason);
    },
  });
}

/**
 * Makes sure a copied request carries every header of the original. Server runtimes copy them all;
 * a browser-like `Request` (happy-dom, used when DOM tests drive a handler) drops the ones a browser
 * forbids scripts to set, `Origin` and `Sec-Fetch-*` among them, which would fail the CSRF check of
 * a request that had passed the network. Nothing is added that the original did not have.
 */
function sameHeaders(copy: Request, original: Request): Request {
  for (const [name, value] of original.headers) {
    if (copy.headers.get(name) !== value) copy.headers.set(name, value);
  }
  return copy;
}

/**
 * Reads a request body as text, never more than `maxBytes` (a smaller limit than the handler's, for
 * endpoints that accept less).
 *
 * @param request The request.
 * @param maxBytes The limit in bytes (`Infinity` for none, on purpose).
 * @returns The text.
 * @throws BodyTooLargeError when the body is larger, before reading anything when `Content-Length` says so.
 * @throws RangeError when `maxBytes` is `NaN` or negative.
 * @throws HttpError 415 when the `charset` parameter is not one of `utf-8`, `utf-16le`, `utf-16be`, `iso-8859-1`, `latin1`;
 *   400 when the bytes are not valid text in the body's charset (the text is never repaired with U+FFFD).
 * @example
 * const text = await readTextLimited(request, 4096);
 * @since 1.0.0
 */
export function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  return readText(request, maxBytes, false);
}

/**
 * The reader behind {@link readTextLimited} and the JSON helpers. The text is decoded strictly: a byte sequence that is
 * not valid in the body's charset is a 400, never U+FFFD, so two different byte strings cannot become the same key or
 * value. With `utf8Only` (JSON, RFC 8259) any other charset is a 415.
 *
 * @internal
 */
export async function readText(
  request: Request,
  maxBytes: number,
  utf8Only: boolean,
): Promise<string> {
  // NaN would compare false against every size and let the whole body through: an unusable bound is an error.
  if (Number.isNaN(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      __DEV__ ? "readTextLimited: maxBytes must be a number of at least 0." : "DUSK_MAXBYTES",
    );
  }
  // The charset is checked before the body is read: an unknown one is refused without touching the stream.
  const decoder = textDecoderFor(request.headers.get("content-type"), utf8Only);
  const bytes = await readBodyBytes(request, maxBytes);
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    // A fatal decoder throws a TypeError for bytes that are not text in the charset.
    if (cause instanceof TypeError) throw new HttpError(400, "Invalid text encoding", { cause });
    throw cause;
  }
}

/** Bodies a route may read in full without a development warning: the largest limit that is not a risk by default. */
const LARGE_BODY_BYTES = 10 * 1024 * 1024;
/** Routes remembered as already warned about; the oldest is forgotten beyond it. */
const MAX_WARNED_ROUTES = 64;
/** The `Request` readers that buffer the whole body. */
const BUFFERING_READERS = ["text", "json", "formData", "arrayBuffer", "blob"] as const;

/** Called when a watched request is read in full; the argument names the reader. */
type BodyReadNotice = (reader: string) => void;

/** Requests the development watch armed, keyed by the request object itself. */
const watchedRequests = new WeakMap<Request, BodyReadNotice>();

/** Options of {@link createLargeBodyWatch}. */
interface LargeBodyWatchOptions {
  readonly dev: boolean;
  /** The handler's `limits.maxBodyBytes`. */
  readonly maxBodyBytes: number;
  readonly warn: (message: string) => void;
}

/**
 * Tells a route in development that it reads its whole body into memory while the handler allows a large one.
 * Nothing happens in production, or when `limits.maxBodyBytes` is 10 MiB or less, and `arm` then does not touch the
 * request.
 *
 * What it sees: {@link noteBodyRead} (called by `readJson`) and `text()`, `json()`, `formData()`, `arrayBuffer()`
 * and `blob()` called on the very request object an API route receives. What it does not see: `request.clone()`,
 * a request built from it, and anything that reads `request.body` as a stream (which is the safe way, so it must
 * not warn). A route is warned about once; at most {@link MAX_WARNED_ROUTES} routes are remembered.
 *
 * @internal
 */
export function createLargeBodyWatch(
  options: LargeBodyWatchOptions,
): (request: Request, routeKey: string, label: string) => void {
  if (!options.dev || !(options.maxBodyBytes > LARGE_BODY_BYTES)) return () => undefined;
  const warned = new Set<string>();
  const limit = options.maxBodyBytes / (1024 * 1024);
  const limitText = `${Number.isInteger(limit) ? limit : limit.toFixed(1)} MiB`;
  return (request, routeKey, label) => {
    // A request without a body has nothing to buffer.
    if (request.body === null) return;
    const notice: BodyReadNotice = (reader) => {
      if (warned.has(routeKey)) return;
      warned.add(routeKey);
      if (warned.size > MAX_WARNED_ROUTES) {
        const oldest = warned.values().next();
        if (oldest.done !== true) warned.delete(oldest.value);
      }
      options.warn(
        `${label} reads its request body in full with ${reader}, and limits.maxBodyBytes is ${limitText}: one request can hold that much memory. ` +
          "Read it with readJsonLimited(request, maxBytes) or readTextLimited(request, maxBytes), or stream request.body. " +
          "(Development check: reads through this request object are seen; request.clone() and copies of it are not.)",
      );
    };
    watchedRequests.set(request, notice);
    for (const name of BUFFERING_READERS) {
      const original: unknown = Reflect.get(request, name);
      if (typeof original !== "function") continue;
      Object.defineProperty(request, name, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: (...args: unknown[]): unknown => {
          notice(`request.${name}()`);
          return Reflect.apply(original, request, args);
        },
      });
    }
  };
}

/**
 * Called by the framework's unbounded readers (`readJson`): when the request is watched (see
 * {@link createLargeBodyWatch}) it warns, once per route. A request that is not watched is untouched.
 *
 * @internal
 */
export function noteBodyRead(request: Request, reader: string): void {
  watchedRequests.get(request)?.(reader);
}

/** The bytes of each request body read through {@link readBodyBytes}: a second reader gets the same bytes. */
const readBytesCache = new WeakMap<Request, Promise<Uint8Array<ArrayBuffer>>>();
/** The cap of each bounded request (see {@link boundRequest}). */
const capOf = new WeakMap<Request, BodyCap>();

/**
 * The cap of a request the handler bounded, or `undefined` for a request built by hand.
 *
 * @internal
 */
export function bodyCapOf(request: Request): BodyCap | undefined {
  return capOf.get(request);
}

/**
 * Throws {@link BodyTooLargeError} when a plain `Content-Length` declares more than `limit` bytes. Called before a byte is
 * read, so a refused body is never buffered.
 *
 * @internal
 */
export function refuseDeclaredLength(headers: Headers, limit: number): void {
  const declared = headers.get("content-length");
  if (declared !== null && DIGITS.test(declared) && Number(declared) > limit) {
    throw new BodyTooLargeError(limit);
  }
}

/**
 * Reads a request body as bytes, exactly as sent. The first call reads the stream (bounded by the request's cap, see
 * {@link boundRequest}, and by `maxBytes`); later calls on the same request return the same bytes. A body that was read
 * through `request.text()` or another reader cannot be read again: that is the clear 500 of {@link bodyAlreadyReadError}.
 *
 * @param request The request.
 * @param maxBytes A smaller bound for this read (`Infinity` for none).
 * @returns The bytes.
 * @throws BodyTooLargeError (413) above the bound.
 * @internal
 */
export function readBodyBytes(
  request: Request,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<Uint8Array<ArrayBuffer>> {
  const cached = readBytesCache.get(request);
  if (cached !== undefined) {
    return cached.then((bytes) => {
      if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
      return bytes;
    });
  }
  if (request.bodyUsed) return Promise.reject(bodyAlreadyReadError());
  const pending = readAllBytes(request, maxBytes);
  readBytesCache.set(request, pending);
  return pending;
}

async function readAllBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (request.body === null) return new Uint8Array(0);
  refuseDeclaredLength(request.headers, maxBytes);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The `charset` labels a text body may name, mapped to the `TextDecoder` label that decodes them. */
const CHARSETS: ReadonlyMap<string, string> = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["utf-16le", "utf-16le"],
  ["utf-16be", "utf-16be"],
  ["iso-8859-1", "iso-8859-1"],
  ["latin1", "iso-8859-1"],
]);

/**
 * The decoder of a text body: its `charset` parameter (UTF-8 when absent), strict. A charset outside {@link CHARSETS} is 415,
 * and with `utf8Only` so is any charset but UTF-8.
 *
 * @internal
 */
export function textDecoderFor(contentType: string | null, utf8Only = false): TextDecoder {
  const charset = charsetOf(contentType);
  const label = charset === undefined ? "utf-8" : CHARSETS.get(charset);
  if (label === undefined || (utf8Only && label !== "utf-8")) {
    throw new HttpError(415, "Unsupported charset");
  }
  return new TextDecoder(label, { fatal: true });
}

/** The lower-case `charset` parameter of a `Content-Type`, or `undefined`. */
function charsetOf(contentType: string | null): string | undefined {
  if (contentType === null) return undefined;
  for (const parameter of contentType.split(";").slice(1)) {
    const [name, ...value] = parameter.split("=");
    if (name?.trim().toLowerCase() === "charset") {
      return value
        .join("=")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .toLowerCase();
    }
  }
  return undefined;
}

/**
 * The error of a body read a second time. Its message says what to do instead.
 *
 * @internal
 */
export function bodyAlreadyReadError(): HttpError {
  return new HttpError(
    500,
    __DEV__
      ? "The request body was already consumed. Read it once, keep its bytes with event.rawBody(), or call request.clone() before the first read."
      : "DUSK_BODY",
  );
}

/** The `Request` readers that consume the body; a second call on a bounded request is the clear error. */
const CONSUMING_READERS = ["text", "json", "arrayBuffer", "blob", "formData"] as const;

/** Makes a second read of a bounded request's body fail with {@link bodyAlreadyReadError}. */
function guardReads(request: Request): void {
  for (const name of CONSUMING_READERS) {
    const original: unknown = Reflect.get(request, name);
    if (typeof original !== "function") continue;
    Object.defineProperty(request, name, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: (...args: unknown[]): unknown => {
        if (request.bodyUsed) return Promise.reject(bodyAlreadyReadError());
        return Reflect.apply(original, request, args);
      },
    });
  }
}
