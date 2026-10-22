/**
 * Marks an error as an HTTP error. A registered symbol (not a module-level class identity) so the
 * check survives two bundled copies of this module, for example the server entry and a dev chunk.
 */
const HTTP_ERROR_BRAND: unique symbol = Symbol.for("shadowjs.dusk.http-error");

/** Reason phrases used as the default message of an {@link HttpError}. */
const REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  418: "I'm a Teapot",
  422: "Unprocessable Content",
  423: "Locked",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * The standard reason phrase of a status, or a generic text for unknown ones.
 *
 * @param status An HTTP status.
 * @returns For example `"Not Found"` for 404.
 * @example
 * reasonPhrase(404); // "Not Found"
 * reasonPhrase(599); // "Server Error"
 * @since 1.0.0
 */
export function reasonPhrase(status: number): string {
  return REASONS[status] ?? (status >= 500 ? "Server Error" : "Error");
}

/** Options of {@link HttpError}. @since 1.0.0 */
export interface HttpErrorOptions {
  /** Extra response headers, for example `WWW-Authenticate` or `Retry-After`. */
  readonly headers?: HeadersInit;
  /** Serializable detail that is sent to the client together with the error. */
  readonly data?: unknown;
  /** The underlying error. Never sent to the client. */
  readonly cause?: unknown;
  /**
   * Whether `message` may be shown to the client. Defaults to `true` for 4xx and `false` for 5xx,
   * where the message is replaced by the status text in production.
   */
  readonly expose?: boolean;
}

/**
 * An error that carries an HTTP status. Throw it from a loader, a middleware, an API route or a
 * server function: the framework answers with that status.
 *
 * Client errors (4xx) expose their message by default, because they are written for the caller.
 * Server errors (5xx) do not: their message is shown only in development.
 *
 * @example
 * if (user === undefined) throw new HttpError(401, "Sign in first", { headers: { "www-authenticate": "Bearer" } });
 * @since 1.0.0
 */
export class HttpError extends Error {
  /** The HTTP status, an integer from 400 to 599. */
  readonly status: number;
  /** Whether the message may be sent to the client in production. */
  readonly expose: boolean;
  /** Extra response headers. */
  readonly headers: Headers;
  /** Serializable detail for the client, if any. */
  readonly data: unknown;

  /**
   * @param status An integer from 400 to 599.
   * @param message Text for the client (see `options.expose`). Defaults to the reason phrase.
   * @param options Headers, data, cause and exposure.
   * @throws RangeError when `status` is not an integer from 400 to 599.
   */
  constructor(status: number, message?: string, options: HttpErrorOptions = {}) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`HttpError: status must be an integer from 400 to 599, got ${status}.`);
    }
    super(message ?? REASONS[status] ?? `HTTP ${status}`, { cause: options.cause });
    this.name = "HttpError";
    this.status = status;
    this.expose = options.expose ?? status < 500;
    this.headers = new Headers(options.headers);
    this.data = options.data;
    // Not a declared field: a symbol-keyed property cannot appear in declaration output, and it
    // needs no type, only to be found by isHttpError().
    Object.defineProperty(this, HTTP_ERROR_BRAND, { value: true });
  }
}

/**
 * True for an {@link HttpError}, also across two copies of this package.
 *
 * @param value Any thrown value.
 * @returns Whether `value` is an HTTP error.
 * @example
 * try { await load(); } catch (error) { if (isHttpError(error)) return error.status; }
 * @since 1.0.0
 */
export function isHttpError(value: unknown): value is HttpError {
  return (
    value instanceof HttpError ||
    (typeof value === "object" && value !== null && Reflect.get(value, HTTP_ERROR_BRAND) === true)
  );
}
