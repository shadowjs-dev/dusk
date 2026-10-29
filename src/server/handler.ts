import { createMatcher, enableRedirectTargets, type RouteMatch } from "@shadow-js/router/core";
import { randomNonce } from "../internal/encoding";
import { HttpError } from "../internal/http-error";
import { assertKnownOptions } from "../internal/known-options";
import { isRedirect, redirectStatus } from "../internal/redirect";
import type { ResolvedRouting, RouteRule } from "../shared/routing-config";
import { NO_ROUTING } from "../shared/routing-empty";
import { NAV_PATH, RPC_PREFIX } from "../shared/wire";
import { takeAfterTasks } from "./after";
import { allowedMethods, allowOf, answersMethod, bodyLimitOf } from "./api";
import { resolveClientAddress } from "./client-address";
import { type ResolvedConfig, resolveConfig, warnToConsole } from "./config";
import { runWithEvent } from "./context";
import { buildCsp } from "./csp";
import { checkCsrf } from "./csrf";
import { attachDigest } from "./digest";
import type { ParsedEnv } from "./env";
import {
  describeError,
  errorBody,
  errorPageHtml,
  RequestTimeoutError,
  redirectResponse,
} from "./errors";
import { EventState, visibilityOf } from "./event";
import { bindFailureMapper } from "./failure";
import {
  type ApiHit,
  type ApiRoutesCapability,
  type Capabilities,
  type DraftCapability,
  type DuskFeature,
  type FeatureHost,
  type FeatureName,
  type ImagesCapability,
  missingFeature,
  type PagesCapability,
  type RpcCapability,
  type StreamHit,
  type StreamsCapability,
  sortFeatures,
} from "./features";
import {
  NOOP_TRACER,
  registerInstrumentation,
  resolveInstrumentation,
  type SpanLike,
} from "./instrumentation";
import {
  type BodyCap,
  boundRequest,
  checkFraming,
  createLargeBodyWatch,
  refuseDeclaredLength,
} from "./limits";
import { runMiddleware } from "./middleware-chain";
import type { Observer } from "./observe";
import { hostGeoOf } from "./platform";
import { patternOfChain, pickCandidate, type RouteCandidate } from "./precedence";
import { checkRedirectTarget, type RedirectPolicy } from "./redirect-target";
import { isLoopback, peerOf, readProcessEnv, sourceFromPlatform, wantsJson } from "./request-env";
import type { RewriteInstruction } from "./rewrite";
import { rewriteOf } from "./rewrite";
import type * as Routing from "./routing";
import type { Runtime } from "./runtime";
import { secureHeaderEntries } from "./secure-headers";
import { trailingSlashTarget } from "./trailing-slash";
import type {
  AssetDecision,
  DuskHandler,
  ErrorPhase,
  HandlerOptions,
  RequestEvent,
  RouteInfo,
} from "./types";
import { mergeVary } from "./vary";

const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const ALLOW_HEADER = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const RESERVED_PREFIX = "/_dusk/";
const EMPTY_ENV: Readonly<Record<string, unknown>> = Object.freeze({});
const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});
const IMAGE_PATH = "/_dusk/image";
/** The marker the middleware's `next()` answers with in the static-file gate: the request is not answered by the app. */
const GATE_PASS = "x-dusk-asset-pass";
/** The headers a file answer keeps for itself: the framing and validators the static server computes. */
const FILE_OWNED: ReadonlySet<string> = new Set([
  "content-length",
  "content-type",
  "content-encoding",
  "content-range",
  "transfer-encoding",
  "accept-ranges",
  "etag",
  "last-modified",
  "connection",
  "keep-alive",
]);

/**
 * What a request resolves to, before CSRF and middleware run. Each endpoint carries the capability that
 * answers it, so the answer needs no check for a feature that is not there.
 */
type Resolution =
  | { readonly kind: "health" }
  | { readonly kind: "rpc"; readonly id: string; readonly capability: RpcCapability }
  | {
      readonly kind: "api";
      readonly hit: ApiHit;
      readonly capability: ApiRoutesCapability;
      /** Methods of the page on the same path (for `Allow`). */
      readonly extra: readonly string[];
      /** The canonical location when the trailing-slash policy redirects this request (308). */
      readonly canonical?: string;
    }
  | { readonly kind: "allow"; readonly allow: string }
  | {
      readonly kind: "page";
      readonly shell: boolean;
      readonly pages: PagesCapability;
      /** The matched route pattern, for `http.route`. */
      readonly pattern?: string;
    }
  | { readonly kind: "stream"; readonly hit: StreamHit; readonly capability: StreamsCapability }
  | { readonly kind: "image"; readonly capability: ImagesCapability }
  | { readonly kind: "nav"; readonly pages: PagesCapability }
  | { readonly kind: "draft"; readonly enable: boolean; readonly capability: DraftCapability }
  | { readonly kind: "none" };

