import { createMemoryHistory, createRouter, type HydrationData } from "@shadow-js/router";
import { deserialize, serialize } from "@shadow-js/web/server";
import { base64UrlDecode } from "../internal/encoding";
import { HttpError } from "../internal/http-error";
import { isRedirect, redirectStatus } from "../internal/redirect";
import { hasControl } from "../internal/text";
import type { FlashPayload, WireError } from "../shared/action";
import { RPC_BATCH_ID, RPC_LOCATION_HEADER } from "../shared/wire";
import { cacheControlHeader, resolveCacheControl } from "./cache-control";
import { runWithEvent } from "./context";
import { checkDeploymentHeader, deploymentMismatchEnvelope } from "./deployment";
import { describeError, type ErrorDescription, errorBody } from "./errors";
import { EventState } from "./event";
import { missingFeature } from "./features";
import { isNoSecrets, writeFlash } from "./flash";
import { formDataOf } from "./form";
import { formToObject, isJsonContentType } from "./json";
import { refuseDeclaredLength } from "./limits";
import { chargeBatchCalls, chargeServerFnCall } from "./rate-limit";
import { checkRedirectTarget } from "./redirect-target";
import type { RpcRuntime } from "./runtime";
import { executeServerFn, isServerFnDefinition } from "./server-fn";
import type { ServerFnDefinition } from "./types";

/** Path (below the base) under which server functions are served. @since 1.0.0 */
export const RPC_PREFIX = "/_dusk/fn/";

/** The request header every client call must send. @since 1.0.0 */
export const RPC_HEADER = "x-dusk-fn";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();
/** Longest location the single-flight header may carry, in characters. */
const LOCATION_LIMIT = 2048;

/** The wire envelope of one answer (a call's answer, or one entry of a batch). */
type Envelope =
  | { readonly ok: true; readonly value: unknown; readonly revalidated?: HydrationData }
  | { readonly ok: false; readonly error: ReturnType<typeof errorBody> }
  | { readonly redirect: { readonly to: string; readonly status: number } };

/** What a failure becomes: the envelope, and the status and headers of a single-call answer. */
interface Failure {
  readonly envelope: Envelope;
  readonly status: number;
  readonly headers: HeadersInit | undefined;
}

/** Builds the response of an RPC call. Always `no-store`, never sniffable. */
function envelopeResponse(envelope: Envelope, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(serialize(envelope), { status, headers });
}

/** The answer for an unknown id, a malformed id and a known id of another build: identical. */
function notFoundEnvelope(event: EventState): Envelope {
  return {
    ok: false,
    error: { name: "NotFound", message: "Not Found", status: 404, requestId: event.id },
  };
}

/** Maps anything thrown on the RPC path to an envelope and the status it answers with. */
function failureOf(rt: RpcRuntime, event: EventState, thrown: unknown): Failure {
  let error = thrown;
  if (isRedirect(thrown)) {
    const to = checkRedirectTarget(thrown.to, rt.policyFor(event));
    if (typeof to === "string") {
      return {
        envelope: { redirect: { to, status: redirectStatus(thrown) } },
        status: 200,
        headers: undefined,
      };
    }
    // A blocked target is a bug in the app (or an open-redirect attempt): report it, answer 500.
    error = to;
  }
  const description = describeError(error, event.dev);
  if (description.report) rt.report(error, "rpc", event);
  return {
    envelope: { ok: false, error: errorBody(description, event.id) },
    status: description.status,
    headers: description.headers,
  };
}

/**
 * Maps anything thrown on the RPC path to its envelope response: a redirect, or an error with the
 * status mirrored. Also used for failures before the endpoint runs (CSRF, middleware), so a client
 * always gets the wire format.
 *
 * @internal
 */
export function rpcFailure(rt: RpcRuntime, event: EventState, thrown: unknown): Response {
  const failure = failureOf(rt, event, thrown);
  return envelopeResponse(failure.envelope, failure.status, failure.headers);
}

