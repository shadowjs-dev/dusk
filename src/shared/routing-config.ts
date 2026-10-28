/**
 * The declarative routing of `dusk.config.ts`: redirects, rewrites, headers and route rules. This file
 * is pure (no Node, no request): the build validates the configuration with it, and the handler
 * compiles the same validated shape at server start, so both read a rule the same way.
 *
 * Evaluation order (pinned by the tests):
 * - redirects: declaration order, the first match answers; the target is checked by
 *   `checkRedirectTarget` when it is used;
 * - rewrites: `beforeFiles` (before the route is matched), then `afterFiles` and `fallback` only when no
 *   page matches; within a phase the first match wins, and a request is rewritten at most once per phase;
 * - headers: every matching rule applies, in declaration order (a later rule overwrites an earlier one). A
 *   header a route or the handler set for the same name wins over a rule unless the rule sets
 *   `override: true` (then the rule wins); see `HeaderRule.override`.
 * - route rules: every matching rule merges, least specific first, so the most specific rule wins a
 *   property; equal shapes merge in declaration order.
 *
 * @packageDocumentation
 */

import { expectKeys } from "./check";
import { cacheControlOf, headersOf, TOKEN } from "./header-value";
import {
  type CompiledPattern,
  comparePatterns,
  compilePattern,
  fillPattern,
  templateNames,
} from "./path-pattern";

/** Redirect status codes. @since 1.0.0 */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/** A request condition: a header, cookie or query parameter, or the host. @since 1.0.0 */
export interface RouteCondition {
  readonly type: "header" | "cookie" | "query" | "host";
  /** The header, cookie or query name (not for `host`). */
  readonly key?: string;
  /** The exact value to match. Without it the condition is that the key is present. */
  readonly value?: string;
}

/** A redirect. @since 1.0.0 */
export interface RedirectRule {
  readonly source: string;
  /** An app path (`/new/:id`) or an absolute URL of a trusted origin. */
  readonly destination: string;
  /** `true` gives 308; `false` or absent gives 307. */
  readonly permanent?: boolean;
  /** Overrides `permanent`. */
  readonly statusCode?: RedirectStatus;
  readonly has?: readonly RouteCondition[];
  readonly missing?: readonly RouteCondition[];
}

/** A rewrite: the request is served by another path, the URL does not change. @since 1.0.0 */
export interface RewriteRule {
  readonly source: string;
  /** An app path (may carry a query string). Never a foreign URL, never under `/_dusk/`. */
  readonly destination: string;
  readonly has?: readonly RouteCondition[];
  readonly missing?: readonly RouteCondition[];
}

/** Rewrites by phase. @since 1.0.0 */
export interface RewriteRules {
  /** Before the route is matched. */
  readonly beforeFiles?: readonly RewriteRule[];
  /** When no page matches the path (the rules of an array are this phase too). */
  readonly afterFiles?: readonly RewriteRule[];
  /** Last resort, when no page matches and the `afterFiles` rules did not apply. */
  readonly fallback?: readonly RewriteRule[];
}

/** Response headers for matching paths. @since 1.0.0 */
export interface HeaderRule {
  readonly source: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly has?: readonly RouteCondition[];
  readonly missing?: readonly RouteCondition[];
  /**
   * Precedence against the header a route or the handler set for the same name. `false` (default): the
   * route wins, the rule fills in only what is absent. `true`: the rule overrides it (Next's `headers()`).
   */
  readonly override?: boolean;
}

/** The ISR options of a route rule. @since 1.0.0 */
export interface RouteCacheOptions {
  /** Seconds a stale page may still be served while it regenerates. */
  readonly staleSeconds?: number;
  /** Cookies that take part in the cache key (other cookies make a request uncacheable). */
  readonly cookies?: readonly string[];
  /** Query parameters that take part in the cache key (all when absent). */
  readonly searchParams?: readonly string[];
  /**
   * Also send `CDN-Cache-Control` with the origin's directives, so a shared cache or CDN keeps the page for the same
   * window as the browser's policy. `{ surrogate: true }` also sends `Surrogate-Control` (for CDNs that read it). A page
   * keyed on cookies is private and sends neither.
   */
  readonly cdn?: boolean | { readonly surrogate?: boolean };
}

