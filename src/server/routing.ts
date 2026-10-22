/**
 * Runtime evaluation of the declarative routing (`redirects`, `rewrites`, `headers`, `routeRules`). The
 * rules are validated by `shared/routing-config.ts`; this file only answers "which rule applies to this
 * request". The order of evaluation is documented there and pinned by `test/runtime/routing.test.ts`.
 *
 * @packageDocumentation
 */

import {
  type CompiledPattern,
  fillPattern,
  matchPattern,
  type PathParams,
} from "../shared/path-pattern";
import type { Condition, ResolvedRouting, RouteRule } from "../shared/routing-config";
import { parseCookies } from "./cookies";
import type { EventState } from "./event";

/** Whether one condition holds for a request. @internal */
function holds(condition: Condition, request: Request, url: URL): boolean {
  switch (condition.type) {
    case "host": {
      // A value without a port matches the host on any port; a value with a port matches that port only (G-C9).
      const wanted = condition.value ?? "";
      const portAt = wanted.lastIndexOf(":");
      const hasPort = portAt !== -1 && portAt > wanted.lastIndexOf("]");
      return (hasPort ? url.host : url.hostname).toLowerCase() === wanted;
    }
    case "header": {
      const value = request.headers.get(condition.key ?? "");
      return value !== null && (condition.value === undefined || value === condition.value);
    }
    case "cookie": {
      const value = parseCookies(request.headers.get("cookie")).get(condition.key ?? "");
      return value !== undefined && (condition.value === undefined || value === condition.value);
    }
    case "query": {
      const values = url.searchParams.getAll(condition.key ?? "");
      return (
        values.length > 0 && (condition.value === undefined || values.includes(condition.value))
      );
    }
  }
}

/**
 * Whether a request meets the `has` conditions (all of them) and none of the `missing` ones.
 *
 * @param has The required conditions.
 * @param missing The forbidden conditions.
 * @param request The request.
 * @param url The request's URL.
 * @returns The answer.
 * @since 1.0.0
 */
export function conditionsMatch(
  has: readonly Condition[],
  missing: readonly Condition[],
  request: Request,
  url: URL,
): boolean {
  return (
    has.every((item) => holds(item, request, url)) &&
    missing.every((item) => !holds(item, request, url))
  );
}

interface Matchable {
  readonly match: CompiledPattern;
  readonly has: readonly Condition[];
  readonly missing: readonly Condition[];
}

/** The first rule (in declaration order) whose pattern and conditions match, with its parameters. @internal */
function firstMatch<R extends Matchable>(
  rules: readonly R[],
  path: string,
  request: Request,
  url: URL,
  ignoreCase: boolean,
): { readonly rule: R; readonly params: PathParams } | undefined {
  for (const rule of rules) {
    const params = matchPattern(rule.match, path, ignoreCase);
    if (params === undefined) continue;
    if (!conditionsMatch(rule.has, rule.missing, request, url)) continue;
    return { rule, params };
  }
  return undefined;
}

/**
 * Throws for a filled destination that holds an empty, `.` or `..` segment. The matcher never captures a rest that would
 * make one (`..%2Fsecret` in a splat), so this is the backstop: such a path would leave its folder, or, as `//host`,
 * its origin, once it is made a URL.
 *
 * @param path A path made by `fillPattern`.
 * @returns The same path.
 * @throws TypeError for a path that climbs or names a host.
 * @internal
 */
export function soundPath(path: string): string {
  if (
    path !== "/" &&
    path
      .slice(1)
      .split("/")
      .some((piece) => piece === "" || piece === "." || piece === "..")
  ) {
    throw new TypeError(
      "DESTINATION_UNSOUND: a filled destination holds an empty, '.' or '..' segment.",
    );
  }
  return path;
}

/** Fills a template's path part; an absolute template is returned as it is. @internal */
function fillTemplate(template: string, params: PathParams): string {
  if (!template.startsWith("/")) return template;
  const queryAt = template.indexOf("?");
  const path = queryAt === -1 ? template : template.slice(0, queryAt);
  const query = queryAt === -1 ? "" : template.slice(queryAt);
  return `${soundPath(fillPattern(path, params))}${query}`;
}

/**
 * The redirect that answers a request, if one matches (the first in declaration order).
 *
 * @param routing The validated routing.
 * @param path The app path (no mount base, no query).
 * @param request The request.
 * @param url The request's URL.
 * @returns The status and the target (not yet checked by `checkRedirectTarget`), or `undefined`.
 * @since 1.0.0
 */
