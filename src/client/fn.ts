import { resolveSameOrigin } from "@shadow-js/router/core";
import { deserialize, serialize } from "@shadow-js/web/server";
import { base64UrlEncode } from "../internal/encoding";
import { HttpError } from "../internal/http-error";
import { notFound, type RedirectStatus, redirect } from "../internal/redirect";
import type { CallArguments } from "../shared/call-arguments";
import type { ServerFnCallOptions } from "../shared/call-options";
import {
  RPC_BATCH_ID,
  RPC_HEADER,
  RPC_LOCATION_HEADER,
  RPC_MAX_BATCH_CALLS,
  RPC_PREFIX,
  type RpcEnvelope,
  type RpcErrorBody,
  type ServerFnStubMeta,
} from "../shared/wire";
import { applyDeploymentHeader, noteDeploymentMismatch } from "./deployment";
import { ServerFnError, ServerFnProtocolError } from "./errors";
import { applyRevalidated } from "./single-flight";

/**
 * The browser side of server functions. The build replaces a `serverFn(...)` or `"use server"`
 * function with `serverFnStub(id, meta)`; calling the stub sends the argument to
 * `{base}/_dusk/fn/<id>` and turns the answer back into a value, an `HttpError`, or a router
 * `redirect()` / `notFound()` signal.
 *
 * Calls made in the same tick to POST functions travel together: the stub queues them and sends one
 * `POST {base}/_dusk/fn/_batch` (at most {@link RPC_MAX_BATCH_CALLS} calls per request). A call with
 * its own `signal`, `headers` or `fetch` is sent alone, and so is a function built with `batch: false`.
 */

/** The longest answer body accepted, in characters. A larger one is a protocol error. */
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

export type { ServerFnCallOptions } from "../shared/call-options";

/**
 * A server function as the browser sees it: a function that returns a promise, plus the pieces
 * a form or a tool may need.
 * @since 1.0.0
 */
export interface ClientServerFn<Input = unknown, Output = unknown> {
  /**
   * Calls the function on the server. The argument is optional when `undefined` is a valid input,
   * and required otherwise: the same rule as the server function this stub stands for. An optional
   * last argument sets the options of this one call (`{ signal }` cancels the request), so a stub
   * fits where a function `(input, { signal })` is expected, such as `submitWith` of
   * `@shadow-js/forms`.
   */
  (...input: [...CallArguments<Input>, options?: ServerFnCallOptions]): Promise<Output>;
  /** The stable id of the function. */
  readonly id: string;
  /** The endpoint, for example `/_dusk/fn/q3Zr…`: use it as a form `action` for `form: true` functions. */
  readonly url: string;
  /** A version of the function with call options (abort signal, headers). */
  with(options: ServerFnCallOptions): (...input: CallArguments<Input>) => Promise<Output>;
}

/**
 * The options argument of a call. Anything that is not a plain options object (the index
 * `Array.prototype.map` passes as a second argument, for example) means "no options".
 */
