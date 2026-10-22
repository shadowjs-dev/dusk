import { isServer, useRenderEffect, useSignal } from "@shadow-js/core";
import type { RenderedMatch, RouterFeature } from "@shadow-js/router";
import { useHead } from "@shadow-js/web";
import { type ChainRoute, chainHead, type ResolvedChain, resolveChain } from "./resolve";

/**
 * The metadata feature of the router (`metadataFeature()`, included in Dusk's `duskFeatures()`).
 *
 * On the client it fills the router's `metadata` capability: every route body on screen calls it, and the route at
 * the bottom of the chain (the leaf) applies the merged metadata of the whole chain, so the layers are merged once
 * and a navigation replaces the leaf's registration. Leaves that are not the deepest route do nothing.
 *
 * On the server the capability does nothing: the page renderer resolves the chain before it renders (async
 * `generateMetadata` needs that), then writes the head and the JSON-LD into the document. See `resolve.ts`.
 */

/**
 * The metadata exports of a route spec, as the router keeps them (it spreads the module's exports into the spec).
 * Structural, so the spec type of the router does not have to be exported.
 * @internal
 */
export interface SpecExports {
  readonly metadata?: unknown;
  readonly generateMetadata?: unknown;
  /** The static metadata images of the route (`FileImages`), put on the spec by the build. */
  readonly fileImages?: unknown;
  /** The metadata of the route's not-found UI, merged over the chain when that UI is on screen. */
  readonly notFoundMetadata?: unknown;
  /** The metadata of the route's error UI, merged over the chain when that UI answers an error status. */
  readonly errorMetadata?: unknown;
  readonly viewport?: unknown;
  readonly generateViewport?: unknown;
  readonly links?: unknown;
  readonly meta?: unknown;
  readonly headers?: unknown;
}

/** The router's capability applier, as the router's features see it. @internal */
type CapabilityApplier = NonNullable<
  Parameters<RouterFeature["install"]>[0]["capabilities"]["metadata"]
>;
/** The router core the applier receives. @internal */
type MetadataCore = Parameters<CapabilityApplier>[0];

/**
 * The raw query string as the generator functions read it: a repeated key is an array.
 *
 * @example
 * searchRecord("tag=a&tag=b&page=2"); // { tag: ["a", "b"], page: "2" }
 * @since 1.0.0
 */
export function searchRecord(search: URLSearchParams | string): Record<string, string | string[]> {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const current = Object.hasOwn(out, key) ? out[key] : undefined;
    if (current === undefined) out[key] = value;
    else out[key] = Array.isArray(current) ? [...current, value] : [current, value];
  }
  return out;
}

/**
 * The metadata exports of a route, read from its spec. The router spreads the module's exports into the spec, so an
 * export that is not a function is a value and one that is a function is a generator; the types are checked when the
 * export is used (see `resolveChain`).
 *
 * @internal
 */
export function chainRouteOf(match: RenderedMatch, spec: SpecExports): ChainRoute {
  return {
    id: match.id,
    params: match.params,
    loaderData: match.loaderData,
    metadata: spec.metadata as ChainRoute["metadata"],
    generateMetadata: spec.generateMetadata as ChainRoute["generateMetadata"],
    fileImages: spec.fileImages as ChainRoute["fileImages"],
    viewport: spec.viewport as ChainRoute["viewport"],
    generateViewport: spec.generateViewport as ChainRoute["generateViewport"],
    links: spec.links as ChainRoute["links"],
    meta: spec.meta as ChainRoute["meta"],
    headers: spec.headers as ChainRoute["headers"],
  };
}

/**
 * The static part of a route's metadata: the exports that are values (no generator), for a page that renders
 * no route content on the server (`ssr = false`). A generator needs the page's data, so it is left out.
 *
 * @param id The route id.
 * @param params The params the path matched.
 * @param spec The route's exports.
 * @returns A chain route without `generateMetadata` and `generateViewport`.
 * @internal
 */
export function staticChainRouteOf(
  id: string,
  params: Readonly<Record<string, string>>,
  spec: SpecExports,
): ChainRoute {
  return {
    ...chainRouteOf({ id, params, loaderData: undefined } as RenderedMatch, spec),
    generateMetadata: undefined,
    generateViewport: undefined,
  };
}

/**
 * The routes of a rendered chain that the metadata reads, outermost first, from matches and their specs.
 *
 * @param matches The rendered matches (a not-found route is skipped).
 * @param specOf The spec of a route id.
 * @returns One chain route per route match with a spec.
 * @example
 * import { chainRoutesOf } from the "@shadow-js/dusk/server" subpath;
 * const matches = [{ kind: "route", id: "docs", pattern: "/docs", params: {}, loaderData: undefined, depth: 0 }];
 * chainRoutesOf(matches, () => ({ metadata: { title: "Docs" } })).map((route) => route.id); // ["docs"]
 * @since 1.0.0
 */