export function redirectFor(
  routing: ResolvedRouting,
  path: string,
  request: Request,
  url: URL,
): { readonly status: number; readonly target: string } | undefined {
  const hit = firstMatch(routing.redirects, path, request, url, routing.ignoreCase === true);
  if (hit === undefined) return undefined;
  return {
    status: hit.rule.status,
    target: withRequestQuery(hit.rule.destination.template, hit.params, url),
  };
}

/**
 * The redirect target of a destination template. A redirect keeps the request's query string (`?x=1` moves to the
 * target) unless the destination already has a query string of its own, which wins (G-C9, documented in
 * dusk-routing.md).
 *
 * @internal
 */
function withRequestQuery(template: string, params: PathParams, url: URL): string {
  const target = fillTemplate(template, params);
  if (target.includes("?") || url.search === "") return target;
  return `${target}${url.search}`;
}

/**
 * The rewrite of one phase that applies to a request, if one matches (the first in declaration order). The
 * request's query string is kept; the destination's query parameters replace the same names.
 *
 * @param rules The rules of the phase.
 * @param path The app path.
 * @param request The request.
 * @param url The request's URL.
 * @param ignoreCase Match the literal parts of a source without ASCII case (see `ResolvedRouting.ignoreCase`).
 * @returns The new path and query string (`""` or `?a=b`), or `undefined`.
 * @since 1.0.0
 */
export function rewriteFor(
  rules: ResolvedRouting["rewrites"]["beforeFiles"],
  path: string,
  request: Request,
  url: URL,
  ignoreCase = false,
): { readonly path: string; readonly search: string } | undefined {
  const hit = firstMatch(rules, path, request, url, ignoreCase);
  if (hit === undefined) return undefined;
  const template = hit.rule.destination.template;
  const queryAt = template.indexOf("?");
  const merged = new URLSearchParams(url.search);
  if (queryAt !== -1) {
    const extra = new URLSearchParams(template.slice(queryAt + 1));
    for (const name of new Set(extra.keys())) merged.delete(name);
    for (const [name, value] of extra) merged.append(name, value);
  }
  const text = merged.toString();
  const pathTemplate = queryAt === -1 ? template : template.slice(0, queryAt);
  const filled = soundPath(fillPattern(pathTemplate, hit.params));
  return { path: filled, search: text === "" ? "" : `?${text}` };
}

/**
 * The response headers of every matching header rule. Rules apply in declaration order; a later rule
 * overwrites a header an earlier rule set.
 *
 * @param routing The validated routing.
 * @param path The app path.
 * @param request The request.
 * @param url The request's URL.
 * @returns Name, value and override flag per header, names in lower case.
 * @since 1.0.0
 */
export function headersFor(
  routing: ResolvedRouting,
  path: string,
  request: Request,
  url: URL,
): (readonly [string, string, boolean])[] {
  // The last matching rule decides a name's value and whether it overrides the route's header.
  const out = new Map<string, readonly [string, boolean]>();
  for (const rule of routing.headers) {
    if (matchPattern(rule.match, path, routing.ignoreCase === true) === undefined) continue;
    if (!conditionsMatch(rule.has, rule.missing, request, url)) continue;
    for (const [name, value] of rule.headers) out.set(name, [value, rule.override]);
  }
  return [...out.entries()].map(([name, [value, override]]) => [name, value, override] as const);
}

/**
 * The route rule that applies to a path: every matching rule merged, least specific first, so the most
 * specific rule wins each property. `headers` merge key by key.
 *
 * @param routing The validated routing.
 * @param path The app path.
 * @returns The merged rule (`{}` when none matches).
 * @since 1.0.0
 */
export function effectiveRule(routing: ResolvedRouting, path: string): RouteRule {
  const merged: { -readonly [K in keyof RouteRule]: RouteRule[K] } = {};
  let headers: Record<string, string> | undefined;
  for (const entry of routing.routeRules) {
    if (matchPattern(entry.match, path, routing.ignoreCase === true) === undefined) continue;
    for (const [key, value] of Object.entries(entry.rule) as [keyof RouteRule, unknown][]) {
      if (value === undefined) continue;
      if (key === "headers") {
        headers = { ...(headers ?? {}), ...(value as Record<string, string>) };
        continue;
      }
      Object.assign(merged, { [key]: value });
    }
  }
  if (headers !== undefined) merged.headers = headers;
  return merged;
}

