import { createHash } from "node:crypto";
import { buildCsp, type CspOptions, defaultCspDirectives, NONCE_TOKEN } from "../server/csp";
import { secureHeaderEntries } from "../server/secure-headers";
import type { SecureHeadersOptions } from "../server/types";
import { matchPattern } from "../shared/path-match";
import type { CompiledPattern } from "../shared/path-pattern";
import type { ResolvedRouting } from "../shared/routing-config";
import type { StaticPage } from "../shared/static-page";

/**
 * Prerendered pages and the rule that decides how a request for one is answered (B2). A prerendered file is a
 * snapshot: it cannot carry a request's cookies, host or nonce, so a page is served from its file only when no rule
 * of the app can apply to it. Every other page is answered by the handler, per request (`mode: "handler"`), and its
 * file is never served by a static layer or the platform's CDN.
 *
 * A static page keeps the app's security headers: the secure defaults and `security.headers`, the Content-Security-
 * Policy with its `{nonce}` sources removed (a file has no nonce), and the header rules of `headers` and `routeRules`
 * that match its path and have no conditions. Per-request values are not static: `x-request-id`, `set-cookie` and the
 * handler's `cache-control` default. HSTS is listed apart (`httpsHeaders`): only a server that knows the request came
 * over https may send it.
 *
 * This module is build-time code (the Vite plugin and the adapters); it never runs in the server bundle.
 *
 * @packageDocumentation
 */

/** A prerendered page as the build knows it. @internal */
export interface StaticPageInput {
  readonly path: string;
  /** The HTML the prerender wrote; `undefined` when the page is not HTML (no CSP is sent for it, as the handler does). */
  readonly html: string | undefined;
  /** A route or `_middleware` module runs for this page. */
  readonly routeMiddleware: boolean;
}

/** What the policy reads. @internal */
export interface StaticPagePolicyInput {
  readonly routing: ResolvedRouting;
  readonly headers?: false | SecureHeadersOptions | undefined;
  readonly csp?: false | CspOptions | undefined;
  /**
   * A reason every page is handler-rendered whatever its path: a global middleware runs for every request, or the entry's
   * options cannot be read (see `vite/entry-static-options.ts`). Absent: the pages are decided one by one.
   */
  readonly wholeApp?: string | undefined;
  readonly pages: readonly StaticPageInput[];
}

/** A `<script>` element with its text, and a `<style>` element with its text. @internal */
const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_ELEMENT = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
const DATA_SCRIPT_TYPES: ReadonlySet<string> = new Set(["application/json", "application/ld+json"]);

/** Headers a static file's response is built from, not taken from the app: they never reach a page's file. @internal */
const FILE_OWNED: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "etag",
  "last-modified",
  "accept-ranges",
  "vary",
  "set-cookie",
  "x-request-id",
]);

/** The CSP source of an inline block: its SHA-256 hash, which is what a browser checks the text against. @internal */
function hashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * The CSP sources of the inline code a prerendered page carries: a hash per executable inline `<script>` (a script with
 * no `src` that is not a data block) for `script-src`, and per `<style>` element for `style-src`. A file has no nonce,
 * so its inline code is allowed by hash instead: the text is fixed at build time, and only that text is allowed.
 * @param html The page.
 * @returns The sources, unique, for each directive.
 * @internal
 * @example inlineSourcesOf('<script type="module" src="/a.js"></script>'); // { script: [], style: [] }
 * @since 1.0.0
 */
export function inlineSourcesOf(html: string): {
  readonly script: string[];
  readonly style: string[];
} {
  const script = new Set<string>();
  const style = new Set<string>();
  for (const match of html.matchAll(SCRIPT_ELEMENT)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
    if (type !== undefined && DATA_SCRIPT_TYPES.has(type)) continue;
    script.add(hashSource(match[2] ?? ""));
  }
  for (const match of html.matchAll(STYLE_ELEMENT)) style.add(hashSource(match[2] ?? ""));
  return { script: [...script], style: [...style] };
}

/**
 * The CSP of a static page: the app's policy with every `{nonce}` source removed. A directive whose only source was the
 * nonce keeps `'self'` (same-origin only), never an empty list, so no directive falls back to a looser default.
 * @param csp The app's CSP options.
 * @returns The header value.
 * @internal
 * @since 1.0.0
 */
export function staticCspValue(
  csp: CspOptions,
  inline: { readonly script: readonly string[]; readonly style: readonly string[] } = {
    script: [],
    style: [],
  },
): string {
  const defaults = csp.useDefaults === false ? {} : defaultCspDirectives();
  const merged = new Map<string, readonly string[] | true>(Object.entries(defaults));
  for (const [name, sources] of Object.entries(csp.directives ?? {})) merged.set(name, sources);
  const directives: Record<string, readonly string[] | true> = {};
  for (const [name, sources] of merged) {
    if (sources === true) {
      directives[name] = true;
      continue;
    }
    const kept = sources.filter((source) => source !== NONCE_TOKEN);
    directives[name] = kept.length === 0 && sources.length > 0 ? ["'self'"] : kept;
  }
  // The inline code of the page is allowed by hash. A directive the policy does not set falls back to default-src; it is
  // written out with that fallback so the hashes add to it rather than replace it. With neither, nothing is restricted.
  for (const [directive, hashes] of [
    ["script-src", inline.script],
    ["style-src", inline.style],
  ] as const) {
    if (hashes.length === 0) continue;
    const base = directives[directive] ?? directives["default-src"];
    if (base === undefined || base === true) continue;
    directives[directive] = [...base, ...hashes];
  }
  return buildCsp(
    {
      directives,
      useDefaults: false,
      ...(csp.reportUri === undefined ? {} : { reportUri: csp.reportUri }),
    },
    undefined,
  );
}

