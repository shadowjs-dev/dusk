/**
 * Checks of the values that `defineFonts` writes into CSS or sends in a request, shared by the local path (`fonts.ts`)
 * and the Google path (`google-fonts.ts`) so both refuse the same things, and the Google path refuses them before any
 * request is made. A font family, a weight and a fallback stack come from a config file, but a config file can read them
 * from a database or a CMS; none of them may carry CSS.
 * @packageDocumentation
 */

/** A CSS custom property name, `--name`. @internal */
export const CSS_VARIABLE: RegExp = /^--[a-z][a-z0-9-]*$/;

const WEIGHT_NUMBER = String.raw`(?:[1-9]\d{0,2}|1000)(?:\.\d{1,3})?`;
const WEIGHT = new RegExp(
  `^(?:normal|bold|bolder|lighter|${WEIGHT_NUMBER}(?: ${WEIGHT_NUMBER})?)$`,
);
/** One family of a stack: unquoted words (`Segoe UI`, `system-ui`, `-apple-system`) or one quoted name. */
const FALLBACK_BARE = /^-?[A-Za-z_][A-Za-z0-9_-]*(?: [A-Za-z0-9_-]+)*$/;
const FALLBACK_QUOTED = /^(?:"[A-Za-z0-9 _.+-]{1,100}"|'[A-Za-z0-9 _.+-]{1,100}')$/;
/** Longest fallback stack. */
const MAX_FALLBACK = 16;

/**
 * A `font-weight` value: a number from 1 to 1000, a keyword, or a range of two numbers (`"400 700"`).
 *
 * @param weight The weight as the author wrote it.
 * @param family The family, for the message.
 * @returns The value to write.
 * @throws TypeError for anything else (it would be written into a rule).
 * @internal
 */
export function checkedWeight(weight: string | number, family: string): string {
  const text = typeof weight === "number" ? String(weight) : weight;
  if (typeof text !== "string" || !WEIGHT.test(text)) {
    throw new TypeError(
      `defineFonts: the weight ${JSON.stringify(weight)} of "${family}" must be a number from 1 to 1000, a range such as "400 700", or normal or bold.`,
    );
  }
  return text;
}

/**
 * A `font-style`: `normal` or `italic`.
 *
 * @internal
 */
export function checkedStyle(style: string, family: string): "normal" | "italic" {
  if (style !== "normal" && style !== "italic") {
    throw new TypeError(
      `defineFonts: the style ${JSON.stringify(style)} of "${family}" must be "normal" or "italic".`,
    );
  }
  return style;
}

/**
 * The families after the web font: each one a family name (words, or one quoted name) or a generic keyword. A comma, a
 * brace, a semicolon, a backslash, a parenthesis or an unbalanced quote is refused, so an entry cannot end the declaration.
 *
 * @param entries The stack.
 * @param family The family the stack belongs to, for the message.
 * @returns The same entries.
 * @throws TypeError for an entry that is not a plain family name.
 * @internal
 */
export function checkedFallback(entries: readonly string[], family: string): readonly string[] {
  if (!Array.isArray(entries) || entries.length > MAX_FALLBACK) {
    throw new TypeError(
      `defineFonts: the fallback of "${family}" must be a list of at most ${MAX_FALLBACK} family names.`,
    );
  }
  for (const entry of entries) {
    if (
      typeof entry !== "string" ||
      entry.length > 100 ||
      !(FALLBACK_BARE.test(entry) || FALLBACK_QUOTED.test(entry))
    ) {
      throw new TypeError(
        `defineFonts: the fallback entry ${JSON.stringify(entry)} of "${family}" must be a family name (letters, digits, spaces, dashes) or a generic family, with no CSS in it.`,
      );
    }
  }
  return entries;
}

/**
 * The CDN origin the font files are served from: an http(s) origin with no path, query, fragment or credentials (the
 * same rule as the `assetOrigin` option of `dusk()`, kept here so the font module does not import the plugin options).
 *
 * @param value The origin as the author wrote it.
 * @returns The origin without a trailing slash.
 * @throws TypeError for anything else (it would be written into the stylesheet and into head links).
 * @internal
 */
export function checkedOrigin(value: string): string {
  const parsed = typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
  if (
    parsed === undefined ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError(
      `defineFonts: assetOrigin must be an http(s) origin such as https://cdn.example (got ${JSON.stringify(value)}).`,
    );
  }
  return parsed.origin;
}
