import type { HeadTag } from "@shadow-js/web";
import type { FileImagesHook } from "./file-images";
import { EMPTY_STATE, type MetadataState, mergeMetadata, mergeViewport } from "./merge";
import { buildHead, type HeadOutput } from "./to-head";
import type {
  HeadersArgs,
  LinkDescriptor,
  MetaArgs,
  MetaDescriptor,
  Metadata,
  MetadataArgs,
  Viewport,
} from "./types";
import { resolveMetadataBase, safeHref } from "./url";

/**
 * Resolves the metadata of a matched route chain: the layers are walked outermost first, each one contributes its
 * `metadata` (or `generateMetadata`), `viewport` (or `generateViewport`), `links`, `meta` and `headers` exports, and
 * the result is merged with the rules of `merge.ts`.
 *
 * The walk is synchronous while every function returns a plain value, so the client can apply a navigation's
 * metadata in the same pass. The first promise switches the rest of the walk to a promise. A function that throws
 * or rejects is reported through `onError` and its layer contributes nothing.
 */

/** Exports of one matched route that the metadata API reads. @since 1.0.0 */
export interface ChainRoute {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
  readonly loaderData: unknown;
  readonly metadata?: Metadata | undefined;
  readonly generateMetadata?:
    | ((args: MetadataArgs) => Metadata | PromiseLike<Metadata>)
    | undefined;
  /**
   * Adds the static `opengraph-image` and `twitter-image` files this route carries (the build sets it on the first
   * route of each chain inside the folder that holds them). Runs on the merged result of the route's own layer; see
   * `file-images.ts`.
   */
  readonly fileImages?: FileImagesHook | undefined;
  readonly viewport?: Viewport | undefined;
  readonly generateViewport?:
    | ((args: MetadataArgs) => Viewport | PromiseLike<Viewport>)
    | undefined;
  readonly links?:
    | (
        | readonly LinkDescriptor[]
        | ((args: MetaArgs) => readonly LinkDescriptor[] | PromiseLike<readonly LinkDescriptor[]>)
      )
    | undefined;
  readonly meta?:
    | (
        | readonly MetaDescriptor[]
        | ((args: MetaArgs) => readonly MetaDescriptor[] | PromiseLike<readonly MetaDescriptor[]>)
      )
    | undefined;
  readonly headers?:
    | (
        | Readonly<Record<string, string>>
        | ((
            args: HeadersArgs,
          ) => Readonly<Record<string, string>> | PromiseLike<Readonly<Record<string, string>>>)
      )
    | undefined;
}

/** Request values the generator functions receive. @since 1.0.0 */
export interface ChainContext {
  /** The raw query string as a record. */
  readonly search: Readonly<Record<string, string | readonly string[]>>;
  /** The page's pathname, for a `./` canonical (Next's rule). `/` when omitted. */
  readonly pathname?: string | undefined;
  /** The app's `trailingSlash` policy, applied to canonical and alternate URLs on the app's origin. */
  readonly trailingSlash?: "never" | "always" | "preserve" | undefined;
}

/** The merged result of a chain. @since 1.0.0 */
export interface ResolvedChain {
  readonly metadata: Metadata;
  readonly viewport: Viewport;
  readonly links: readonly LinkDescriptor[];
  readonly meta: readonly MetaDescriptor[];
  readonly headers: Readonly<Record<string, string>>;
  /** The `metadataBase` of the merged metadata, or undefined. */
  readonly base: URL | undefined;
  /** The pathname the chain was resolved for (`/` when unknown). */
  readonly pathname?: string | undefined;
  /** The trailing-slash policy the chain was resolved with. */
  readonly trailingSlash?: "never" | "always" | "preserve" | undefined;
}

/** Called with an error a metadata function threw, and the route it belongs to. @since 1.0.0 */
export type ChainErrorHandler = (error: unknown, routeId: string) => void;

/** The accumulator the steps fold into. @internal */
interface Acc {
  readonly state: MetadataState;
  readonly viewport: Viewport;
  readonly links: readonly LinkDescriptor[];
  readonly meta: readonly MetaDescriptor[];
  readonly headers: Readonly<Record<string, string>>;
}

/** One unit of the walk: returns the next accumulator, or a promise of it. @internal */
type Step = (acc: Acc) => Acc | PromiseLike<Acc>;

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function"
  );
}

/** Header names and values a route may set: tokens and visible text, nothing that could split a header line. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\t -~\u0080-ÿ]*$/;

/** Checks the headers a route returns. A bad name or value is a TypeError, reported like a thrown error. */
export function checkedHeaders(
  input: Readonly<Record<string, string>>,
  routeId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!HEADER_NAME.test(name) || typeof value !== "string" || !HEADER_VALUE.test(value)) {
      throw new TypeError(
        __DEV__
          ? `headers of route "${routeId}": ${JSON.stringify(name)} is not a valid header.`
          : `DUSK_META_1 ${routeId}`,
      );
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}

