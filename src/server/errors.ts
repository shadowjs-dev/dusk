import { SearchValidationError } from "@shadow-js/router/core";
import { HttpError, isHttpError, reasonPhrase } from "../internal/http-error";
import { isNotFound } from "../internal/redirect";
import type { ErrorBody, ValidationIssue } from "./types";
import { ValidationError } from "./validate";

/**
 * Thrown by the handler when the request outlives its time budget. Answered with 504.
 * @example
 * throw new RequestTimeoutError(30_000);
 * @since 1.0.0
 */
export class RequestTimeoutError extends HttpError {
  /** @param timeoutMs The budget that was exceeded. */
  constructor(timeoutMs: number) {
    super(504, `The request took longer than ${timeoutMs} ms.`, { expose: false });
    this.name = "RequestTimeoutError";
  }
}

/** What the client is told about a thrown value, and whether the server logs it. @internal */
export interface ErrorDescription {
  readonly status: number;
  readonly name: string;
  readonly message: string;
  readonly headers: Headers;
  readonly issues: readonly ValidationIssue[] | undefined;
  readonly data: unknown;
  /** A stable code for the client (`SEARCH_INVALID` for a rejected query), when the error has one. */
  readonly code?: string;
  /** Whether the error is unexpected and must be reported to the server's error sink. */
  readonly report: boolean;
}

/** The built-in not-found page's title and indexing (see the `notFoundPage` option). @internal */
export interface NotFoundPage {
  readonly title: string;
  readonly noindex: boolean;
}

/** True for the abort error that a canceled request produces. */
function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (Reflect.get(error, "name") === "AbortError" ||
      Reflect.get(error, "name") === "ResponseAborted")
  );
}

/**
 * Decides what the client sees. Client errors (4xx) show their message; everything else shows the
 * standard reason phrase unless `dev` is on. Details of unexpected errors never leave the server.
 *
 * @param error Any thrown value.
 * @param dev Whether development details may be shown.
 * @returns Status, public message and whether to report it.
 * @internal
 */
export function describeError(error: unknown, dev: boolean): ErrorDescription {
  if (error instanceof SearchValidationError) {
    // A rejected query is the client's error: 400 with the failing keys and a stable code (G-C3).
    const keys = error.issues.map((issue) => issue.path.join(".")).filter((key) => key !== "");
    return {
      status: 400,
      name: "SearchValidationError",
      message: `Invalid search parameters${keys.length > 0 ? `: ${keys.join(", ")}` : ""} (SEARCH_INVALID)`,
      headers: new Headers(),
      issues: error.issues.map((issue) => ({ message: issue.message, path: [...issue.path] })),
      data: undefined,
      code: "SEARCH_INVALID",
      report: false,
    };
  }
  if (error instanceof ValidationError) {
    return {
      status: 400,
      name: "ValidationError",
      message: "Invalid input",
      headers: error.headers,
      issues: error.issues,
      data: undefined,
      report: false,
    };
  }
  if (isHttpError(error)) {
    const visible = error.expose || dev;
    return {
      status: error.status,
      name: "HttpError",
      message: visible ? error.message : reasonPhrase(error.status),
      headers: error.headers,
      issues: undefined,
      data: visible ? error.data : undefined,
      report: error.status >= 500,
    };
  }
  if (isNotFound(error)) {
    return {
      status: 404,
      name: "NotFound",
      message: reasonPhrase(404),
      headers: new Headers(),
      issues: undefined,
      data: undefined,
      report: false,
    };
  }
  if (isAbort(error)) {
    return {
      status: 499,
      name: "Aborted",
      message: "Client Closed Request",
      headers: new Headers(),
      issues: undefined,
      data: undefined,
      report: false,
    };
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    status: 500,
    name: "Error",
    message: dev ? detail : reasonPhrase(500),
    headers: new Headers(),
    issues: undefined,
    data: undefined,
    report: true,
  };
}

/** The error object sent in JSON and RPC bodies. @internal */
export function errorBody(description: ErrorDescription, requestId: string): ErrorBody {
  return {
    name: description.name,
    message: description.message,
    status: description.status,
    requestId,
    ...(description.issues === undefined ? {} : { issues: description.issues }),
    ...(description.data === undefined ? {} : { data: description.data }),
    ...(description.code === undefined ? {} : { code: description.code }),
  };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes the five HTML-significant characters of a string. This is the page's own copy of the web package's escape
 * for strings: the error page needs no more, and the web escape would pull the whole SSR runtime into every handler.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * A minimal HTML page for an error. The message is escaped; in production it is the reason phrase.
 *
 * @param status HTTP status.
 * @param message Public message.
 * @param requestId Id to quote when reporting the problem.
 * @param lang Language of the page.
 * @returns A complete document.
 * @internal
 */
export function errorPageHtml(
  status: number,
  message: string,
  requestId: string,
  lang: string,
  page?: NotFoundPage,
): string {
  const title = `${status} ${reasonPhrase(status)}`;
  // The document title and `noindex` of the built-in not-found page (`notFoundPage`); the heading keeps the status.
  const documentTitle = page?.title ?? title;
  const robots = page?.noindex === true ? '<meta name="robots" content="noindex">' : "";
  return (
    `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">${robots}` +
    `<title>${escapeHtml(documentTitle)}</title></head><body><main><h1>${escapeHtml(title)}</h1>` +
    `<p>${escapeHtml(message)}</p><p><small>Request ${escapeHtml(requestId)}</small></p></main></body></html>`
  );
}

/**
 * A `Location` value that is safe to put in a header: characters outside printable ASCII are percent-encoded, so no
 * value can fail header validation or split a header. The pattern reads code points (`u`), so an emoji is one character
 * and not two halves. A half of a surrogate pair (a decoded query can hold one) becomes U+FFFD first
 * (`toWellFormed`), because `encodeURIComponent` throws on it and that would turn a redirect into a crash.
 *
 * @param location A target already checked by `checkRedirectTarget`.
 * @returns The header value.
 * @internal
 */
export function encodeLocation(location: string): string {
  // `toWellFormed` is ES2024 (Node 20, Bun, Deno and Workers have it); the project's `lib` does not list it yet.
  const wellFormed = (location as string & { toWellFormed(): string }).toWellFormed();
  return wellFormed.replace(/[^\x21-\x7e]/gu, encodeURIComponent);
}

/**
 * A redirect response with an empty body (see {@link encodeLocation} for the `Location` value).
 *
 * @param location A target already checked by `checkRedirectTarget`.
 * @param status 301, 302, 303, 307 or 308.
 * @returns The response.
 * @internal
 */
export function redirectResponse(location: string, status: number): Response {
  return new Response(null, {
    status,
    headers: { location: encodeLocation(location), "cache-control": "no-store" },
  });
}