/** The settings of one route rule. Every field is optional. @since 1.0.0 */
export interface RouteRule {
  /** `false` turns caching off for the path; an object sets the ISR options. */
  readonly cache?: false | RouteCacheOptions;
  /** Seconds a rendered page is fresh (the default when the page exports no `revalidate`); `false` never. */
  readonly revalidate?: number | false;
  /** Renders the path at build time. Only for a literal path (no parameters or wildcards). */
  readonly prerender?: boolean;
  /** Response headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The `cache-control` of the path's responses that set none, in place of `security.defaultCacheControl`. A string
   * sets it; `false` leaves the responses without it. A `cache-control` the route or a `headers` rule sets wins.
   */
  readonly cacheControl?: string | false;
  /** Redirects the path. */
  readonly redirect?: { readonly to: string; readonly statusCode?: RedirectStatus };
  /** `false`: the document is served without rendering the route (the browser renders it). */
  readonly ssr?: false;
  /** `false`: the page ships no client JavaScript. */
  readonly csr?: boolean;
}

/** The whole declarative routing. @since 1.0.0 */
export interface RoutingConfig {
  readonly redirects?: readonly RedirectRule[];
  /** An array is the `afterFiles` phase. */
  readonly rewrites?: readonly RewriteRule[] | RewriteRules;
  readonly headers?: readonly HeaderRule[];
  readonly routeRules?: Readonly<Record<string, RouteRule>>;
}

/** A destination after validation. @internal */
export interface Destination {
  readonly kind: "path" | "absolute";
  /** The destination as it will be filled: a path with `:name` tokens, or an absolute URL. */
  readonly template: string;
}

/** A validated condition. @internal */
export interface Condition {
  readonly type: RouteCondition["type"];
  readonly key: string | undefined;
  readonly value: string | undefined;
}

/** A validated redirect. @internal */
export interface ResolvedRedirect {
  readonly source: string;
  readonly match: CompiledPattern;
  readonly destination: Destination;
  readonly status: RedirectStatus;
  readonly has: readonly Condition[];
  readonly missing: readonly Condition[];
}

/** A validated rewrite. @internal */
export interface ResolvedRewrite {
  readonly source: string;
  readonly match: CompiledPattern;
  readonly destination: Destination;
  readonly has: readonly Condition[];
  readonly missing: readonly Condition[];
}

/** A validated header rule. @internal */
export interface ResolvedHeaders {
  readonly source: string;
  readonly match: CompiledPattern;
  readonly headers: readonly (readonly [string, string])[];
  readonly has: readonly Condition[];
  readonly missing: readonly Condition[];
  /** True when the rule overrides a header the route set for the same name (see `HeaderRule`). */
  readonly override: boolean;
}

/** A validated route rule. @internal */
export interface ResolvedRouteRule {
  readonly source: string;
  readonly match: CompiledPattern;
  readonly rule: RouteRule;
  readonly redirect:
    | { readonly destination: Destination; readonly status: RedirectStatus }
    | undefined;
}

/** The validated routing. @since 1.0.0 */
export interface ResolvedRouting {
  readonly redirects: readonly ResolvedRedirect[];
  readonly rewrites: {
    readonly beforeFiles: readonly ResolvedRewrite[];
    readonly afterFiles: readonly ResolvedRewrite[];
    readonly fallback: readonly ResolvedRewrite[];
  };
  readonly headers: readonly ResolvedHeaders[];
  /** Least specific first; merging in this order lets the most specific rule win. */
  readonly routeRules: readonly ResolvedRouteRule[];
  /**
   * Whether the literal parts of a source match without ASCII case. The handler sets it when the router does
   * (`router.caseSensitive` off, the default), so a rule covers every spelling the router serves: `/ADMIN` as well
   * as `/admin`.
   */
  readonly ignoreCase?: boolean;
}

