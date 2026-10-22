import { HttpError } from "../internal/http-error";
import { noteBodyRead, readText } from "./limits";

/** Limits of the JSON helpers. @since 1.0.0 */
export const JSON_LIMITS: Readonly<{ maxDepth: number }> = Object.freeze({ maxDepth: 64 });

/**
 * A JSON response. The body is serialized with `JSON.stringify`; `Content-Type` is
 * `application/json; charset=utf-8` and sniffing is disabled.
 *
 * @param data Any JSON-serializable value.
 * @param init Status and headers.
 * @returns The response.
 * @throws TypeError when `data` cannot be serialized (cycles, BigInt).
 * @example
 * export const GET = () => json({ ok: true }, { status: 200 });
 * @since 1.0.0
 */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(data);
  if (body === undefined) throw new TypeError("json(): the value has no JSON form.");
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(body, { ...init, headers });
}

/**
 * A plain text response (`text/plain; charset=utf-8`).
 *
 * @param body The text.
 * @param init Status and headers.
 * @returns The response.
 * @example
 * export const GET = () => text("pong");
 * @since 1.0.0
 */
export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(body, { ...init, headers });
}

/**
 * An HTML response (`text/html; charset=utf-8`). The caller is responsible for escaping.
 *
 * @param body Trusted markup.
 * @param init Status and headers.
 * @returns The response.
 * @example
 * export const GET = () => html("<h1>Hello</h1>");
 * @since 1.0.0
 */
export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

/** Keys that reach the prototype chain when a parsed object is merged or assigned carelessly. */
function isDangerousKey(key: string, value: unknown): boolean {
  if (key === "__proto__") return true;
  return (
    (key === "constructor" || key === "prototype") && typeof value === "object" && value !== null
  );
}

/**
 * Finds a key that could pollute a prototype: `__proto__`, or `constructor` / `prototype` holding
 * an object. Iterative, so a deeply nested body cannot overflow the stack; depth is capped.
 */
function findDangerousKey(root: unknown): string | undefined {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { value, depth } = entry;
    if (typeof value !== "object" || value === null) continue;
    if (depth > JSON_LIMITS.maxDepth) return "(too deep)";
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) {
      const child: unknown = Reflect.get(value, key);
      if (isDangerousKey(key, child)) return key;
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

/**
 * Parses JSON from untrusted input and rejects what could pollute a prototype later: a
 * `__proto__` key anywhere, a `constructor` or `prototype` key holding an object, and nesting
 * deeper than 64 levels.
 *
 * @param source JSON text.
 * @returns The parsed value.
 * @throws HttpError 400 for invalid JSON, a forbidden key or excessive depth.
 * @example
 * const body = parseJsonSafe(await request.text());
 * @since 1.0.0
 */
export function parseJsonSafe(source: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new HttpError(400, "Invalid JSON", { cause });
  }
  const found = findDangerousKey(parsed);
  if (found !== undefined) {
    throw new HttpError(400, "Invalid JSON", { cause: new Error(`forbidden key ${found}`) });
  }
  return parsed;
}

/**
 * True when a `Content-Type` header names JSON (`application/json`, `application/*+json`).
 *
 * @param contentType The header value, or `null`.
 * @returns Whether the type is JSON.
 * @example
 * isJsonContentType("application/vnd.api+json; charset=utf-8"); // true
 * @since 1.0.0
 */
export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

/**
 * Reads and parses a JSON request body safely (see {@link parseJsonSafe}). The body size limit of
 * the handler already applies to `request`.
 *
 * @param request The request.
 * @returns The parsed body.
 * @throws HttpError 415 when the content type is not JSON or names a charset other than UTF-8 (JSON is UTF-8, RFC 8259),
 *   400 for bytes that are not valid UTF-8, invalid JSON or a forbidden key.
 * @example
 * export const POST = async ({ request }) => json(await readJson(request));
 * @since 1.0.0
 */
export async function readJson(request: Request): Promise<unknown> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new HttpError(415, "Expected application/json");
  }
  if (__DEV__) noteBodyRead(request, "readJson()");
  // The stream's own bound applies (the handler's limit, or the route's); the charset of the body is honored.
  return parseJsonSafe(await readText(request, Number.POSITIVE_INFINITY, true));
}

/**
 * Reads and parses a JSON request body safely (see {@link parseJsonSafe}), never more than `maxBytes`. The
 * body is read as a stream and the read stops at the bound, so a route that accepts large uploads on purpose
 * can still keep each JSON field small. Use it where {@link readJson} would buffer up to the handler's
 * `limits.maxBodyBytes`.
 *
 * @param request The request.
 * @param maxBytes The limit in bytes; a smaller limit than the handler's, for this route.
 * @returns The parsed body.
 * @throws BodyTooLargeError (413) when the body is larger, before reading anything when `Content-Length` says so.
 * @throws HttpError 415 when the content type is not JSON or names a charset other than UTF-8, 400 for bytes that are not
 *   valid UTF-8, invalid JSON or a forbidden key.
 * @throws RangeError when `maxBytes` is `NaN` or negative.
 * @example
 * export const POST = async ({ request }) => json(await readJsonLimited(request, 64 * 1024));
 * @since 1.0.0
 */
export async function readJsonLimited(request: Request, maxBytes: number): Promise<unknown> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new HttpError(415, "Expected application/json");
  }
  return parseJsonSafe(await readText(request, maxBytes, true));
}

/**
 * Converts form data to a plain object. Repeated fields become arrays, files stay `File`
 * objects, and the keys `__proto__`, `constructor` and `prototype` are dropped.
 *
 * @param data A `FormData` or `URLSearchParams`.
 * @returns A null-prototype object.
 * @throws HttpError 400 when a field name holds U+FFFD (the sign of bytes that were not UTF-8).
 * @example
 * const fields = formToObject(await request.formData());
 * @since 1.0.0
 */
export function formToObject(data: FormData | URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of data.entries()) {
    // The parser repairs bytes that are not UTF-8 with U+FFFD, so `k%FF` and `k%FE` would both read as `k\uFFFD` and
    // become one field. A name that carries the replacement character is refused, not merged.
    if (key.includes("\uFFFD")) throw new HttpError(400, "Invalid form field name");
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}
