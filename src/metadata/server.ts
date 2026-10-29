import type { RenderedMatch } from "@shadow-js/router";
import { normalizeTags } from "@shadow-js/web/server";
import { type EventState, visibilityOf } from "../server/event";
import type { PageRuntime } from "../server/runtime";
import type { GlobalErrorModule } from "../shared/global-error";
import { chainRoutesOf, type SpecExports, searchRecord, staticChainRouteOf } from "./feature";
import { type ChainRoute, chainHead, type ResolvedChain, resolveChain } from "./resolve";

/**
 * The server side of the metadata exports: the head of a page (its metadata tags, JSON-LD and the response headers
 * the routes set), of the shell, and of the global error document. The page renderer loads this module only when the
 * app has a route that exports metadata (`pages({ metadata })`, `@shadow-js/dusk/features/metadata`); an app without
 * one never has the chain resolver, the tag writer or the JSON-LD code in its bundle.
 *
 * @packageDocumentation
 */

/** The head one page render adds to its document. */
export interface PageHead {
  /** The metadata tags, normalized for the head collector. */
  readonly tags: ReturnType<typeof normalizeTags>;
  /** The JSON-LD texts of the chain, in order. */
  readonly jsonLd: readonly string[];
  /** Writes the response headers the routes' `headers` exports set. A refused name is reported and skipped. */
  applyHeaders(headers: Headers): void;
}

/** Response headers a route's `headers` export may not set: the framework's own answers, and cookies. */
const ROUTE_HEADER_DENYLIST: ReadonlySet<string> = new Set([
  "content-length",
  "content-type",
  "link",
  "location",
  "set-cookie",
]);

/** Writes the response headers the matched routes' `headers` exports return. A refused name is reported and skipped. */
function applyChainHeaders(
  headers: Headers,
  chain: ResolvedChain,
  report: (error: unknown) => void,
): void {
  for (const [name, value] of Object.entries(chain.headers)) {
    if (ROUTE_HEADER_DENYLIST.has(name)) {
      report(
        new TypeError(__DEV__ ? `headers: a route cannot set "${name}".` : `DUSK_META_4 ${name}`),
      );
      continue;
    }
    headers.set(name, value);
  }
}

/** The head of a resolved chain: its tags and JSON-LD, and the headers the routes set. */
function headOf(chain: ResolvedChain, rt: PageRuntime, event: EventState): PageHead {
  const headOut = chainHead(chain);
  return {
    tags: normalizeTags(headOut.tags),
    jsonLd: headOut.jsonLd,
    applyHeaders: (headers) =>
      applyChainHeaders(headers, chain, (error) => rt.report(error, "head", event)),
  };
}

/** The request's search record and pathname, as the chain resolver reads them. */
function locationOf(rt: PageRuntime, event: EventState) {
  return {
    search: searchRecord(event.url.searchParams),
    pathname: event.url.pathname,
    trailingSlash: rt.config.trailingSlash,
  };
}

/** A chain route carrying a UI's metadata: a value, or a generator (`generateMetadata`). */
function uiRouteOf(match: RenderedMatch, value: unknown): ChainRoute {
  const base = { id: match.id, params: match.params, loaderData: match.loaderData };
  return typeof value === "function"
    ? { ...base, generateMetadata: value as ChainRoute["generateMetadata"] }
    : { ...base, metadata: value as ChainRoute["metadata"] };
}

/**
 * The metadata of the not-found or error UI that answers the status, as a chain route merged after the page's chain. A
 * 404 is answered by the not-found UI of the match the router marks `notFound`; an error status by the `error` UI of the
 * innermost matched route that has one (an approximation: a render error caught inside a component has no route).
 */
function uiChainRouteOf(
  matches: readonly RenderedMatch[],
  specs: PageRuntime["specs"],
  status: number,
): ChainRoute | undefined {
  if (status === 404) {
    const owner = matches.find((match) => match.kind === "notFound");
    const value = owner === undefined ? undefined : specs.get(owner.id)?.notFoundMetadata;
    return owner === undefined || value === undefined ? undefined : uiRouteOf(owner, value);
  }
  if (status < 400) return undefined;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (match === undefined) continue;
    const spec = specs.get(match.id);
    if (spec?.error !== undefined && spec.errorMetadata !== undefined) {
      return uiRouteOf(match, spec.errorMetadata);
    }
  }
  return undefined;
}

/**
 * The metadata of a shell page: the static exports of the routes that match its path (the layout's defaults
 * included). Generators do not run: they need the page's data, which a shell page does not load on the server.
 */
function shellChainOf(rt: PageRuntime, event: EventState): ChainRoute[] {
  const chain: ChainRoute[] = [];
  for (const match of rt.pageMatcher.match(event.url.pathname, visibilityOf(event))) {
    const spec: SpecExports | undefined = rt.specs.get(match.id);
    if (spec !== undefined) chain.push(staticChainRouteOf(match.id, match.params, spec));
  }
  return chain;
}

/**
 * The head of a rendered page: the chain of its matched routes, then the metadata of the not-found or error UI that
 * answers the status. The chain is resolved before the render, because an async `generateMetadata` has to be awaited.
 * Errors are reported and the route contributes nothing (see `resolve.ts`).
 *
 * @param rt Shared runtime of the pages feature.
 * @param event The request event.
 * @param matches The matches the router rendered.
 * @param status The status the page answers with (a 404 or an error takes the UI's metadata).
 * @returns The head of the page.
 * @internal
 */
export async function pageHead(
  rt: PageRuntime,
  event: EventState,
  matches: readonly RenderedMatch[],
  status: number,
): Promise<PageHead> {
  const ui = uiChainRouteOf(matches, rt.specs, status);
  const chain = await resolveChain(
    [...chainRoutesOf(matches, (id) => rt.specs.get(id)), ...(ui === undefined ? [] : [ui])],
    locationOf(rt, event),
    (error) => rt.report(error, "head", event),
  );
  return headOf(chain, rt, event);
}

/**
 * The head of a shell page (`ssr = false`): the static metadata of the matched routes, so crawlers and link previews
 * see the page's title and description.
 * @internal
 */
export async function shellHead(rt: PageRuntime, event: EventState): Promise<PageHead> {
  const chain = await resolveChain(shellChainOf(rt, event), locationOf(rt, event), (error) =>
    rt.report(error, "head", event),
  );
  return headOf(chain, rt, event);
}

/**
 * The tags of the global error document: the metadata of the `_global-error` module, which the document's own `<head>`
 * takes.
 * @internal
 */
export async function globalErrorTags(
  rt: PageRuntime,
  event: EventState,
  module: GlobalErrorModule,
): Promise<PageHead["tags"]> {
  const chain = await resolveChain(
    module.metadata === undefined
      ? []
      : [{ id: "global-error", params: {}, loaderData: undefined, metadata: module.metadata }],
    locationOf(rt, event),
    (failed) => rt.report(failed, "head", event),
  );
  return normalizeTags(chainHead(chain).tags);
}