/** Reads the call input from a POST body or the `p` query of a GET. */
async function readInput(rt: RpcRuntime, event: EventState): Promise<unknown> {
  let text: string;
  if (event.method === "GET") {
    const payload = event.url.searchParams.get("p");
    if (payload === null) return undefined;
    if (payload.length > rt.config.rpc.maxGetPayloadChars) {
      throw new HttpError(414, "Payload too long");
    }
    const bytes = base64UrlDecode(payload);
    if (bytes === undefined) throw new HttpError(400, "Malformed request");
    text = new TextDecoder().decode(bytes);
  } else {
    text = await event.request.text();
  }
  let decoded: unknown;
  try {
    decoded = deserialize(text);
  } catch (cause) {
    throw new HttpError(400, "Malformed request", { cause });
  }
  if (!Array.isArray(decoded) || decoded.length > 1) throw new HttpError(400, "Malformed request");
  return decoded[0];
}

const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];

function isFormRequest(event: EventState): boolean {
  const type = (event.request.headers.get("content-type") ?? "").toLowerCase();
  return FORM_TYPES.some((form) => type.startsWith(form));
}

/**
 * The page a classic form post goes back to: the referring page of this origin, else the app's root.
 * Answered with 303, so the browser makes a GET of it (post, redirect, get).
 */
function backResponse(rt: RpcRuntime, event: EventState, headers: Headers): Response {
  const referer = event.request.headers.get("referer");
  let back = rt.config.base === "" ? "/" : rt.config.base;
  if (referer !== null && URL.canParse(referer)) {
    const url = new URL(referer);
    // The referer's path is checked like any redirect target: "https://app//evil.example" has the path "//evil.example".
    const checked =
      url.origin === event.url.origin
        ? checkRedirectTarget(`${url.pathname}${url.search}`, rt.policyFor(event))
        : undefined;
    if (typeof checked === "string") back = checked;
  }
  headers.set("location", back);
  return new Response(null, { status: 303, headers });
}

/** The error of a failed submission as the flash keeps it: status, public message, problems, data. */
function wireErrorOf(description: ErrorDescription): WireError {
  const issues = description.issues?.map((issue) => ({
    message: issue.message,
    path: [...issue.path],
  }));
  return {
    status: description.status,
    message: description.message,
    ...(issues === undefined ? {} : { issues }),
    ...(description.data === undefined ? {} : { data: description.data }),
  };
}

/**
 * Answer to a classic form post. With cookie secrets the outcome goes into the one-time flash and the
 * browser is sent back to the page, which renders the outcome (post, redirect, get). Without secrets
 * a success is the plain 303 and an error is `text/plain` with its status (nothing can be carried).
 * A redirect thrown by the function goes to its target.
 */
async function formResponse(
  rt: RpcRuntime,
  event: EventState,
  outcome: { error: unknown } | { value: unknown },
  key: string,
): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store" });
  // A flash needs cookie secrets; without them the flash is not written and the classic answer is given.
  const carry = async (patch: FlashPayload): Promise<boolean> => {
    try {
      await writeFlash(event, patch);
      return true;
    } catch (error) {
      if (isNoSecrets(error)) return false;
      throw error;
    }
  };
  if ("error" in outcome) {
    const error = outcome.error;
    const to = isRedirect(error) ? checkRedirectTarget(error.to, rt.policyFor(event)) : undefined;
    if (isRedirect(error) && typeof to === "string") {
      headers.set("location", to.startsWith("/") ? `${rt.config.base}${to}` : to);
      return new Response(null, {
        status: redirectStatus(error) === 302 ? 303 : redirectStatus(error),
        headers,
      });
    }
    const reported = to === undefined ? error : to;
    const description = describeError(reported, event.dev);
    if (description.report) rt.report(reported, "rpc", event);
    if (await carry({ submission: { key, status: "error", error: wireErrorOf(description) } })) {
      return backResponse(rt, event, headers);
    }
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(description.message, { status: description.status, headers });
  }
  await carry({ submission: { key, status: "success", value: outcome.value } });
  return backResponse(rt, event, headers);
}

/**
 * The loader data of the page the browser is on, computed on the server for a single-flight answer:
 * the router runs the matched loaders for the location the browser sent, under the same request (so
 * the same cookies and middleware-set context), and its dehydrated data is returned. Nothing is sent
 * when the location is not a same-origin path, when the page redirects or fails, or when the data
 * would exceed the hydration payload limit: the browser then loads the page as it would without
 * single flight.
 *
 * @internal
 */