/**
 * Converts the `meta` export (React Router style descriptors) to head tags. `title` is the document title; `charSet`
 * is the charset meta; a `link` descriptor is a link tag.
 * @internal
 */
export function metaDescriptorTags(descriptors: readonly MetaDescriptor[]): HeadTag[] {
  const tags: HeadTag[] = [];
  for (const descriptor of descriptors) {
    if ("title" in descriptor) {
      tags.push({ tag: "title", children: descriptor.title });
    } else if ("charSet" in descriptor) {
      tags.push({ tag: "meta", props: { charset: descriptor.charSet } });
    } else if ("tagName" in descriptor) {
      const { tagName: _tagName, ...rest } = descriptor;
      const props: Record<string, string> = {};
      let dropped = false;
      for (const [key, value] of Object.entries(rest)) {
        if (key === "href") {
          // The address is written as given, but a script scheme (or a `data:` that is not an icon) is not an address.
          const href = safeHref(String(value), {
            dataImage: /icon/i.test(String(rest["rel"] ?? "")),
          });
          if (href === undefined) dropped = true;
          else props[key] = href;
          continue;
        }
        props[key === "hrefLang" ? "hreflang" : key] = value;
      }
      if (!dropped) tags.push({ tag: "link", props });
    } else if ("name" in descriptor) {
      tags.push({ tag: "meta", props: { name: descriptor.name, content: descriptor.content } });
    } else if ("property" in descriptor) {
      tags.push({
        tag: "meta",
        props: { property: descriptor.property, content: descriptor.content },
      });
    } else {
      tags.push({
        tag: "meta",
        props: { "http-equiv": descriptor.httpEquiv, content: descriptor.content },
      });
    }
  }
  return tags;
}

/** One call of a route's export: a plain value or a promise, with a thrown error reported and skipped. */
function guarded<R>(
  routeId: string,
  onError: ChainErrorHandler,
  run: () => R | PromiseLike<R>,
  apply: (value: R) => Acc,
  keep: Acc,
): Acc | PromiseLike<Acc> {
  let value: R | PromiseLike<R>;
  try {
    value = run();
  } catch (error) {
    onError(error, routeId);
    return keep;
  }
  if (isThenable<R>(value)) {
    return Promise.resolve(value).then(
      (resolved) => apply(resolved),
      (error: unknown) => {
        onError(error, routeId);
        return keep;
      },
    );
  }
  return apply(value);
}

/** The steps of one route, in the order the exports apply. @internal */
function stepsOf(route: ChainRoute, context: ChainContext, onError: ChainErrorHandler): Step[] {
  const args = (acc: Acc): MetadataArgs => ({
    params: route.params,
    search: context.search,
    parent: acc.state.metadata,
    loaderData: route.loaderData,
  });
  const metaArgs: MetaArgs = { params: route.params, loaderData: route.loaderData };
  const steps: Step[] = [];
  /** Merges the route's own layer; the hook the build made for its static images (if any) adds them to the result. */
  const addLayer = (acc: Acc, layer: Metadata): Acc => {
    const state = mergeMetadata(acc.state, layer);
    return withState(
      acc,
      route.fileImages?.(state, layer, route.params, route.id, onError) ?? state,
    );
  };

  steps.push((acc) => {
    if (route.metadata !== undefined && route.generateMetadata !== undefined) {
      onError(
        new TypeError(
          __DEV__
            ? `route "${route.id}" exports both metadata and generateMetadata; export one of them.`
            : `DUSK_META_2 ${route.id}`,
        ),
        route.id,
      );
      return acc;
    }
    const generate = route.generateMetadata;
    if (generate === undefined) return addLayer(acc, route.metadata ?? {});
    return guarded(
      route.id,
      onError,
      () => generate(args(acc)),
      (value) => addLayer(acc, value ?? {}),
      acc,
    );
  });

  steps.push((acc) => {
    if (route.viewport !== undefined && route.generateViewport !== undefined) {
      onError(
        new TypeError(
          __DEV__
            ? `route "${route.id}" exports both viewport and generateViewport; export one of them.`
            : `DUSK_META_3 ${route.id}`,
        ),
        route.id,
      );
      return acc;
    }
    if (route.generateViewport !== undefined) {
      const generate = route.generateViewport;
      return guarded(
        route.id,
        onError,
        () => generate(args(acc)),
        (value) => ({ ...acc, viewport: mergeViewport(acc.viewport, value ?? {}) }),
        acc,
      );
    }
    return route.viewport === undefined
      ? acc
      : { ...acc, viewport: mergeViewport(acc.viewport, route.viewport) };
  });

  steps.push((acc) => {
    const links = route.links;
    if (links === undefined) return acc;
    const add = (value: readonly LinkDescriptor[]): Acc => ({
      ...acc,
      links: [...acc.links, ...value],
    });
    if (typeof links !== "function") return add(links);
    return guarded(route.id, onError, () => links(metaArgs), add, acc);
  });

  steps.push((acc) => {
    const meta = route.meta;
    if (meta === undefined) return acc;
    const add = (value: readonly MetaDescriptor[]): Acc => ({
      ...acc,
      meta: [...acc.meta, ...value],
    });
    if (typeof meta !== "function") return add(meta);
    return guarded(route.id, onError, () => meta(metaArgs), add, acc);
  });

  steps.push((acc) => {
    const headers = route.headers;
    if (headers === undefined) return acc;
    const apply = (value: Readonly<Record<string, string>>): Acc => {
      let checked: Record<string, string>;
      try {
        checked = checkedHeaders(value, route.id);
      } catch (error) {
        onError(error, route.id);
        return acc;
      }
      return { ...acc, headers: { ...acc.headers, ...checked } };
    };
    if (typeof headers !== "function") return apply(headers);
    return guarded(
      route.id,
      onError,
      () =>
        headers({ params: route.params, loaderData: route.loaderData, parentHeaders: acc.headers }),
      apply,
      acc,
    );
  });
  return steps;
}