export function chainRoutesOf(
  matches: readonly RenderedMatch[],
  specOf: (id: string) => SpecExports | undefined,
): ChainRoute[] {
  const out: ChainRoute[] = [];
  for (const match of matches) {
    if (match.kind !== "route") continue;
    const spec = specOf(match.id);
    if (spec !== undefined) out.push(chainRouteOf(match, spec));
  }
  return out;
}

/**
 * The chain up to a depth when that depth is the leaf (nothing rendered below it), or undefined.
 * Reading the accessors here makes the caller track the navigation.
 */
function leafChain(core: MetadataCore, depth: number): ChainRoute[] | undefined {
  // Only the leaf applies the chain: a not-found UI rendered below a layout is what the layout shows.
  const below = core.entryAt(depth + 1)();
  if (below !== undefined) return undefined;
  const matches: RenderedMatch[] = [];
  for (let index = 0; index <= depth; index += 1) {
    const entry = core.entryAt(index)();
    if (entry !== undefined) matches.push(entry);
  }
  const chain = chainRoutesOf(matches, (id) => core.specOf(id));
  // A rendered not-found UI is the leaf: its own metadata is merged over the chain (as on the server).
  const leaf = matches[matches.length - 1];
  const value = leaf?.kind === "notFound" ? core.specOf(leaf.id)?.notFoundMetadata : undefined;
  if (leaf !== undefined && value !== undefined) {
    chain.push({
      id: leaf.id,
      params: leaf.params,
      loaderData: leaf.loaderData,
      ...(typeof value === "function"
        ? { generateMetadata: value as ChainRoute["generateMetadata"] }
        : { metadata: value as ChainRoute["metadata"] }),
    });
  }
  return chain;
}

/** Applies the metadata of the leaf at a depth. Runs inside the route's owner, like the `head` applier. */
function applyAt(core: MetadataCore, depth: number, report: (error: unknown) => void): void {
  const [result, setResult] = useSignal<ResolvedChain | undefined>(undefined);
  useRenderEffect(
    () => leafChain(core, depth),
    (routes) => {
      if (routes === undefined) {
        setResult(undefined);
        return undefined;
      }
      const location = core.location();
      const search = searchRecord(location?.search ?? "");
      const pathname = location?.pathname ?? "/";
      const out = resolveChain(routes, { search, pathname }, (error) => report(error));
      if (out instanceof Promise) {
        let live = true;
        out.then(
          (value) => {
            if (live) setResult(value);
          },
          (error: unknown) => report(error),
        );
        return () => {
          live = false;
        };
      }
      setResult(out);
      return undefined;
    },
  );
  useHead(() => {
    const value = result();
    return value === undefined ? [] : chainHead(value).tags;
  });
  useRenderEffect(
    () => {
      const value = result();
      return value === undefined ? [] : chainHead(value).jsonLd;
    },
    (texts) => applyJsonLd(texts),
  );
}

/**
 * Marks the JSON-LD scripts the client writes or the server rendered.
 *
 * @example
 * JSON_LD_MARK; // "data-shadow-jsonld"
 * @since 1.0.0
 */
export const JSON_LD_MARK = "data-shadow-jsonld";

/**
 * Replaces the JSON-LD scripts of the document with the given texts. Scripts the server rendered carry the same mark,
 * so the first client pass removes them before writing its own: a hydrated page never holds two copies.
 */
function applyJsonLd(texts: readonly string[]): () => void {
  if (typeof document === "undefined") return () => undefined;
  const head = document.head;
  for (const old of Array.from(head.querySelectorAll(`script[${JSON_LD_MARK}]`))) old.remove();
  const written: Element[] = [];
  for (const text of texts) {
    const script = document.createElement("script");
    script.setAttribute("type", "application/ld+json");
    script.setAttribute(JSON_LD_MARK, "");
    script.textContent = text;
    head.appendChild(script);
    written.push(script);
  }
  return () => {
    for (const script of written) script.remove();
  };
}

/**
 * The metadata feature of a router. Dusk's `duskFeatures()` includes it; a router that renders routes with metadata
 * exports needs it.
 *
 * @returns The feature.
 * @example
 * const router = createRouter({ routes, features: [metadataFeature()] });
 * @since 1.0.0
 */
export function metadataFeature(): RouterFeature {
  return {
    id: "metadata",
    install(host): void {
      host.capabilities.metadata = (core, depth): void => {
        if (isServer) return;
        applyAt(core, depth, host.report);
      };
    },
  };
}
