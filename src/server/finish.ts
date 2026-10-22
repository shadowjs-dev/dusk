/**
 * The last step of every answer: the entity tags (a 304 for a matching `If-None-Match`, and the generated weak ETag of a
 * buffered page or of an API answer that asks for one: `cache.etag`, `RequestEvent.etag`), then the final `Response`
 * with its cookies. Loaded on first use (`import("./finish")` in the handler), so the initial chunk of a handler does not
 * carry this code.
 *
 * @packageDocumentation
 */

import type { EventState } from "./event";

/**
 * A weak entity tag for a body: `W/"…"` over the first 16 bytes of its SHA-256 (32 hex digits). The same bytes always get
 * the same tag, and the tag changes with the bytes.
 *
 * @param bytes The body.
 * @returns The entity tag, quotes included.
 * @internal
 */
async function weakEtagOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest.subarray(0, 16)) hex += byte.toString(16).padStart(2, "0");
  return `W/"${hex}"`;
}

/** Weak comparison of an `If-None-Match` list with an entity tag. */
function etagMatches(condition: string, etag: string): boolean {
  const strip = (tag: string): string => tag.trim().replace(/^W\//, "");
  if (condition.trim() === "*") return true;
  const current = strip(etag);
  return condition.split(",").some((candidate) => strip(candidate) === current);
}

/**
 * Whether a GET answer with status 200 and a body gets a generated weak ETag. It must have no ETag of its own and must not
 * opt out (`event.etag(false)`). With `event.etag(true)` it always does. Otherwise (the default) it is a page that is built
 * whole (it carries Content-Length, which the framework sets only on those) that a cache may keep (`cache.etag` is not
 * `false`, and the answer is not `no-store`). An API answer gets none by default.
 */
function generatedWanted(event: EventState, headers: Headers, cacheEtag: boolean): boolean {
  if (headers.has("etag") || event.etagPolicy === false) return false;
  if (event.etagPolicy !== undefined) return event.etagPolicy;
  if (!cacheEtag || event.route.kind !== "page" || !headers.has("content-length")) return false;
  return !/(^|,)\s*no-store\s*(,|$)/i.test(headers.get("cache-control") ?? "");
}

/**
 * Finishes an answer: the entity tags, then the `Response` the client gets. A generated tag is set in `headers` and the body
 * is read to compute it. A GET or HEAD whose `If-None-Match` matches the answer's ETag (its own, or the generated one) gets
 * a 304 with no body, unless the route opted out (`event.etag(false)`). The cookies the request set are added last, and a
 * browser-like `Response` (happy-dom, in a DOM test) that drops `Set-Cookie` is given them back.
 *
 * @param event The request event.
 * @param response The route's answer.
 * @param headers The answer's headers, complete except for the entity tag (set in place).
 * @param cacheEtag `cache.etag` (true unless turned off).
 * @returns The response to send.
 * @internal
 */
export async function finishAnswer(
  event: EventState,
  response: Response,
  headers: Headers,
  cacheEtag: boolean,
): Promise<Response> {
  const tagged = await tagStep(event, response, headers, cacheEtag);
  if (tagged?.response !== undefined) return tagged.response;
  const keepBody = event.method !== "HEAD" && response.body !== null;
  if (event.method === "HEAD") void response.body?.cancel();
  const final = new Response(tagged?.body ?? (keepBody ? response.body : null), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  const outgoing = headers.getSetCookie();
  if (final.headers.getSetCookie().length !== outgoing.length) {
    final.headers.delete("set-cookie");
    for (const cookie of outgoing) final.headers.append("set-cookie", cookie);
  }
  return final;
}

/** The entity-tag step (see {@link finishAnswer}): the generated tag, or the 304. */
async function tagStep(
  event: EventState,
  response: Response,
  headers: Headers,
  cacheEtag: boolean,
): Promise<{ readonly response?: Response; readonly body?: Uint8Array<ArrayBuffer> } | undefined> {
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (
    event.method === "GET" &&
    response.status === 200 &&
    response.body !== null &&
    generatedWanted(event, headers, cacheEtag)
  ) {
    body = new Uint8Array(await response.arrayBuffer());
    headers.set("etag", await weakEtagOf(body));
  }
  const etag = headers.get("etag");
  const condition = event.request.headers.get("if-none-match");
  const safe = event.method === "GET" || event.method === "HEAD";
  if (
    safe &&
    response.status === 200 &&
    etag !== null &&
    condition !== null &&
    event.etagPolicy !== false &&
    etagMatches(condition, etag)
  ) {
    // A body read for a generated tag is consumed; any other body is released unread.
    if (body === undefined) void response.body?.cancel();
    headers.delete("content-length");
    headers.delete("content-type");
    return { response: new Response(null, { status: 304, headers }) };
  }
  return body === undefined ? undefined : { body };
}