function callOptions(value: unknown): ServerFnCallOptions {
  return isRecord(value) && !Array.isArray(value) ? (value as ServerFnCallOptions) : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isRedirectStatus(status: number): status is RedirectStatus {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Narrows a decoded body to an {@link RpcEnvelope}, or returns undefined. @internal */
export function asEnvelope(value: unknown): RpcEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const redirectTarget = Reflect.get(value, "redirect");
  if (isRecord(redirectTarget)) {
    const to = Reflect.get(redirectTarget, "to");
    const status = Reflect.get(redirectTarget, "status");
    if (typeof to === "string" && typeof status === "number") {
      return { redirect: { to, status } };
    }
    return undefined;
  }
  const ok = Reflect.get(value, "ok");
  if (ok === true) {
    const revalidated: unknown = Reflect.get(value, "revalidated");
    return revalidated === undefined
      ? { ok: true, value: Reflect.get(value, "value") }
      : { ok: true, value: Reflect.get(value, "value"), revalidated };
  }
  if (ok === false) {
    const error = Reflect.get(value, "error");
    if (!isRecord(error)) return undefined;
    const name = Reflect.get(error, "name");
    const message = Reflect.get(error, "message");
    const status = Reflect.get(error, "status");
    if (typeof name !== "string" || typeof message !== "string" || typeof status !== "number") {
      return undefined;
    }
    const requestId = Reflect.get(error, "requestId");
    const issues: unknown = Reflect.get(error, "issues");
    const data: unknown = Reflect.get(error, "data");
    const body: RpcErrorBody = {
      name,
      message,
      status,
      ...(typeof requestId === "string" ? { requestId } : {}),
      ...(Array.isArray(issues) ? { issues: issues as RpcErrorBody["issues"] & unknown[] } : {}),
      ...(data === undefined ? {} : { data }),
    };
    return { ok: false, error: body };
  }
  return undefined;
}

/** The value to throw for a failed call: the class the server threw, or a generic error. */
function errorFor(body: RpcErrorBody): unknown {
  if (body.name === "NotFound") return notFound();
  const inRange = Number.isInteger(body.status) && body.status >= 400 && body.status <= 599;
  if ((body.name === "HttpError" || body.name === "ValidationError") && inRange) {
    const data = body.name === "ValidationError" ? { issues: body.issues ?? [] } : body.data;
    return new HttpError(body.status, body.message, { data, expose: true });
  }
  return new ServerFnError(body.message, body.status, body.requestId);
}

/** Where relative redirect targets are resolved: the page, or a neutral origin outside a page. */
function currentLocation(): string {
  const location: unknown = Reflect.get(globalThis, "location");
  const href = isRecord(location) ? Reflect.get(location, "href") : undefined;
  return typeof href === "string" ? href : "http://localhost/";
}

/**
 * The path and query of the page the browser is on, for the single-flight header; undefined outside a
 * page (no `location`), so no header is sent.
 */
function pageLocation(): string | undefined {
  const location: unknown = Reflect.get(globalThis, "location");
  const href = isRecord(location) ? Reflect.get(location, "href") : undefined;
  if (typeof href !== "string" || !URL.canParse(href)) return undefined;
  const url = new URL(href);
  return `${url.pathname}${url.search}`;
}

/**
 * Turns one decoded envelope into the call's outcome: the value, or the error to throw. A redirect
 * target must stay on the origin of the page; anything else is a protocol error.
 * @internal
 */
export function outcomeOf(envelope: RpcEnvelope, status: number): unknown {
  if ("redirect" in envelope) {
    const to = resolveSameOrigin(envelope.redirect.to, currentLocation());
    if (to === undefined) {
      throw new ServerFnProtocolError("the server redirected to another origin", status);
    }
    const code = envelope.redirect.status;
    throw redirect(to, { status: isRedirectStatus(code) ? code : 302 });
  }
  if (!envelope.ok) throw errorFor(envelope.error);
  return envelope.value;
}

/**
 * Decodes an answer body. A body that is not a server function answer is a protocol error; the text
 * of the response never enters the message.
 * @internal
 */
export function decodeBody(text: string, status: number): unknown {
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new ServerFnProtocolError("the answer is larger than the client accepts", status);
  }
  try {
    return deserialize(text);
  } catch (cause) {
    // The cause is attached for debugging; the response text is never copied into the message.
    throw new ServerFnProtocolError(
      `the answer is not a server function result (status ${status})`,
      status,
      cause,
    );
  }
}

/** The single-call request: the call's own endpoint, `POST` or `GET`. */
async function call(
  url: string,
  meta: ServerFnStubMeta,
  input: unknown,
  options: ServerFnCallOptions,
): Promise<unknown> {
  const body = serialize([input]);
  const headers = new Headers(options.headers);
  headers.set(RPC_HEADER, "1");
  applyDeploymentHeader(headers);
  if (meta.singleFlight === true && options.revalidate !== false) setLocation(headers);
  let target = url;
  const init: RequestInit = {
    method: meta.method,
    headers,
    credentials: "same-origin",
    // An RPC never follows a redirect on its own: redirects are answered as `{ redirect }`.
    redirect: "manual",
  };
  if (options.signal !== undefined) init.signal = options.signal;
  if (meta.method === "GET") {
    target = `${url}?p=${base64UrlEncode(new TextEncoder().encode(body))}`;
  } else {
    headers.set("content-type", "application/json");
    init.body = body;
  }
  const send = options.fetch ?? globalThis.fetch;
  return answer(await send(target, init));
}

/**
 * Turns the answer of a call into its outcome: the value, or the error or redirect to throw. A
 * single-flight answer applies its loader data before the outcome is returned.
 */
async function answer(response: Response): Promise<unknown> {
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new ServerFnProtocolError(
      "the server answered with a redirect instead of a result",
      response.status,
    );
  }
  if (response.status === 409) noteDeploymentMismatch();
  const envelope = asEnvelope(decodeBody(await response.text(), response.status));
  if (envelope === undefined) {
    throw new ServerFnProtocolError("the answer has an unknown shape", response.status);
  }
  if ("ok" in envelope && envelope.ok) {
    // A single-flight answer: the page is updated before the call resolves.
    if (envelope.revalidated !== undefined) await applyRevalidated(envelope.revalidated);
    return envelope.value;
  }
  return outcomeOf(envelope, response.status);
}

