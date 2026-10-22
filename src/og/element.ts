/**
 * The element tree an image is drawn from. It is the subset Next's `ImageResponse` accepts: flex layout with inline
 * `style` objects, text, and `img`/`svg`-free boxes. A node is a string, a number, nothing, or an element; an element
 * is a tag name (lower-case) with props, or a function component that returns a node.
 *
 * ShadowJS JSX compiles to DOM templates, so it cannot build this tree. Write the tree with `h` (or with the JSX
 * runtime of this module, `jsx`/`jsxs`, through a `jsxImportSource` pragma when a build compiles the image file as
 * plain JSX).
 * @packageDocumentation
 */

/** A CSS value in an inline style: a string or a number (pixels). @since 1.0.0 */
export type OgStyleValue = string | number;

/** The inline style of an element, in camelCase. @since 1.0.0 */
export type OgStyle = Readonly<Record<string, OgStyleValue | undefined>>;

/** A drawable element. @since 1.0.0 */
export interface OgElement {
  readonly type: string | OgComponent;
  readonly props: {
    readonly style?: OgStyle;
    readonly children?: OgNode;
    readonly [name: string]: unknown;
  };
}

/** A function component: it receives the props and returns a node. @since 1.0.0 */
export type OgComponent = (props: Readonly<Record<string, unknown>>) => OgNode;

/** What a child may be. @since 1.0.0 */
export type OgNode = OgElement | string | number | null | undefined | boolean | readonly OgNode[];

/** A tag name satori draws: lower-case letters and digits. @internal */
const TAG_NAME = /^[a-z][a-z0-9]*$/;

/**
 * Longest tree a single image may hold (nodes), so a generated tree cannot exhaust memory.
 *
 * @example
 * import { MAX_OG_NODES } from "@shadow-js/dusk/og";
 * MAX_OG_NODES; // 5000
 * @since 1.0.0
 */
export const MAX_OG_NODES = 5000;

/**
 * Most characters of text (children and prop strings, data: images apart) in one tree.
 * @example
 * expandTree(h("p", null, "x".repeat(MAX_OG_TEXT_LENGTH))); // fits: exactly the limit
 * expandTree(h("p", null, "x".repeat(MAX_OG_TEXT_LENGTH + 1))); // throws RangeError
 * @since 1.0.0
 */
export const MAX_OG_TEXT_LENGTH = 100_000;

/**
 * Longest single prop or style string, data: images apart.
 * @example
 * expandTree(h("div", { style: { fontFamily: "a".repeat(MAX_OG_STRING_LENGTH) } })); // fits
 * expandTree(h("div", { style: { fontFamily: "a".repeat(MAX_OG_STRING_LENGTH + 1) } })); // throws RangeError
 * @since 1.0.0
 */
export const MAX_OG_STRING_LENGTH = 10_000;

/**
 * Longest single `data:` image, in characters (4 MiB).
 * @example
 * expandTree(h("img", { src: `data:image/png;base64,${"A".repeat(200_000)}` })); // fits
 * expandTree(h("img", { src: `data:image/png;base64,${"A".repeat(MAX_OG_DATA_LENGTH)}` })); // throws RangeError
 * @since 1.0.0
 */
export const MAX_OG_DATA_LENGTH: number = 4 * 1024 * 1024;

/**
 * Most characters of `data:` images in one tree (8 MiB).
 * @example
 * const image = h("img", { src: `data:image/png;base64,${"A".repeat(1_000_000)}` });
 * expandTree(h("div", null, ...Array.from({ length: 8 }, () => image))); // fits: about 8 MB
 * expandTree(h("div", null, ...Array.from({ length: 9 }, () => image))); // throws RangeError
 * @since 1.0.0
 */
export const MAX_OG_DATA_TOTAL: number = 8 * 1024 * 1024;

/** Options of {@link expandTree}. @internal */
export interface ExpandOptions {
  /** Let `src`, `href` and `url()` name an http(s) URL, which satori then fetches. Default false: only `data:` images. */
  readonly allowRemoteImages?: boolean;
}