/** Whether any condition of a rule is present (a rule with conditions depends on the request). @internal */
function hasConditions(rule: {
  readonly has: readonly unknown[];
  readonly missing: readonly unknown[];
}): boolean {
  return rule.has.length > 0 || rule.missing.length > 0;
}

/**
 * Why a page cannot be served from its file, or `undefined` when nothing in the app applies to it.
 * @internal
 */
function handlerReason(
  page: StaticPageInput,
  routing: ResolvedRouting,
  ignoreCase: boolean,
  wholeApp: string | undefined,
): string | undefined {
  if (wholeApp !== undefined) return wholeApp;
  const at = (pattern: CompiledPattern): boolean =>
    matchPattern(pattern, page.path, ignoreCase) !== undefined;
  if (page.routeMiddleware) return "a middleware of the route or a _middleware folder runs for it";
  if (routing.redirects.some((rule) => at(rule.match))) return "a redirect rule matches the path";
  const rewrites = [
    ...routing.rewrites.beforeFiles,
    ...routing.rewrites.afterFiles,
    ...routing.rewrites.fallback,
  ];
  if (rewrites.some((rule) => at(rule.match))) return "a rewrite rule matches the path";
  if (routing.routeRules.some((rule) => rule.redirect !== undefined && at(rule.match))) {
    return "a route rule redirects the path";
  }
  if (routing.headers.some((rule) => hasConditions(rule) && at(rule.match))) {
    return "a header rule with conditions (host, cookie, header or query) matches the path";
  }
  return undefined;
}

/**
 * The header set of a static page: the same order and precedence as the handler's answer for a page that no rule
 * depends on (secure defaults, then the CSP, then unconditioned header rules, then route-rule headers; a rule
 * overrides only when it says so, and a route rule fills in what is absent).
 * @internal
 */
function staticHeaders(
  path: string,
  routing: ResolvedRouting,
  ignoreCase: boolean,
  headers: false | SecureHeadersOptions | undefined,
  csp: false | CspOptions | undefined,
  page: { readonly html: string | undefined },
): (readonly [string, string])[] {
  const isHtml = page.html !== undefined;
  // The CSP is sent for HTML only, as the handler sends it (see `finalize` in server/handler.ts).
  const out = new Map<string, string>();
  if (headers !== false) {
    for (const [name, value] of secureHeaderEntries(headers, false)) out.set(name, value);
  }
  if (csp !== undefined && csp !== false && isHtml) {
    const inline = page.html === undefined ? undefined : inlineSourcesOf(page.html);
    out.set(
      csp.reportOnly === true ? "content-security-policy-report-only" : "content-security-policy",
      staticCspValue(csp, inline),
    );
  }
  // Header rules: the last matching rule decides a name's value; it overrides a header already set only when it says so.
  const rules = new Map<string, readonly [string, boolean]>();
  for (const rule of routing.headers) {
    if (matchPattern(rule.match, path, ignoreCase) === undefined || hasConditions(rule)) continue;
    for (const [name, value] of rule.headers) rules.set(name, [value, rule.override]);
  }
  for (const [name, [value, override]] of rules) {
    if (override || !out.has(name)) out.set(name, value);
  }
  // Route rules merge least specific first, so the most specific headers win; they fill in only what is absent.
  const routeHeaders = new Map<string, string>();
  for (const entry of routing.routeRules) {
    if (matchPattern(entry.match, path, ignoreCase) === undefined) continue;
    for (const [name, value] of Object.entries(entry.rule.headers ?? {}))
      routeHeaders.set(name, value);
  }
  for (const [name, value] of routeHeaders) if (!out.has(name)) out.set(name, value);
  // The file server owns the representation of the file (its type, length, encoding and validators) and the per-request
  // values: a rule that names one of them must not reach the file, or the response would describe another body.
  return [...out.entries()].filter(([name]) => !FILE_OWNED.has(name));
}

/**
 * Decides how every prerendered page is answered, and the headers of the static ones.
 * @param input The routing, the security options and the prerendered pages.
 * @param ignoreCase Whether the router matches without ASCII case (`router.caseSensitive` off, the default).
 * @returns One entry per page, in input order.
 * @example
 * staticPagesOf({ routing, headers, csp, pages: [{ path: "/", html, routeMiddleware: false }] }, true);
 * @internal
 * @since 1.0.0
 */
export function staticPagesOf(input: StaticPagePolicyInput, ignoreCase = true): StaticPage[] {
  return input.pages.map((page): StaticPage => {
    const reason = handlerReason(page, input.routing, ignoreCase, input.wholeApp);
    if (reason !== undefined) {
      return { path: page.path, mode: "handler", headers: [], httpsHeaders: [], reason };
    }
    const httpsHeaders =
      input.headers === false
        ? []
        : secureHeaderEntries(input.headers, true).filter(
            ([name]) => name === "strict-transport-security",
          );
    return {
      path: page.path,
      mode: "static",
      headers: staticHeaders(page.path, input.routing, ignoreCase, input.headers, input.csp, page),
      httpsHeaders,
      reason: undefined,
    };
  });
}
