import { deserialize, serialize } from "@shadow-js/web/server";
import { base64UrlEncode } from "../internal/encoding";
import type { Handler } from "../server/types";
import { createTestCookieJar, type TestCookieJar } from "./cookie-jar";
import { buildRequest } from "./request";

/** Options of {@link createTestClient}. @since 1.0.0 */
export interface TestClientOptions {
  /** Origin requests are sent to. Default `"http://localhost"`. */
  readonly origin?: string;
  /** `"manual"` (default) returns 3xx responses as they are; `"follow"` follows them like a browser. */
  readonly redirect?: "manual" | "follow";
  /** Redirects followed before giving up. Default 10. */
  readonly maxRedirects?: number;
  /** Headers added to every request. */
  readonly headers?: HeadersInit;
  /** Peer address the handler sees as `event.clientAddress`. Default `"127.0.0.1"`. */
  readonly clientAddress?: string;
  /** Mount point of the app (`base` of the handler); used by {@link TestClient.serverFn}. */
  readonly base?: string;
  /** Time source for cookie expiry. Default `Date.now`. */
  readonly now?: () => number;
}

/** Per-request options. @since 1.0.0 */
export interface TestRequestInit extends Omit<RequestInit, "redirect"> {
  /** Required by `fetch` when the body is a stream. */
  readonly duplex?: "half";
  readonly redirect?: "manual" | "follow";
  /** Send the request as a cross-site browser would (`Sec-Fetch-Site: cross-site`, foreign `Origin`). */
  readonly crossSite?: boolean;
  /** Do not add the fetch-metadata and `Origin` headers a same-origin browser adds. */
  readonly bare?: boolean;
}

/** The decoded answer of a server function call. @since 1.0.0 */
export interface ServerFnResult {
  readonly status: number;
  readonly response: Response;
  /** True for a `{ ok: true }` answer. */
  readonly ok: boolean;
  /** The returned value when `ok`. */
  readonly value: unknown;
  /** The error object when the call failed. */
  readonly error:
    | {
        readonly name: string;
        readonly message: string;
        readonly status: number;
        readonly issues?: unknown;
        readonly data?: unknown;
        readonly requestId?: string;
      }
    | undefined;
  /** The redirect when the function redirected. */
  readonly redirect: { readonly to: string; readonly status: number } | undefined;
  /** The raw decoded body. */
  readonly body: unknown;
}

/** Options of {@link TestClient.serverFn}. @since 1.0.0 */
export interface ServerFnCallOptions extends Omit<TestRequestInit, "method" | "body"> {
  /** `"GET"` for functions declared with `method: "GET"`. Default `"POST"`. */
  readonly method?: "GET" | "POST";
}

/**
 * Calls a handler without a network, the way a browser would: it keeps cookies, adds the headers a
 * same-origin page adds, and can follow redirects.
 *
 * It also works in a DOM test (happy-dom). There `Request` drops `Origin`, `Cookie` and `Sec-Fetch-*`
 * (browsers forbid scripts to set them), which would make every `POST` fail the CSRF check; the
 * client puts them back on the request it sends, and the handler keeps them. The CSRF check itself
 * stays on: `crossSite: true` and `bare: true` requests are still refused.
 * @since 1.0.0
 */