/**
 * Posts form data to a `form: true` function: the `FormData` is the body (files included), and the call
 * header asks the server for the envelope instead of the redirect a classic form post gets.
 */
async function postForm(
  url: string,
  meta: ServerFnStubMeta,
  data: FormData,
  options: ServerFnCallOptions,
): Promise<unknown> {
  const headers = new Headers(options.headers);
  headers.set(RPC_HEADER, "1");
  applyDeploymentHeader(headers);
  if (meta.singleFlight === true && options.revalidate !== false) setLocation(headers);
  const init: RequestInit = {
    method: "POST",
    headers,
    credentials: "same-origin",
    redirect: "manual",
    body: data,
  };
  if (options.signal !== undefined) init.signal = options.signal;
  const send = options.fetch ?? globalThis.fetch;
  return answer(await send(url, init));
}

/**
 * What a form needs from a server function stub: whether it takes form posts, whether it is single
 * flight, and how to post form data to it. `undefined` for anything that is not a stub.
 * @internal
 */
export interface StubInternals {
  /** `"POST"` or `"GET"`. */
  readonly method: "GET" | "POST";
  /** Whether the function accepts form posts (`form: true`). */
  readonly form: boolean;
  /** Whether the answer carries the refreshed loader data (single flight). */
  readonly singleFlight: boolean;
  /** Posts form data; resolves with the value (a `fail()` result included) or rejects with the error. */
  postForm(data: FormData, options: ServerFnCallOptions): Promise<unknown>;
}

/** The internals of each stub, by stub. A WeakMap: it goes with the stub. */
const internals = new WeakMap<object, StubInternals>();

/**
 * The internals of a server function stub, or `undefined` for any other value.
 * @internal
 */
export function stubInternals(value: unknown): StubInternals | undefined {
  return typeof value === "function" ? internals.get(value) : undefined;
}

/** Sets the single-flight header from the page the browser is on, when there is one. */
function setLocation(headers: Headers): void {
  const location = pageLocation();
  if (location !== undefined) headers.set(RPC_LOCATION_HEADER, location);
}