const HANDLER_OPTIONS: ReadonlySet<string> = new Set([
  "features",
  "manifest",
  "globalError",
  "notFoundPage",
  "mode",
  "middleware",
  "security",
  "env",
  "trustedOrigins",
  "base",
  "trailingSlash",
  "dev",
  "envSource",
  "onError",
  "onWarning",
  "document",
  "asyncContext",
  "renderId",
  "renderHeader",
  "maxPayloadBytes",
  "rpc",
  "healthPath",
  "cache",
  "streams",
  "images",
  "routing",
  "runMiddlewareForStaticFiles",
  "cacheLife",
  "draft",
  "instrumentation",
  "serverTiming",
  "metrics",
  "deploymentId",
  "i18n",
]);
const IMAGE_OPTIONS: ReadonlySet<string> = new Set([
  "source",
  "remotePatterns",
  "processor",
  "widths",
  "maxWidth",
  "maxSourceBytes",
  "cacheControl",
  "timeoutMs",
  "fetch",
  "formats",
  "qualities",
  "maxConcurrentFetches",
  "maxConcurrentFetchesPerClient",
]);
const STREAM_OPTIONS: ReadonlySet<string> = new Set([
  "sseHeartbeatMs",
  "sseMaxBufferedEvents",
  "wsMaxMessageBytes",
  "wsMaxMessagesPerSecond",
  "wsPingIntervalMs",
  "wsPongTimeoutMs",
  "wsMaxInFlightMessages",
  "wsMaxConnectionsPerAddress",
  "wsMaxConnections",
]);
const CACHE_OPTIONS: ReadonlySet<string> = new Set([
  "store",
  "maxEntries",
  "maxEntryBytes",
  "maxInFlight",
  "maxWaiters",
  "renderTimeoutMs",
  "backoffBaseMs",
  "backoffMaxMs",
  "now",
  "kv",
  "etag",
]);
const SECURITY_OPTIONS: ReadonlySet<string> = new Set([
  "allowedHosts",
  "acknowledgeNoHostCheck",
  "headers",
  "csp",
  "csrf",
  "cookieSecrets",
  "limits",
  "trustProxy",
  "nonce",
  "cors",
  "requestId",
  "methodNotAllowed",
  "defaultCacheControl",
]);
const LIMIT_OPTIONS: ReadonlySet<string> = new Set([
  "maxUrlLength",
  "maxBodyBytes",
  "maxRouteBodyBytes",
  "form",
  "requestTimeoutMs",
  "streamTimeoutMs",
]);
const FORM_LIMIT_OPTIONS: ReadonlySet<string> = new Set([
  "maxFields",
  "maxFileCount",
  "maxFileBytes",
  "maxFieldBytes",
  "maxTotalFieldBytes",
]);
/** Options that only page rendering reads: given without `pages()`, they would be silently ignored. */
const PAGE_OPTIONS: readonly (keyof HandlerOptions)[] = [
  "mode",
  "document",
  "i18n",
  "renderId",
  "renderHeader",
  "maxPayloadBytes",
];

/**
 * Refuses a handler whose manifest or options need a feature it does not have. Runs once, after every
 * feature is installed, so a capability a feature wraps is already in place.
 */
function checkNeeds(
  options: HandlerOptions,
  config: ResolvedConfig,
  capabilities: Capabilities,
  need: (name: FeatureName, reason: string) => never,
): void {
  const { manifest } = config;
  if (manifest.routes.length > 0 && capabilities.pages === undefined) {
    need("pages", __DEV__ ? `the manifest's ${manifest.routes.length} page route(s)` : "");
  }
  if (manifest.apiRoutes.length > 0 && capabilities.apiRoutes === undefined) {
    need("apiRoutes", __DEV__ ? `the manifest's ${manifest.apiRoutes.length} API route(s)` : "");
  }
  if ((manifest.streams?.length ?? 0) > 0 && capabilities.streams === undefined) {
    need("streams", __DEV__ ? `the manifest's ${manifest.streams?.length} stream route(s)` : "");
  }
  if (Object.keys(manifest.serverFns).length > 0 && capabilities.rpc === undefined) {
    need("rpc", __DEV__ ? "the manifest's server functions" : "");
  }
  if (capabilities.pages?.revalidates === true && capabilities.isr === undefined) {
    need("isr", __DEV__ ? "a page that exports revalidate" : "");
  }
  const routing = capabilities.routing?.rules ?? NO_ROUTING;
  if (routing.routeRules.some((entry) => entry.rule.revalidate !== undefined)) {
    if (capabilities.isr === undefined) need("isr", __DEV__ ? "a route rule with revalidate" : "");
  }
  if (options.routing !== undefined && capabilities.routing === undefined) {
    need("routing", __DEV__ ? 'the option "routing"' : "");
  }
  if (options.cache !== undefined && capabilities.isr === undefined) {
    need("isr", __DEV__ ? 'the option "cache"' : "");
  }
  if (options.images !== undefined && capabilities.images === undefined) {
    need("images", __DEV__ ? 'the option "images"' : "");
  }
  if (options.streams !== undefined && capabilities.streams === undefined) {
    need("streams", __DEV__ ? 'the option "streams"' : "");
  }
  if (options.globalError !== undefined && capabilities.pages === undefined) {
    need("pages", __DEV__ ? 'the option "globalError"' : "");
  }
  if (options.draft !== undefined && capabilities.draftMode === undefined) {
    need("draftMode", __DEV__ ? 'the option "draft"' : "");
  }
  if (options.rpc !== undefined && capabilities.rpc === undefined) {
    need("rpc", __DEV__ ? 'the option "rpc"' : "");
  }
  if (capabilities.pages === undefined) {
    for (const key of PAGE_OPTIONS) {
      if (options[key] !== undefined) need("pages", __DEV__ ? `the option "${key}"` : "");
    }
  }
}

/**
 * Creates the request handler: the single `fetch(Request) => Response` contract that adapters,
 * the dev server, the test client and prerendering all call.
 *
 * The core pipeline is: guards (URL length, host, framing, body size, timeout) -> route resolution ->
 * CSRF -> middleware -> the endpoint (API route, server function, page, stream, image, draft or nav gate)
 * -> secure headers. The endpoints are features: a handler has only the ones in `features`, and a request
 * for an endpoint the handler lacks is a 404. Configuration errors (a bad option, a conflicting route, an
 * invalid environment, a manifest or option that needs a missing feature) throw here, at startup.
 *
 * @param options The manifest, the features and the settings. See {@link HandlerOptions}.
 * @returns The handler.
 * @throws TypeError / RangeError for invalid options or a missing feature; EnvError for an invalid environment.
 * @example
 * import { pages } from the "@shadow-js/dusk/features/pages" subpath;
 * import { rpc } from the "@shadow-js/dusk/features/rpc" subpath;
 * const handler = createHandler({
 *   manifest,
 *   features: [pages(), rpc()],
 *   security: { allowedHosts: ["example.com"], cookieSecrets: [process.env.COOKIE_SECRET] },
 * });
 * const response = await handler.fetch(new Request("https://example.com/"));
 * @since 1.0.0
 */
