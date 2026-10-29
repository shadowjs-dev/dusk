import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * Bridges a Node HTTP request/response to the Web `Request`/`Response` the handler speaks. Used by
 * the dev server; `@shadow-js/dusk/node` has the production bridge. Streaming in both directions,
 * with backpressure, `Set-Cookie` kept as separate headers, and an abort signal that fires when the
 * client goes away.
 */

/** A request that could not be turned into a `Request`. @since 1.0.0 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** Options of {@link toWebRequest}. @since 1.0.0 */
export interface ToWebRequestOptions {
  /** `http` or `https`. */
  readonly protocol: "http" | "https";
  /** Aborts the request signal. */
  readonly signal: AbortSignal;
}

/**
 * Builds the Web request.
 *
 * @param req The Node request. The URL comes from `originalUrl` when the middleware stack rewrote `url`.
 * @param options Protocol and abort signal.
 * @returns The request.
 * @throws BadRequestError when the Host header or the URL is not usable.
 * @since 1.0.0
 * @internal
 * @example const request = toWebRequest(req, { protocol: "http", signal: controller.signal });
 */
export function toWebRequest(
  req: IncomingMessage & { originalUrl?: string | undefined },
  options: ToWebRequestOptions,
): Request {
  const host = req.headers.host;
  if (host === undefined || host === "") throw new BadRequestError("missing Host header");
  const target = req.originalUrl ?? req.url ?? "/";
  const origin = `${options.protocol}://${host}`;
  // An origin-form target (`/path?query`) is appended to the origin, never resolved against it: resolving makes a target
  // such as `//evil.example/x` another host. This is how the production bridge builds the URL too.
  const href = target.startsWith("/") ? `${origin}${target}` : undefined;
  if (href === undefined ? !URL.canParse(target, origin) : !URL.canParse(href)) {
    throw new BadRequestError("invalid request URL");
  }
  const url = href === undefined ? new URL(target, origin) : new URL(href);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: options.signal };
  if (method !== "GET" && method !== "HEAD") {
    // Node's readable and the Web ReadableStream are the same bytes; the cast bridges the typings.
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * Writes a Web response to a Node response.
 *
 * @param res The Node response.
 * @param response What to send. A `HEAD` request gets the headers only.
 * @param isHead Whether the request method was `HEAD`.
 * @since 1.0.0
 * @internal
 * @example await writeWebResponse(res, response, request.method === "HEAD");
 */
export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
  isHead: boolean,
): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText !== "") res.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (response.body === null || isHead) {
    if (response.body !== null) await response.body.cancel();
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const closed = new Promise<"closed">((resolve) => res.once("close", () => resolve("closed")));
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), closed]);
      if (next === "closed") {
        await reader.cancel();
        return;
      }
      if (next.done) break;
      if (!res.write(next.value)) {
        const drained = await Promise.race([
          new Promise<"drained">((resolve) => res.once("drain", () => resolve("drained"))),
          closed,
        ]);
        if (drained === "closed") {
          await reader.cancel();
          return;
        }
      }
    }
    res.end();
  } catch (error) {
    // The stream broke after the head was sent: the only honest answer is to cut the connection.
    res.destroy(error instanceof Error ? error : undefined);
    throw error;
  }
}
