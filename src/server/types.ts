import type { RouteDefinition } from "@shadow-js/router";
import type { ParamFilter } from "@shadow-js/router/core";
import type { AppComponent } from "../shared/app-component";
import type { CacheLifeProfile } from "../shared/cache-life";
import type { GlobalErrorModule } from "../shared/global-error";
import type { RoutingConfig } from "../shared/routing-config";
import type { CacheControlOption } from "./cache-control";
import type { CookieJar } from "./cookies";
import type { CorsOptions } from "./cors";
import type { CspOptions } from "./csp";
import type { DraftModeSettings } from "./draft-mode";
import type { EnvSchema, ParsedEnv } from "./env";
import type { DuskFeature } from "./features";
import type { ImagesOptions } from "./image-route";
import type { InstrumentationModule } from "./instrumentation";
import type { CacheOptions } from "./isr";
import type { FormLimits } from "./limits";
import type { EventTiming, MetricsLike, ServerTimingOptions } from "./observe-types";
import type { GeoInfo } from "./platform";
import type { ServerFnRateLimit } from "./rate-limit-option";
import type { SseHandler } from "./sse";
import type { StandardSchemaV1 } from "./standard-schema";
import type { WebSocketHandlers, WebSocketInput, WebSocketSink } from "./websocket";

/** HTTP methods the handler dispatches. @since 1.0.0 */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

export type { AppComponent };

/** What an API route handler may return. A `Response` is sent as is, anything else becomes JSON. @since 1.0.0 */
export type ApiResult = Response | undefined | null | string | number | boolean | object;

/**
 * A handler of one HTTP method of an API route.
 *
 * @example
 * export const GET: ApiHandler = (event) => json({ id: event.params.id });
 * @since 1.0.0
 */
export type ApiHandler = (event: RequestEvent) => ApiResult | Promise<ApiResult>;

/**
 * The module of an API route: HTTP-method exports and no default export. `csrf: false` opts the
 * route out of the CSRF check, for webhooks that authenticate by signature.
 * @since 1.0.0
 */
export interface ApiModule {
  readonly GET?: ApiHandler | undefined;
  readonly HEAD?: ApiHandler | undefined;
  readonly POST?: ApiHandler | undefined;
  readonly PUT?: ApiHandler | undefined;
  readonly PATCH?: ApiHandler | undefined;
  readonly DELETE?: ApiHandler | undefined;
  readonly OPTIONS?: ApiHandler | undefined;
  /**
   * Answers every method the module does not export by name (HEAD and OPTIONS included). An explicit method export
   * wins over it. Unknown method tokens (TRACE, PURGE) are never answered by it: they get 501.
   */
  readonly ALL?: ApiHandler | undefined;
  readonly csrf?: boolean | undefined;
  /** Middleware that wraps every method of the route, after the app-wide middleware. */
  readonly middleware?: readonly Middleware[] | undefined;
}

/**
 * What a server function middleware receives: the request event and the (validated) input.
 * @since 1.0.0
 */
export interface ServerFnContext {
  readonly event: RequestEvent;
  /** The validated input. */
  readonly input: unknown;
}

/**
 * Middleware of a server function. Call `next()` to continue; return its value (or another) to
 * answer; throw an {@link HttpError} to reject.
 * @since 1.0.0
 */
export type ServerFnMiddleware = (
  context: ServerFnContext,
  next: () => Promise<unknown>,
) => unknown | Promise<unknown>;

/**
 * Request-scoped values that middleware, guards, loaders and server functions share. Middleware sets
 * them on `event.locals`; they are read on the server only and never serialized into a page, a
 * payload or an API answer unless a loader or handler returns them on purpose.
 *
 * Declare the keys once by merging into this interface (see `defineLocals` for a typed helper):
 *
 * @example
 * declare module "@shadow-js/dusk/server" {
 *   interface DuskLocals {
 *     user: { id: string; role: "reader" | "admin" } | undefined;
 *   }
 * }
 * @since 1.0.0
 */
// biome-ignore lint/suspicious/noEmptyInterface: an empty interface is the augmentation point; a type alias cannot be merged
export interface DuskLocals {}

/**
 * A guard: a check that runs before a server function's input is validated or its handler runs, and
 * before an API route method's body is read. Return nothing (or `true`) to let the call through, return
 * `false` to refuse it with 403, or throw (an `HttpError` gives 401, 403 or any other status). A guard
 * sees the request only, not the input: the input is untrusted until its schema has accepted it.
 *
 * @example
 * export const requireUser: Guard = (event) => {
 *   if (event.locals.user === undefined) throw new HttpError(401, "Sign in first");
 * };
 * @since 1.0.0
 */
