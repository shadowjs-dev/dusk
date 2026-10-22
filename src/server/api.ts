import { HttpError } from "../internal/http-error";
import type { EventState } from "./event";
import { failureResponseFor } from "./failure";
import { guardList, runGuards } from "./guard";
import { json, readJson, readJsonLimited, text } from "./json";
import { BodyTooLargeError } from "./limits";
import { type InferOutput, isStandardSchema, type StandardSchemaV1 } from "./standard-schema";
import type {
  ApiHandler,
  ApiModule,
  ApiResult,
  Guard,
  HttpMethod,
  Middleware,
  RequestEvent,
} from "./types";
import { validate } from "./validate";

const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/** The handler keys of a module: the methods, and `ALL` (every method the module does not export by name). */
const HANDLER_KEYS: readonly string[] = [...METHODS, "ALL"];
const MODULE_KEYS: ReadonlySet<string> = new Set([...HANDLER_KEYS, "csrf", "middleware"]);

/**
 * Defines an API route module. It is an identity function with validation: it checks that every
 * key is an HTTP method (or `csrf` / `middleware`) and that handlers are functions, so a typo such
 * as `Get` fails at startup instead of answering 405 in production.
 *
 * @param module The methods of the route.
 * @returns The same module, frozen.
 * @throws TypeError for an unknown key or a non-function handler.
 * @example
 * export default apiRoute({
 *   GET: (event) => json({ id: event.params.id }),
 *   POST: (event) => json({ created: true }, { status: 201 }),
 * });
 * @since 1.0.0
 */
export function apiRoute<const M extends ApiModule>(module: M): Readonly<M> {
  for (const [key, value] of Object.entries(module)) {
    if (!MODULE_KEYS.has(key)) {
      throw new TypeError(
        `apiRoute: "${key}" is not an HTTP method. Use ${HANDLER_KEYS.join(", ")}.`,
      );
    }
    if (HANDLER_KEYS.includes(key) && typeof value !== "function") {
      throw new TypeError(`apiRoute: ${key} must be a function.`);
    }
  }
  return Object.freeze({ ...module });
}

/** What a validated API handler receives. @since 1.0.0 */
export interface ApiContext<Body, Query> {
  readonly event: RequestEvent;
  /** The parsed and validated JSON body (`undefined` when no `body` schema is given). */
  readonly body: Body;
  /** The validated query (`undefined` when no `query` schema is given). */
  readonly query: Query;
}

/** Options of {@link apiHandler}. @since 1.0.0 */
export interface ApiHandlerOptions<
  B extends StandardSchemaV1 | undefined,
  Q extends StandardSchemaV1 | undefined,
> {
  /** Schema of the JSON body. A missing or malformed body gives 400/415. */
  readonly body?: B;
  /** Schema of the query string (an object of strings; repeated keys become arrays). */
  readonly query?: Q;
  /** Middleware that wraps this handler only. */
  readonly middleware?: readonly Middleware[];
  /**
   * Guards that run before the body and the query are read or validated (see `serverFn`'s `guard`): a refused
   * request gets its status and the handler does not run.
   */
  readonly guard?: Guard | readonly Guard[];
  /**
   * Largest JSON body this handler reads, in bytes; larger gives 413 and the read stops at the bound. Default: the
   * app's `limits.maxBodyBytes`. Set it on a handler whose body is small when the app allows large bodies elsewhere
   * (uploads), so the handler does not buffer up to that limit.
   */
  readonly maxBodyBytes?: number;
  /**
   * The message of the 413 answer when the handler's body is larger than its limit (`maxBodyBytes`, or the app's), whether
   * the schema read it or the handler read it with `readJsonLimited` / `readFormLimited`. The answer is a 413 with the
   * API error shape, so the app needs no mapping of its own. Default: `Payload Too Large`.
   */
  readonly bodyTooLargeMessage?: string;
}

/**
 * Builds an API handler with validated input and a typed context.
 *
 * @param options Schemas and middleware.
 * @param handler Receives `{ event, body, query }`, all validated.
 * @returns An {@link ApiHandler} to use as `GET`, `POST`, ...
 * @throws ValidationError (status 400) from the handler call when input fails its schema.
 * @example
 * export const POST = apiHandler({ body: z.object({ title: z.string() }) }, ({ body }) => json(body, { status: 201 }));
 * @since 1.0.0
 */
