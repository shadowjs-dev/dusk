import type { CallArguments } from "../shared/call-arguments";
import type { ServerFnCallOptions } from "../shared/call-options";
import { RPC_PREFIX } from "../shared/wire";
import { type CacheControlOption, resolveCacheControl } from "./cache-control";
import { DuskError, getRequestEvent } from "./context";
import { guardList, runGuards } from "./guard";
import { normalizeServerFnRateLimit, type ServerFnRateLimitOption } from "./rate-limit-option";
import {
  type InferInput,
  type InferOutput,
  isStandardSchema,
  type StandardSchemaV1,
} from "./standard-schema";
import type { Guard, RequestEvent, ServerFnDefinition, ServerFnMiddleware } from "./types";
import { validate } from "./validate";

/** Options of {@link serverFn}. @since 1.0.0 */
export interface ServerFnOptions {
  /** `"POST"` (default) for anything that changes state. `"GET"` only for safe, idempotent reads. */
  readonly method?: "GET" | "POST";
  /** Input schema (any Standard Schema). Without one the input is untrusted `unknown`. */
  readonly input?: StandardSchemaV1;
  /** Middleware, outermost first; for example an authorization check. */
  readonly middleware?: readonly ServerFnMiddleware[];
  /** Also accept HTML form posts (`application/x-www-form-urlencoded` or multipart) for progressive enhancement. */
  readonly form?: boolean;
  /**
   * Whether browser calls may be sent in a batch with the calls of the same tick (one request for many
   * calls). Default `true`; `false` sends each call alone. Read by the build for the browser stub.
   */
  readonly batch?: boolean;
  /**
   * A mutation that also answers with the refreshed loader data of the page the browser is on, so the
   * router applies it without a second request. Read at run time. Default `false`.
   */
  readonly singleFlight?: boolean;
  /**
   * Guards that run before the input is validated and before the middleware and the handler: a
   * refused call never reaches its handler. One guard or an array (see `all`, `any`, `defineGuard`).
   * Guards see the request, not the input. A guard that returns `false` gives 403; a throw keeps its
   * status (an `HttpError` 401, 403, ...).
   */
  readonly guard?: Guard | readonly Guard[];
  /**
   * The `cache-control` of a successful answer. Default `no-store`. `public` is for GET functions only and is
   * private for a request that carries cookies or authorization. Errors are never cached.
   */
  readonly cacheControl?: CacheControlOption;
  /**
   * Rate limit for the calls that reach this function over HTTP, one token per call, whether the call
   * came alone or inside a batch (a batch of 25 calls takes 25 tokens). The bucket is per function and per
   * caller (the client address, or `key`); a call without a token is refused with the 429 of the rate limit
   * middleware (`retry-after`, `ratelimit-*`), and in a batch only that call is refused. A limiter, or
   * `{ limiter, key, cost }`. Calls from server code (`fn()`, `fn.invoke()`) are not charged.
   */
  readonly rateLimit?: ServerFnRateLimitOption;
  /**
   * The largest request body a call of this function reads, in bytes. Default: the app's `security.limits.maxBodyBytes`.
   * A larger value raises the limit for this function only, up to `security.limits.maxRouteBodyBytes`; a smaller one lowers
   * it. A call over the limit is a 413 with the JSON error envelope, and the function does not run. A batch call is bounded
   * by the app's limit, not by this one (call the function alone for a larger body).
   */
  readonly maxBodyBytes?: number;
}

export type { CallArguments };

/** Options of an AsyncIterable server function; streaming excludes forms, batches and cached answers. @since 1.0.0 */
export interface StreamingServerFnOptions
  extends Omit<ServerFnOptions, "form" | "batch" | "singleFlight" | "cacheControl"> {
  /** Opt in to typed SSE delivery through `rpc({ streams: {} })`. */
  readonly stream: true;
  /** Streaming answers cannot be consumed by progressive form posts. */
  readonly form?: false;
  /** A stream owns one request and cannot share a batch. */
  readonly batch?: false;
  /** Streaming answers cannot refresh page loaders. */
  readonly singleFlight?: false;
  /** A stream is always private and uncached. */
  readonly cacheControl?: never;
}

