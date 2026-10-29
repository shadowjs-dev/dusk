import type { HeadTag } from "@shadow-js/web";
import { hasControl } from "../internal/text";

/**
 * Font loading helpers: the preload link that starts a font's download early, the `@font-face` rule with
 * `font-display`, and a fallback face whose size and vertical metrics match the web font, so the text does
 * not jump when the web font replaces the fallback (the "size-adjust" technique). Everything here is plain
 * data or CSS text; the values that could break out of a CSS string are refused.
 */

/** The formats a `@font-face` source may name. @since 1.0.0 */
export type FontFormat = "woff2" | "woff" | "truetype" | "opentype" | "embedded-opentype" | "svg";

/** `font-display` values. @since 1.0.0 */
export type FontDisplay = "auto" | "block" | "swap" | "fallback" | "optional";

/** One source of a font: its URL and format. @since 1.0.0 */
export interface FontSource {
  readonly url: string;
  readonly format: FontFormat;
}

/** Options of {@link fontFace}. @since 1.0.0 */
export interface FontFaceOptions {
  /** The family name the CSS uses. */
  readonly family: string;
  /** The sources, in the order the browser tries them. */
  readonly src: readonly FontSource[];
  /** A weight, or a range (`"100 900"`). */
  readonly weight?: string | number;
  /** `normal`, `italic` or `oblique`. */
  readonly style?: "normal" | "italic" | "oblique";
  /** Default `swap`: show the fallback at once, then the web font. */
  readonly display?: FontDisplay;
  /** The characters the face covers (`U+0000-00FF`). */
  readonly unicodeRange?: string;
  /** A stretch (width axis) or a range of them: `"75% 100%"` for a variable `wdth` axis. */
  readonly stretch?: string;
}

/** A font's vertical and width metrics, in font units. @since 1.0.0 */
export interface FontMetrics {
  readonly unitsPerEm: number;
  /** The average width of a lowercase letter (OS/2 `xAvgCharWidth` is close; a measured value is better). */
  readonly xWidthAvg: number;
  /** The typographic ascender (a positive number). */
  readonly ascender: number;
  /** The typographic descender (negative, or positive; its magnitude is used). */
  readonly descender: number;
  readonly lineGap: number;
}