export function apiHandler<
  B extends StandardSchemaV1 | undefined = undefined,
  Q extends StandardSchemaV1 | undefined = undefined,
>(
  options: ApiHandlerOptions<B, Q>,
  handler: (
    context: ApiContext<
      B extends StandardSchemaV1 ? InferOutput<B> : undefined,
      Q extends StandardSchemaV1 ? InferOutput<Q> : undefined
    >,
  ) => ApiResult | Promise<ApiResult>,
): ApiHandler {
  if (options.body !== undefined && !isStandardSchema(options.body)) {
    throw new TypeError("apiHandler: `body` must be a Standard Schema.");
  }
  if (options.query !== undefined && !isStandardSchema(options.query)) {
    throw new TypeError("apiHandler: `query` must be a Standard Schema.");
  }
  if (
    options.maxBodyBytes !== undefined &&
    !(Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes >= 0)
  ) {
    throw new TypeError("apiHandler: `maxBodyBytes` must be a finite number of at least 0.");
  }
  if (
    options.bodyTooLargeMessage !== undefined &&
    (typeof options.bodyTooLargeMessage !== "string" || options.bodyTooLargeMessage.trim() === "")
  ) {
    throw new TypeError("apiHandler: `bodyTooLargeMessage` must be a non-empty string.");
  }
  const tooLargeMessage = options.bodyTooLargeMessage;
  const guards = guardList(options.guard, "apiHandler({ guard })");
  const run = async (event: RequestEvent): Promise<ApiResult> => {
    if (guards.length > 0) await runGuards(guards, event);
    const body =
      options.body === undefined
        ? undefined
        : await validate(
            options.body,
            options.maxBodyBytes === undefined
              ? await readJson(event.request)
              : await readJsonLimited(event.request, options.maxBodyBytes),
          );
    const query =
      options.query === undefined
        ? undefined
        : await validate(options.query, queryObject(event.url));
    // The conditional types above resolve to the schema output or `undefined`, exactly what was computed.
    return handler({ event, body, query } as Parameters<typeof handler>[0]);
  };
  const inner: ApiHandler = async (event) => {
    try {
      return await run(event);
    } catch (error) {
      // A body over the limit, read by the schema or by the handler: the configured 413 (the default is the framework's).
      if (tooLargeMessage !== undefined && error instanceof BodyTooLargeError) {
        throw new HttpError(413, tooLargeMessage, { cause: error });
      }
      throw error;
    }
  };
  const middleware = options.middleware ?? [];
  const answer: ApiHandler =
    middleware.length === 0
      ? inner
      : async (event) => {
          const response = await runMiddleware(middleware, event, async () =>
            toResponse(await inner(event)),
          );
          return response;
        };
  if (options.maxBodyBytes !== undefined) bodyLimits.set(answer, options.maxBodyBytes);
  return answer;
}

/** The `maxBodyBytes` each `apiHandler` was built with, keyed by the handler. @internal */
const bodyLimits = new WeakMap<ApiHandler, number>();

/**
 * The body limit a route declares for a method: the `maxBodyBytes` of the handler that would answer it (its own, `ALL`,
 * or `GET` for `HEAD`), or `undefined` when that handler does not declare one. Used by the handler before the route runs.
 *
 * @internal
 */
export function bodyLimitOf(module: ApiModule, method: string): number | undefined {
  const known = (METHODS as readonly string[]).includes(method);
  const own = known ? module[method as HttpMethod] : undefined;
  const handler: ApiHandler | undefined = !known
    ? undefined
    : (own ?? module.ALL ?? (method === "HEAD" ? module.GET : undefined));
  return handler === undefined ? undefined : bodyLimits.get(handler);
}

function queryObject(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const existing = result[key];
    if (existing === undefined) result[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[key] = [existing, value];
  }
  return result;
}

/**
 * Runs a middleware list around `final`.
 *
 * `next()` always settles with a `Response`: whatever the rest of the chain throws (a route error,
 * an `HttpError`, a redirect, a validation failure, an error of an inner middleware) is turned into
 * the response the client would get, so an outer middleware can set headers on it, log its status or
 * replace it. A middleware that wants the failure to propagate throws its own error. Calling `next`
 * twice is a programming error and stays a rejection. Outside a request (an event built by hand)
 * there is no failure mapper and errors propagate unchanged.
 *
 * @internal
 */