export type Guard = (event: RequestEvent) => void | boolean | Promise<void | boolean>;

/**
 * A module of server middleware that is loaded on demand. `load` resolves to the module's `middleware`
 * export (an array of {@link Middleware}); the handler checks it when it loads it.
 * @since 1.0.0
 */
export interface MiddlewareModule {
  load(): Promise<unknown>;
}

/**
 * The server-only middleware of the routes, as the build emits it. Nothing here reaches the browser.
 * @since 1.0.0
 */
export interface RouteMiddlewareManifest {
  /** Route-level middleware (a page's or layout's `middleware` export), by route id. */
  readonly routes: Readonly<Record<string, MiddlewareModule>>;
  /** `_middleware` files, by folder relative to the routes directory (`""` for the root). */
  readonly directories: Readonly<Record<string, MiddlewareModule>>;
  /** For each page route id, the folders whose `_middleware` applies to it, outermost first. */
  readonly pages: Readonly<Record<string, readonly string[]>>;
  /** For each API route id, the folders whose `_middleware` applies to it, outermost first. */
  readonly apis: Readonly<Record<string, readonly string[]>>;
}

/**
 * A server function as the build output registers it. {@link serverFn} creates these.
 *
 * `I` is the type the handler receives. The default, `unknown`, is what the executor passes: the
 * output of the function's schema, or the untrusted input when it has none. A typed definition (a
 * handler that takes `{ id: string }`) is assignable to `ServerFnDefinition` (a manifest entry)
 * without a cast because `handler` is declared as a method, whose parameters are checked
 * bivariantly; the schema the definition was built with is what makes that input safe.
 * @since 1.0.0
 */
export interface ServerFnDefinition<I = unknown, O = unknown> {
  /** `"POST"` (the default) or `"GET"` for idempotent reads. */
  readonly method: "GET" | "POST";
  /** Input schema, if any. Input is untrusted until it has passed it. */
  readonly input: StandardSchemaV1 | undefined;
  readonly middleware: readonly ServerFnMiddleware[];
  /** Whether the function also accepts HTML form posts (`application/x-www-form-urlencoded` or multipart). */
  readonly form: boolean;
  /** Whether the answer also carries the refreshed loader data of the current page (see `serverFn`). */
  readonly singleFlight?: boolean;
  /** Delivers an AsyncIterable as typed SSE items; requires `rpc({ streams: {} })`. */
  readonly stream?: boolean;
  /** `cache-control` of a successful answer. Default `no-store` (see `cache-control.ts`). */
  readonly cacheControl?: CacheControlOption;
  /** The largest body a call of this function reads, in bytes (see `serverFn({ maxBodyBytes })`). Absent: the app's limit. */
  readonly maxBodyBytes?: number;
  /** Guards that run before the input is validated (see {@link Guard}). Absent: none. */
  readonly guard?: readonly Guard[];
  /** Rate limit charged to every call that arrives over HTTP, alone or in a batch. Absent: none. */
  readonly rateLimit?: ServerFnRateLimit;
  /** The handler. A method, so typed definitions are assignable to the erased default (see above). */
  handler(input: I, event: RequestEvent): O | Promise<O>;
}

/**
 * The runtime manifest the build emits for the server entry.
 * @since 1.0.0
 */
export interface DuskRuntimeManifest {
  /** Generated by `@shadow-js/router/vite`: route definitions for `createRouter({ routes })`. */
  readonly routes: readonly RouteDefinition[];
  /** API routes: file-based HTTP-method modules, matched before pages. */
  readonly apiRoutes: readonly {
    readonly id: string;
    readonly path: string;
    /**
     * The module's `matchFilters` (the same rules as a page's): a value that fails is not a match. Read at build time,
     * so the matcher can use it at startup; the module itself is loaded lazily.
     */
    readonly matchFilters?: Readonly<Record<string, ParamFilter>>;
    load(): Promise<ApiModule>;
  }[];
  /** Server functions by stable id (hash of file + export). `load` is lazy and server-only. */
  readonly serverFns: Readonly<Record<string, { load(): Promise<ServerFnDefinition> }>>;
  /**
   * Built client assets. `entry`, `css` and `preloads` are URLs: a value starting with `/` or an
   * absolute `http(s)` URL is used as is, anything else is joined to `base`.
   */
  readonly assets: {
    readonly entry: string;
    readonly css: readonly string[];
    readonly preloads: Readonly<Record<string, readonly string[]>>;
    readonly base: string;
  };
  /** Root component of the app. */
  readonly App: AppComponent;
  /**
   * The build's `router.caseSensitive`: static route segments compare ASCII case exactly, so `/About` and `/about`
   * are two routes. Absent or false: case folds (the default). Every server router and matcher reads it.
   */
  readonly caseSensitive?: boolean;
  /**
   * Stream routes: files that export `SSE` and/or `WS`. Answered before pages. Absent in a manifest
   * built without streams.
   */
  readonly streams?: readonly {
    readonly id: string;
    readonly path: string;
    readonly kinds: readonly ("SSE" | "WS")[];
    load(): Promise<StreamModule>;
  }[];
  /**
   * Server-only middleware of the routes (`middleware` exports and `_middleware` folders). Absent in a
   * manifest built without any. See {@link RouteMiddlewareManifest}.
   */
  readonly middleware?: RouteMiddlewareManifest;
  /**
   * The `prerender` export of each route that has one, loaded on demand (the server entry exports the same list as
   * `prerenderRoutes`). The server reads it for a route that sets `dynamicParams = false`: a param the export does not
   * list is not found. A route that sets `false` without an entry here makes the handler refuse to start.
   */
  readonly prerenderRoutes?: readonly {
    readonly id: string;
    /** Loads the export: a list of paths, or a function that returns the params. */
    load(): Promise<unknown>;
  }[];
}

