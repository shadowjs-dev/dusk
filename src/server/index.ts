/**
 * `@shadow-js/dusk/server`: the request handler and everything it is built from.
 *
 * `createHandler` is the single contract (`Request` in, `Response` out) that every adapter, the
 * dev server, the test client and prerendering call. Around it: middleware, server functions,
 * API routes, cookies, sessions, rate limiting, CSRF, secure headers, CSP and environment
 * validation.
 * @packageDocumentation
 */

export { HttpError, type HttpErrorOptions, isHttpError } from "../internal/http-error";
export {
  isNotFound,
  isRedirect,
  notFound,
  type RedirectOptions,
  type RedirectSignal,
  type RedirectStatus,
  redirect,
  redirectStatus,
} from "../internal/redirect";
export { chainRoutesOf } from "../metadata/feature";
export {
  type ChainContext,
  type ChainErrorHandler,
  type ChainRoute,
  chainHead,
  type ResolvedChain,
  resolveChain,
} from "../metadata/resolve";
export { type ActionFailure, fail, isFailure } from "../shared/action";
export {
  CACHE_LIFE_PRESETS,
  type CacheLifePreset,
  type CacheLifeProfile,
} from "../shared/cache-life";
export type { ServerFnCallOptions } from "../shared/call-options";
export { type ResponseHandle, useResponse } from "../shared/response";
export { type RouteRule, type RoutingConfig, validateRouting } from "../shared/routing-config";
export { type AbsoluteUrlOptions, absoluteUrl } from "./absolute-url";
export { after } from "./after";
export {
  type ApiContext,
  type ApiHandlerOptions,
  apiHandler,
  apiRoute,
} from "./api";
export { type BakedServerConfig, serverOptionsFromConfig } from "./baked-config";
export type { CacheControlOption } from "./cache-control";
export {
  type CacheEntry,
  type CacheStore,
  createKeyValueCacheStore,
  createMemoryCacheStore,
  type KeyValueCacheStoreOptions,
  type KeyValueClient,
  type MemoryCacheStoreOptions,
} from "./cache-store";
export {
  addressKey,
  normalizeIp,
  resolveClientAddress,
} from "./client-address";
export {
  createKey,
  DuskError,
  getRequestEvent,
  hasAsyncContext,
  runWithEvent,
  tryGetRequestEvent,
} from "./context";
export {
  COOKIE_LIMITS,
  type CookieJar,
  type CookieOptions,
  type CookieSigner,
  createCookieSigner,
  MIN_SECRET_LENGTH,
  parseCookies,
  serializeCookie,
} from "./cookies";
export type { CorsOptions } from "./cors";
export {
  buildCsp,
  type CspOptions,
  defaultCspDirectives,
  MAX_CSP_LENGTH,
  NONCE_TOKEN,
} from "./csp";
export {
  type CsrfContext,
  type CsrfDecision,
  type CsrfReason,
  checkCsrf,
  normalizeOrigins,
} from "./csrf";
export {
  type CacheDataOptions,
  type CachedFetchInit,
  type CachedFetchOptions,
  cacheData,
  cachedFetch,
  createDataCache,
  type DataCache,
  type DataCacheOptions,
} from "./data-cache";
export { DEPLOYMENT_HEADER, DEPLOYMENT_MISMATCH } from "./deployment";
export { ROUTER_PAYLOAD_ID } from "./document";
export { draftMode } from "./draft-mode";
export {
  type BooleanField,
  defineEnv,
  type EnumField,
  EnvError,
  type EnvField,
  type EnvIssue,
  type EnvOptions,
  type EnvSchema,
  type EnvShape,
  type EnvSource,
  type NumberField,
  type ParsedEnv,
  type StringField,
  type UrlField,
} from "./env";
export { RequestTimeoutError } from "./errors";
export type { DuskFeature, FeatureName } from "./features";
export { type FileOptions, file } from "./file";
export { setFlash } from "./flash";
export { type FormLimitsOptions, readFormLimited } from "./form";
export { all, any, defineGuard } from "./guard";
export { createHandler } from "./handler";
export { compileHostRules } from "./hosts";
export {
  type ImageProcessor,
  type ImageProcessorInput,
  type ImageSource,
  type ImagesOptions,
  passthroughProcessor,
  svgProcessor,
} from "./image-route";
export {
  type ResolvedAddress,
  type SafeImageFetchOptions,
  safeImageFetch,
} from "./image-safe-fetch";
export { type SharpFactory, type SharpProcessorOptions, sharpProcessor } from "./image-sharp";
export {
  type InstrumentationModule,
  NOOP_TRACER,
  type RequestErrorContext,
  type SpanLike,
  type TracerLike,
} from "./instrumentation";
export { type CacheOptions, cacheTags, revalidatePath, revalidateTag } from "./isr";
export {
  formToObject,
  html,
  isJsonContentType,
  JSON_LIMITS,
  json,
  parseJsonSafe,
  readJson,
  readJsonLimited,
  text,
} from "./json";
// Storage, caching, request lifecycle and configuration.
export {
  createKvCacheStore,
  createKvRateLimitStore,
  createKvSessionStore,
  type KvCacheStoreOptions,
} from "./kv-adapters";
export {
  createMemoryKVStore,
  type KVListOptions,
  type KVListPage,
  type KVStore,
  type KVWriteOptions,
  type MemoryKVStoreOptions,
} from "./kv-store";
export {
  BodyTooLargeError,
  checkFraming,
  DEFAULT_LIMITS,
  type FramingProblem,
  limitBody,
  readTextLimited,
} from "./limits";
export { type DefinedLocals, defineLocals, getLocals, useRequestLocals } from "./locals";
export { mergeHandlerOptions } from "./merge-options";
export {
  type ChangeFrequency,
  MAX_SITEMAP_ALTERNATES,
  MAX_SITEMAP_BYTES,
  MAX_SITEMAP_IMAGES,
  MAX_SITEMAP_TEXT,
  MAX_SITEMAP_URLS,
  MAX_SITEMAP_VIDEO_TAGS,
  MAX_VIDEO_DURATION,
  type Manifest,
  type ManifestIcon,
  type MetadataResponseOptions,
  manifestJson,
  manifestRoute,
  type RobotsConfig,
  type RobotsRule,
  robotsRoute,
  robotsTxt,
  type SitemapEntry,
  type SitemapImage,
  type SitemapIndexEntry,
  type SitemapVideo,
  sitemapIndexRoute,
  sitemapIndexXml,
  sitemapRoute,
  sitemapXml,
  xmlEscape,
} from "./metadata-routes";
export type {
  CounterLike,
  EventTiming,
  HistogramLike,
  MetricsLike,
  RequestTimings,
  ServerTimingOptions,
} from "./observe-types";
export {
  type CreateFetchOptions,
  createFetch,
  type FetchModule,
  type GeoInfo,
  type GeoPlatform,
  geoOf,
  type PlatformInit,
  platformHost,
  runtimeEnvironment,
  type WaitUntilContext,
  waitUntil,
} from "./platform";
export {
  type BucketSpec,
  createMemoryRateLimitStore,
  createRateLimiter,
  type MemoryRateLimitStoreOptions,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitMiddlewareOptions,
  type RateLimitStore,
} from "./rate-limit";
export type { ServerFnRateLimit, ServerFnRateLimitOption } from "./rate-limit-option";
export {
  checkRedirectTarget,
  RedirectBlockedError,
  type RedirectPolicy,
  resolveRedirectTarget,
} from "./redirect-target";
export { type RewriteOptions, rewrite } from "./rewrite";
export { RPC_HEADER, RPC_PREFIX } from "./rpc";
export { DEFAULT_PERMISSIONS_POLICY, secureHeaderEntries } from "./secure-headers";
export {
  bindServerFn,
  executeServerFn,
  type ServerFn,
  type ServerFnOptions,
  type StreamingServerFnOptions,
  serverFn,
} from "./server-fn";
export {
  createMemorySessionStore,
  createSessionManager,
  type MemorySessionStoreOptions,
  type Session,
  type SessionManager,
  type SessionOptions,
  type SessionRecord,
  type SessionStore,
  signIn,
} from "./session";
export {
  createEventLog,
  type EventLog,
  formatSseEvent,
  type LoggedEvent,
  type SseHandler,
  type SseMessage,
  SseOverflowError,
  type SseStream,
} from "./sse";
export {
  type InferInput,
  type InferOutput,
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Props,
  type StandardSchemaV1Result,
} from "./standard-schema";
export { timing } from "./timing";
export type {
  ApiHandler,
  ApiModule,
  ApiResult,
  AppComponent,
  ContextKey,
  CsrfOptions,
  DocumentAttributes,
  DocumentOptions,
  DuskHandler,
  DuskLocals,
  DuskRuntimeManifest,
  ErrorBody,
  ErrorInfo,
  ErrorPhase,
  Guard,
  Handler,
  HandlerOptions,
  HttpMethod,
  LimitsOptions,
  Middleware,
  MiddlewareModule,
  Next,
  RequestEvent,
  RouteInfo,
  RouteMiddlewareManifest,
  SecureHeadersOptions,
  SecurityOptions,
  ServerFnContext,
  ServerFnDefinition,
  ServerFnMiddleware,
  StreamModule,
  StreamOptions,
  TrustProxyOptions,
  UpgradeDecision,
  ValidationIssue,
} from "./types";
export { ISSUE_LIMITS, ValidationError, validate } from "./validate";
export type {
  MessageWebSocketInput,
  MessageWebSocketSink,
  WebSocketConnection,
  WebSocketHandlers,
  WebSocketInput,
  WebSocketLimits,
  WebSocketModule,
  WebSocketSink,
} from "./websocket";
export {
  CLOSE as WS_CLOSE,
  encodeFrame,
  FrameReader,
  WebSocketProtocolError,
  type WsEvent,
} from "./ws-protocol";