/** Options of {@link validateRouting}. @since 1.0.0 */
export interface RoutingValidationOptions {
  /** Origins an absolute redirect may point to (`security.trustedOrigins`). */
  readonly trustedOrigins?: Iterable<string>;
  /** See {@link ResolvedRouting.ignoreCase}. Default `false` (the build validates; the handler decides case). */
  readonly ignoreCase?: boolean;
}

const ROUTING_KEYS = ["redirects", "rewrites", "headers", "routeRules"] as const;
const REDIRECT_KEYS = [
  "source",
  "destination",
  "permanent",
  "statusCode",
  "has",
  "missing",
] as const;
const REWRITE_KEYS = ["source", "destination", "has", "missing"] as const;
const REWRITE_PHASES = ["beforeFiles", "afterFiles", "fallback"] as const;
const HEADER_KEYS = ["source", "headers", "has", "missing", "override"] as const;
const ROUTE_RULE_KEYS = [
  "cache",
  "revalidate",
  "prerender",
  "headers",
  "cacheControl",
  "redirect",
  "ssr",
  "csr",
] as const;
const CACHE_KEYS = ["staleSeconds", "cookies", "searchParams", "cdn"] as const;
const CONDITION_KEYS = ["type", "key", "value"] as const;
const CONDITION_TYPES = ["header", "cookie", "query", "host"] as const;
const STATUSES: readonly RedirectStatus[] = [301, 302, 303, 307, 308];

export { cacheControlOf };

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\\]/;

/** Re-throws a validation error with the place it was found. @internal */
function at<T>(where: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new TypeError(`${where}: ${error.message}`);
    }
    throw error;
  }
}

function patternOf(where: string, source: unknown): CompiledPattern {
  if (typeof source !== "string") throw new TypeError(`${where}.source must be a string.`);
  return at(`${where}.source`, () => compilePattern(source));
}

/** A pattern with no parameter, wildcard or rest: one fixed path. @internal */
function isLiteral(pattern: CompiledPattern): boolean {
  return pattern.rest === "none" && pattern.segments.every((segment) => segment.kind === "literal");
}

function captureNames(pattern: CompiledPattern): Set<string> {
  const names = new Set<string>();
  for (const segment of pattern.segments) if (segment.kind === "param") names.add(segment.name);
  if (pattern.restName !== undefined) names.add(pattern.restName);
  return names;
}

/**
 * Splits a destination at its fragment: `/a?x=1#top` is `["/a?x=1", "#top"]`. The fragment starts at the first `#` and
 * runs to the end, so a `?` after it is part of the fragment, not a query.
 *
 * @param text A destination template or a target.
 * @returns The part before the fragment, and the fragment with its `#` (`""` when there is none).
 * @internal
 */
export function splitFragment(text: string): readonly [string, string] {
  const at = text.indexOf("#");
  return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at)];
}

