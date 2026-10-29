import { type CacheLifeProfile, resolveCacheLife } from "../shared/cache-life";
import type { GlobalErrorModule } from "../shared/global-error";
import { cacheControlOf } from "../shared/header-value";
import { type CookieSigner, createCookieSigner } from "./cookies";
import { type ResolvedCors, resolveCors } from "./cors";
import { buildCsp, type CspOptions } from "./csp";
import { normalizeOrigins } from "./csrf";
import { errorDigest } from "./digest";
import type { NotFoundPage } from "./errors";
import { compileHostRules } from "./hosts";
import { DEFAULT_FORM_LIMITS, DEFAULT_LIMITS, type FormLimits } from "./limits";
import { readProcessEnv } from "./request-env";
import { secureHeaderEntries } from "./secure-headers";
import type {
  DocumentOptions,
  DuskRuntimeManifest,
  ErrorInfo,
  HandlerOptions,
  Middleware,
  RequestEvent,
  SecureHeadersOptions,
  TrustProxyOptions,
} from "./types";

/** The options of a handler after validation and defaults. @internal */
export interface ResolvedConfig {
  readonly manifest: DuskRuntimeManifest;
  readonly mode: "string" | "async" | "stream";
  readonly middleware: readonly Middleware[];
  readonly dev: boolean;
  /** Production without `allowedHosts`: the handler sends its note on the first request (see `productionHostNote`). */
  readonly productionHostUnset: boolean;
  readonly base: string;
  readonly trailingSlash: "never" | "always" | "preserve";
  readonly trustedOrigins: ReadonlySet<string>;
  readonly hostAllowed: ((host: string) => boolean) | undefined;
  readonly limits: {
    readonly maxUrlLength: number;
    readonly maxBodyBytes: number;
    /** The ceiling of a route's own body limit; never below `maxBodyBytes`. */
    readonly maxRouteBodyBytes: number;
    readonly form: FormLimits;
    readonly requestTimeoutMs: number;
    readonly streamTimeoutMs: number;
  };
  readonly headers: SecureHeadersOptions | false | undefined;
  readonly csp: CspOptions | undefined;
  readonly csrf: {
    readonly enabled: boolean;
    readonly allowMissingOrigin: boolean;
    readonly trusted: ReadonlySet<string>;
  };
  readonly signer: CookieSigner | undefined;
  readonly trustProxy: TrustProxyOptions | undefined;
  readonly nonce: boolean;
  /** The `x-request-id` value: `false` omits the header; otherwise it is named by this function (default: the event id). */
  readonly requestId: false | ((event: RequestEvent) => string);
  /** The answer to an unsupported method: the error body (`json`) or an empty 405 (`empty`). */
  readonly methodNotAllowed: "json" | "empty";
  /** The `cache-control` of a response that sets none (`security.defaultCacheControl`), or `false` for none. */
  readonly defaultCacheControl: string | false;
  /** Whether a buffered page a cache may keep gets a generated weak ETag (`cache.etag`, default true). */
  readonly cacheEtag: boolean;
  readonly document: Required<Pick<DocumentOptions, "lang" | "rootId">> & {
    readonly head: NonNullable<DocumentOptions["head"]>;
    readonly bodyClass: string | undefined;
  };
  readonly renderId: string;
  readonly renderHeader: boolean;
  readonly maxPayloadBytes: number;
  readonly rpc: {
    readonly maxGetPayloadChars: number;
    readonly maxResponseBytes: number;
    readonly maxBatchSize: number;
  };
  readonly healthPath: string | undefined;
  /** The CORS rule for API routes, or `undefined`. */
  readonly cors: ResolvedCors | undefined;
  /** The `cacheLife` profiles in force (presets and the configured ones). */
  readonly cacheLife: Readonly<Record<string, CacheLifeProfile>>;
  /** The global error document, or `undefined` for the built-in 500 page. */
  readonly globalError: GlobalErrorModule | undefined;
  /** The built-in 404 page's title and indexing, or `undefined` for the status page (`notFoundPage: false`). */
  readonly notFoundPage: NotFoundPage | undefined;
  /** The deployment id, or `undefined` when no skew check is made. */
  readonly deploymentId: string | undefined;
  readonly asyncContext: boolean;
  readonly report: (error: unknown, info: ErrorInfo) => void;
  readonly warn: (message: string) => void;
}

const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const ROOT_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RENDER_ID = /^[A-Za-z0-9_-]+$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 1)
    throw new RangeError(__DEV__ ? `${name} must be a positive integer.` : `DUSK_POSITIVE ${name}`);
  return chosen;
}

