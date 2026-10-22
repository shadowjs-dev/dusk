/**
 * Builds a `Request` that keeps every header it was given, also under a browser-like runtime.
 *
 * Browsers forbid scripts from setting `Origin`, `Cookie`, `Host`, `Referer` and `Sec-*` headers,
 * and DOM implementations such as happy-dom copy that rule into the `Request` constructor, which
 * silently drops them. A server handler never runs in a browser: it receives those headers from the
 * network, and CSRF protection and sessions depend on them. The test helpers therefore set them
 * again on the constructed request. On a server runtime (Node, Bun, Deno, Workers) nothing was
 * dropped and this does nothing. The handler's own checks are not touched.
 *
 * @param url The request URL.
 * @param init The request init; `headers` is replaced by `headers`.
 * @param headers The headers to send.
 * @returns The request.
 * @internal
 */
export function buildRequest(
  url: URL,
  init: RequestInit & { duplex?: "half" },
  headers: Headers,
): Request {
  const request = new Request(url, { ...init, headers });
  for (const [name, value] of headers) {
    if (request.headers.get(name) !== value) request.headers.set(name, value);
  }
  return request;
}