function withState(acc: Acc, state: MetadataState): Acc {
  return { ...acc, state };
}

/** Runs the steps in order. Stays synchronous until a step returns a promise. */
function flow(steps: readonly Step[], index: number, acc: Acc): Acc | PromiseLike<Acc> {
  let current = acc;
  for (let i = index; i < steps.length; i += 1) {
    const step = steps[i];
    if (step === undefined) continue;
    const out = step(current);
    if (isThenable<Acc>(out)) {
      const next = i + 1;
      return Promise.resolve(out).then((resolved) => flow(steps, next, resolved));
    }
    current = out;
  }
  return current;
}

/** The final value of a walk. */
function finish(
  acc: Acc,
  pathname: string | undefined,
  trailingSlash: ResolvedChain["trailingSlash"],
): ResolvedChain {
  return {
    metadata: acc.state.metadata,
    viewport: acc.viewport,
    links: acc.links,
    meta: acc.meta,
    headers: acc.headers,
    base: resolveMetadataBase(acc.state.metadata.metadataBase),
    pathname,
    trailingSlash,
  };
}

/**
 * Resolves a matched chain, outermost route first.
 *
 * @param routes The matched routes, outermost first (the root layout, then the page).
 * @param context The raw query string, passed to the generator functions.
 * @param onError Receives each error a metadata function threw; the layer then contributes nothing.
 * @returns The merged result, or a promise of it when a generator function returned a promise.
 * @throws TypeError (from `metadataBase`) when the merged base is not an absolute http(s) URL.
 * @example
 * const chain = resolveChain([root, page], { search: {} }, report);
 * @since 1.0.0
 */
export function resolveChain(
  routes: readonly ChainRoute[],
  context: ChainContext,
  onError: ChainErrorHandler,
): ResolvedChain | Promise<ResolvedChain> {
  const steps = routes.flatMap((route) => stepsOf(route, context, onError));
  const result = flow(steps, 0, {
    state: EMPTY_STATE,
    viewport: {},
    links: [],
    meta: [],
    headers: {},
  });
  const pathname = context.pathname;
  const trailingSlash = context.trailingSlash;
  return isThenable<Acc>(result)
    ? Promise.resolve(result).then((acc) => finish(acc, pathname, trailingSlash))
    : finish(result, pathname, trailingSlash);
}

/**
 * The head tags and JSON-LD blocks of a resolved chain.
 *
 * @param chain What {@link resolveChain} returned.
 * @returns The head output (tags in document order, and the JSON-LD texts).
 * @since 1.0.0
 */
export function chainHead(chain: ResolvedChain): HeadOutput {
  return buildHead({
    metadata: chain.metadata,
    viewport: chain.viewport,
    links: chain.links,
    metaTags: metaDescriptorTags(chain.meta),
    base: chain.base,
    pathname: chain.pathname,
    trailingSlash: chain.trailingSlash,
  });
}

/** Empty result, for a route with no metadata exports. @since 1.0.0 */
export const EMPTY_CHAIN: ResolvedChain = {
  metadata: {},
  viewport: {},
  links: [],
  meta: [],
  headers: {},
  base: undefined,
};