/** The form caps with their defaults, each a positive integer (`security.limits.form`). */
function formLimitsOf(options: Partial<FormLimits> | undefined): FormLimits {
  return {
    maxFields: positiveInteger(
      "limits.form.maxFields",
      options?.maxFields,
      DEFAULT_FORM_LIMITS.maxFields,
    ),
    maxFileCount: positiveInteger(
      "limits.form.maxFileCount",
      options?.maxFileCount,
      DEFAULT_FORM_LIMITS.maxFileCount,
    ),
    maxFileBytes: positiveInteger(
      "limits.form.maxFileBytes",
      options?.maxFileBytes,
      DEFAULT_FORM_LIMITS.maxFileBytes,
    ),
    maxFieldBytes: positiveInteger(
      "limits.form.maxFieldBytes",
      options?.maxFieldBytes,
      DEFAULT_FORM_LIMITS.maxFieldBytes,
    ),
    maxTotalFieldBytes: positiveInteger(
      "limits.form.maxTotalFieldBytes",
      options?.maxTotalFieldBytes,
      DEFAULT_FORM_LIMITS.maxTotalFieldBytes,
    ),
  };
}

/** Normalizes the mount point: `""` or `/segment[/segment]` without a trailing slash. */
function normalizeBase(base: string | undefined): string {
  if (base === undefined || base === "" || base === "/") return "";
  if (!base.startsWith("/") || base.startsWith("//") || /[\\?#]|\.\.|\/\//.test(base)) {
    throw new TypeError(
      __DEV__ ? `base ${JSON.stringify(base)} must be a path such as "/app".` : "DUSK_BASE",
    );
  }
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * Default error sink: one line with the request id and the error's digest (the code the error page shows, see
 * `errorDigest`), then the error with its stack.
 */
function defaultReport(error: unknown, info: ErrorInfo): void {
  const id = info.event === undefined ? "-" : info.event.id;
  console.error(`[dusk] ${info.phase} error (request ${id}, digest ${errorDigest(error)})`, error);
}

/** `security.requestId` after validation (see `SecurityOptions.requestId`). */
function requestIdOf(
  value: boolean | ((event: RequestEvent) => string) | undefined,
): ResolvedConfig["requestId"] {
  if (value === undefined || value === true) return (event) => event.id;
  if (value === false) return false;
  if (typeof value === "function") return value;
  throw new TypeError(
    __DEV__
      ? "security.requestId must be true, false, or a function (event) => string."
      : "DUSK_REQID",
  );
}

/** `security.methodNotAllowed` after validation. */
function methodNotAllowedOf(value: "json" | "empty" | undefined): "json" | "empty" {
  if (value === undefined || value === "json") return "json";
  if (value === "empty") return "empty";
  throw new TypeError(
    __DEV__ ? 'security.methodNotAllowed must be "json" or "empty".' : "DUSK_METHOD",
  );
}

/**
 * Validates handler options and fills defaults. Throws at startup, so a bad configuration never
 * serves a request.
 *
 * @param options The options given to `createHandler`.
 * @returns The resolved configuration.
 * @internal
 */
/** The default for `onWarning`: the console, prefixed. Shared by every server module that warns. */
export function warnToConsole(message: string): void {
  console.warn(`[dusk] ${message}`);
}

export function resolveConfig(options: HandlerOptions): ResolvedConfig {
  const security = options.security ?? {};
  const maxBodyBytes = positiveInteger(
    "limits.maxBodyBytes",
    security.limits?.maxBodyBytes,
    DEFAULT_LIMITS.maxBodyBytes,
  );
  const limits = {
    maxUrlLength: positiveInteger(
      "limits.maxUrlLength",
      security.limits?.maxUrlLength,
      DEFAULT_LIMITS.maxUrlLength,
    ),
    maxBodyBytes,
    // A route's own limit is clamped to this ceiling, which is never below the app's limit.
    maxRouteBodyBytes: Math.max(
      maxBodyBytes,
      positiveInteger(
        "limits.maxRouteBodyBytes",
        security.limits?.maxRouteBodyBytes,
        DEFAULT_LIMITS.maxRouteBodyBytes,
      ),
    ),
    form: formLimitsOf(security.limits?.form),
    requestTimeoutMs: positiveInteger(
      "limits.requestTimeoutMs",
      security.limits?.requestTimeoutMs,
      DEFAULT_LIMITS.requestTimeoutMs,
    ),
    streamTimeoutMs: positiveInteger(
      "limits.streamTimeoutMs",
      security.limits?.streamTimeoutMs,
      DEFAULT_LIMITS.streamTimeoutMs,
    ),
  };
  const dev = options.dev ?? __DEV__;
  const warn = options.onWarning ?? warnToConsole;
  const trustedOrigins = normalizeOrigins(options.trustedOrigins ?? []);
  const csrfOptions = security.csrf;
  const csrfTrusted = normalizeOrigins(
    csrfOptions === false || csrfOptions === undefined ? [] : (csrfOptions.trustedOrigins ?? []),
  );
  for (const origin of trustedOrigins) csrfTrusted.add(origin);
  const csp = security.csp === false || security.csp === undefined ? undefined : security.csp;
  if (csp !== undefined) buildCsp(csp, "validation-nonce"); // fails now, not on the first request
  if (security.headers !== false) secureHeaderEntries(security.headers, true);
  const hosts = security.allowedHosts;
  // Production is the built bundle (`__DEV__` off) or NODE_ENV=production at start when no `dev`
  // option is given. There the Host header is attacker input, so a missing list is a startup error.
  const production =
    !dev || (options.dev === undefined && readProcessEnv()?.["NODE_ENV"] === "production");
  // Unset in production is a warning, not a startup error: a plain app must start with the defaults. The Host header
  // is only trusted to build absolute URLs and host conditions, and the host list is what makes that safe. Set
  // `allowedHosts` (the template does, from APP_URL) to close the gap.
  // The note is sent by the handler on its first request (not here), so a build that evaluates the module stays quiet.
  const productionHostUnset = hosts === undefined && production;
  if (hosts !== undefined && hosts.length === 0 && production) {
    if (security.acknowledgeNoHostCheck !== true) {
      throw new TypeError(
        "security.allowedHosts is [] (no host check) in production: set security.acknowledgeNoHostCheck: true to accept any Host, or list the host names this server answers for.",
      );
    }
  }
  const documentOptions = options.document ?? {};
  const lang = documentOptions.lang ?? options.i18n?.defaultLocale ?? "en";
  const rootId = documentOptions.rootId ?? "app";
  if (!LANG.test(lang))
    throw new TypeError(
      __DEV__ ? `document.lang ${JSON.stringify(lang)} is not a language tag.` : "DUSK_DOC_1",
    );
  if (!ROOT_ID.test(rootId))
    throw new TypeError(
      __DEV__ ? `document.rootId ${JSON.stringify(rootId)} is not a valid id.` : "DUSK_DOC_2",
    );
  const renderId = options.renderId ?? "0";
  if (!RENDER_ID.test(renderId))
    throw new TypeError(
      __DEV__ ? "dusk config: renderId must be made of letters, digits, _ and -." : "DUSK_RENDER",
    );
  const healthPath =
    options.healthPath === false ? undefined : (options.healthPath ?? "/_dusk/health");
  const base = normalizeBase(options.base);
  const trust = security.trustProxy;
  const cacheLife = resolveCacheLife(options.cacheLife);
  const cors = resolveCors(security.cors);
  if (options.deploymentId !== undefined && !DEPLOYMENT_ID.test(options.deploymentId)) {
    throw new TypeError(
      __DEV__
        ? "deploymentId must be 1 to 128 letters, digits, dots, dashes or underscores."
        : "DUSK_DEPLOY",
    );
  }
  return {
    productionHostUnset,
    manifest: options.manifest,
    mode: options.mode ?? "stream",
    middleware: options.middleware ?? [],
    dev,
    base,
    trailingSlash: options.trailingSlash ?? "never",
    trustedOrigins,
    // An empty list is the explicit "no host check" (see SecurityOptions.allowedHosts).
    hostAllowed: hosts === undefined || hosts.length === 0 ? undefined : compileHostRules(hosts),
    limits,
    headers: security.headers,
    csp,
    csrf: {
      enabled: csrfOptions !== false,
      allowMissingOrigin:
        csrfOptions === false || csrfOptions === undefined
          ? false
          : csrfOptions.allowMissingOrigin === true,
      trusted: csrfTrusted,
    },
    signer:
      security.cookieSecrets === undefined || security.cookieSecrets.length === 0
        ? undefined
        : createCookieSigner(security.cookieSecrets),
    trustProxy: trust === false || trust === undefined ? undefined : trust,
    nonce: security.nonce === true || csp !== undefined,
    requestId: requestIdOf(security.requestId),
    methodNotAllowed: methodNotAllowedOf(security.methodNotAllowed),
    defaultCacheControl:
      security.defaultCacheControl === undefined
        ? "private, no-store"
        : cacheControlOf("security.defaultCacheControl", security.defaultCacheControl),
    cacheEtag: options.cache?.etag !== false,
    document: {
      lang,
      rootId,
      head: documentOptions.head ?? "",
      bodyClass: documentOptions.bodyClass,
    },
    renderId,
    renderHeader: options.renderHeader === true,
    maxPayloadBytes: positiveInteger("maxPayloadBytes", options.maxPayloadBytes, 2 * 1024 * 1024),
    rpc: {
      maxGetPayloadChars: positiveInteger(
        "rpc.maxGetPayloadChars",
        options.rpc?.maxGetPayloadChars,
        4096,
      ),
      maxResponseBytes: positiveInteger(
        "rpc.maxResponseBytes",
        options.rpc?.maxResponseBytes,
        8 * 1024 * 1024,
      ),
      maxBatchSize: positiveInteger("rpc.maxBatchSize", options.rpc?.maxBatchSize, 25),
    },
    healthPath,
    cors,
    cacheLife,
    globalError: options.globalError,
    notFoundPage: resolveNotFoundPage(options.notFoundPage),
    deploymentId: options.deploymentId,
    asyncContext: options.asyncContext !== false,
    report: options.onError ?? defaultReport,
    warn,
  };
}

/** The built-in 404 page: `notFoundPage` with its defaults (`Not found`, `noindex`), or none for `false`. */
function resolveNotFoundPage(value: HandlerOptions["notFoundPage"]): NotFoundPage | undefined {
  if (value === false) return undefined;
  return { title: value?.title ?? "Not found", noindex: value?.noindex ?? true };
}