/**
 * The redirect of the most specific route rule that has one and matches the path (`routeRules` are kept least
 * specific first, so the last match is the one that wins).
 *
 * @param routing The validated routing.
 * @param path The app path.
 * @returns The status and the target (not yet checked), or `undefined`.
 * @since 1.0.0
 */
export function routeRedirectFor(
  routing: ResolvedRouting,
  path: string,
  _request: Request,
  url: URL,
): { readonly status: number; readonly target: string } | undefined {
  let found: { readonly status: number; readonly target: string } | undefined;
  for (const rule of routing.routeRules) {
    if (rule.redirect === undefined) continue;
    const params = matchPattern(rule.match, path, routing.ignoreCase === true);
    if (params === undefined) continue;
    found = {
      status: rule.redirect.status,
      target: withRequestQuery(rule.redirect.destination.template, params, url),
    };
  }
  return found;
}

/** What the early rules of the config need from the handler (see {@link answerEarly}). @internal */
export interface EarlyHost {
  /** The mount point (`""` at the root). */
  readonly base: string;
  readonly routing: ResolvedRouting;
  /** Answers a redirect to `target` (the handler checks the target and prefixes the base). */
  readonly redirect: (
    event: EventState,
    hit: { readonly status: number; readonly target: string },
  ) => Response;
  /** Moves the request to a rewritten path. */
  readonly rewrite: (
    event: EventState,
    hit: { readonly path: string; readonly search: string },
  ) => void;
}

/** The app's own prefix: no rule of the config matches a path under it. */
const RESERVED_PREFIX = "/_dusk/";

/**
 * The redirects of the config and the route rules, then the `beforeFiles` rewrites: they run before the route is
 * matched. A redirect answers (one to the same place is ignored); a rewrite moves the request and answers nothing.
 *
 * @returns The redirect answer, or `undefined` when the request goes on.
 * @internal
 */
export function answerEarly(event: EventState, host: EarlyHost): Response | undefined {
  const source = event.sourcePath;
  if (source === undefined || source.startsWith(RESERVED_PREFIX)) return undefined;
  const { routing } = host;
  const hit =
    redirectFor(routing, source, event.request, event.url) ??
    routeRedirectFor(routing, source, event.request, event.url);
  if (hit !== undefined) {
    const there = hit.target.startsWith("/") ? `${host.base}${hit.target}` : hit.target;
    if (there !== `${event.url.pathname}${event.url.search}`) return host.redirect(event, hit);
  }
  const rewritten = rewriteFor(
    routing.rewrites.beforeFiles,
    source,
    event.request,
    event.url,
    routing.ignoreCase === true,
  );
  if (rewritten !== undefined) host.rewrite(event, rewritten);
  return undefined;
}

/** What the late rules of the config need from the handler (see {@link answerLate}). @internal */
export interface LateHost<R> {
  readonly routing: ResolvedRouting;
  /** The app path of a request path (without the base), or `undefined` outside the base. */
  readonly stripBase: (pathname: string) => string | undefined;
  /** Moves the request to a rewritten path. */
  readonly rewrite: (
    event: EventState,
    hit: { readonly path: string; readonly search: string },
  ) => void;
  /** Resolves the rewritten request again (what the handler answers with). */
  readonly resolveAgain: (event: EventState) => Promise<R>;
  /** Whether a page matches the request's path now. */
  readonly matchesPage: (event: EventState) => boolean;
}

/**
 * The `afterFiles` and `fallback` rewrites: only when no page matches the path. A rewrite that leads to a page (or to
 * a page-matching path) is taken; otherwise the resolution asked for stands.
 *
 * @internal
 */
export async function answerLate<R extends { readonly kind: string }>(
  event: EventState,
  resolution: R,
  host: LateHost<R>,
): Promise<R> {
  for (const phase of [host.routing.rewrites.afterFiles, host.routing.rewrites.fallback]) {
    const current = host.stripBase(event.url.pathname);
    if (current === undefined || phase.length === 0) continue;
    const hit = rewriteFor(
      phase,
      current,
      event.request,
      event.url,
      host.routing.ignoreCase === true,
    );
    if (hit === undefined) continue;
    host.rewrite(event, hit);
    const next = await host.resolveAgain(event);
    if (next.kind !== "page" || host.matchesPage(event)) return next;
  }
  return resolution;
}