/** One call waiting in the batch queue. */
interface Queued {
  readonly id: string;
  readonly meta: ServerFnStubMeta;
  readonly input: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The batch queues, by mount base: the calls made since the last flush. A queue is created by its first
 * call and flushed in a microtask, so the calls of one synchronous run share a request. It is emptied at
 * every flush, so it holds only calls of the current tick.
 */
const queues = new Map<string, Queued[]>();

/** Queues a call and returns its outcome. */
function enqueue(base: string, item: Queued): void {
  const queue = queues.get(base);
  if (queue !== undefined) {
    queue.push(item);
    return;
  }
  queues.set(base, [item]);
  queueMicrotask(() => flush(base));
}

/** Sends the queue of a base: one call alone, or the chunks of a batch. */
function flush(base: string): void {
  const items = queues.get(base);
  queues.delete(base);
  if (items === undefined || items.length === 0) return;
  for (let start = 0; start < items.length; start += RPC_MAX_BATCH_CALLS) {
    const chunk = items.slice(start, start + RPC_MAX_BATCH_CALLS);
    const first = chunk[0];
    if (chunk.length === 1 && first !== undefined) {
      const url = `${base}${RPC_PREFIX}${first.id}`;
      call(url, first.meta, first.input, {}).then(first.resolve, first.reject);
    } else {
      void sendBatch(base, chunk);
    }
  }
}

/**
 * One batch request: the calls as `{ id, input }`, in order. The answer is an array of envelopes in the
 * same order; a batch-level refusal (CSRF, the call header, the size limit) is one envelope that applies
 * to every call of the batch.
 */
async function sendBatch(base: string, chunk: readonly Queued[]): Promise<void> {
  const url = `${base}${RPC_PREFIX}${RPC_BATCH_ID}`;
  const headers = new Headers({ [RPC_HEADER]: "1", "content-type": "application/json" });
  applyDeploymentHeader(headers);
  if (chunk.some((item) => item.meta.singleFlight === true)) setLocation(headers);
  let body: string;
  try {
    body = serialize(chunk.map((item) => ({ id: item.id, input: item.input })));
  } catch (error) {
    // A call whose input cannot be serialized (a function, a class instance) is that call's own failure, as it is when
    // the call travels alone; the others still go. Left to throw, this unawaited function would leave every call of the
    // chunk pending forever.
    const sound = chunk.filter((item) => {
      try {
        serialize([item.input]);
        return true;
      } catch (cause) {
        item.reject(cause);
        return false;
      }
    });
    if (sound.length === chunk.length) for (const item of chunk) item.reject(error);
    else if (sound.length > 0) await sendBatch(base, sound);
    return;
  }
  let response: Response;
  let text: string;
  try {
    response = await globalThis.fetch(url, {
      method: "POST",
      headers,
      credentials: "same-origin",
      redirect: "manual",
      body,
    });
    text = await response.text();
  } catch (error) {
    for (const item of chunk) item.reject(error);
    return;
  }
  if (response.status === 409) noteDeploymentMismatch();
  let decoded: unknown;
  try {
    decoded = decodeBody(text, response.status);
  } catch (error) {
    for (const item of chunk) item.reject(error);
    return;
  }
  const perCall = Array.isArray(decoded) && decoded.length === chunk.length;
  const single = perCall ? undefined : asEnvelope(decoded);
  if (!perCall && single === undefined) {
    const error = new ServerFnProtocolError("the answer has an unknown shape", response.status);
    for (const item of chunk) item.reject(error);
    return;
  }
  const envelopes: (RpcEnvelope | undefined)[] = perCall
    ? (decoded as unknown[]).map((entry) => asEnvelope(entry))
    : chunk.map(() => single);
  // The loader data of a single-flight batch is one payload: applied once, before any call resolves.
  const carried = envelopes.find(
    (envelope) =>
      envelope !== undefined &&
      "ok" in envelope &&
      envelope.ok === true &&
      envelope.revalidated !== undefined,
  );
  if (carried !== undefined && "ok" in carried && carried.ok === true) {
    await applyRevalidated(carried.revalidated);
  }
  chunk.forEach((item, index) => {
    const envelope = envelopes[index];
    if (envelope === undefined) {
      item.reject(new ServerFnProtocolError("the answer has an unknown shape", response.status));
      return;
    }
    try {
      item.resolve(outcomeOf(envelope, response.status));
    } catch (error) {
      item.reject(error);
    }
  });
}

/**
 * Creates the browser function that stands for a server function. The build calls this; you
 * rarely do.
 *
 * Arguments are encoded with `serialize` (dates, maps, sets, bigint and `undefined` survive;
 * functions and class instances, `Error` included, throw a `TypeError`). The answer is decoded the
 * same way. Failures do not travel as `Error` instances: the server sends the status, name and the
 * public message in the answer's `error` member, and the stub rebuilds the error from that. A
 * stack or a `cause` never crosses the wire, and in production the message of anything but a
 * client error (or an `HttpError` created with `expose: true`) is the standard reason phrase.
 *
 * @param id The stable id of the server function.
 * @param meta Method, form support, mount base, batching and single flight, all known at build time.
 * @returns A callable with `.id`, `.url` and `.with(options)`.
 * @throws HttpError for every `HttpError` the server function threw, with its `status`, and its
 *   `message` and `data` as the server allows (4xx: as thrown; 5xx: the reason phrase unless
 *   `expose: true`), and for a failed input validation (400, `data.issues`).
 * @throws ServerFnError for any other error on the server (status 500, `requestId`), an unknown
 *   method, or an aborted request.
 * @throws ServerFnProtocolError when the answer is not a server function answer.
 * @example
 * const getPost = serverFnStub("q3Zr0b1g2yTt0m5Qk9w3xA", { method: "GET", form: false, base: "" });
 * const post = await getPost({ id: "7" });
 * @since 1.0.0
 */
export function serverFnStub<Input = unknown, Output = unknown>(
  id: string,
  meta: ServerFnStubMeta,
): ClientServerFn<Input, Output> {
  const url = `${meta.base}${RPC_PREFIX}${id}`;
  const invoke = (input: unknown, options: ServerFnCallOptions): Promise<Output> => {
    const batchable =
      meta.method === "POST" &&
      meta.batch !== false &&
      options.signal === undefined &&
      options.headers === undefined &&
      options.fetch === undefined &&
      options.revalidate === undefined;
    if (!batchable) return call(url, meta, input, options) as Promise<Output>;
    return new Promise<unknown>((resolve, reject) => {
      enqueue(meta.base, { id, meta, input, resolve, reject });
    }) as Promise<Output>;
  };
  const stub = (
    ...input: [...CallArguments<Input>, options?: ServerFnCallOptions]
  ): Promise<Output> => invoke(input[0], callOptions(input[1]));
  internals.set(stub, {
    method: meta.method,
    form: meta.form,
    singleFlight: meta.singleFlight === true,
    postForm: (data, options) => postForm(url, meta, data, options),
  });
  return Object.assign(stub, {
    id,
    url,
    with(options: ServerFnCallOptions): (...input: CallArguments<Input>) => Promise<Output> {
      return (...input: CallArguments<Input>): Promise<Output> => invoke(input[0], options);
    },
  });
}