/**
 * The handlers a stream route module exports: `SSE` (server-sent events) and `WS` (WebSocket).
 * @since 1.0.0
 */
export interface StreamModule {
  readonly SSE?: SseHandler;
  readonly WS?: WebSocketHandlers;
}

/** Which kind of route answered a request. @since 1.0.0 */
export interface RouteInfo {
  readonly kind: "none" | "page" | "api" | "rpc" | "stream";
  /** Route id for pages and API routes, server function id for RPC. */
  readonly id: string | undefined;
  readonly params: Readonly<Record<string, string>>;
}

/** Attributes of the `<html>` element. @since 1.0.0 */
export interface DocumentAttributes {
  lang: string;
  dir: "ltr" | "rtl" | "auto" | undefined;
}

/**
 * A typed key of the per-request context.
 * @since 1.0.0
 */
export interface ContextKey<T> {
  readonly name: string;
  /** Phantom member that carries `T`. Never set. */
  readonly type?: T;
}

/**
 * The state of one request. It is available as the argument of middleware, API routes and server
 * functions, as `context.event` in `beforeLoad` and loaders, and through `getRequestEvent()` where
 * the runtime has `AsyncLocalStorage`.
 * @since 1.0.0
 */
export interface RequestEvent {
  /** The request, with its body limited to the configured size. */
  readonly request: Request;
  /**
   * The body as bytes, exactly as sent (a byte order mark and invalid UTF-8 kept). Read once: a second call returns the
   * same bytes, and so does `readJson` afterward. Bounded by the route's body limit: a larger body gives 413. Use it to
   * verify a webhook signature over the bytes that were signed.
   * @example
   * const bytes = await event.rawBody();
   * if (!verify(bytes, event.request.headers.get("x-signature"))) return json({ error: "bad" }, { status: 401 });
   * @since 1.0.0
   */
  rawBody(): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * The URL the middleware is checking. For a client navigation check (`isNavigationCheck`) it is the
   * TARGET of the navigation (path and search), not the `/_dusk/nav` request, so a middleware can build
   * `redirect_url` from it.
   */
  readonly url: URL;
  readonly method: string;
  /**
   * True while the browser's navigation check runs the chain of its target (`POST /_dusk/nav`), before
   * the client loads anything. A middleware that redirects here sends the browser to sign-in with
   * `redirect_url` set to `url`. False for every document request.
   */
  readonly isNavigationCheck: boolean;
  /** Aborted when the client disconnects or the request times out. */
  readonly signal: AbortSignal;
  /** Random id of this request, for logs. Never taken from the client. */
  readonly id: string;
  /** CSP nonce of this request, when a CSP or `nonce: true` is configured. Put it on inline scripts. */
  readonly nonce: string | undefined;
  readonly cookies: CookieJar;
  /** Headers added to the response of this request (cookies are added separately). */
  readonly responseHeaders: Headers;
  /**
   * Sets whether the framework validates this response with entity tags: `false` opts out (no generated ETag, and a
   * route's own ETag answers 200 even to a matching `If-None-Match`); `true` gives an API answer a generated weak ETag
   * (the body is read to compute it). Without a call, a cacheable page gets one (see `cache.etag`).
   * @example
   * export const GET = () => { event.etag(true); return json(data); }; // a public API answer with 304 support
   * @since 1.0.0
   */
  etag(enabled: boolean): void;
  /**
   * Your own metrics for the `Server-Timing` header and the `onTimings` hook (see `serverTiming`). Without
   * `serverTiming` (the production default) its methods run your function and record nothing.
   * @example
   * const rows = await event.timing.measure("db", () => query(sql), "orders");
   * @since 1.0.0
   */
  readonly timing: EventTiming;
  /** The validated environment (see `defineEnv`). Empty when no schema is configured. */
  readonly env: Readonly<Record<string, unknown>>;
  /** The value the host passed as the second argument of `fetch(request, env)`. */
  readonly platform: unknown;
  /** Address of the client as the host reports it (after the trusted-proxy rules), if known. */
  readonly clientAddress: string | undefined;
  /** True in development mode: error details are shown. */
  readonly dev: boolean;
  /** The app's mount path (`""` at the root, `/app` under `base`). Relative metadata URLs resolve against it. */
  readonly base: string;
  /** The app's `trailingSlash` policy. Metadata routes (sitemaps) apply it to their URLs. */
  readonly trailingSlash: "never" | "always" | "preserve";
  /**
   * Where the visitor is, as the platform reported it (Cloudflare, Vercel, Netlify; see `GeoInfo`). Every field is
   * `undefined` when there is no platform source, so a client's own headers are never used.
   */
  readonly geo: GeoInfo;
  /** True while draft (preview) mode is on for this request (see `draftMode()`). */
  readonly draft: boolean;
  /** Attributes of `<html>`; set them before the page renders. */
  readonly document: DocumentAttributes;
  /** The matched route. `kind` is `"none"` until the route is resolved. */
  readonly route: RouteInfo;
  /** Stores a value under a typed key. */
  set<T>(key: ContextKey<T>, value: T): void;
  /** Reads a value; throws when the key was never set. */
  get<T>(key: ContextKey<T>): T;
  /** Reads a value, or `undefined`. */
  tryGet<T>(key: ContextKey<T>): T | undefined;
  /** Route params of an API route or page (decoded). */
  readonly params: Readonly<Record<string, string>>;
  /**
   * Request-scoped values set by middleware and read by guards, loaders and server functions. Typed
   * through the {@link DuskLocals} interface. Server only: never sent to the client by the framework.
   */
  readonly locals: DuskLocals;
}

