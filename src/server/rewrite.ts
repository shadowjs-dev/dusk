/**
 * `rewrite(destination)`: a middleware answer that serves the request with another route of the app, as Next's
 * `NextResponse.rewrite` does. The handler takes the marker out of the middleware chain and routes the request to
 * `destination` again. The URL the client sees does not change; the rewrite's `headers` are added to the request the
 * target route receives (a host router uses this to pass an internal marker). The middleware chain does not run
 * again for the target, so a rewrite cannot loop: a second rewrite of the same request is refused with a 500.
 *
 * @packageDocumentation
 */

/** The URL prefix the framework serves itself (server functions, health, images). No rewrite may name it. */
const RESERVED = "/_dusk";

/** Options of {@link rewrite}. @since 1.0.0 */
export interface RewriteOptions {
  /** Headers added to the request the target route receives (they replace a header of the same name). */
  readonly headers?: HeadersInit;
}

/** What the handler does with a rewrite marker. @internal */
export interface RewriteInstruction {
  /** The path of the target, without the mount base. */
  readonly path: string;
  /** The query string of the target, with its leading `?` (or empty). */
  readonly search: string;
  /** Request headers the target receives. */
  readonly headers: Headers;
}

/** The markers the middleware returned, by identity. A `Response` nobody else holds can carry no instruction. */
const instructions = new WeakMap<Response, RewriteInstruction>();

/**
 * Returns a rewrite answer for middleware: `return rewrite("/internal/path")`.
 *
 * @param destination A path of this app, optionally with a query string (`/site/acme/index.html?x=1`). Anything
 *   else is refused: an absolute URL, a protocol-relative `//host`, a backslash, a control character, or a path under
 *   `/_dusk/`.
 * @param options The request headers the target receives.
 * @returns A response that only the handler reads. Return it from middleware, unchanged, so the handler sees it.
 * @throws TypeError for a destination that is not a path of this app.
 * @example
 * export const middleware: Middleware[] = [
 *   (event, next) => (event.url.hostname === "status.example.com" ? rewrite("/status") : next()),
 * ];
 * @since 1.0.0
 */
export function rewrite(destination: string, options: RewriteOptions = {}): Response {
  if (typeof destination !== "string")
    throw new TypeError("rewrite(destination): a path string is required.");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (!destination.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(destination)) {
    throw new TypeError(
      `rewrite(${JSON.stringify(destination)}): the destination must be a path of this app.`,
    );
  }
  if (destination.startsWith("//")) {
    throw new TypeError(
      `rewrite(${JSON.stringify(destination)}): a protocol-relative destination is refused.`,
    );
  }
  const url = new URL(destination, "http://rewrite.invalid");
  if (url.pathname === RESERVED || url.pathname.startsWith(`${RESERVED}/`)) {
    throw new TypeError(
      `rewrite(${JSON.stringify(destination)}): the ${RESERVED} prefix is reserved.`,
    );
  }
  const marker = new Response(null, { status: 204 });
  instructions.set(marker, {
    path: url.pathname,
    search: url.search,
    headers: new Headers(options.headers),
  });
  return marker;
}

/**
 * The instruction a middleware answer carries, or `undefined` for an ordinary response.
 *
 * @param response The response the middleware chain returned.
 * @returns The rewrite, if the response is a marker of {@link rewrite}.
 * @internal
 */
export function rewriteOf(response: Response): RewriteInstruction | undefined {
  return instructions.get(response);
}