export async function revalidatedFor(
  rt: RpcRuntime,
  event: EventState,
): Promise<HydrationData | undefined> {
  // Single flight refreshes the loaders of the page routes: without the pages feature there are none to run.
  const routes = rt.pageRoutes;
  if (routes === undefined) {
    throw missingFeature("pages", "a single-flight server function");
  }
  const raw = event.request.headers.get(RPC_LOCATION_HEADER);
  if (
    raw === null ||
    raw.length > LOCATION_LIMIT ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    hasControl(raw)
  ) {
    return undefined;
  }
  // The loaders of the page see the page's URL and the request's headers (cookies, authorization).
  const url = new URL(raw, event.url.origin);
  // "/\\host" is read as "//host" by the URL parser: a location of another origin gets no loader run.
  if (url.origin !== event.url.origin) return undefined;
  const page = new EventState({
    request: new Request(url, { headers: event.request.headers }),
    url,
    signal: event.signal,
    id: event.id,
    nonce: undefined,
    signer: rt.config.signer,
    secureCookies: true,
    env: event.env,
    platform: event.platform,
    clientAddress: event.clientAddress,
    dev: event.dev,
    lang: rt.config.document.lang,
  });
  const router = createRouter({
    routes,
    // The same router features as a page render of these routes (see `PageRuntime.routerFeatures`).
    features: rt.routerFeatures ?? [],
    history: createMemoryHistory({ initialEntries: [raw] }),
    base: rt.config.base,
    trailingSlash: rt.config.trailingSlash,
    caseSensitive: rt.config.manifest.caseSensitive === true,
    // The location is the one the browser shows: a private route is not part of it.
    visibility: "public",
    context: { event: page },
    maxRedirects: 1,
    onError: (error) => rt.report(error, "loader", page),
  });
  try {
    const outcome = await runWithEvent(page, () => router.ready(), rt.config.asyncContext);
    if (outcome.kind !== "success") return undefined;
    const data = router.dehydrate();
    return encoder.encode(serialize(data)).byteLength <= rt.config.maxPayloadBytes
      ? data
      : undefined;
  } catch (error) {
    rt.report(error, "rpc", event);
    return undefined;
  } finally {
    router.dispose();
  }
}

/**
 * Answers a server function call: `POST {base}/_dusk/fn/<id>` (or GET for `method: "GET"`
 * functions). Checks run in a fixed order, each before the next costs anything: the id, the
 * method (405 before the body is read), the call headers, the body size, the decoding, the
 * schema, the middleware, the handler.
 *
 * @param rt Shared runtime.
 * @param event The request event.
 * @param id The id taken from the path (`_batch` for the batch endpoint).
 * @returns The envelope response.
 * @internal
 */