/** Continues the middleware chain. @since 1.0.0 */
export type Next = () => Promise<Response>;

/**
 * Middleware: runs around the rest of the request. Return a `Response` to answer without calling
 * `next`, or call `next()` and return (or replace) its response. Calling `next` twice is an error.
 *
 * `next()` always settles with a `Response`, also when the rest of the request fails: an error
 * thrown by a route, an `HttpError`, a `redirect()`, a validation failure or an error of an inner
 * middleware arrives as the response the client would get (a 500 with the reason phrase, the
 * `HttpError`'s status and headers, the 3xx). Headers set after `await next()` are therefore on
 * error responses too. To let a failure take another shape, return a different response or throw
 * your own error (an `HttpError` is mapped like any other). Requests the guards or CSRF check
 * reject never reach middleware.
 *
 * @example
 * const timing: Middleware = async (event, next) => {
 *   const started = performance.now();
 *   const response = await next();
 *   response.headers.set("server-timing", `app;dur=${performance.now() - started}`);
 *   return response;
 * };
 * @since 1.0.0
 */
export type Middleware = (event: RequestEvent, next: Next) => Response | Promise<Response>;

/** Limits applied before any application code runs. @since 1.0.0 */
export interface LimitsOptions {
  /** Longest accepted URL (`request.url`), in characters. Default 8192; longer gives 414. */
  readonly maxUrlLength?: number;
  /** Largest accepted request body in bytes. Default 1 MiB; larger gives 413. */
  readonly maxBodyBytes?: number;
  /**
   * The largest `maxBodyBytes` a route may ask for (`apiHandler({ maxBodyBytes })`). Default 512 MiB. A route value above it
   * is clamped to it; the ceiling is never below `maxBodyBytes`.
   */
  readonly maxRouteBodyBytes?: number;
  /**
   * Caps on the entries of a multipart or urlencoded form read with `readFormLimited`: fields, files, file size, text field
   * size and the total of text fields. Defaults: 1000 entries, 20 files, 10 MiB per file, 64 KiB per field, 1 MiB of fields.
   */
  readonly form?: Partial<FormLimits>;
  /** Time to produce the response head, in milliseconds. Default 30 000; longer gives 504. */
  readonly requestTimeoutMs?: number;
  /** Time a streamed page may take until its last byte, in milliseconds. Default 120 000. */
  readonly streamTimeoutMs?: number;
}

