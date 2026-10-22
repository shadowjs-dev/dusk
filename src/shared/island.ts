/**
 * Islands: parts of a page that are rendered by the server as static markup and hydrated in the browser only
 * when they are needed. The markup is an ordinary element that carries the attributes this module returns;
 * spread them on the element (`<div {...islandAttributes({ id: "chart", props })}>…</div>`). The page ships
 * the code of an island only when the island's loader is called (see `hydrateIslands` in the client).
 */

/**
 * When an island is hydrated: `load` (as soon as the page is interactive), `visible` (it scrolls into view),
 * `idle` (the browser is idle), `interaction` (the first pointer, key or focus on it), or `media` (a media query
 * matches). `only` renders nothing on the server: the component is mounted in the browser alone, as `load` does.
 * @since 1.0.0
 */
export type IslandStrategy = "load" | "visible" | "idle" | "interaction" | "media" | "only";

/** Options of {@link islandAttributes}. @since 1.0.0 */
export interface IslandOptions {
  /** The island's key in the client registry: lowercase letters, digits and dashes. */
  readonly id: string;
  /** Default `visible`. */
  readonly client?: IslandStrategy;
  /** The media query of the `media` strategy. Required with it. */
  readonly media?: string;
  /** The props the island is given: plain data only (objects, arrays, strings, finite numbers, booleans, null). */
  readonly props?: Readonly<Record<string, unknown>>;
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const STRATEGIES: ReadonlySet<string> = new Set([
  "load",
  "visible",
  "idle",
  "interaction",
  "media",
  "only",
]);
/** The largest props attribute, in characters; a larger one should be fetched by the island itself. */
const MAX_PROPS_CHARS = 16 * 1024;

/** The JSON of plain data, with the characters that could end a script or an attribute written as escapes. */
function propsJson(props: Readonly<Record<string, unknown>>): string {
  const seen = new Set<object>();
  const check = (value: unknown, path: string): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new TypeError(`island props: ${path} is not a finite number.`);
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError(
        `island props: ${path} is a ${typeof value}; only plain data can be a prop.`,
      );
    }
    if (seen.has(value)) throw new TypeError(`island props: ${path} is a cycle.`);
    seen.add(value);
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) check(item, `${path}[${index}]`);
    } else {
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(
          `island props: ${path} is an instance of a class; only plain objects can be props.`,
        );
      }
      for (const key of Object.keys(value)) check(Reflect.get(value, key), `${path}.${key}`);
    }
    seen.delete(value);
  };
  check(props, "props");
  const text = JSON.stringify(props).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (text.length > MAX_PROPS_CHARS) {
    throw new RangeError(
      `island props: the props are ${text.length} characters; the limit is ${MAX_PROPS_CHARS}.`,
    );
  }
  return text;
}

/**
 * The attributes of an island's element: its id, strategy, media query and props.
 *
 * @param options The island's id, strategy and props.
 * @returns The attributes (spread them on the element).
 * @throws TypeError for an id or strategy that is not allowed, a `media` strategy without a query, or props
 *   that are not plain data (functions, class instances, bigint, NaN, cycles).
 * @throws RangeError for props over the size limit.
 * @example
 * <div {...islandAttributes({ id: "chart", client: "visible", props: { series } })}>{fallback}</div>
 * @since 1.0.0
 */
export function islandAttributes(options: IslandOptions): Record<string, string> {
  if (!ID.test(options.id)) {
    throw new TypeError(
      `islandAttributes: the id ${JSON.stringify(options.id)} must be lowercase letters, digits and dashes.`,
    );
  }
  const strategy = options.client ?? "visible";
  if (!STRATEGIES.has(strategy))
    throw new TypeError(`islandAttributes: ${JSON.stringify(strategy)} is not a strategy.`);
  if (strategy === "media" && (options.media === undefined || options.media.trim() === "")) {
    throw new TypeError('islandAttributes: the "media" strategy needs a media query.');
  }
  const attributes: Record<string, string> = { "data-island": options.id, "data-client": strategy };
  if (options.media !== undefined) attributes["data-media"] = options.media;
  if (options.props !== undefined) attributes["data-props"] = propsJson(options.props);
  return attributes;
}

/**
 * A props attribute that could not be read back (not JSON, or not an object). Raised by the client, which
 * reports it and leaves that island as the server rendered it.
 * @example
 * new IslandPropsError("not JSON", new SyntaxError("Unexpected token")).message; // "island props: not JSON"
 * @since 1.0.0
 */
export class IslandPropsError extends Error {
  constructor(message: string, cause: unknown) {
    super(`island props: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "IslandPropsError";
  }
}