export interface TestClient {
  readonly cookies: TestCookieJar;
  readonly origin: string;
  request(input: string | URL, init?: TestRequestInit): Promise<Response>;
  get(path: string, init?: TestRequestInit): Promise<Response>;
  head(path: string, init?: TestRequestInit): Promise<Response>;
  post(path: string, init?: TestRequestInit): Promise<Response>;
  put(path: string, init?: TestRequestInit): Promise<Response>;
  patch(path: string, init?: TestRequestInit): Promise<Response>;
  delete(path: string, init?: TestRequestInit): Promise<Response>;
  options(path: string, init?: TestRequestInit): Promise<Response>;
  /**
   * A `fetch` that sends its requests through this client: same headers, same cookie jar, no
   * network. Hand it to code that calls the server itself, for example
   * `serverFnStub(id, meta).with({ fetch: client.fetch })`, so a DOM test can call server
   * functions (also `POST` ones) through the real handler with the CSRF check on.
   */
  readonly fetch: typeof fetch;
  /** POSTs `body` as JSON. */
  postJson(path: string, body: unknown, init?: TestRequestInit): Promise<Response>;
  /** Calls a server function by id with the wire format and headers of the real client. */
  serverFn(id: string, input?: unknown, options?: ServerFnCallOptions): Promise<ServerFnResult>;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Creates a test client for a handler.
 *
 * @param handler Anything with `fetch(request, env)`, usually the result of `createHandler`.
 * @param options Origin, redirect policy and defaults.
 * @returns The client.
 * @example
 * const client = createTestClient(handler);
 * const page = await client.get("/");
 * const result = await client.serverFn("addTodo", { title: "x" });
 * @since 1.0.0
 */
export function createTestClient(handler: Handler, options: TestClientOptions = {}): TestClient {
  const origin = new URL(options.origin ?? "http://localhost").origin;
  const cookies = createTestCookieJar(options.now);
  const defaultRedirect = options.redirect ?? "manual";
  const maxRedirects = options.maxRedirects ?? 10;
  const base = options.base ?? "";
  const platform = { clientAddress: options.clientAddress ?? "127.0.0.1" };

  const send = async (url: URL, init: TestRequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers);
    for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    if (init.bare !== true) {
      if (!headers.has("sec-fetch-site"))
        headers.set("sec-fetch-site", init.crossSite === true ? "cross-site" : "same-origin");
      if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) {
        headers.set("origin", init.crossSite === true ? "https://evil.example" : origin);
      }
    }
    const cookie = cookies.header(url);
    if (cookie !== undefined && !headers.has("cookie")) headers.set("cookie", cookie);
    const { redirect: _redirect, crossSite: _crossSite, bare: _bare, ...rest } = init;
    const requestInit: RequestInit & { duplex?: "half" } = { ...rest, method };
    const request = buildRequest(url, requestInit, headers);
    const response = await handler.fetch(request, platform);
    cookies.ingest(url, response.headers.getSetCookie());
    return response;
  };

  const request = async (input: string | URL, init: TestRequestInit = {}): Promise<Response> => {
    let url = new URL(input, origin);
    let current: TestRequestInit = init;
    // Redirects may need the body again (307, 308), so it is read once up front.
    const follow = (init.redirect ?? defaultRedirect) === "follow";
    let bytes: ArrayBuffer | undefined;
    if (follow && init.body !== undefined && init.body !== null) {
      bytes = await new Request(url, { method: "POST", body: init.body }).arrayBuffer();
      current = { ...init, body: bytes };
    }
    for (let hops = 0; ; hops += 1) {
      const response = await send(url, current);
      const location = response.headers.get("location");
      if (!follow || !REDIRECT_STATUSES.has(response.status) || location === null) return response;
      if (hops >= maxRedirects)
        throw new Error(`test client: more than ${maxRedirects} redirects.`);
      await response.body?.cancel();
      url = new URL(location, url);
      const method = (current.method ?? "GET").toUpperCase();
      const keepsMethod = response.status === 307 || response.status === 308;
      if (!keepsMethod && method !== "GET" && method !== "HEAD") {
        const { body: _body, ...withoutBody } = current;
        current = { ...withoutBody, method: "GET" };
      }
    }
  };

  const shortcut =
    (method: string) =>
    (path: string, init: TestRequestInit = {}): Promise<Response> =>
      request(path, { ...init, method });

  /** `fetch` over the handler: what a browser-side caller (a server function stub) is given. */
  const handlerFetch: typeof fetch = async (input, init) => {
    const source = input instanceof Request ? input : undefined;
    const target = source?.url ?? (input instanceof URL ? input.href : String(input));
    const headers = new Headers(source?.headers);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    const body =
      init?.body ??
      (source === undefined || source.body === null ? undefined : await source.arrayBuffer());
    const signal = init?.signal ?? source?.signal;
    const mode = init?.redirect ?? source?.redirect ?? "follow";
    return request(target, {
      method: init?.method ?? source?.method ?? "GET",
      headers,
      redirect: mode === "follow" ? "follow" : "manual",
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined || signal === null ? {} : { signal }),
    });
  };

  return {
    cookies,
    origin,
    request,
    fetch: handlerFetch,
    get: shortcut("GET"),
    head: shortcut("HEAD"),
    post: shortcut("POST"),
    put: shortcut("PUT"),
    patch: shortcut("PATCH"),
    delete: shortcut("DELETE"),
    options: shortcut("OPTIONS"),
    postJson: (path, body, init = {}) =>
      request(path, {
        ...init,
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    async serverFn(id, input, callOptions = {}) {
      const method = callOptions.method ?? "POST";
      const path = `${base}/_dusk/fn/${id}`;
      const payload = serialize([input]);
      const headers = new Headers(callOptions.headers);
      headers.set("x-dusk-fn", "1");
      const response =
        method === "GET"
          ? await request(`${path}?p=${base64UrlEncode(new TextEncoder().encode(payload))}`, {
              ...callOptions,
              method,
              headers,
            })
          : await request(path, {
              ...callOptions,
              method,
              headers: withJson(headers),
              body: payload,
            });
      const text = await response.text();
      let body: unknown;
      try {
        body = text === "" ? undefined : deserialize(text);
      } catch (cause) {
        throw new Error(
          `test client: the server function answered something that is not the wire format: ${text.slice(0, 200)}`,
          { cause },
        );
      }
      const record = typeof body === "object" && body !== null ? body : {};
      const error: unknown = Reflect.get(record, "error");
      const redirect: unknown = Reflect.get(record, "redirect");
      return {
        status: response.status,
        response,
        ok: Reflect.get(record, "ok") === true,
        value: Reflect.get(record, "value"),
        error: readError(error),
        redirect: readRedirect(redirect),
        body,
      };
    },
  };
}

/** Narrows the `error` member of an answer; anything else is `undefined`. */
function readError(value: unknown): ServerFnResult["error"] {
  if (typeof value !== "object" || value === null) return undefined;
  const name: unknown = Reflect.get(value, "name");
  const message: unknown = Reflect.get(value, "message");
  const status: unknown = Reflect.get(value, "status");
  if (typeof name !== "string" || typeof message !== "string" || typeof status !== "number")
    return undefined;
  const requestId: unknown = Reflect.get(value, "requestId");
  return {
    name,
    message,
    status,
    issues: Reflect.get(value, "issues"),
    data: Reflect.get(value, "data"),
    ...(typeof requestId === "string" ? { requestId } : {}),
  };
}

/** Narrows the `redirect` member of an answer; anything else is `undefined`. */
function readRedirect(value: unknown): ServerFnResult["redirect"] {
  if (typeof value !== "object" || value === null) return undefined;
  const to: unknown = Reflect.get(value, "to");
  const status: unknown = Reflect.get(value, "status");
  return typeof to === "string" && typeof status === "number" ? { to, status } : undefined;
}

function withJson(headers: Headers): Headers {
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}