/** Validates a destination. Paths are internal; absolute URLs need a trusted origin. @internal */
function destinationOf(
  where: string,
  raw: unknown,
  kind: "redirect" | "rewrite",
  captures: ReadonlySet<string>,
  trusted: ReadonlySet<string>,
): Destination {
  if (typeof raw !== "string" || raw === "")
    throw new TypeError(`${where}.destination must be a non-empty string.`);
  if (UNSAFE_TEXT.test(raw)) {
    throw new TypeError(
      `${where}.destination must not contain a control character or a backslash.`,
    );
  }
  if (raw.startsWith("//"))
    throw new TypeError(`${where}.destination must not start with "//" (a foreign host).`);
  if (raw.startsWith("/")) {
    // A redirect may end in a fragment: the browser keeps it from the `Location` header (`/old` to `/#download`). A
    // rewrite may not, because the server never sees one.
    const [beforeFragment, fragment] = splitFragment(raw);
    if (fragment !== "" && kind === "rewrite") {
      throw new TypeError(`${where}.destination of a rewrite must not contain a fragment.`);
    }
    const queryAt = beforeFragment.indexOf("?");
    const path = queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt);
    if (kind === "rewrite" && (path === "/_dusk" || path.startsWith("/_dusk/"))) {
      throw new TypeError(
        `${where}.destination must not point under /_dusk/ (the framework's own routes).`,
      );
    }
    at(`${where}.destination`, () => {
      const sample: Record<string, string> = {};
      for (const name of captures) sample[name] = "x";
      fillPattern(path, sample);
    });
    for (const name of templateNames(path)) {
      if (!captures.has(name)) {
        throw new TypeError(
          `${where}.destination uses ":${name}", which the source does not capture.`,
        );
      }
    }
    return { kind: "path", template: raw };
  }
  if (kind === "rewrite") {
    throw new TypeError(`${where}.destination of a rewrite must be a path of this app, not a URL.`);
  }
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new TypeError(`${where}.destination must be http(s), not ${url.protocol}`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new TypeError(`${where}.destination must not carry user information.`);
    }
    if (!trusted.has(url.origin)) {
      throw new TypeError(
        `${where}.destination is on the origin ${url.origin}, which is not in security.trustedOrigins.`,
      );
    }
    return { kind: "absolute", template: url.href };
  }
  throw new TypeError(
    `${where}.destination must start with "/" or be an absolute URL of a trusted origin.`,
  );
}