export async function handleRpc(
  rt: RpcRuntime,
  event: EventState,
  id: string,
  stream?: (definition: ServerFnDefinition, event: EventState, input: unknown) => Promise<Response>,
): Promise<Response> {
  if (id === RPC_BATCH_ID) return handleBatch(rt, event);
  const { serverFns } = rt.config.manifest;
  if (!ID.test(id) || !Object.hasOwn(serverFns, id))
    return envelopeResponse(notFoundEnvelope(event), 404);
  const entry = serverFns[id];
  if (entry === undefined) return envelopeResponse(notFoundEnvelope(event), 404);
  let definition: ServerFnDefinition;
  try {
    const loaded: unknown = await entry.load();
    if (!isServerFnDefinition(loaded))
      throw new TypeError(`server function "${id}" is not a serverFn() result.`);
    definition = loaded;
  } catch (error) {
    rt.report(error, "rpc", event);
    return envelopeResponse(
      { ok: false, error: errorBody(describeError(new Error("load failed"), false), event.id) },
      500,
    );
  }
  if (event.method !== definition.method) {
    return envelopeResponse(
      {
        ok: false,
        error: {
          name: "MethodNotAllowed",
          message: "Method Not Allowed",
          status: 405,
          requestId: event.id,
        },
      },
      405,
      new Headers({ allow: definition.method }),
    );
  }
  // A client from another deployment is told to reload before its call runs (see `deployment.ts`).
  if (!checkDeploymentHeader(event.request, rt.config.deploymentId)) {
    return envelopeResponse(deploymentMismatchEnvelope(event.id), 409);
  }
  const form = definition.form && event.method === "POST" && isFormRequest(event);
  // A form post from a browser script carries the call header and wants the envelope back; a post made
  // by the browser itself (no script) is the classic one that answers with a redirect.
  const classic = form && event.request.headers.get(RPC_HEADER) !== "1";
  // The function's own body limit (`serverFn({ maxBodyBytes })`), or the app's. Set before any byte is read; a declared
  // length over it is refused here, as an envelope, before the rate limit is charged.
  event.bodyCap.limit =
    definition.maxBodyBytes === undefined
      ? rt.config.limits.maxBodyBytes
      : Math.min(definition.maxBodyBytes, rt.config.limits.maxRouteBodyBytes);
  try {
    refuseDeclaredLength(event.request.headers, event.bodyCap.limit);
    if (!form) {
      if (event.request.headers.get(RPC_HEADER) !== "1") {
        throw new HttpError(400, `Missing ${RPC_HEADER} header`);
      }
      if (
        event.method === "POST" &&
        !isJsonContentType(event.request.headers.get("content-type"))
      ) {
        throw new HttpError(415, "Expected application/json");
      }
    }
    // The function's own rate limit is charged before the body is read: a call without a token costs nothing more.
    if (definition.rateLimit !== undefined) {
      const headers = await chargeServerFnCall(definition.rateLimit, id, event);
      for (const [name, value] of Object.entries(headers)) event.responseHeaders.set(name, value);
    }
    const input = form ? formToObject(await formDataOf(event.request)) : await readInput(rt, event);
    if (definition.stream === true) {
      if (stream === undefined) throw new TypeError("typed streams need rpc({ streams: {} }).");
      return await stream(definition, event, input);
    }
    const value = await executeServerFn(definition, input, event);
    if (classic) return await formResponse(rt, event, { value }, id);
    const revalidated =
      definition.singleFlight === true ? await revalidatedFor(rt, event) : undefined;
    const body = serialize(
      revalidated === undefined ? { ok: true, value } : { ok: true, value, revalidated },
    );
    if (encoder.encode(body).byteLength > rt.config.rpc.maxResponseBytes) {
      throw new Error("SERVER_FN_RESPONSE_TOO_LARGE");
    }
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    // The function may name its cache-control (`serverFn({ cacheControl })`); errors below stay no-store.
    const control = cacheControlHeader(
      resolveCacheControl(definition.cacheControl, definition.method, rt.config.cacheLife),
      event.request,
    );
    headers.set("cache-control", control.value);
    if (control.vary !== undefined) headers.set("vary", control.vary);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    return classic ? await formResponse(rt, event, { error }, id) : rpcFailure(rt, event, error);
  }
}

/** Reads one call of a batch: `{ id, input }`. Anything else is a malformed request. */
function batchCallOf(value: unknown): { readonly id: string; readonly input: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Malformed request");
  }
  const id: unknown = Reflect.get(value, "id");
  if (typeof id !== "string") throw new HttpError(400, "Malformed request");
  return { id, input: Reflect.get(value, "input") };
}

/**
 * Runs one call of a batch. The call has the same checks and middleware as a single call; its
 * failure becomes its own envelope, so the other calls of the batch are not affected.
 */
async function runBatchCall(
  rt: RpcRuntime,
  event: EventState,
  call: { readonly id: string; readonly input: unknown },
): Promise<{ readonly envelope: Envelope; readonly singleFlight: boolean }> {
  const { serverFns } = rt.config.manifest;
  const none = { singleFlight: false } as const;
  if (!ID.test(call.id) || !Object.hasOwn(serverFns, call.id)) {
    return { envelope: notFoundEnvelope(event), ...none };
  }
  const entry = serverFns[call.id];
  if (entry === undefined) return { envelope: notFoundEnvelope(event), ...none };
  let definition: ServerFnDefinition;
  try {
    const loaded: unknown = await entry.load();
    if (!isServerFnDefinition(loaded))
      throw new TypeError(`server function "${call.id}" is not a serverFn() result.`);
    definition = loaded;
  } catch (error) {
    rt.report(error, "rpc", event);
    return {
      envelope: {
        ok: false,
        error: errorBody(describeError(new Error("load failed"), false), event.id),
      },
      ...none,
    };
  }
  // The batch endpoint is a POST: a GET function cannot be batched (the browser never sends one).
  if (definition.method !== "POST") {
    return {
      envelope: {
        ok: false,
        error: {
          name: "MethodNotAllowed",
          message: "Method Not Allowed",
          status: 405,
          requestId: event.id,
        },
      },
      ...none,
    };
  }
  try {
    // Each call of the batch takes its own token from the function's bucket, as a single call would.
    if (definition.stream === true)
      throw new HttpError(400, "Streaming functions cannot be batched");
    if (definition.rateLimit !== undefined) {
      await chargeServerFnCall(definition.rateLimit, call.id, event);
    }
    const value = await executeServerFn(definition, call.input, event);
    return { envelope: { ok: true, value }, singleFlight: definition.singleFlight === true };
  } catch (error) {
    return { envelope: failureOf(rt, event, error).envelope, ...none };
  }
}