/** An image the tree carries itself. */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;
/** A `url(data:image/...)` inside a CSS value, quoted or not. */
const CSS_DATA_URL = /url\(\s*(['"]?)data:image\/[^)'"]*\1\s*\)/gi;
/** Any `url(...)` function; the target is the first capture group after the quote. */
const CSS_URL = /url\s*\(\s*(['"]?)([^)'"]*)/gi;
/** CSS functions that fetch an image and are not `url()`. */
const CSS_OTHER_FETCH = /(?:^|[^a-z0-9_-])(?:-webkit-)?(?:image-set|src)\s*\(/i;
/** Attributes whose value is a place to fetch from. */
const FETCH_KEYS: ReadonlySet<string> = new Set([
  "src",
  "href",
  "xlink:href",
  "xlinkhref",
  "srcset",
  "poster",
  "data",
]);

/** What the walk has counted so far. */
interface Budget {
  count: number;
  text: number;
  data: number;
}

/** Counts a `data:` image against the per-image and total limits. */
function spendData(budget: Budget, length: number): void {
  if (length > MAX_OG_DATA_LENGTH)
    throw new RangeError(
      `ImageResponse: a data: image is longer than ${MAX_OG_DATA_LENGTH} characters.`,
    );
  budget.data += length;
  if (budget.data > MAX_OG_DATA_TOTAL)
    throw new RangeError(
      `ImageResponse: the data: images hold more than ${MAX_OG_DATA_TOTAL} characters.`,
    );
}

/** Counts text against the total limit. */
function spendText(budget: Budget, length: number): void {
  budget.text += length;
  if (budget.text > MAX_OG_TEXT_LENGTH)
    throw new RangeError(
      `ImageResponse: the tree holds more than ${MAX_OG_TEXT_LENGTH} characters of text.`,
    );
}

/** Whether a fetching attribute may hold this value: an image the tree carries, a fragment, or (opt-in) an http(s) URL. */
function allowedSource(value: string, remote: boolean): boolean {
  if (DATA_IMAGE.test(value) || value.startsWith("#")) return true;
  return remote && /^https?:\/\//i.test(value) && URL.canParse(value);
}

/**
 * Checks one prop or style value. Satori fetches what `src`, `href` and CSS `url()` name, so a URL that a request can
 * influence would be a server-side request: only images the tree carries (`data:image/...`) are allowed unless the app
 * opts in. Numbers must be finite, and nothing but data (no function, symbol or bigint) reaches the renderer.
 */
function checkValue(
  key: string,
  value: unknown,
  budget: Budget,
  remote: boolean,
  depth: number,
): void {
  if (value === undefined || value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`ImageResponse: "${key}" is ${String(value)}; numbers must be finite.`);
    return;
  }
  if (typeof value === "string") {
    if (FETCH_KEYS.has(key.toLowerCase())) {
      if (!allowedSource(value, remote)) {
        throw new TypeError(
          `ImageResponse: "${key}" must be a data:image URI${remote ? " or an http(s) URL" : ""} (a URL is fetched by the renderer, so it must not come from a request; pass allowRemoteImages for URLs fixed in code).`,
        );
      }
      if (DATA_IMAGE.test(value)) spendData(budget, value.length);
      else spendText(budget, value.length);
      return;
    }
    let rest = value;
    if (/url\s*\(/i.test(value)) {
      rest = value.replace(CSS_DATA_URL, (match) => {
        spendData(budget, match.length);
        return "data-image";
      });
    }
    if (rest.length > MAX_OG_STRING_LENGTH)
      throw new RangeError(
        `ImageResponse: "${key}" is longer than ${MAX_OG_STRING_LENGTH} characters.`,
      );
    spendText(budget, rest.length);
    // A CSS escape can spell `url(` without writing it, and no real style needs one.
    if (rest.includes("\\"))
      throw new TypeError(`ImageResponse: "${key}" holds a backslash escape.`);
    if (CSS_OTHER_FETCH.test(rest))
      throw new TypeError(`ImageResponse: "${key}" uses a CSS function that fetches an image.`);
    for (const match of rest.matchAll(CSS_URL)) {
      const target = match[2] ?? "";
      if (target !== "" && !allowedSource(target, remote)) {
        throw new TypeError(
          `ImageResponse: "${key}" has a url() that is not a data:image URI${remote ? " or an http(s) URL" : ""}.`,
        );
      }
      if (target === "")
        throw new TypeError(`ImageResponse: "${key}" has an empty or unreadable url().`);
    }
    return;
  }
  if (typeof value === "object" && depth < 4) {
    for (const [name, inner] of Object.entries(value)) {
      checkValue(name, inner, budget, remote, depth + 1);
    }
    return;
  }
  throw new TypeError(`ImageResponse: "${key}" is a ${typeof value}, which a drawing cannot hold.`);
}

/**
 * Creates an element. `h("div", { style: { display: "flex" } }, "Hello")` is the same as `<div style=...>Hello</div>`.
 *
 * @param type A lower-case tag name, or a function component.
 * @param props The props (`style` and any others).
 * @param children The children (strings, numbers, elements, arrays).
 * @returns The element.
 * @throws TypeError for a tag name satori cannot draw.
 * @example
 * h("div", { style: { display: "flex", fontSize: 48 } }, "Example");
 * @since 1.0.0
 */
export function h(
  type: string | OgComponent,
  props: Readonly<Record<string, unknown>> | null = null,
  ...children: readonly OgNode[]
): OgElement {
  if (typeof type === "string" && !TAG_NAME.test(type)) {
    throw new TypeError(
      `ImageResponse: "${type}" is not a tag satori can draw (use lower-case names).`,
    );
  }
  // Children passed as arguments win; otherwise a `children` prop (the JSX runtime's form) is kept.
  const { children: fromProps, ...rest } = props ?? {};
  const kids: OgNode =
    children.length === 0
      ? (fromProps as OgNode)
      : children.length === 1
        ? children[0]
        : [...children];
  return {
    type,
    props: { ...rest, ...(kids === undefined ? {} : { children: kids }) } as OgElement["props"],
  };
}

/**
 * Fragment: its children, without a wrapping element.
 *
 * @example
 * import { Fragment, h } from "@shadow-js/dusk/og";
 * Fragment({ children: h("p", null, "Hi") }); // { type: "p", props: { children: "Hi" } }
 * @since 1.0.0
 */
export const Fragment = (props: { readonly children?: OgNode }): OgNode => props.children;

/**
 * The JSX runtime entry for one child (`jsx(type, props)`). Keys are ignored; the tree is the same as `h`'s.
 *
 * @param type The tag or component.
 * @param props The props, with `children`.
 * @returns The element.
 * @example
 * import { jsx } from "@shadow-js/dusk/og";
 * jsx("p", { children: "Hi" }); // { type: "p", props: { children: "Hi" } }
 * @since 1.0.0
 */
export function jsx(
  type: string | OgComponent,
  props: Readonly<Record<string, unknown>>,
): OgElement {
  return h(type, props);
}

/**
 * The JSX runtime entry for several children (`jsxs(type, props)`).
 *
 * @param type The tag or component.
 * @param props The props, with an array `children`.
 * @returns The element.
 * @example
 * import { jsxs } from "@shadow-js/dusk/og";
 * jsxs("p", { children: ["a", "b"] }); // { type: "p", props: { children: ["a", "b"] } }
 * @since 1.0.0
 */
export function jsxs(
  type: string | OgComponent,
  props: Readonly<Record<string, unknown>>,
): OgElement {
  return h(type, props);
}

/**
 * Expands function components and counts the nodes of a tree, failing when it is too large. The result is what the
 * renderer receives: only tags and text, with every component called. Strings, numbers and fetching attributes are
 * checked on the way (see {@link checkValue}), so the renderer is never handed a URL to fetch, an unbounded amount of
 * text, or a value it cannot lay out.
 *
 * @param node The tree.
 * @param options `allowRemoteImages` lets http(s) URLs through (the renderer then fetches them).
 * @returns The expanded tree.
 * @throws RangeError when the tree has more than {@link MAX_OG_NODES} nodes, nests deeper than 200 levels or holds too
 *   much text.
 * @throws TypeError for a tag, a value or a URL the renderer must not be given.
 * @internal
 */
export function expandTree(
  node: OgNode,
  options: ExpandOptions = {},
): OgElement | string | number | null {
  const budget: Budget = { count: 0, text: 0, data: 0 };
  const remote = options.allowRemoteImages === true;
  const visit = (value: OgNode, depth: number): OgElement | string | number | null => {
    if (depth > 200)
      throw new RangeError("ImageResponse: the element tree is nested deeper than 200 levels.");
    budget.count += 1;
    if (budget.count > MAX_OG_NODES)
      throw new RangeError(`ImageResponse: the element tree has more than ${MAX_OG_NODES} nodes.`);
    if (value === null || value === undefined || typeof value === "boolean") return null;
    if (typeof value === "string") {
      spendText(budget, value.length);
      return value;
    }
    if (typeof value === "number") {
      checkValue("text", value, budget, remote, 0);
      return value;
    }
    if (Array.isArray(value)) {
      // An array is a fragment; satori takes a single node, so a list is wrapped in a flex column with no style.
      const items = (value as readonly OgNode[])
        .map((item) => visit(item, depth + 1))
        .filter((item) => item !== null);
      return {
        type: "div",
        props: { style: { display: "flex", flexDirection: "column" }, children: items },
      };
    }
    const element = value as OgElement;
    if (typeof element.type === "function") {
      return visit(element.type({ ...element.props }), depth + 1);
    }
    if (!TAG_NAME.test(element.type)) {
      throw new TypeError(`ImageResponse: "${element.type}" is not a tag satori can draw.`);
    }
    const children = element.props.children;
    const expanded = children === undefined ? undefined : (children as OgNode);
    const kids = expanded === undefined ? undefined : visitChildren(expanded, depth + 1, visit);
    const { children: _removed, ...rest } = element.props;
    for (const [key, prop] of Object.entries(rest)) {
      checkValue(key, prop, budget, remote, 0);
    }
    return {
      type: element.type,
      props: { ...rest, ...(kids === undefined ? {} : { children: kids }) } as OgElement["props"],
    };
  };
  return visit(node, 0);
}

/** Children of an element: one node or a list, each expanded. */
function visitChildren(
  children: OgNode,
  depth: number,
  visit: (value: OgNode, depth: number) => OgElement | string | number | null,
): OgElement | string | number | null | readonly (OgElement | string | number)[] {
  if (Array.isArray(children)) {
    return (children as readonly OgNode[])
      .map((child) => visit(child, depth))
      .filter((child): child is OgElement | string | number => child !== null);
  }
  return visit(children, depth);
}
