import type { Metadata, MetadataTitle, Viewport } from "./types";

/** A viewport layer: each field may be `null`, which removes the value above it. @since 1.0.0 */
export type ViewportLayer = { readonly [K in keyof Viewport]?: Viewport[K] | null };

/**
 * How the layers of a route chain combine. The chain is walked outermost first (root layout, then each layout, then
 * the page), and each layer is merged onto what the layers above resolved.
 *
 * - Titles. A string title is wrapped in the nearest `template` above it (`%s` is replaced). `absolute` sets the
 *   title and skips the template. `default` is used only when no layer sets a title. A `template` in a layer
 *   applies to the titles below it; `template: null` clears the inherited one.
 * - Every other field replaces the value above it when the layer sets it, as a whole (a child's `openGraph` replaces
 *   the parent's `openGraph`; it is not merged field by field). `other` is the exception: its keys merge.
 * - A layer sets a field to `null` to remove what the layers above set.
 * - `metadataBase` replaces the base above it. It is resolved to a URL once, after the merge.
 *
 * The merged value is what `generateMetadata` receives as `parent`: its `title` is the plain string the page shows.
 */

/** The resolved state of a chain: the merged metadata and the title template the layers below inherit. @internal */
export interface MetadataState {
  /** The merged metadata. Its `title` is the title the page shows (a string), not the template form. */
  readonly metadata: Metadata;
  /** The template the next layer's string title is wrapped in, or undefined. */
  readonly template: string | undefined;
  /** The `default` title, used when no layer sets a title. */
  readonly fallback: string | undefined;
  /** The explicit title (a string or an absolute), or undefined. */
  readonly explicit: string | undefined;
}

/**
 * The empty state: nothing set.
 *
 * @example
 * EMPTY_STATE.metadata; // {}
 * EMPTY_STATE.template; // undefined
 * @since 1.0.0
 */
export const EMPTY_STATE: MetadataState = {
  metadata: {},
  template: undefined,
  fallback: undefined,
  explicit: undefined,
};

/**
 * Wraps a title in a template. The first `%s` is replaced; a template without `%s` is used as the whole title.
 *
 * @param template The template, or undefined for no template.
 * @param title The title to wrap.
 * @returns The wrapped title.
 * @example
 * applyTemplate("%s | Example", "Docs"); // "Docs | Example"
 * applyTemplate("Example", "Docs"); // "Example"
 * @since 1.0.0
 */
export function applyTemplate(template: string | undefined, title: string): string {
  if (template === undefined) return title;
  return template.includes("%s") ? template.replace("%s", () => title) : template;
}

/**
 * Merges one layer's metadata onto the state of the layers above it.
 *
 * @param state What the layers above resolved.
 * @param layer The layer's metadata (a `metadata` export or what `generateMetadata` returned).
 * @returns The new state. The inputs are not changed.
 * @example
 * const root = mergeMetadata(EMPTY_STATE, { title: { default: "Example", template: "%s · Example" } });
 * mergeMetadata(root, { title: "Docs" }).metadata.title; // "Docs · Example"
 * @since 1.0.0
 */
export function mergeMetadata(state: MetadataState, layer: Metadata): MetadataState {
  let template = state.template;
  let fallback = state.fallback;
  let explicit = state.explicit;
  const title: MetadataTitle | null | undefined = layer.title;
  if (typeof title === "string") {
    explicit = applyTemplate(template, title);
  } else if (title !== null && title !== undefined) {
    if (Object.hasOwn(title, "template")) template = title.template ?? undefined;
    if (title.default !== undefined) fallback = title.default;
    if (title.absolute !== undefined) explicit = title.absolute;
  } else if (title === null) {
    explicit = undefined;
    fallback = undefined;
  }
  const { title: _previous, ...rest } = mergeFields(state.metadata, layer);
  const resolvedTitle = explicit ?? fallback;
  const metadata: Metadata = resolvedTitle === undefined ? rest : { ...rest, title: resolvedTitle };
  return { metadata, template, fallback, explicit };
}

/** Copies the layer's fields over the merged ones: replace, delete on null, merge `other`. */
function mergeFields(base: Metadata, layer: Metadata): Metadata {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(layer) as (keyof Metadata)[]) {
    if (key === "title") continue;
    const value: unknown = layer[key];
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = value;
  }
  // `other` is the one object field that merges key by key.
  const merged = out as Metadata;
  if (isPlainObject(base.other) && isPlainObject(layer.other)) {
    return { ...merged, other: { ...base.other, ...layer.other } };
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof URL)
  );
}

/**
 * Merges a viewport layer onto the viewport above it: each field the layer sets replaces the one above; `null`
 * removes it.
 *
 * @param base The viewport of the layers above.
 * @param layer The layer's viewport.
 * @returns The merged viewport.
 * @example
 * mergeViewport({ width: "device-width" }, { initialScale: 1, width: null }); // { initialScale: 1 }
 * @since 1.0.0
 */
export function mergeViewport(base: Viewport, layer: ViewportLayer): Viewport {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(layer) as (keyof Viewport)[]) {
    const value: unknown = layer[key];
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out as Viewport;
}

/**
 * Renders the `viewport` meta content from its fields, in the order browsers document. A string viewport is returned
 * as given.
 *
 * @param viewport The viewport fields.
 * @returns The content of `<meta name="viewport">`, or undefined when no field is set.
 * @example
 * viewportContent({ width: "device-width", initialScale: 1 }); // "width=device-width, initial-scale=1"
 * @since 1.0.0
 */
export function viewportContent(viewport: Viewport | string): string | undefined {
  if (typeof viewport === "string") return viewport === "" ? undefined : viewport;
  const parts: string[] = [];
  if (viewport.width !== undefined) parts.push(`width=${String(viewport.width)}`);
  if (viewport.height !== undefined) parts.push(`height=${String(viewport.height)}`);
  if (viewport.initialScale !== undefined) parts.push(`initial-scale=${viewport.initialScale}`);
  if (viewport.minimumScale !== undefined) parts.push(`minimum-scale=${viewport.minimumScale}`);
  if (viewport.maximumScale !== undefined) parts.push(`maximum-scale=${viewport.maximumScale}`);
  if (viewport.userScalable !== undefined)
    parts.push(`user-scalable=${viewport.userScalable ? "yes" : "no"}`);
  if (viewport.viewportFit !== undefined) parts.push(`viewport-fit=${viewport.viewportFit}`);
  if (viewport.interactiveWidget !== undefined)
    parts.push(`interactive-widget=${viewport.interactiveWidget}`);
  return parts.length === 0 ? undefined : parts.join(", ");
}
