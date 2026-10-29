import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Handler } from "../server/types";

/** Why a request could not be turned into a Web `Request`. @internal */
export interface BridgeRejection {
  readonly status: number;
  readonly message: string;
}

/** How the bridge decides the public URL of a request. @internal */
export interface BridgeOptions {
  /** Believe `X-Forwarded-Proto` and `X-Forwarded-Host`. Only safe behind a proxy you control. */
  readonly trustProxy: boolean;
}

// A host name or address with an optional port: no path, user info, spaces or quotes.
const HOST = /^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const BODYLESS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** Counts how often a header name occurs in the raw header list (names compare case-insensitively). */
function occurrences(rawHeaders: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

/**
 * Rightmost value of a possibly comma-separated forwarded header. The client controls the left
 * end of the list; the nearest trusted proxy appends its own value on the right, so only that
 * one is believed.
 * @internal
 */
export function lastValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[value.length - 1] : value;
  const parts = text?.split(",") ?? [];
  const last = parts[parts.length - 1]?.trim();
  return last === undefined || last === "" ? undefined : last;
}

/**
 * The public URL of a Node request, built the way the request bridge builds it: the framing and Host checks of
 * {@link toWebRequest}, then `scheme://host` + the request target. The static file layer reads the host from this same
 * function, so a file is never answered for a Host the bridge would not hand to the handler.
 *
 * @param req The Node request.
 * @param options Proxy trust.
 * @returns The URL, or the rejection to answer.
 * @internal
 */
export function requestUrlOf(
  req: IncomingMessage,
  options: BridgeOptions,
): { readonly url: URL } | { readonly rejection: BridgeRejection } {
  const target = req.url ?? "";
  if (!target.startsWith("/")) return { rejection: { status: 400, message: "Bad Request" } };
  for (const name of ["content-length", "transfer-encoding", "host"]) {
    if (occurrences(req.rawHeaders, name) > 1)
      return { rejection: { status: 400, message: "Bad Request" } };
  }
  // Only a plain "chunked" is understood; any other coding is how a proxy and this server could
  // disagree about where the body ends.
  const coding = req.headers["transfer-encoding"];
  if (coding !== undefined && coding.trim().toLowerCase() !== "chunked") {
    return { rejection: { status: 400, message: "Bad Request" } };
  }
  const forwardedHost = options.trustProxy ? lastValue(req.headers["x-forwarded-host"]) : undefined;
  const host = forwardedHost ?? req.headers.host;
  if (host === undefined || !HOST.test(host))
    return { rejection: { status: 400, message: "Bad Request" } };
  const forwardedProto = options.trustProxy
    ? lastValue(req.headers["x-forwarded-proto"])?.toLowerCase()
    : undefined;
  const encrypted = "encrypted" in req.socket && req.socket.encrypted === true;
  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : encrypted
        ? "https"
        : "http";
  const href = `${protocol}://${host}${target}`;
  if (!URL.canParse(href)) return { rejection: { status: 400, message: "Bad Request" } };
  return { url: new URL(href) };
}

/**
 * Builds the Web `Request` of a Node request. Framing that request smuggling relies on is rejected
 * here, on the raw header list (the Fetch `Headers` joins duplicates and hides them): a repeated
 * `Content-Length`, `Transfer-Encoding` or `Host`. The URL is always built as
 * `scheme://host` + the request target, never by resolving the target against a base, so a target
 * such as `//evil.example/x` stays a path.
 *
 * @param req The Node request.
 * @param res The response, whose `close` aborts the request signal when the client goes away.
 * @param options Proxy trust.
 * @returns The request, or the rejection to answer.
 * @internal
 */
export function toWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeOptions,
): { readonly request: Request } | { readonly rejection: BridgeRejection } {
  const built = requestUrlOf(req, options);
  if ("rejection" in built) return built;
  const url = built.url;

  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index];
    const value = req.rawHeaders[index + 1];
    if (name === undefined || value === undefined) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
      return { rejection: { status: 400, message: "Bad Request" } };
    headers.append(name, value);
  }

  const abort = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished)
      abort.abort(new DOMException("The client disconnected.", "AbortError"));
  });

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody =
    !BODYLESS.has(method) &&
    (req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"));
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal };
  if (hasBody) {
    // Readable.toWeb applies backpressure: the socket is not read faster than the consumer pulls.
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return { request: new Request(url, init) };
}

/**
 * The host object of a request that may send Early Hints: the peer address, and `earlyHints(links)`, which writes a
 * `103` response with the links as `Link` headers. A method (not an own property), so it never shows up as an
 * environment binding or in a copy of the object.
 */
class HintingPlatform {
  readonly clientAddress: string | undefined;
  readonly #res: ServerResponse;
  readonly #report: (error: unknown) => void;

  constructor(
    clientAddress: string | undefined,
    res: ServerResponse,
    report: (error: unknown) => void,
  ) {
    this.clientAddress = clientAddress;
    this.#res = res;
    this.#report = report;
  }

  earlyHints(links: readonly string[]): void {
    if (this.#res.headersSent) return;
    try {
      this.#res.writeEarlyHints({ link: [...links] });
    } catch (error) {
      this.#report(error);
    }
  }
}

/**
 * The value the bridge passes to `handler.fetch` as the host object. With `res`, it also offers `earlyHints` to an
 * HTTP/1.1 browser navigation: older clients do not understand an informational response before the final one, and
 * only a browser acts on it. The browsers that do send `Sec-Fetch-Mode: navigate`; a script, a crawler or a load tool
 * does not, and is spared the extra response.
 *
 * @param req The Node request.
 * @param res The response `earlyHints` writes to; omit it to offer no hints.
 * @param report Receives a failure to write the hints.
 * @internal
 */
export function platformOf(
  req: IncomingMessage,
  res?: ServerResponse,
  report: (error: unknown) => void = () => undefined,
): { readonly clientAddress: string | undefined } {
  return res !== undefined &&
    req.httpVersion === "1.1" &&
    req.headers["sec-fetch-mode"] === "navigate"
    ? new HintingPlatform(req.socket.remoteAddress, res, report)
    : { clientAddress: req.socket.remoteAddress };
}

/** Calls the handler, turning a rejected promise into a plain 500 (a handler should never reject). @internal */
export async function callHandler(
  handler: Handler,
  request: Request,
  platform: unknown,
  report: (error: unknown) => void,
): Promise<Response> {
  try {
    return await handler.fetch(request, platform);
  } catch (error) {
    report(error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}