/**
 * A server function: callable on the server like a normal async function, and callable from the
 * client through the RPC endpoint once the build registers it.
 * @since 1.0.0
 */
export interface ServerFn<Input, Output, Parsed = Input>
  extends ServerFnDefinition<Parsed, Output> {
  /**
   * Calls the function inside the current request (validation and middleware run). The input is
   * optional when its type allows `undefined` (no schema, or a schema of an optional value).
   */
  (...input: [...CallArguments<Input>, options?: ServerFnCallOptions]): Promise<Output>;
  /**
   * The same call with options, as on the browser stub. On the server the options are ignored (a
   * direct call has no network and runs in the current request); the signature exists so code that
   * runs on both sides, such as a component, type-checks against this definition.
   */
  with(options: ServerFnCallOptions): (...input: CallArguments<Input>) => Promise<Output>;
  /** Calls the function with an explicit event, where `getRequestEvent()` is unavailable. */
  invoke(input: Input, event: RequestEvent): Promise<Output>;
  /**
   * The stable id the build gave the function: the same one its browser stub has.
   * @throws DuskError `SERVER_FN_NOT_BUILT` when read on a function the build did not process
   *   (a unit test that imports the module without `dusk()`).
   */
  readonly id: string;
  /**
   * The endpoint, for example `/_dusk/fn/q3Zr…`: the `action` of a `<form>` for a function
   * defined with `form: true`. Rendered on the server it equals the browser stub's `url`.
   * @throws DuskError `SERVER_FN_NOT_BUILT` as {@link ServerFn.id}.
   */
  readonly url: string;
}

const METHODS: ReadonlySet<string> = new Set(["GET", "POST"]);

/**
 * Runs a server function definition: validation, middleware, then the handler. Used by the RPC
 * endpoint and by direct calls, so both take the same path.
 *
 * @param definition The function.
 * @param raw The untrusted input.
 * @param event The request event.
 * @returns The handler's result.
 * @throws ValidationError for input that fails the schema; whatever the middleware or handler throw.
 * @example
 * const value = await executeServerFn(definition, { title: "x" }, event);
 * @since 1.0.0
 */
export async function executeServerFn(
  definition: ServerFnDefinition,
  raw: unknown,
  event: RequestEvent,
): Promise<unknown> {
  // Guards first: a refused call is not validated, and its handler and middleware never run.
  if (definition.guard !== undefined && definition.guard.length > 0) {
    await runGuards(definition.guard, event);
  }
  const input = definition.input === undefined ? raw : await validate(definition.input, raw);
  const chain = definition.middleware;
  let called = -1;
  const dispatch = (index: number): Promise<unknown> => {
    if (index <= called) {
      return Promise.reject(
        new DuskError("MIDDLEWARE_NEXT_TWICE", "next() was called more than once."),
      );
    }
    called = index;
    const middleware = chain[index];
    // The input is what the function's schema accepted, or the untrusted `unknown` of a function
    // without one. The erased definition takes `unknown` for that reason, so no cast is needed.
    if (middleware === undefined) return Promise.resolve(definition.handler(input, event));
    return Promise.resolve(middleware({ event, input }, () => dispatch(index + 1)));
  };
  return dispatch(0);
}

/** True when a loaded module value has the shape of a server function definition. @internal */
export function isServerFnDefinition(value: unknown): value is ServerFnDefinition {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return false;
  const method: unknown = Reflect.get(value, "method");
  return (
    typeof method === "string" &&
    METHODS.has(method) &&
    typeof Reflect.get(value, "handler") === "function" &&
    Array.isArray(Reflect.get(value, "middleware"))
  );
}