export async function runMiddleware(
  chain: readonly Middleware[],
  event: RequestEvent,
  final: () => Promise<Response>,
): Promise<Response> {
  let called = -1;
  // async: a middleware that throws synchronously rejects instead of unwinding through `next()`.
  const dispatch = async (index: number): Promise<Response> => {
    called = index;
    const middleware = chain[index];
    if (middleware === undefined) return final();
    return middleware(event, () => {
      if (index + 1 <= called) {
        return Promise.reject(
          new Error("MIDDLEWARE_NEXT_TWICE: next() was called more than once."),
        );
      }
      return settle(event, dispatch(index + 1));
    });
  };
  return dispatch(0);
}

/** Awaits `pending`; a rejection becomes the failure response of the request, when there is a mapper. */
async function settle(event: RequestEvent, pending: Promise<Response>): Promise<Response> {
  try {
    return await pending;
  } catch (thrown) {
    const response = failureResponseFor(event, thrown);
    if (response === undefined) throw thrown;
    return response;
  }
}

/** Turns a handler result into a response. @internal */
export function toResponse(result: ApiResult): Response {
  if (result instanceof Response) return result;
  if (result === undefined || result === null) return new Response(null, { status: 204 });
  if (typeof result === "string") return text(result);
  // A stream is sent chunk by chunk, not serialized as JSON (use a Response to set its status or headers).
  if (result instanceof ReadableStream) return new Response(result);
  return json(result);
}

/**
 * True when an API module answers the method: its own handler, `HEAD` through `GET`, or `OPTIONS` (always). The
 * handler's precedence rule uses it to tell two routes of one path apart by the method.
 *
 * @internal
 */
export function answersMethod(module: ApiModule, method: string): boolean {
  return (allowedMethods(module) as string[]).includes(method);
}

/**
 * The methods a module answers, with the implied `HEAD` and `OPTIONS`. A module with `ALL` answers every method (the
 * explicit exports win over it, but the set is the same).
 *
 * @internal
 */
export function allowedMethods(module: ApiModule): HttpMethod[] {
  if (typeof module.ALL === "function") return [...METHODS];
  const allowed = new Set<HttpMethod>();
  for (const method of METHODS) {
    if (typeof module[method] === "function") allowed.add(method);
  }
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return METHODS.filter((method) => allowed.has(method));
}

/**
 * The `Allow` value of a set of methods: the canonical order, each once.
 *
 * @example allowOf(["OPTIONS", "GET", "HEAD"]); // "GET, HEAD, OPTIONS"
 * @internal
 */
export function allowOf(methods: readonly string[]): string {
  return METHODS.filter((method) => methods.includes(method)).join(", ");
}

/**
 * Dispatches a request to an API module: the method's handler, then `ALL` (when the module has it), `HEAD` answered by
 * `GET` without a body, `OPTIONS` answered with `Allow` when not handled, anything else 405 with `Allow`. The `Allow`
 * list is the module's methods plus `extra` (the methods of the other routes on the same path).
 *
 * @param event The request event.
 * @param module The route module.
 * @param extra Methods of the other candidates on the path, added to `Allow`.
 * @returns The response.
 * @internal
 */
export async function dispatchApi(
  event: EventState,
  module: ApiModule,
  extra: readonly string[] = [],
): Promise<Response> {
  const method = event.method;
  const allow = allowOf([...allowedMethods(module), ...extra]);
  const known = (METHODS as readonly string[]).includes(method);
  const own = known ? module[method as HttpMethod] : undefined;
  const handler: ApiHandler | undefined = !known
    ? undefined
    : (own ?? module.ALL ?? (method === "HEAD" ? module.GET : undefined));
  if (handler === undefined) {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow } });
    throw new HttpError(405, "Method Not Allowed", { headers: { allow } });
  }
  const response = await runMiddleware(module.middleware ?? [], event, async () =>
    toResponse(await handler(event)),
  );
  if (method === "HEAD") {
    await response.body?.cancel();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}