export function createHandler(options: HandlerOptions): DuskHandler {
  assertKnownOptions("createHandler", options, HANDLER_OPTIONS);
  enableRedirectTargets();
  assertKnownOptions("createHandler({ security })", options.security, SECURITY_OPTIONS);
  assertKnownOptions(
    "createHandler({ security: { limits } })",
    options.security?.limits,
    LIMIT_OPTIONS,
  );
  assertKnownOptions(
    "createHandler({ security: { limits: { form } } })",
    options.security?.limits?.form,
    FORM_LIMIT_OPTIONS,
  );
  assertKnownOptions("createHandler({ cache })", options.cache, CACHE_OPTIONS);
  assertKnownOptions("createHandler({ streams })", options.streams, STREAM_OPTIONS);
  assertKnownOptions("createHandler({ images })", options.images, IMAGE_OPTIONS);
  if (
    options.runMiddlewareForStaticFiles !== undefined &&
    typeof options.runMiddlewareForStaticFiles !== "boolean"
  ) {
    throw new TypeError("runMiddlewareForStaticFiles must be true or false.");
  }
  const config: ResolvedConfig = resolveConfig(options);
  let hostNoteSent = false;
  // Development only: warns when an API route reads a body in full under a limit above 10 MiB (see `limits.ts`).
  // Behind `__DEV__` so a production build of the handler does not carry it.
  const watchLargeBody = __DEV__
    ? createLargeBodyWatch({
        dev: config.dev,
        maxBodyBytes: config.limits.maxBodyBytes,
        warn: config.warn,
      })
    : undefined;
  const instrumentation = resolveInstrumentation(options.instrumentation);

  // The declarative routing is the `routing()` feature's validated rules (installed below). They are evaluated by
  // `./routing`, loaded on the first request of a handler that declares a rule. A handler without rules never loads it:
  // every lookup then answers "no rule", which is what it would answer anyway.
  let routing: ResolvedRouting = NO_ROUTING;
  let routingModule: typeof Routing | undefined;
  /** The merged route rule of a path (`{}` when the handler declares none). */
  const ruleOf = (path: string): RouteRule =>
    routingModule === undefined ? {} : routingModule.effectiveRule(routing, path);

  // An error can pass several places (the loader wrapper, then the page, then the response
  // mapping); the sink should hear about it once.
  const reported = new WeakSet<object>();
  /** Hands an error to `instrumentation.onRequestError`; a failing hook is logged, never thrown. */
  const notifyError = (
    error: unknown,
    phase: ErrorPhase,
    event: RequestEvent | undefined,
  ): void => {
    const hook = instrumentation.onRequestError;
    if (hook === undefined) return;
    try {
      const outcome = hook(error, event?.request, {
        phase,
        routeKind: event?.route.kind,
        routeId: event?.route.id,
        requestId: event?.id,
      });
      if (outcome instanceof Promise) {
        outcome.catch((hookError: unknown) =>
          console.error("[dusk] instrumentation.onRequestError failed", hookError),
        );
      }
    } catch (hookError) {
      console.error("[dusk] instrumentation.onRequestError failed", hookError);
    }
  };

  const report = (error: unknown, phase: ErrorPhase, event: RequestEvent | undefined): void => {
    if (typeof error === "object" && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    // The page shows this digest (see `attachDigest`): the dev server's log line reads it from the error.
    if (__DEV__ && config.dev) attachDigest(error);
    try {
      config.report(error, { phase, event });
    } catch (sinkError) {
      // The sink itself failed: last resort, so the original error is not lost with it.
      console.error("[dusk] the error sink threw", sinkError, "while reporting", error);
    }
    notifyError(error, phase, event);
    (event as EventState | undefined)?.obs?.error(error);
  };

  const policyFor = (event: RequestEvent): RedirectPolicy => ({
    origin: event.url.origin,
    trustedOrigins: config.trustedOrigins,
  });
  const runtime: Runtime = {
    config,
    policyFor,
    report,
    markReported: (value: unknown): void => {
      if (typeof value === "object" && value !== null) reported.add(value);
    },
  };

  // Observability (child spans, `Server-Timing`, metrics) lives in `observe.ts`, loaded only when one is configured: a
  // tracer, `serverTiming`, `metrics`, or development mode. A bad option is reported, never thrown: it must not stop the app.
  // A configured one is waited for, so no request runs unobserved; the development default is not (it never delays a request).
  let observer: Observer | undefined;
  let observing: Promise<void> | undefined;
  const tracer = instrumentation.tracer === NOOP_TRACER ? undefined : instrumentation.tracer;
  const wanted =
    tracer !== undefined || options.serverTiming !== undefined || options.metrics !== undefined;
  if (wanted || (__DEV__ && config.dev)) {
    const loading = import("./observe")
      .then((module) => {
        observer = module.createObserver(options, tracer, config.dev, report, describeError);
      })
      .catch((error: unknown) => report(error, "instrumentation", undefined))
      .then(() => {
        observing = undefined;
      });
    if (wanted) observing = loading;
  }

  // Environment: validated now when a source exists, otherwise on the first request (Workers).
  let parsedEnv: ParsedEnv | undefined;
  if (options.env !== undefined) {
    const source =
      options.envSource === false ? undefined : (options.envSource ?? readProcessEnv());
    if (source !== undefined) parsedEnv = options.env.parse(source);
  }
  const envFor = (platform: unknown): Readonly<Record<string, unknown>> => {
    if (options.env === undefined) return EMPTY_ENV;
    parsedEnv ??= options.env.parse(sourceFromPlatform(platform));
    return parsedEnv.all;
  };

  /** Maps anything thrown to a response: redirect, JSON error or HTML error page. */
  const failureResponse = (event: EventState, thrown: unknown): Response => {
    if (event.route.kind === "rpc" && capabilities.rpc !== undefined) {
      return capabilities.rpc.failure(event, thrown);
    }
    let error = thrown;
    if (isRedirect(thrown)) {
      const target = checkRedirectTarget(thrown.to, runtime.policyFor(event));
      if (typeof target === "string") return redirectResponse(target, redirectStatus(thrown));
      error = target;
    }
    const description = describeError(error, event.dev);
    const phase: ErrorPhase = event.route.kind === "api" ? "api" : "request";
    if (description.report) report(error, phase, event);
    const headers = new Headers(description.headers);
    // `security.methodNotAllowed: "empty"`: an unsupported method answers an empty 405 (no error body). `Allow`
    // is sent in both shapes, so a client can see the methods the route accepts.
    if (description.status === 405 && !headers.has("allow")) headers.set("allow", ALLOW_HEADER);
    if (description.status === 405 && config.methodNotAllowed === "empty") {
      return new Response(null, { status: 405, headers });
    }
    const json = event.route.kind === "api" || wantsJson(event.request);
    if (json) {
      headers.set("content-type", "application/json; charset=utf-8");
      const body = JSON.stringify({ error: errorBody(description, event.id) });
      return new Response(event.method === "HEAD" ? null : body, {
        status: description.status,
        headers,
      });
    }
    headers.set("content-type", "text/html; charset=utf-8");
    const body = errorPageHtml(
      description.status,
      description.message,
      event.id,
      event.document.lang,
    );
    return new Response(event.method === "HEAD" ? null : body, {
      status: description.status,
      headers,
    });
  };

  /** Adds cookies, secure headers, CSP, the cache-control default and the request id, then finishes the answer (finish.ts). */
  const finalize = async (event: EventState, response: Response): Promise<Response> => {
    const headers = new Headers(response.headers);
    for (const [name, value] of event.responseHeaders) {
      if (name === "set-cookie") continue;
      // `Vary` is a list both sides add to (CORS adds `Origin`): the route's own names do not drop the framework's.
      if (name === "vary") mergeVary(headers, value);
      else if (!headers.has(name)) headers.set(name, value);
    }
    // An origin that is not listed (or none) gets a different answer from a listed one (it has no grant): a shared cache
    // must key on `Origin` for every answer of an API route, or it hands one the other's. Added here, after the route ran,
    // because a route that sets `event.responseHeaders` `Vary` replaces whatever was put there before it.
    if (config.cors !== undefined && event.route.kind === "api") mergeVary(headers, "origin");
    for (const value of event.responseHeaders.getSetCookie()) headers.append("set-cookie", value);
    for (const cookie of event.cookies.serialized()) headers.append("set-cookie", cookie);
    if (config.headers !== false) {
      for (const [name, value] of secureHeaderEntries(
        config.headers,
        event.url.protocol === "https:",
      )) {
        if (!headers.has(name)) headers.set(name, value);
      }
    }
    const isHtml = (headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
    if (config.csp !== undefined && isHtml) {
      const name =
        config.csp.reportOnly === true
          ? "content-security-policy-report-only"
          : "content-security-policy";
      if (!headers.has(name)) headers.set(name, buildCsp(config.csp, event.nonce));
    }
    // Header rules (`headers` in the config and the `headers` of route rules) match the path asked for. A header
    // the handler already set wins over them; the framework's secure defaults come after them.
    const asked = event.sourcePath;
    const routeRule =
      asked !== undefined && routingModule !== undefined
        ? routingModule.effectiveRule(routing, asked)
        : undefined;
    if (asked !== undefined && routingModule !== undefined) {
      // A config rule yields to the route's header for the same name, unless it sets `override: true`.
      for (const [name, value, override] of routingModule.headersFor(
        routing,
        asked,
        event.request,
        event.url,
      )) {
        if (override || !headers.has(name)) headers.set(name, value);
      }
      for (const [name, value] of Object.entries(routeRule?.headers ?? {})) {
        if (!headers.has(name)) headers.set(name, value);
      }
    }
    // The cache-control default: a route rule's `cacheControl` for its path, else `security.defaultCacheControl`.
    // `false` (either one) leaves the response without the header.
    if (!headers.has("cache-control")) {
      const value = routeRule?.cacheControl ?? config.defaultCacheControl;
      if (value !== false) headers.set("cache-control", value);
    }
    // A request id the route or the handler set (an app can echo the client's `X-Request-Id`) is kept.
    // `security.requestId: false` omits it on every answer; a function names the id.
    if (config.requestId !== false && !headers.has("x-request-id")) {
      headers.set("x-request-id", config.requestId(event));
    }
    // The entity tags and the final response (finish.ts, loaded on first use), then the observation of the request
    // (`Server-Timing`, the status for spans and metrics).
    const answered = await (await import("./finish")).finishAnswer(
      event,
      response,
      headers,
      config.cacheEtag,
    );
    return event.obs?.done(answered) ?? answered;
  };

  const capabilities: Capabilities = {};
  const host: FeatureHost = {
    options,
    config,
    runtime,
    capabilities,
    need: (name, reason) => {
      throw missingFeature(name, reason);
    },
    finalize: (event, response) => finalize(event, response),
    failureResponse: (event, thrown) => failureResponse(event, thrown),
    envFor: (platform) => envFor(platform),
  };

  // The features, in their fixed order. Each fills its capability; none runs for a feature not listed.
  const installed: DuskFeature[] = sortFeatures(options.features);
  for (const feature of installed) feature.install(host);
  routing = capabilities.routing?.rules ?? NO_ROUTING;
  checkNeeds(options, config, capabilities, host.need);
  const { redirects, rewrites, headers: headerRules, routeRules } = routing;
  const declaresRouting =
    redirects.length +
      headerRules.length +
      routeRules.length +
      rewrites.beforeFiles.length +
      rewrites.afterFiles.length +
      rewrites.fallback.length >
    0;

  // The route matcher of the base: strips the mount point from a path. The pages, API and stream matchers
  // match routes; this one only the base.
  const baseMatcher = createMatcher([], {
    basePath: config.base,
    caseSensitive: config.manifest.caseSensitive === true,
  });
  /** The app path of a request path (without the base), or undefined when it is outside the base. */
  const stripBase = (pathname: string): string | undefined => baseMatcher.stripBase(pathname);
  const matchesPage = (event: EventState): boolean =>
    (capabilities.pages?.match(event.url.pathname, visibilityOf(event)).length ?? 0) > 0;

  /** Resolves a request to what will answer it. No application handler code runs here. */
  const resolve = async (event: EventState, shell: boolean): Promise<Resolution> => {
    const pathname = event.url.pathname;
    if (config.healthPath !== undefined && pathname === config.healthPath)
      return { kind: "health" };
    const appPath = stripBase(pathname);
    if (appPath === undefined) return { kind: "none" };
    const draft = capabilities.draftMode?.match(appPath);
    if (draft !== undefined && capabilities.draftMode !== undefined) {
      return { kind: "draft", enable: draft.enable, capability: capabilities.draftMode };
    }
    if (appPath.startsWith(RESERVED_PREFIX)) {
      if (appPath === IMAGE_PATH && capabilities.images !== undefined) {
        return { kind: "image", capability: capabilities.images };
      }
      if (appPath === NAV_PATH && capabilities.pages !== undefined) {
        return { kind: "nav", pages: capabilities.pages };
      }
      if (appPath.startsWith(RPC_PREFIX) && capabilities.rpc !== undefined) {
        const id = appPath.slice(RPC_PREFIX.length);
        return id.includes("/")
          ? { kind: "none" }
          : { kind: "rpc", id, capability: capabilities.rpc };
      }
      return { kind: "none" };
    }
    if (shell) {
      return capabilities.pages === undefined
        ? { kind: "none" }
        : { kind: "page", shell: true, pages: capabilities.pages };
    }
    // Stream routes, API routes and pages are candidates; the most specific pattern answers (see `precedence.ts`).
    const visibility = visibilityOf(event);
    const streamHit =
      capabilities.streams === undefined
        ? undefined
        : await capabilities.streams.match(pathname, visibility);
    const apiHit =
      capabilities.apiRoutes === undefined
        ? undefined
        : await capabilities.apiRoutes.match(pathname, visibility);
    const chain: readonly RouteMatch[] = capabilities.pages?.match(pathname, visibility) ?? [];
    const candidates: RouteCandidate[] = [];
    if (streamHit !== undefined) {
      candidates.push({ kind: "stream", pattern: streamHit.pattern, claims: true });
    }
    if (apiHit !== undefined) {
      candidates.push({
        kind: "api",
        pattern: apiHit.pattern,
        claims: answersMethod(apiHit.module, event.method),
      });
    }
    if (chain.length > 0) {
      const claims =
        event.method === "GET" || event.method === "HEAD" || event.method === "OPTIONS";
      candidates.push({ kind: "page", pattern: patternOfChain(chain), claims });
    }
    const winner = pickCandidate(candidates);
    if (
      winner?.kind === "stream" &&
      capabilities.streams !== undefined &&
      streamHit !== undefined
    ) {
      return { kind: "stream", hit: streamHit, capability: capabilities.streams };
    }
    // Every method the candidates on this path answer, for `Allow`: a refusal lists the union, not one route's list.
    const pageMethods: readonly string[] = chain.length > 0 ? ["GET", "HEAD", "OPTIONS"] : [];
    if (winner?.kind === "api" && capabilities.apiRoutes !== undefined && apiHit !== undefined) {
      // The trailing-slash policy applies to API routes as it does to pages. The check is skipped for a rewrite
      // target: the client asked for another address.
      const canonical = event.rewritten
        ? undefined
        : trailingSlashTarget(pathname.slice(config.base.length), config.trailingSlash);
      return {
        kind: "api",
        hit: apiHit,
        capability: capabilities.apiRoutes,
        extra: pageMethods,
        ...(canonical === undefined ? {} : { canonical: `${config.base}${canonical}` }),
      };
    }
    // A page answers GET and HEAD. For another method on a path an API route also matches, the refusal (405) or the
    // OPTIONS answer lists the methods of both.
    if (
      winner?.kind === "page" &&
      apiHit !== undefined &&
      capabilities.apiRoutes !== undefined &&
      event.method !== "GET" &&
      event.method !== "HEAD"
    ) {
      return { kind: "allow", allow: allowOf([...allowedMethods(apiHit.module), ...pageMethods]) };
    }
    if (capabilities.pages === undefined) return { kind: "none" };
    // A route rule with `ssr: false` answers the shell, like `defineRoute({ ssr: false })`.
    return {
      kind: "page",
      shell: ruleOf(appPath).ssr === false,
      pages: capabilities.pages,
      ...(chain.length > 0 ? { pattern: patternOfChain(chain) } : {}),
    };
  };

  /** Runs one resolved request through CSRF and the middleware onion. */
  const answer = async (event: EventState, resolution: Resolution): Promise<Response> => {
    if (resolution.kind === "health") {
      return new Response(event.method === "HEAD" ? null : '{"status":"ok"}', {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const route: RouteInfo =
      resolution.kind === "stream"
        ? { kind: "stream", id: resolution.hit.id, params: NO_PARAMS }
        : resolution.kind === "api"
          ? { kind: "api", id: resolution.hit.id, params: resolution.hit.params }
          : resolution.kind === "rpc"
            ? { kind: "rpc", id: resolution.id, params: NO_PARAMS }
            : resolution.kind === "page" || resolution.kind === "allow"
              ? { kind: "page", id: undefined, params: NO_PARAMS }
              : { kind: "none", id: undefined, params: NO_PARAMS };
    event.route = route;
    event.obs?.routed(resolution);
    // The body limit of this request: the route's own `maxBodyBytes` when its handler declares one (clamped to the
    // ceiling), else the app's. A declared length over it is refused here, before the middleware and before a byte is read.
    const routeLimit =
      resolution.kind === "api" ? bodyLimitOf(resolution.hit.module, event.method) : undefined;
    event.bodyCap.limit =
      routeLimit === undefined
        ? config.limits.maxBodyBytes
        : Math.min(routeLimit, config.limits.maxRouteBodyBytes);
    // A server function's own limit is applied by its handler (rpc.ts), once the function is loaded.
    if (resolution.kind !== "rpc") refuseDeclaredLength(event.request.headers, event.bodyCap.limit);
    // CORS for listed origins (`security.cors`): a preflight is answered here, before the route runs.
    // The runtime loads only for a handler that sets `security.cors` (see `cors-headers.ts`).
    if (resolution.kind === "api" && config.cors !== undefined) {
      const { corsHeadersFor } = await import("./cors-headers");
      const preflight =
        event.method === "OPTIONS" && event.request.headers.has("access-control-request-method");
      const cors = corsHeadersFor(config.cors, event.request.headers.get("origin"), preflight);
      if (cors !== undefined) {
        if (preflight) return new Response(null, { status: 204, headers: cors });
        for (const [name, value] of Object.entries(cors)) {
          if (name !== "vary") event.responseHeaders.set(name, value);
        }
      }
    }
    const csrfApplies = resolution.kind !== "api" || resolution.hit.module.csrf !== false;
    if (config.csrf.enabled && csrfApplies) {
      const decision = checkCsrf(event.request, {
        origin: event.url.origin,
        trustedOrigins: config.csrf.trusted,
        allowMissingOrigin: config.csrf.allowMissingOrigin,
      });
      if (!decision.ok) {
        throw new HttpError(
          403,
          event.dev ? `CSRF check failed: ${decision.reason}` : "Forbidden",
          { expose: true },
        );
      }
    }
    if (resolution.kind === "api" && watchLargeBody !== undefined) {
      watchLargeBody(
        event.request,
        `${event.method} ${resolution.hit.id}`,
        `${event.method} ${event.url.pathname}`,
      );
    }
    // A request a rewrite already moved skips the app-wide middleware: the rewrite answer is the middleware's
    // decision for this request, and running the chain again on the target could rewrite it forever.
    const endpoint = async (): Promise<Response> => {
      switch (resolution.kind) {
        case "rpc":
          return resolution.capability.handle(event, resolution.id);
        case "stream":
          return resolution.capability.answer(event, resolution.hit);
        case "image":
          return resolution.capability.handle(event);
        case "nav":
          return resolution.pages.gate(event);
        case "draft":
          return resolution.capability.endpoint(event, resolution.enable);
        case "api": {
          if (resolution.canonical !== undefined) {
            return redirectResponse(`${resolution.canonical}${event.url.search}`, 308);
          }
          // The folders' `_middleware` run first; the module's own `middleware` runs inside dispatch.
          // No `_middleware` file in the app: no folder chain, and the module that builds one is not loaded.
          const folders =
            config.manifest.middleware === undefined
              ? []
              : await (await import("./api-middleware")).apiMiddlewareFor(
                  config.manifest.middleware,
                  resolution.hit.id,
                );
          return runMiddleware(folders, event, () =>
            resolution.capability.dispatch(event, resolution.hit, resolution.extra),
          );
        }
        case "allow":
          // A path two routes share, and a method neither answers by name: the refusal lists both routes' methods.
          if (event.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: { allow: resolution.allow } });
          }
          throw new HttpError(405, "Method Not Allowed", {
            headers: { allow: resolution.allow },
          });
        case "page":
          // The SPA shell (`renderShell`) carries no route content, so no route middleware runs for it.
          return resolution.shell ? resolution.pages.shell(event) : resolution.pages.serve(event);
        default:
          throw new HttpError(404, "Not Found");
      }
    };
    const obs = event.obs;
    const outcome = await runMiddleware(
      event.rewritten ? [] : config.middleware,
      event,
      obs === undefined ? endpoint : () => obs.endpoint(resolution.kind, route.id, endpoint),
    );
    const moved = rewriteOf(outcome);
    return moved === undefined ? outcome : rewriteTo(event, moved);
  };

  /**
   * Serves a request a middleware rewrote (see `rewrite()`): the URL and the request move to the target, the target
   * is resolved and answered, and the app-wide middleware does not run again. A second rewrite is an error.
   */
  const rewriteTo = async (event: EventState, moved: RewriteInstruction): Promise<Response> =>
    (await import("./middleware-rewrite")).rewriteTarget(event, moved, {
      move: (event, hit) => rewriteEvent(event, hit),
      answer: async (event) => answer(event, await resolve(event, false)),
    });

  /** Moves the request to the rewritten path; `event.sourcePath` keeps the path asked for. */
  const rewriteEvent = (
    event: EventState,
    hit: { readonly path: string; readonly search: string },
  ): void => {
    event.url = new URL(`${config.base}${hit.path}${hit.search}`, event.url.origin);
    // The target of a rewrite may be a private route: a request the client sent cannot be (see `visibilityOf`).
    event.internalAccess = true;
  };

  /**
   * The rules that run before the route is matched: the config redirects and route-rule redirects (which
   * answer), then the `beforeFiles` rewrites (which change the path). A redirect to the same place is ignored.
   */
  // The steps the early rules call back into (see `answerEarly`); a config without rules never reaches them.
  const earlyHost: Routing.EarlyHost = {
    base: config.base,
    routing,
    redirect: (event, hit) => {
      const location = hit.target.startsWith("/") ? `${config.base}${hit.target}` : hit.target;
      const checked = checkRedirectTarget(location, runtime.policyFor(event));
      if (typeof checked !== "string") return failureResponse(event, checked);
      return redirectResponse(checked, hit.status);
    },
    rewrite: (event, hit) => rewriteEvent(event, hit),
  };
  // No rule declared: nothing redirects or rewrites (see `declaresRouting`), so the routing module is not needed.
  const routeEarly = (event: EventState): Response | undefined =>
    routingModule === undefined ? undefined : routingModule.answerEarly(event, earlyHost);

  /** The `afterFiles` and `fallback` rewrites: only when no page matches the path. */
  const late: Routing.LateHost<Resolution> = {
    routing,
    stripBase,
    rewrite: (event, hit) => rewriteEvent(event, hit),
    resolveAgain: (event) => resolve(event, false),
    matchesPage,
  };
  const rewriteLate = async (event: EventState, resolution: Resolution): Promise<Resolution> =>
    routingModule === undefined ? resolution : routingModule.answerLate(event, resolution, late);

  /** `instrumentation.onRequest`: called before routing; a failure is reported and the request goes on. */
  const notifyRequest = async (event: EventState): Promise<void> => {
    const hook = instrumentation.onRequest;
    if (hook === undefined) return;
    try {
      await hook(event.request, { requestId: event.id, routeKind: "unresolved" });
    } catch (error) {
      report(error, "instrumentation", event);
    }
  };

  /**
   * Starts the `after()` tasks of a request once its response has been sent (see `after-run.ts`, loaded when a request
   * queued a task): on the platform's `waitUntil` when it has one, otherwise when the response body ends.
   */
  const scheduleAfter = async (event: EventState, response: Response): Promise<Response> => {
    const tasks = takeAfterTasks(event);
    if (tasks.length === 0) return response;
    return (await import("./after-run")).scheduleAfter(
      tasks,
      (error) => report(error, "after", event),
      event.platform,
      response,
    );
  };

  /** Every request: a span around it (the tracer of `instrumentation`), then the request itself. */
  const handle = (request: Request, platform: unknown, shell: boolean): Promise<Response> => {
    if (config.productionHostUnset && !hostNoteSent) {
      // The first request waits for the note, so the warning is out before its response. Then it runs as usual.
      hostNoteSent = true;
      const warn = options.onWarning ?? warnToConsole;
      return import("./production-host-note").then(({ productionHostNote }) => {
        warn(productionHostNote());
        return handle(request, platform, shell);
      });
    }
    if (tracer === undefined) return handleRequest(request, platform, shell);
    const attributes = {
      "http.request.method": request.method,
      "url.path": new URL(request.url).pathname,
    };
    return tracer.startActiveSpan("dusk.request", { attributes }, async (span) => {
      try {
        const response = await handleRequest(request, platform, shell, span);
        if (response.status >= 500) span.setStatus({ code: 2, message: String(response.status) });
        return response;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: 2, message: error instanceof Error ? error.message : "error" });
        throw error;
      } finally {
        span.end();
      }
    });
  };

  /**
   * The route a framing rejection answers for, before routing ran: an API route or a server function keeps its JSON
   * error shape. Any other path has no route (`none`), so the Accept header decides, as for every other error.
   */
  const routeOfRejection = async (url: URL): Promise<RouteInfo> => {
    const appPath = stripBase(url.pathname);
    if (appPath?.startsWith(RPC_PREFIX) && capabilities.rpc !== undefined) {
      return { kind: "rpc", id: appPath.slice(RPC_PREFIX.length), params: NO_PARAMS };
    }
    const hit =
      appPath === undefined || capabilities.apiRoutes === undefined
        ? undefined
        : await capabilities.apiRoutes.match(url.pathname, "public");
    return hit === undefined
      ? { kind: "none", id: undefined, params: NO_PARAMS }
      : { kind: "api", id: hit.id, params: hit.params };
  };

  const handleRequest = async (
    request: Request,
    platform: unknown,
    shell: boolean,
    span?: SpanLike,
  ): Promise<Response> => {
    if (observing !== undefined) await observing;
    if (declaresRouting && routingModule === undefined) routingModule = await import("./routing");
    // A fragment is never sent by a browser; a caller that builds a Request with one must not
    // change routing or the event's hash, so the server URL carries none (G-C4).
    const url = new URL(request.url);
    url.hash = "";
    // One controller per request follows the connection (`request.signal`) and the request timeout. `AbortSignal.any` is not
    // used: Node keeps every composite signal alive after it is unreachable (about 650 bytes each), so the heap grew with
    // the number of requests served.
    const requestController = new AbortController();
    const signal = requestController.signal;
    if (request.signal.aborted) requestController.abort(request.signal.reason);
    else {
      request.signal.addEventListener(
        "abort",
        () => requestController.abort(request.signal.reason),
        { once: true },
      );
    }

    // Guards that need nothing but the request line and headers.
    let rejected: HttpError | undefined;
    if (request.url.length > config.limits.maxUrlLength)
      rejected = new HttpError(414, "URI Too Long");
    else if (!ALLOWED_METHODS.has(request.method)) {
      // A token Dusk does not know (TRACE, PURGE) is not implemented: 501. A known method a route lacks is a 405.
      rejected = new HttpError(501, "Not Implemented", { headers: { allow: ALLOW_HEADER } });
    } else if (
      config.hostAllowed !== undefined &&
      url.pathname !== config.healthPath &&
      !config.hostAllowed(url.host)
    ) {
      rejected = new HttpError(400, "Bad Request");
    } else {
      // The ceiling of a route's own limit: the route is not known yet, so a declared length up to it is allowed here
      // and `answer` refuses it against the route's limit.
      const framing = checkFraming(request.headers, config.limits.maxRouteBodyBytes);
      if (framing !== undefined) rejected = new HttpError(framing.status, framing.message);
    }

    // Bounded by the app's limit; `answer` raises it to the route's own limit before the body is read.
    const bodyCap: BodyCap = {
      limit: config.limits.maxBodyBytes,
      form: config.limits.form,
      dev: config.dev,
    };
    const bounded = rejected === undefined ? boundRequest(request, bodyCap, signal) : request;
    const event = new EventState({
      request: bounded,
      url,
      signal,
      id: crypto.randomUUID(),
      nonce: config.nonce ? randomNonce() : undefined,
      signer: config.signer,
      // Browsers accept Secure cookies from localhost over http; in development that is the default.
      secureCookies: !(config.dev && url.protocol === "http:" && isLoopback(url.hostname)),
      env: EMPTY_ENV,
      platform,
      clientAddress: resolveClientAddress(peerOf(platform), request.headers, config.trustProxy),
      dev: config.dev,
      base: config.base,
      trailingSlash: config.trailingSlash,
      geo: hostGeoOf(platform),
      lang: config.document.lang,
      bodyCap,
    });

    observer?.begin(event, span);
    // Revalidation (revalidatePath, revalidateTag) called in this request reaches the cache of this handler.
    capabilities.isr?.adopt(event);
    capabilities.dataCache?.adopt(event);
    // Middleware sees route failures as responses (see `runMiddleware`).
    bindFailureMapper(event, (thrown) => failureResponse(event, thrown));
    if (rejected !== undefined) {
      event.route = await routeOfRejection(url);
      return finalize(event, failureResponse(event, rejected));
    }
    if (request.signal.aborted) return finalize(event, new Response(null, { status: 499 }));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new RequestTimeoutError(config.limits.requestTimeoutMs);
        requestController.abort(error);
        reject(error);
      }, config.limits.requestTimeoutMs);
    });
    const work = runWithEvent(
      event,
      async (): Promise<Response> => {
        event.env = envFor(platform);
        event.sourcePath = stripBase(event.url.pathname);
        await notifyRequest(event);
        if (capabilities.draftMode !== undefined) {
          event.draft = await capabilities.draftMode.enabledFor(event.request, platform);
        }
        if (!shell) {
          const early = routeEarly(event);
          if (early !== undefined) return early;
        }
        let resolution = await resolve(event, shell);
        if (!shell && resolution.kind === "page" && !resolution.shell && !matchesPage(event)) {
          resolution = await rewriteLate(event, resolution);
        }
        const currentPath = stripBase(event.url.pathname) ?? "/";
        event.noClient = ruleOf(currentPath).csr === false;
        return answer(event, resolution);
      },
      config.asyncContext,
    );
    try {
      return await scheduleAfter(
        event,
        await finalize(event, await Promise.race([work, timedOut])),
      );
    } catch (error) {
      void work.catch((late: unknown) => {
        // The race already answered; a later failure of the abandoned work must not vanish.
        if (late !== error) report(late, "request", event);
      });
      return await scheduleAfter(event, await finalize(event, failureResponse(event, error)));
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * The static-file gate (`runMiddlewareForStaticFiles`): the global middleware runs for a request that names a file the
   * server would serve. The guards (URL, method, Host) run first, as for any request. A middleware that calls `next()`
   * lets the file through, with the headers and cookies it set (`fileHeaders`). Any other answer is the answer to the
   * request: a refusal, a redirect, a failure, or the answer of a rewrite's target. The request timeout applies.
   */
  const gateAsset = async (request: Request, platform: unknown): Promise<AssetDecision> => {
    const url = new URL(request.url);
    url.hash = "";
    const event = new EventState({
      request,
      url,
      signal: request.signal,
      id: crypto.randomUUID(),
      nonce: config.nonce ? randomNonce() : undefined,
      signer: config.signer,
      secureCookies: !(config.dev && url.protocol === "http:" && isLoopback(url.hostname)),
      env: EMPTY_ENV,
      platform,
      clientAddress: resolveClientAddress(peerOf(platform), request.headers, config.trustProxy),
      dev: config.dev,
      base: config.base,
      trailingSlash: config.trailingSlash,
      geo: hostGeoOf(platform),
      lang: config.document.lang,
      bodyCap: { limit: config.limits.maxBodyBytes, form: config.limits.form, dev: config.dev },
    });
    event.route = { kind: "none", id: undefined, params: NO_PARAMS };
    event.sourcePath = stripBase(url.pathname);
    bindFailureMapper(event, (thrown) => failureResponse(event, thrown));
    const answer = async (response: Response): Promise<AssetDecision> => ({
      kind: "answer",
      response: await finalize(event, response),
    });
    if (
      request.url.length > config.limits.maxUrlLength ||
      (config.hostAllowed !== undefined && !config.hostAllowed(url.host))
    ) {
      return answer(failureResponse(event, new HttpError(400, "Bad Request")));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RequestTimeoutError(config.limits.requestTimeoutMs));
      }, config.limits.requestTimeoutMs);
    });
    try {
      return await Promise.race([
        runWithEvent(
          event,
          async (): Promise<AssetDecision> => {
            event.env = envFor(platform);
            const passed = new Response(null, { status: 204, headers: { [GATE_PASS]: "1" } });
            const outcome = await runMiddleware(config.middleware, event, async () => passed);
            if (outcome.headers.get(GATE_PASS) === null) {
              const moved = rewriteOf(outcome);
              return answer(moved === undefined ? outcome : await rewriteTo(event, moved));
            }
            return { kind: "serve", headers: fileHeaders(event, outcome) };
          },
          config.asyncContext,
        ),
        timedOut,
      ]);
    } catch (error) {
      return answer(failureResponse(event, error));
    } finally {
      clearTimeout(timer);
    }
  };

  /** The headers of a file the middleware let through: its own headers and cookies, without the framing the file owns. */
  const fileHeaders = (event: EventState, outcome: Response): Headers => {
    const headers = new Headers();
    for (const [name, value] of outcome.headers) {
      if (name === GATE_PASS || name === "set-cookie" || FILE_OWNED.has(name)) continue;
      headers.set(name, value);
    }
    for (const [name, value] of event.responseHeaders) {
      if (name === "set-cookie" || FILE_OWNED.has(name)) continue;
      headers.set(name, value);
    }
    for (const cookie of outcome.headers.getSetCookie()) headers.append("set-cookie", cookie);
    for (const cookie of event.responseHeaders.getSetCookie()) headers.append("set-cookie", cookie);
    for (const cookie of event.cookies.serialized()) headers.append("set-cookie", cookie);
    return headers;
  };

  registerInstrumentation(instrumentation, (error) => report(error, "instrumentation", undefined));
  const fetchHandler: DuskHandler["fetch"] = (request, platform) =>
    handle(request, platform, false);
  const streams = capabilities.streams;
  return {
    get env() {
      return parsedEnv;
    },
    // An empty list is no host check, which the type reports as `undefined` (see DuskHandler).
    allowedHosts:
      options.security?.allowedHosts?.length === 0 ? undefined : options.security?.allowedHosts,
    fetch: fetchHandler,
    // The shell needs the pages feature; without it the promise rejects with the factory to add.
    renderShell: (request = new Request("http://localhost/")) =>
      capabilities.pages === undefined
        ? Promise.reject(missingFeature("pages", "renderShell()"))
        : handle(request, undefined, true),
    // Only a handler with the streams feature takes WebSocket upgrades (a transport checks for the member).
    ...(streams === undefined
      ? {}
      : {
          webSocketLimits: streams.limits,
          upgrade: (request: Request, platform?: unknown) => streams.upgrade(request, platform),
        }),
    // Only a handler that runs its middleware for files is asked about them (see `runMiddlewareForStaticFiles`).
    ...(options.runMiddlewareForStaticFiles === true ? { gateAsset } : {}),
  };
}