/** How the client address is derived. @since 1.0.0 */
export interface TrustProxyOptions {
  /** Header that carries the client address. Default `"x-forwarded-for"`. */
  readonly header?: string;
  /**
   * For a list header such as `x-forwarded-for`: how many proxies of yours append to it. The
   * address is the entry that many positions from the right. Default 1.
   */
  readonly hops?: number;
  /**
   * Only trust the header when the connection comes from one of these addresses (the proxies).
   * Without it the header is trusted from any peer, which is only safe when the server is not
   * reachable except through the proxy.
   */
  readonly trustedPeers?: readonly string[];
}

/** Options of the CSRF check. @since 1.0.0 */
export interface CsrfOptions {
  /** Origins (besides the request's own) allowed to send state-changing requests. */
  readonly trustedOrigins?: readonly string[];
  /**
   * Accept state-changing requests that carry no `Sec-Fetch-Site`, `Origin` or `Referer`
   * (command-line clients). Default `false`: such requests are rejected.
   */
  readonly allowMissingOrigin?: boolean;
}

/** Options of the secure response headers. Each value can be replaced, or `false` to omit the header. @since 1.0.0 */
export interface SecureHeadersOptions {
  readonly contentTypeOptions?: false | string;
  readonly referrerPolicy?: false | string;
  readonly permissionsPolicy?: false | string;
  readonly frameOptions?: false | "DENY" | "SAMEORIGIN";
  readonly crossOriginOpenerPolicy?: false | string;
  readonly crossOriginResourcePolicy?: false | string;
  /** Opt-in. Only sent on https requests. */
  readonly hsts?:
    | false
    | { readonly maxAge: number; readonly includeSubDomains?: boolean; readonly preload?: boolean };
}

/** Security settings. Everything is on by default except the CSP, HSTS and the allowed hosts. @since 1.0.0 */
export interface SecurityOptions {
  /**
   * Host names the server answers for (`example.com`, `example.com:8443`, `*.example.com`). A
   * request for another host gets 400. Required in production (createHandler throws without it):
   * the Host header is attacker input. An empty list means no host check, and in production it
   * also needs `acknowledgeNoHostCheck: true`.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * Set with `allowedHosts: []` in production to accept any Host on purpose (for example behind a
   * proxy that already checks it). Without it, production refuses an empty list. Default false.
   */
  readonly acknowledgeNoHostCheck?: boolean;
  /** Cross-origin access to API routes for the listed origins (see `cors.ts`). */
  readonly cors?: CorsOptions;
  /** Response headers; `false` turns them all off. */
  readonly headers?: false | SecureHeadersOptions;
  /** Content-Security-Policy with a per-request nonce. Off by default. */
  readonly csp?: false | CspOptions;
  /** CSRF check for state-changing requests; `false` turns it off (not recommended). */
  readonly csrf?: false | CsrfOptions;
  /** Secrets for signed cookies and sessions; the first signs, all verify (rotation). 32+ characters. */
  readonly cookieSecrets?: readonly string[];
  /** Size, time and URL limits. */
  readonly limits?: LimitsOptions;
  /** Derive the client address from a proxy header. Off by default (the peer address is used). */
  readonly trustProxy?: false | TrustProxyOptions;
  /** Generate a nonce even without a CSP, for apps that set their own header. Default false. */
  readonly nonce?: boolean;
  /**
   * The `x-request-id` header on every answer (OPTIONS, 404 and 405 included). `true` (default)
   * sends the request id; `false` omits the header; a function returns the value (a function can be given
   * here only: `dusk.config.ts` is written into the bundle, so it takes `true` or `false`). A header the route or
   * the handler set is kept.
   */
  readonly requestId?: boolean | ((event: RequestEvent) => string);
  /**
   * The answer to a method the route does not accept. `"json"` (default): the error body, as for any error.
   * `"empty"`: an empty 405 with no body. `Allow` is sent in both shapes.
   */
  readonly methodNotAllowed?: "json" | "empty";
  /**
   * The `cache-control` of a response that sets none (a page or an API answer). Default `private, no-store`. A string
   * replaces it; `false` leaves such responses without the header. A route rule's `cacheControl` replaces it for its
   * paths, and a `cache-control` the route or a header rule sets always wins.
   */
  readonly defaultCacheControl?: string | false;
}

/** Where an error was caught. @since 1.0.0 */
export type ErrorPhase =
  | "request"
  | "middleware"
  | "api"
  | "rpc"
  | "loader"
  | "render"
  | "stream"
  | "head"
  | "cache"
  | "after"
  | "instrumentation"
  | "draft";