/**
 * Defines a server function. The handler runs only on the server and receives the validated
 * input and the request event. In a client bundle the build replaces it with a stub that calls
 * the RPC endpoint (`POST /_dusk/fn/<id>`).
 *
 * @param options Method, input schema, middleware.
 * @param handler The server-side implementation.
 * @returns A callable server function.
 * @throws TypeError for an invalid method, schema or middleware list.
 * @example
 * export const addTodo = serverFn(
 *   { input: z.object({ title: z.string().min(1) }), middleware: [requireUser] },
 *   async ({ title }, event) => db.todos.insert({ title, owner: event.get(userKey).id }),
 * );
 * @since 1.0.0
 */
export function serverFn<S extends StandardSchemaV1, Item>(
  options: StreamingServerFnOptions & { readonly input: S },
  handler: (
    input: InferOutput<S>,
    event: RequestEvent,
  ) => AsyncIterable<Item> | Promise<AsyncIterable<Item>>,
): ServerFn<InferInput<S>, AsyncIterable<Item>, InferOutput<S>>;
/** Defines a typed streaming function without a schema. @param options Streaming options. @param handler Produces items. @returns The callable stream. @example const ticks = serverFn({ stream: true }, async function* () { yield 1; }); @since 1.0.0 */
export function serverFn<Item>(
  options: StreamingServerFnOptions,
  handler: (
    input: unknown,
    event: RequestEvent,
  ) => AsyncIterable<Item> | Promise<AsyncIterable<Item>>,
): ServerFn<unknown, AsyncIterable<Item>, unknown>;
/** Defines a schema-validated ordinary server function. @param options Function options. @param handler Implementation. @returns The callable function. @example const echo = serverFn({ input: schema }, value => value); @since 1.0.0 */
export function serverFn<S extends StandardSchemaV1, Output>(
  options: ServerFnOptions & { readonly input: S; readonly stream?: false },
  handler: (input: InferOutput<S>, event: RequestEvent) => Output | Promise<Output>,
): ServerFn<InferInput<S>, Awaited<Output>, InferOutput<S>>;
/**
 * Defines a server function without an input schema: the input is untrusted `unknown`, so validate
 * it yourself (a schema is the better choice).
 *
 * @param options Method and middleware.
 * @param handler The server-side implementation.
 * @returns A callable server function.
 * @example
 * export const ping = serverFn({}, () => "pong");
 * @since 1.0.0
 */