function conditionsOf(where: string, value: unknown): readonly Condition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${where} must be an array of conditions.`);
  return value["map"]((item, index) => {
    const here = `${where}[${index}]`;
    expectKeys(here, item, CONDITION_KEYS);
    const type: unknown = item["type"];
    if (typeof type !== "string" || !(CONDITION_TYPES as readonly string[]).includes(type)) {
      throw new TypeError(`${here}.type must be one of ${CONDITION_TYPES.join(", ")}.`);
    }
    const kind = type as Condition["type"];
    const key: unknown = item["key"];
    const val: unknown = item["value"];
    if (val !== undefined && typeof val !== "string")
      throw new TypeError(`${here}.value must be a string.`);
    if (type === "host") {
      if (val === undefined) throw new TypeError(`${here}.value is required for a host condition.`);
      return { type: kind, key: undefined, value: val.toLowerCase() };
    }
    if (typeof key !== "string" || key === "")
      throw new TypeError(`${here}.key is required for a ${type} condition.`);
    if (type === "header") {
      if (!TOKEN.test(key)) throw new TypeError(`${here}.key is not a valid header name.`);
      return { type: kind, key: key.toLowerCase(), value: val };
    }
    return { type: kind, key, value: val };
  });
}

function statusOf(where: string, value: unknown): RedirectStatus {
  if (!(STATUSES as readonly unknown[]).includes(value)) {
    throw new TypeError(`${where}.statusCode must be one of ${STATUSES.join(", ")}.`);
  }
  return value as RedirectStatus;
}

function cacheOf(where: string, value: unknown): false | RouteCacheOptions {
  if (value === false) return false;
  expectKeys(where, value, CACHE_KEYS);
  const options: {
    staleSeconds?: number;
    cookies?: readonly string[];
    searchParams?: readonly string[];
    cdn?: boolean | { readonly surrogate?: boolean };
  } = {};
  const cdn = value["cdn"];
  if (cdn !== undefined) {
    const surrogate =
      typeof cdn === "object" && cdn !== null ? Reflect.get(cdn, "surrogate") : undefined;
    if (
      typeof cdn !== "boolean" &&
      (typeof cdn !== "object" ||
        cdn === null ||
        Object.keys(cdn).some((key) => key !== "surrogate") ||
        (surrogate !== undefined && typeof surrogate !== "boolean"))
    ) {
      throw new TypeError(`${where}.cdn must be true, false, or { surrogate: boolean }.`);
    }
    options.cdn = typeof cdn === "boolean" ? cdn : { surrogate: surrogate === true };
  }
  if (value["staleSeconds"] !== undefined) {
    if (
      typeof value["staleSeconds"] !== "number" ||
      !Number.isFinite(value["staleSeconds"]) ||
      value["staleSeconds"] < 0
    ) {
      throw new TypeError(`${where}.staleSeconds must be a number of seconds, 0 or more.`);
    }
    options.staleSeconds = value["staleSeconds"];
  }
  for (const field of ["cookies", "searchParams"] as const) {
    const list = value[field];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item === "")) {
      throw new TypeError(`${where}.${field} must be an array of names.`);
    }
    if (field === "cookies" && list.some((item) => !TOKEN.test(String(item)))) {
      throw new TypeError(`${where}.cookies holds an invalid cookie name.`);
    }
    options[field] = [...(list as string[])];
  }
  return options;
}

function ruleOf(where: string, value: unknown, pattern: CompiledPattern): RouteRule {
  expectKeys(where, value, ROUTE_RULE_KEYS);
  const rule: { -readonly [K in keyof RouteRule]: RouteRule[K] } = {};
  if (value["cache"] !== undefined) rule.cache = cacheOf(`${where}.cache`, value["cache"]);
  if (value["revalidate"] !== undefined) {
    const seconds = value["revalidate"];
    if (
      seconds !== false &&
      (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)
    ) {
      throw new TypeError(`${where}.revalidate must be false or a positive number of seconds.`);
    }
    rule.revalidate = seconds;
  }
  if (value["prerender"] !== undefined) {
    if (typeof value["prerender"] !== "boolean")
      throw new TypeError(`${where}.prerender must be a boolean.`);
    if (value["prerender"] && !isLiteral(pattern)) {
      throw new TypeError(
        `${where}.prerender needs a literal path (no parameters or wildcards); list dynamic paths in prerender.entries.`,
      );
    }
    rule.prerender = value["prerender"];
  }
  if (value["headers"] !== undefined)
    rule.headers = Object.fromEntries(headersOf(`${where}.headers`, value["headers"]));
  if (value["cacheControl"] !== undefined) {
    rule.cacheControl = cacheControlOf(`${where}.cacheControl`, value["cacheControl"]);
  }
  if (value["redirect"] !== undefined) {
    expectKeys(`${where}.redirect`, value["redirect"], ["to", "statusCode"]);
    const statusCode =
      value["redirect"]["statusCode"] === undefined
        ? undefined
        : statusOf(`${where}.redirect`, value["redirect"]["statusCode"]);
    rule.redirect =
      statusCode === undefined
        ? { to: String(value["redirect"]["to"]) }
        : { to: String(value["redirect"]["to"]), statusCode };
  }
  if (value["ssr"] !== undefined) {
    if (value["ssr"] !== false) {
      throw new TypeError(
        `${where}.ssr accepts only false (a shell). Use defineRoute({ ssr }) for "data-only".`,
      );
    }
    rule.ssr = false;
  }
  if (value["csr"] !== undefined) {
    if (typeof value["csr"] !== "boolean") throw new TypeError(`${where}.csr must be a boolean.`);
    rule.csr = value["csr"];
  }
  return rule;
}

/**
 * Validates the declarative routing and compiles every pattern. Throws at the first problem, naming
 * the rule (`redirects[2].destination`), so a configuration error is found when the build starts, and
 * the same check runs again when the server starts.
 *
 * @param input The routing as written in `dusk.config.ts`.
 * @param options The trusted origins of absolute redirects.
 * @returns The validated routing.
 * @throws TypeError with the place and the reason; a suggestion for an unknown key.
 * @example validateRouting({ redirects: [{ source: "/old", destination: "/new", permanent: true }] }, {}).redirects[0]?.status; // 308
 * @since 1.0.0
 */
export function validateRouting(
  input: RoutingConfig,
  options: RoutingValidationOptions = {},
): ResolvedRouting {
  expectKeys("dusk.config (routing)", input as unknown, ROUTING_KEYS);
  const trusted = new Set<string>(options.trustedOrigins ?? []);
  const redirects: ResolvedRedirect[] = [];
  (input.redirects ?? []).forEach((rule, index) => {
    const where = `redirects[${index}]`;
    expectKeys(where, rule as unknown, REDIRECT_KEYS);
    const match = patternOf(where, rule.source);
    const captures = captureNames(match);
    const destination = destinationOf(where, rule.destination, "redirect", captures, trusted);
    // `statusCode` wins over `permanent`, as documented.
    const status =
      rule.statusCode === undefined
        ? rule.permanent === true
          ? 308
          : 307
        : statusOf(where, rule.statusCode);
    redirects.push({
      source: match.source,
      match,
      destination,
      status,
      has: conditionsOf(`${where}.has`, rule.has),
      missing: conditionsOf(`${where}.missing`, rule.missing),
    });
  });

  const rewriteRules = (where: string, list: unknown): ResolvedRewrite[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) throw new TypeError(`${where} must be an array of rewrites.`);
    return list.map((raw, index) => {
      const here = `${where}[${index}]`;
      expectKeys(here, raw as unknown, REWRITE_KEYS);
      const match = patternOf(here, raw["source"]);
      const destination = destinationOf(
        here,
        raw["destination"],
        "rewrite",
        captureNames(match),
        trusted,
      );
      return {
        source: match.source,
        match,
        destination,
        has: conditionsOf(`${here}.has`, raw["has"]),
        missing: conditionsOf(`${here}.missing`, raw["missing"]),
      };
    });
  };
  const rewrites = input.rewrites;
  let phases: {
    beforeFiles: ResolvedRewrite[];
    afterFiles: ResolvedRewrite[];
    fallback: ResolvedRewrite[];
  };
  if (rewrites === undefined) phases = { beforeFiles: [], afterFiles: [], fallback: [] };
  else if (Array.isArray(rewrites))
    phases = { beforeFiles: [], afterFiles: rewriteRules("rewrites", rewrites), fallback: [] };
  else {
    expectKeys("rewrites", rewrites as unknown, REWRITE_PHASES);
    const byPhase = rewrites as RewriteRules;
    phases = {
      beforeFiles: rewriteRules("rewrites.beforeFiles", byPhase.beforeFiles),
      afterFiles: rewriteRules("rewrites.afterFiles", byPhase.afterFiles),
      fallback: rewriteRules("rewrites.fallback", byPhase.fallback),
    };
  }

  const headers: ResolvedHeaders[] = (input.headers ?? []).map((rule, index) => {
    const where = `headers[${index}]`;
    expectKeys(where, rule as unknown, HEADER_KEYS);
    const match = patternOf(where, rule.source);
    if (rule.override !== undefined && typeof rule.override !== "boolean") {
      throw new TypeError(`${where}.override must be true or false.`);
    }
    return {
      source: match.source,
      match,
      headers: headersOf(`${where}.headers`, rule.headers),
      has: conditionsOf(`${where}.has`, rule.has),
      missing: conditionsOf(`${where}.missing`, rule.missing),
      override: rule.override === true,
    };
  });

  const routeEntries = Object.entries(input.routeRules ?? {});
  const routeRules: ResolvedRouteRule[] = routeEntries.map(([source, rule]) => {
    const where = `routeRules[${JSON.stringify(source)}]`;
    const match = patternOf(where, source);
    const checked = ruleOf(where, rule, match);
    const redirect =
      checked.redirect === undefined
        ? undefined
        : {
            destination: destinationOf(
              `${where}.redirect`,
              checked.redirect.to,
              "redirect",
              captureNames(match),
              trusted,
            ),
            status: checked.redirect.statusCode ?? 307,
          };
    return { source: match.source, match, rule: checked, redirect };
  });
  // Least specific first; the stable sort keeps declaration order for equal shapes.
  routeRules.sort((a, b) => comparePatterns(b.match, a.match));

  return {
    redirects,
    rewrites: phases,
    headers,
    routeRules,
    ...(options.ignoreCase === true ? { ignoreCase: true } : {}),
  };
}