/**
 * The batch endpoint, `POST {base}/_dusk/fn/_batch`: a JSON array of `{ id, input }`, answered with
 * an array of envelopes in the same order. Each call runs as a single call would (its own schema,
 * middleware, errors and redirects); the request-level checks (CSRF, the call header, the body size)
 * run once for the batch. A single-flight call makes the batch carry the loader data of the page once,
 * after every call ran. The envelopes share one response budget (`rpc.maxResponseBytes`): a call whose
 * answer would exceed what is left answers `SERVER_FN_RESPONSE_TOO_LARGE`.
 *
 * @internal
 */
export async function handleBatch(rt: RpcRuntime, event: EventState): Promise<Response> {
  if (event.method !== "POST")
    throw new HttpError(405, "Method Not Allowed", { headers: { allow: "POST" } });
  if (event.request.headers.get(RPC_HEADER) !== "1") {
    throw new HttpError(400, `Missing ${RPC_HEADER} header`);
  }
  if (!isJsonContentType(event.request.headers.get("content-type"))) {
    throw new HttpError(415, "Expected application/json");
  }
  if (!checkDeploymentHeader(event.request, rt.config.deploymentId)) {
    return envelopeResponse(deploymentMismatchEnvelope(event.id), 409);
  }
  // The app's limit (a batch is not raised by a call's own limit). The read is outside the parse: a body over the limit
  // keeps its 413 (BodyTooLargeError), it is not a malformed batch.
  refuseDeclaredLength(event.request.headers, event.bodyCap.limit);
  const text = await event.request.text();
  let decoded: unknown;
  try {
    decoded = deserialize(text);
  } catch (cause) {
    throw new HttpError(400, "Malformed request", { cause });
  }
  if (!Array.isArray(decoded)) throw new HttpError(400, "Malformed request");
  if (decoded.length > rt.config.rpc.maxBatchSize) {
    throw new HttpError(413, "Too many calls in one batch");
  }
  const calls = decoded.map(batchCallOf);
  // A rate limit middleware charged the request as one call: the others are charged now, before any call runs.
  await chargeBatchCalls(event, calls.length);
  const results: { envelope: Envelope; singleFlight: boolean }[] = [];
  for (const call of calls) results.push(await runBatchCall(rt, event, call));

  if (
    results.some((result) => result.singleFlight && "ok" in result.envelope && result.envelope.ok)
  ) {
    const revalidated = await revalidatedFor(rt, event);
    if (revalidated !== undefined) {
      for (const result of results) {
        const { envelope } = result;
        if (result.singleFlight && "ok" in envelope && envelope.ok) {
          result.envelope = { ok: true, value: envelope.value, revalidated };
        }
      }
    }
  }

  let budget = rt.config.rpc.maxResponseBytes;
  const answers: Envelope[] = [];
  for (const { envelope } of results) {
    let bytes = encoder.encode(serialize(envelope)).byteLength;
    let settled = envelope;
    if (bytes > budget) {
      settled = {
        ok: false,
        error: {
          name: "ResponseTooLarge",
          message: "Response too large",
          status: 500,
          requestId: event.id,
        },
      };
      bytes = encoder.encode(serialize(settled)).byteLength;
    }
    budget -= bytes;
    answers.push(settled);
  }
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  return new Response(serialize(answers), { status: 200, headers });
}