/** Context of a reported error. @since 1.0.0 */
export interface ErrorInfo {
  readonly phase: ErrorPhase;
  readonly event: RequestEvent | undefined;
}

/** Options of the generated document. @since 1.0.0 */
export interface DocumentOptions {
  /** `<html lang>`. Default `"en"`. */
  readonly lang?: string;
  /** Id of the element the app is rendered into. Default `"app"`. */
  readonly rootId?: string;
  /**
   * `class` of `<body>`, the same on every page (a fixed string: never put request data in it). Default: none.
   * Set it when the root layout styles the body (the `className` of Next.js's `<body>`).
   */
  readonly bodyClass?: string;
  /**
   * Extra markup for `<head>`. Trusted HTML.
   *
   * A string is the same for every request: never put request data in it. A function runs for
   * every page response and receives the request event, so it can use `event.nonce` (the CSP nonce
   * of this response, which an inline script needs), `event.document` or the request's cookies.
   * It must return a string; escape anything that comes from the request. If it throws or returns
   * something else, the error is reported (phase `"head"`) and the page renders without it.
   *
   * @example
   * document: { head: (event) => themeScriptTag({ nonce: event.nonce }) }
   */
  readonly head?: string | ((event: RequestEvent) => string);
}

/** Options of {@link createHandler}. @since 1.0.0 */
export interface HandlerOptions {
  readonly manifest: DuskRuntimeManifest;
  /**
   * The features the handler has: `pages()`, `rpc()`, `isr()`, `dataCache()`, `apiRoutes()`, `streams()`,
   * `images()`, `draftMode()`, each imported from `@shadow-js/dusk/features/<name>`. Absent: none, so a handler
   * carries only the request pipeline. The generated server entry passes all of them. See {@link DuskFeature}.
   */
  readonly features?: readonly DuskFeature[];
  /** `"stream"` (default), `"async"` (wait for all data, one string) or `"string"` (no waiting). */
  readonly mode?: "string" | "async" | "stream";
  readonly middleware?: readonly Middleware[];
  readonly security?: SecurityOptions;
  /** Environment schema, validated at startup. */
  readonly env?: EnvSchema;
  /** Origins allowed to send cross-origin state-changing requests, and absolute redirect targets. */
  readonly trustedOrigins?: readonly string[];
  /** Mount point of the app, for example `/app`. Default `""`. */
  readonly base?: string;
  /** Trailing-slash policy of pages. Default `"never"`. */
  readonly trailingSlash?: "never" | "always" | "preserve";
  /** Development mode. Default: the build constant. Shows error details and relaxes cookie `Secure` on localhost. */
  readonly dev?: boolean;
  /**
   * Where environment variables come from. Default `process.env` when it exists. `false` skips
   * the startup check: the schema is validated on the first request from the host object passed
   * to `fetch(request, env)` (Workers bindings).
   */
  readonly envSource?: Readonly<Record<string, string | undefined>> | false;
  /** Receives every error the handler catches. Default: `console.error`. */
  readonly onError?: (error: unknown, info: ErrorInfo) => void;
  /** Receives configuration warnings. Default: `console.warn`. */
  readonly onWarning?: (message: string) => void;
  /** Document shell options. */
  readonly document?: DocumentOptions;
  /** Use `AsyncLocalStorage` for `getRequestEvent()` when the runtime has it. Default `true`. */
  readonly asyncContext?: boolean;
  /** The ISR cache of pages with `revalidate`: store, bounds and clock. See {@link CacheOptions}. */
  readonly cache?: CacheOptions;
  /** Limits of the stream routes (server-sent events and WebSocket). See {@link StreamOptions}. */
  readonly streams?: StreamOptions;
  /** The image optimizer at `/_dusk/image`. See {@link ImagesOptions}. Absent: local sources are 404. */
  readonly images?: ImagesOptions;
  /** Declarative routing of `dusk.config.ts`: redirects, rewrites, headers and route rules (validated at start). */
  readonly routing?: RoutingConfig;
  /**
   * Runs the global middleware (`middleware`) for a request that names a static file: `public/` files and the build's
   * assets. Default `false`: a file is answered before the middleware, as before, so a file costs no code. With `true`,
   * the middleware runs first: it can refuse the file, redirect it, or set headers and cookies that go out with it (the
   * framing headers stay the server's). The Node server (`serve`, `dusk start`) and the Cloudflare Worker honor it; a
   * platform that answers files from its CDN before any code runs (Vercel, Netlify, a static export) cannot, and the
   * build warns. `dusk dev` answers files through Vite, so the middleware does not run for them there.
   */
  readonly runMiddlewareForStaticFiles?: boolean;
  /** Named cache lifetimes (`cacheLife` profiles), added to the presets. */
  readonly cacheLife?: Readonly<Record<string, CacheLifeProfile>>;
  /** Draft mode: the secret variable and the endpoints. Absent: draft mode is off. */
  readonly draft?: Partial<DraftModeSettings>;
  /**
   * The global error document (`src/routes/_global-error.tsx`): answered, with status 500, when the app itself fails to
   * render above the routes. Needs `pages()`. Absent: the built-in 500 page.
   */
  readonly globalError?: GlobalErrorModule;
  /**
   * The built-in 404 page (answered when no route renders a not-found UI): its document title and whether it asks
   * search engines not to index it. Default `{ title: "Not found", noindex: true }`; `false` keeps the status title
   * (`404 Not Found`) and no robots tag.
   */
  readonly notFoundPage?: { readonly title?: string; readonly noindex?: boolean } | false;
  /** The `instrumentation.ts` module (register, onRequest, onRequestError, tracer). */
  readonly instrumentation?: InstrumentationModule;
  /**
   * The `Server-Timing` header (W3C): `total`, `route`, `loaders` and `render` durations, plus the metrics of
   * `event.timing`. `true` or `false` switches the header; an object sets `header` and the `onTimings` hook. Default:
   * on in development, off in production (the numbers describe your server's internals, so enable it deliberately).
   * A response that already has its own `Server-Timing` is left alone. For a streamed page the header carries the time
   * to the shell; `onTimings` receives the full render time when the stream ends.
   */
  readonly serverTiming?: boolean | ServerTimingOptions;
  /**
   * A request counter (`dusk.server.requests`) and a duration histogram (`http.server.request.duration`, seconds),
   * both by `http.route`, `http.request.method` and `http.response.status_class`. Pass a Meter of the OpenTelemetry
   * Metrics API (`metrics.getMeter("app")`) or any object with `createCounter` and `createHistogram`.
   */
  readonly metrics?: MetricsLike;
  /** Identifies this deployment. A client from another deployment gets 409 DEPLOYMENT_MISMATCH. */
  readonly deploymentId?: string;
  /** The default language of `<html lang>` (the default locale of `i18n`). */
  readonly i18n?: { readonly locales: readonly string[]; readonly defaultLocale: string };
  /** Prefix of hydration keys. Default `"0"`. */
  readonly renderId?: string;
  /** Send `x-dusk-render: <mode>` on pages. Default `false`. */
  readonly renderHeader?: boolean;
  /** Largest hydration payload in bytes; an oversized match is dropped from the payload. Default 2 MiB. */
  readonly maxPayloadBytes?: number;
  /** Limits of the server function endpoint. */
  readonly rpc?: {
    /** Largest GET payload (`?p=`), in characters. Default 4096; larger gives 414. */
    readonly maxGetPayloadChars?: number;
    /** Largest response body in bytes. Default 8 MiB. */
    readonly maxResponseBytes?: number;
    /** Most calls one batch request may carry. Default 25; more gives 413. */
    readonly maxBatchSize?: number;
  };
  /** Path of the health endpoint (always answers 200 `ok`). Default `"/_dusk/health"`; `false` disables. */
  readonly healthPath?: string | false;
}