const URL_CHARS = /^[^"'()\\\s;{}<>]+$/;
const FORMATS: ReadonlySet<string> = new Set([
  "woff2",
  "woff",
  "truetype",
  "opentype",
  "embedded-opentype",
  "svg",
]);
const DISPLAYS: ReadonlySet<string> = new Set(["auto", "block", "swap", "fallback", "optional"]);

const STYLES: ReadonlySet<string> = new Set(["normal", "italic", "oblique"]);
/** A weight: a keyword or a number from 1 to 1000, or a range of two numbers (a variable font's axis). */
const WEIGHT =
  /^(?:normal|bold|(?:[1-9]\d{0,2}|1000)(?:\.\d+)?(?:\s+(?:[1-9]\d{0,2}|1000)(?:\.\d+)?)?)$/;

/** The `font-weight` text; anything else could end the declaration, the rule or the style element it is written into. */
function weightText(weight: string | number): string {
  const text = String(weight);
  if (!WEIGHT.test(text))
    throw new TypeError(
      `fontFace: weight ${JSON.stringify(text)} must be normal, bold, a number from 1 to 1000, or a range of two numbers.`,
    );
  return text;
}

/** A CSS string literal for a name, refusing anything that could end the string or the rule. */
function cssName(name: string, what: string): string {
  if (name.length === 0 || name.length > 100 || hasControl(name) || /["';{}<>\\]/.test(name)) {
    throw new TypeError(
      `${what} must be 1 to 100 characters with no quotes, backslashes, braces, semicolons or control characters.`,
    );
  }
  return `"${name}"`;
}

function cssUrl(url: string): string {
  if (hasControl(url) || !URL_CHARS.test(url))
    throw new TypeError(
      `a font URL (${JSON.stringify(url)}) contains a character that is not allowed in url().`,
    );
  if (
    !(url.startsWith("/") && !url.startsWith("//")) &&
    !(URL.canParse(url) && /^https?:$/.test(new URL(url).protocol))
  ) {
    throw new TypeError(
      `a font URL (${JSON.stringify(url)}) must be a path on this origin or an http(s) URL.`,
    );
  }
  return `url("${url}")`;
}

/**
 * The head link that preloads a font file: the browser starts the download before the stylesheet is read.
 * Fonts are always fetched in CORS mode, so the link says `crossorigin`.
 *
 * @param options The font's URL and its MIME type (default `font/woff2`).
 * @returns A head tag for `useHead` or `document.head`.
 * @throws TypeError for a URL that is not a path or an http(s) URL.
 * @example
 * import { fontPreloadTag } from "@shadow-js/dusk/static";
 * fontPreloadTag({ href: "/fonts/inter.woff2" }).props.as; // "font"
 * @since 1.0.0
 */
export function fontPreloadTag(options: {
  readonly href: string;
  readonly type?: string;
}): HeadTag {
  cssUrl(options.href);
  return {
    tag: "link",
    props: {
      rel: "preload",
      as: "font",
      href: options.href,
      type: options.type ?? "font/woff2",
      crossorigin: "anonymous",
    },
  };
}

/**
 * A `@font-face` rule for a web font. `font-display` defaults to `swap`.
 *
 * @param options The family, sources and descriptors.
 * @returns The CSS rule.
 * @throws TypeError for a name or URL that could break out of the CSS, an unknown format or display value, or no sources.
 * @example
 * fontFace({ family: "Inter", src: [{ url: "/fonts/inter.woff2", format: "woff2" }], weight: "100 900" });
 * @since 1.0.0
 */
export function fontFace(options: FontFaceOptions): string {
  if (options.src.length === 0) throw new TypeError("fontFace: at least one source is needed.");
  const sources = options.src.map((source) => {
    if (!FORMATS.has(source.format))
      throw new TypeError(`fontFace: ${JSON.stringify(source.format)} is not a font format.`);
    return `${cssUrl(source.url)} format("${source.format}")`;
  });
  const display = options.display ?? "swap";
  if (!DISPLAYS.has(display))
    throw new TypeError(`fontFace: ${JSON.stringify(display)} is not a font-display value.`);
  const parts = [
    `font-family: ${cssName(options.family, "the family name")}`,
    `src: ${sources.join(", ")}`,
  ];
  if (options.weight !== undefined) parts.push(`font-weight: ${weightText(options.weight)}`);
  if (options.style !== undefined) {
    if (!STYLES.has(options.style))
      throw new TypeError(`fontFace: ${JSON.stringify(options.style)} is not a font style.`);
    parts.push(`font-style: ${options.style}`);
  }
  if (options.stretch !== undefined) {
    if (!/^(?:\d+(?:\.\d+)?%)(?:\s+\d+(?:\.\d+)?%)?$/.test(options.stretch)) {
      throw new TypeError(
        `fontFace: stretch ${JSON.stringify(options.stretch)} is not a percentage or a pair of them.`,
      );
    }
    parts.push(`font-stretch: ${options.stretch}`);
  }
  parts.push(`font-display: ${display}`);
  if (options.unicodeRange !== undefined) {
    if (!/^[Uu+0-9A-Fa-f?\-,\s]+$/.test(options.unicodeRange))
      throw new TypeError("fontFace: unicodeRange is not a range list.");
    parts.push(`unicode-range: ${options.unicodeRange}`);
  }
  return `@font-face { ${parts.join("; ")}; }`;
}

/** A percentage with two decimals at most. */
function percent(ratio: number): string {
  return `${Math.round(ratio * 10000) / 100}%`;
}

/**
 * A `@font-face` for a locally installed font that stands in for the web font while it loads, scaled so its
 * average character width matches the web font (`size-adjust`), and with its ascent, descent and line gap
 * overridden in the same scale, so the line boxes do not change height when the web font arrives.
 *
 * The formula: the web font's width is `xWidthAvg / unitsPerEm`; the fallback's is the same for its own
 * metrics; `size-adjust` is the ratio of the two. The vertical overrides are the font's metrics divided by
 * that ratio.
 *
 * @param options The family name, the local font, the web font's metrics and the fallback's width.
 * @returns The CSS rule.
 * @throws RangeError for a metric that is not a positive number (a zero width would divide by zero).
 * @throws TypeError for a name that could break out of the CSS.
 * @example
 * fallbackFontFace({ family: "Inter fallback", local: "Arial", font: inter, fallback: { unitsPerEm: 2048, xWidthAvg: 904 } });
 * @since 1.0.0
 */
export function fallbackFontFace(options: {
  readonly family: string;
  readonly local: string;
  readonly font: FontMetrics;
  readonly fallback: { readonly unitsPerEm: number; readonly xWidthAvg: number };
}): string {
  const { font, fallback } = options;
  for (const [name, value] of [
    ["font.unitsPerEm", font.unitsPerEm],
    ["font.xWidthAvg", font.xWidthAvg],
    ["fallback.unitsPerEm", fallback.unitsPerEm],
    ["fallback.xWidthAvg", fallback.xWidthAvg],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`fallbackFontFace: ${name} must be a positive number.`);
  }
  const sizeAdjust = font.xWidthAvg / font.unitsPerEm / (fallback.xWidthAvg / fallback.unitsPerEm);
  return `@font-face { font-family: ${cssName(options.family, "the family name")}; src: local(${cssName(options.local, "the local font name")}); size-adjust: ${percent(sizeAdjust)}; ascent-override: ${percent(font.ascender / font.unitsPerEm / sizeAdjust)}; descent-override: ${percent(Math.abs(font.descender) / font.unitsPerEm / sizeAdjust)}; line-gap-override: ${percent(font.lineGap / font.unitsPerEm / sizeAdjust)}; }`;
}
