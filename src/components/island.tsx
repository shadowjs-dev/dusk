import { type IslandStrategy, islandAttributes } from "../shared/island";

/**
 * `<Island>`: a part of the page that the server renders as static markup and the browser takes over later.
 * Give one directive: `client:load`, `client:idle`, `client:visible`, `client:interaction`, `client:media="(min-width: 800px)"`
 * or `client:only` (no server markup: `fallback` is shown until the browser mounts the component). The island's
 * props are plain data; the browser's registry (`hydrateIslands`) names the component by `id`.
 */

/**
 * The props of {@link Island}. Exactly one `client:*` directive applies; with none the island is `visible`.
 * @since 1.0.0
 */
export interface IslandProps {
  /** The island's key in the browser registry: lowercase letters, digits and dashes. */
  readonly id: string;
  /** Plain data for the component (objects, arrays, strings, finite numbers, booleans, null). */
  readonly props?: Readonly<Record<string, unknown>>;
  /** Shown on the server for `client:only`. */
  readonly fallback?: unknown;
  /** The server markup of the island (the content hydrated in the browser). Ignored for `client:only`. */
  readonly children?: unknown;
  readonly "client:load"?: boolean;
  readonly "client:idle"?: boolean;
  readonly "client:visible"?: boolean;
  readonly "client:interaction"?: boolean;
  /** Mounts when this media query matches. */
  readonly "client:media"?: string;
  readonly "client:only"?: boolean;
}

const DIRECTIVES: readonly IslandStrategy[] = [
  "load",
  "idle",
  "visible",
  "interaction",
  "media",
  "only",
];

/** The one strategy the props name. More than one is an error; none is `visible`. */
function strategyOf(props: IslandProps): { strategy: IslandStrategy; media: string | undefined } {
  const named: { strategy: IslandStrategy; media: string | undefined }[] = [];
  for (const directive of DIRECTIVES) {
    const value = props[`client:${directive}` as keyof IslandProps];
    if (value === undefined || value === false) continue;
    if (directive === "media") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError(
          'Island: client:media needs a media query, for example client:media="(min-width: 800px)".',
        );
      }
      named.push({ strategy: "media", media: value });
    } else if (value === true) {
      named.push({ strategy: directive, media: undefined });
    } else {
      throw new TypeError(`Island: client:${directive} takes no value.`);
    }
  }
  if (named.length > 1) {
    throw new TypeError(
      `Island: ${named.map((entry) => entry.strategy).join(", ")} are set together; give one client:* directive.`,
    );
  }
  return named[0] ?? { strategy: "visible", media: undefined };
}

/**
 * An island on the page.
 *
 * @param props The island's id, its props, its directive and its markup.
 * @returns The wrapping element (with the island attributes), holding the children or the fallback.
 * @throws TypeError for two directives, a directive with a value it does not take, or props that are not plain data.
 * @example
 * <Island id="chart" client:visible props={{ series }}>
 *   <ChartPreview series={series} />
 * </Island>
 * @since 1.0.0
 */
export function Island(props: IslandProps): unknown {
  const { strategy, media } = strategyOf(props);
  const attributes = islandAttributes({
    id: props.id,
    client: strategy,
    ...(media === undefined ? {} : { media }),
    ...(props.props === undefined ? {} : { props: props.props }),
  });
  const content = strategy === "only" ? props.fallback : props.children;
  return <div {...attributes}>{content as never}</div>;
}