/**
 * The fetch handler: the single contract every adapter bridges to.
 * @since 1.0.0
 */
export interface Handler {
  /** Validated stream limits, present with the streams feature; native adapters configure their payload bounds from them. */
  readonly webSocketLimits?: import("./websocket").WebSocketLimits;
  fetch(request: Request, env?: unknown): Promise<Response>;
  /**
   * Present only when the handler runs its middleware for files (`runMiddlewareForStaticFiles`): decides a request that
   * names a file the server would serve (see {@link AssetDecision}). A server asks it once it has found the file, and
   * sends the file or the answer. Absent otherwise, so a server that does not run middleware for files never calls it.
   */
  gateAsset?(request: Request, platform?: unknown): Promise<AssetDecision>;
  /**
   * Decides a WebSocket upgrade: refuses it with a response, or accepts it with the handshake headers and
   * the start function the transport calls once it has written the 101 response. Present on every handler
   * built by {@link createHandler}; a runtime without upgrades does not call it.
   */
  upgrade?(request: Request, platform?: unknown): Promise<UpgradeDecision>;
}

/**
 * The answer of the static-file gate (`Handler.gateAsset`). `serve`: the middleware let the request through, so the file
 * is sent with these headers (the headers and cookies the middleware set; the headers that frame the file, such as
 * `content-length` and `content-type`, are the server's own and are not in it). `answer`: the middleware answered the
 * request (a refusal, a redirect, a failure, or the answer of a rewritten target), and that response is sent instead.
 * @since 1.0.0
 */