export function serverFn<Output>(
  options: ServerFnOptions & { readonly stream?: false },
  handler: (input: unknown, event: RequestEvent) => Output | Promise<Output>,
): ServerFn<unknown, Awaited<Output>, unknown>;
export function serverFn(
  options: ServerFnOptions & { readonly stream?: boolean },
  handler: (input: unknown, event: RequestEvent) => unknown,
): ServerFn<unknown, unknown, never> {
  const method = options.method ?? "POST";
  const stream = options.stream === true;
  if (
    stream &&
    (options.form === true ||
      options.batch === true ||
      options.singleFlight === true ||
      options.cacheControl !== undefined)
  ) {
    throw new TypeError(
      "serverFn: streams cannot use forms, batches, single flight or cache-control.",
    );
  }
  if (!METHODS.has(method))
    throw new TypeError(`serverFn: method must be "GET" or "POST", got ${String(method)}.`);
  if (options.input !== undefined && !isStandardSchema(options.input)) {
    throw new TypeError(
      "serverFn: `input` must be a Standard Schema (an object with ~standard.validate).",
    );
  }
  if (typeof handler !== "function")
    throw new TypeError("serverFn: the handler must be a function.");
  const middleware = options.middleware ?? [];
  for (const entry of middleware) {
    if (typeof entry !== "function")
      throw new TypeError("serverFn: middleware entries must be functions.");
  }
  const guard = guardList(options.guard, "serverFn({ guard })");
  const rateLimit =
    options.rateLimit === undefined ? undefined : normalizeServerFnRateLimit(options.rateLimit);
  // Checked now (the shape and the POST rule); a profile name is checked against the config at request time.
  resolveCacheControl(options.cacheControl, method);
  if (
    options.maxBodyBytes !== undefined &&
    (typeof options.maxBodyBytes !== "number" ||
      !Number.isInteger(options.maxBodyBytes) ||
      options.maxBodyBytes < 1)
  ) {
    throw new TypeError("serverFn: maxBodyBytes must be a positive whole number of bytes.");
  }
  const definition: ServerFnDefinition<unknown, unknown> = {
    method,
    input: options.input,
    middleware: [...middleware],
    form: options.form === true,
    singleFlight: options.singleFlight === true,
    ...(stream ? { stream } : {}),
    ...(options.cacheControl === undefined ? {} : { cacheControl: options.cacheControl }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    guard,
    ...(rateLimit === undefined ? {} : { rateLimit }),
    handler,
  };
  const invoke = (input: unknown, event: RequestEvent): Promise<unknown> =>
    executeServerFn(definition, input, event);
  const callable = async (input: unknown): Promise<unknown> => invoke(input, getRequestEvent());
  // Call options matter only to the browser stub; here they are accepted and ignored.
  const withOptions = (): ((input: unknown) => Promise<unknown>) => callable;
  const unbound = (member: string) => ({
    // Not enumerable: listing or spreading an unbound function must not fail.
    enumerable: false,
    configurable: true,
    get(): never {
      throw new DuskError(
        "SERVER_FN_NOT_BUILT",
        `server function \`${member}\` has no build id; load it through dusk() in vite.config.`,
      );
    },
  });
  return Object.defineProperties(
    Object.assign(callable, definition, { invoke, with: withOptions }),
    {
      id: unbound("id"),
      url: unbound("url"),
    },
  ) as unknown as ServerFn<unknown, unknown, never>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Gives a server function the id and url the build assigned to it. The build's server transform
 * wraps every `serverFn(...)` in this call; you do not call it yourself. It makes the server-side
 * function carry the same `id` and `url` as the browser stub (`serverFnStub`), so a page rendered
 * on the server can write `<form action={fn.url}>` for a function with `form: true`.
 *
 * @param fn A function made by {@link serverFn}.
 * @param id Its stable id (letters, digits, `-` and `_`, at most 128 characters).
 * @param base Mount base of the app, `""` or `"/app"` (no trailing slash).
 * @returns `fn` itself.
 * @throws TypeError when `fn` is not a `serverFn()` result or `id` is not URL-safe.
 * @throws DuskError `SERVER_FN_ALREADY_BOUND` when `fn` already has an id.
 * @example
 * const send = bindServerFn(serverFn({ form: true }, handler), "q3Zr0b1g2yTt0m5Qk9w3xA", "");
 * send.url; // "/_dusk/fn/q3Zr0b1g2yTt0m5Qk9w3xA"
 * @internal
 */
export function bindServerFn<F extends ServerFnDefinition>(fn: F, id: string, base: string): F {
  if (!isServerFnDefinition(fn) || typeof fn !== "function") {
    throw new TypeError("bindServerFn: expected the result of serverFn().");
  }
  if (!ID.test(id)) {
    throw new TypeError("bindServerFn: the id must be 1-128 characters of A-Z, a-z, 0-9, - and _.");
  }
  if (Object.getOwnPropertyDescriptor(fn, "id")?.get === undefined) {
    throw new DuskError(
      "SERVER_FN_ALREADY_BOUND",
      `this server function already has the id "${String(Reflect.get(fn, "id"))}".`,
    );
  }
  Object.defineProperties(fn, {
    id: { value: id, enumerable: true, configurable: false, writable: false },
    url: {
      value: `${base}${RPC_PREFIX}${id}`,
      enumerable: true,
      configurable: false,
      writable: false,
    },
  });
  return fn;
}