export type AssetDecision =
  | { readonly kind: "serve"; readonly headers: Headers }
  | { readonly kind: "answer"; readonly response: Response };

/**
 * The answer to a WebSocket upgrade: refused with a response, or accepted. An accepted upgrade carries
 * the handshake headers (the caller writes the 101 status line before them) and `start`, which binds the
 * connection to the transport's sink and returns the input the transport feeds.
 * @since 1.0.0
 */
export type UpgradeDecision =
  | { readonly kind: "reject"; readonly response: Response }
  | {
      readonly kind: "websocket";
      /** Handshake headers of the 101 response (Upgrade, Connection, Sec-WebSocket-Accept). */
      readonly headers: Readonly<Record<string, string>>;
      start(sink: WebSocketSink): WebSocketInput;
      /** Starts on a runtime that delivers decoded messages and owns WebSocket framing. */
      startMessages?(
        sink: import("./websocket").MessageWebSocketSink,
      ): import("./websocket").MessageWebSocketInput;
      /** Validated limits, used by a native runtime to configure its own payload and heartbeat bounds. */
      readonly limits?: import("./websocket").WebSocketLimits;
      /**
       * Tells the handler the transport will not call `start` (it could not write the 101, or the client
       * went away first), so the connection slot the decision holds is given back. Safe to call more than
       * once, and a no-op after `start`.
       */
      abandon?(): void;
    };

/**
 * Limits of the stream routes. Every value has a default; a value out of range is refused at startup.
 * @since 1.0.0
 */
export interface StreamOptions {
  /** Milliseconds between the heartbeat comments of an SSE stream. Default 15 000. */
  readonly sseHeartbeatMs?: number;
  /** Sends that may wait at once for a slow SSE consumer before the stream is closed. Default 256. */
  readonly sseMaxBufferedEvents?: number;
  /** Largest WebSocket message a client may send, in bytes. Default 1 MiB. */
  readonly wsMaxMessageBytes?: number;
  /** WebSocket messages a client may send per second. Default 100. */
  readonly wsMaxMessagesPerSecond?: number;
  /** Milliseconds between the server's WebSocket pings. Default 30 000. */
  readonly wsPingIntervalMs?: number;
  /** Milliseconds a ping may wait for its pong. Default 10 000. */
  readonly wsPongTimeoutMs?: number;
  /**
   * Message handler calls that may be in flight at once on one WebSocket connection (a `message` handler that
   * returns a promise that has not settled). The next message closes the connection with 1013 and is not
   * handled. Handlers that return synchronously never count. Default 16.
   */
  readonly wsMaxInFlightMessages?: number;
  /**
   * Upgraded WebSocket connections one client address may hold at once (the address `trustProxy` resolves;
   * an IPv6 client counts by its /64). The next upgrade is refused with 503 and `Retry-After` before a socket
   * exists. `false` turns the cap off. Default 100. Behind a proxy, set `trustProxy`, or every client shares
   * the proxy's address.
   */
  readonly wsMaxConnectionsPerAddress?: number | false;
  /**
   * Upgraded WebSocket connections the whole handler may hold at once (the bookkeeping of the per-address
   * cap is bounded by it). The next upgrade is refused with 503 and `Retry-After`. `false` turns the cap off.
   * Default 10 000.
   */
  readonly wsMaxConnections?: number | false;
}

/**
 * What {@link createHandler} returns: the {@link Handler} plus the validated environment and the
 * SPA shell used by `@shadow-js/dusk/static`.
 * @since 1.0.0
 */
export interface DuskHandler extends Handler {
  /** The validated environment, or `undefined` when none is configured or it is validated on the first request. */
  readonly env: ParsedEnv | undefined;
  /**
   * The host patterns the handler accepts (`security.allowedHosts`), or `undefined` when it accepts
   * any host. Prerendering reads it to send its requests to a host the handler allows.
   */
  readonly allowedHosts: readonly string[] | undefined;
  /**
   * Renders the document without any route content: the shell a single-page app boots from.
   * Status 200, no loaders run.
   */
  renderShell(request?: Request): Promise<Response>;
}

/** Context the helpers of the server use to describe a thrown value. @since 1.0.0 */
export interface ErrorBody {
  readonly name: string;
  readonly message: string;
  readonly status: number;
  /** A stable code for the client, such as `SEARCH_INVALID`, when the error has one. */
  readonly code?: string;
  readonly issues?: readonly ValidationIssue[];
  readonly data?: unknown;
  readonly requestId?: string;
}

/** One validation issue as sent to the client. @since 1.0.0 */
export interface ValidationIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}
