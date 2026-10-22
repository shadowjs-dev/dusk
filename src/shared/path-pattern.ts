/**
 * Path patterns: the one grammar behind `redirects`, `rewrites`, `headers` and `routeRules` of
 * `dusk.config.ts`. It is the router's segment grammar (`:name` for one segment, `*name` for a rest splat)
 * plus one glob, `**`, and a `*` inside a segment.
 *
 * - `/about` is a literal. A trailing slash is ignored (`/about/` is `/about`).
 * - `:name` matches one non-empty segment and captures it, percent-decoded.
 * - `*name` (or `*`) matches one or more trailing segments and captures them, joined with `/`. It is the
 *   router's splat: it needs at least one segment.
 * - `**` matches zero or more trailing segments and captures nothing (the glob of the config files).
 * - `img-*.png`: a `*` inside a segment matches any run of characters within that segment. A segment that
 *   starts with `*` must be `*`, `*name` or `**`.
 * - `*name` and `**` are only allowed as the last segment. Matching is case-sensitive.
 * - Optional segments (`:name?`) and the `:name*` form are not part of the grammar (use `*name`).
 * - A request path with an empty segment (`//`) never matches.
 *
 * Priority ("specificity") is a total order: at each segment a literal beats a segment glob, which beats a
 * param; then a fixed path beats a splat, which beats `**`; a longer fixed path beats a shorter one. Ties
 * (same shape, other names) compare equal. Route rules merge by this order; first-match rules use the
 * declaration order instead.
 *
 * @packageDocumentation
 */

/** One segment of a compiled pattern (before the trailing rest, if any). @internal */
type Segment =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "glob"; readonly pieces: readonly string[] }
  | { readonly kind: "param"; readonly name: string };

/** A compiled pattern. @since 1.0.0 */
export interface CompiledPattern {
  /** The pattern as written, without a trailing slash (`/` for the root). */
  readonly source: string;
  /** The segments before the rest, in order. */
  readonly segments: readonly Segment[];
  /** `none`: no rest; `splat`: `*name`/`*` (one or more); `any`: `**` (zero or more). */
  readonly rest: "none" | "splat" | "any";
  /** The capture name of a splat (`*` captures as `*`). */
  readonly restName: string | undefined;
  /** The specificity sequence: one rank per segment, then the terminator (see the file comment). */
  readonly specificity: readonly number[];
}

/** The captured parameters of a match. @since 1.0.0 */
export type PathParams = Readonly<Record<string, string>>;

// The matcher is its own module: it runs only when a request meets a rule, so the code that reads the configuration at
// start-up does not carry it. Re-exported, so `matchPattern` is still named here.
export { matchPattern } from "./path-match";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RANK = { literal: 4, glob: 3, param: 2 } as const;
const TERMINATOR = { none: -1, splat: -2, any: -3 } as const;

function decodeSegment(raw: string, where: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new TypeError(`${where}: "${raw}" is not valid percent-encoding.`);
  }
}

/**
 * Compiles a pattern. Throws for anything the grammar does not allow, so a bad pattern fails when the
 * configuration is read, never on a request.
 *
 * @param source The pattern, starting with `/`.
 * @returns The compiled pattern.
 * @throws TypeError for a pattern that is not valid (see the file comment).
 * @example compilePattern("/blog/:slug").segments.length; // 2
 * @since 1.0.0
 */
export function compilePattern(source: string): CompiledPattern {
  if (typeof source !== "string" || !source.startsWith("/")) {
    throw new TypeError(`path pattern ${JSON.stringify(source)} must start with "/".`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[?#\\\u0000-\u001f\u007f]/.test(source)) {
    throw new TypeError(
      `path pattern ${JSON.stringify(source)} must not contain ?, #, \\ or control characters.`,
    );
  }
  const normal = source.length > 1 && source.endsWith("/") ? source.slice(0, -1) : source;
  const parts = normal === "/" ? [] : normal.slice(1).split("/");
  const where = `path pattern ${JSON.stringify(source)}`;
  const segments: Segment[] = [];
  let rest: CompiledPattern["rest"] = "none";
  let restName: string | undefined;
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === "") throw new TypeError(`${where} has an empty segment.`);
    if (part === "**") {
      if (!last) throw new TypeError(`${where}: "**" must be the last segment.`);
      rest = "any";
      return;
    }
    if (part.startsWith("*")) {
      if (!last) throw new TypeError(`${where}: "${part}" must be the last segment.`);
      const name = part === "*" ? "*" : part.slice(1);
      if (name !== "*" && !PARAM_NAME.test(name))
        throw new TypeError(`${where}: "${part}" has an invalid name.`);
      rest = "splat";
      restName = name;
      return;
    }
    if (part.startsWith(":")) {
      if (part.endsWith("?"))
        throw new TypeError(`${where}: optional segments (":name?") are not supported.`);
      if (part.endsWith("*"))
        throw new TypeError(`${where}: write a rest capture as "*name", not ":name*".`);
      const name = part.slice(1);
      if (!PARAM_NAME.test(name)) throw new TypeError(`${where}: "${part}" has an invalid name.`);
      segments.push({ kind: "param", name });
      return;
    }
    if (part.includes("*")) {
      const pieces = part.split("*").map((piece) => decodeSegment(piece, where));
      segments.push({ kind: "glob", pieces });
      return;
    }
    segments.push({ kind: "literal", text: decodeSegment(part, where) });
  });
  const ranks = segments.map((segment) => RANK[segment.kind]);
  return {
    source: normal,
    segments,
    rest,
    restName,
    specificity: [...ranks, TERMINATOR[rest === "none" ? "none" : rest]],
  };
}

/**
 * The parameter names a destination template uses (`:name` and `*name`), in order.
 *
 * @param template A path template.
 * @returns The names.
 * @since 1.0.0
 */
export function templateNames(template: string): string[] {
  const names: string[] = [];
  for (const token of template.split("/")) {
    if (token.startsWith(":")) names.push(token.slice(1));
    else if (token.startsWith("*") && token.length > 1) names.push(token.slice(1));
  }
  return names;
}

/**
 * Fills a destination template with captured parameters. Each value is percent-encoded; a splat is encoded
 * per segment, so its `/` separators stay. `**` and a `*` inside a segment are not allowed in a destination.
 *
 * @param template A path such as `/users/:id/edit` or `/new/*rest`.
 * @param params The captured values.
 * @returns The path.
 * @throws TypeError for a missing parameter or a wildcard in the template.
 * @example fillPattern("/users/:id", { id: "a/b" }); // "/users/a%2Fb"
 * @since 1.0.0
 */
export function fillPattern(template: string, params: PathParams): string {
  if (!template.startsWith("/"))
    throw new TypeError(`destination ${JSON.stringify(template)} must start with "/".`);
  const parts = template === "/" ? [] : template.slice(1).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "")
      throw new TypeError(
        `destination ${JSON.stringify(template)} may not contain empty segments.`,
      );
    if (part.startsWith(":")) {
      const name = part.slice(1);
      const value = params[name];
      if (value === undefined)
        throw new TypeError(
          `destination ${JSON.stringify(template)} needs the parameter "${name}".`,
        );
      out.push(encodeURIComponent(value));
      continue;
    }
    if (part.startsWith("*")) {
      const name = part === "*" ? "*" : part.slice(1);
      const value = params[name];
      if (value === undefined)
        throw new TypeError(
          `destination ${JSON.stringify(template)} needs the parameter "${name}".`,
        );
      if (value !== "") out.push(...value.split("/").map((piece) => encodeURIComponent(piece)));
      continue;
    }
    if (part.includes("*"))
      throw new TypeError(`destination ${JSON.stringify(template)} may not contain "*".`);
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * The specificity order of two compiled patterns: negative when `a` is more specific than `b`, positive when
 * less, `0` when equal in shape. A total preorder (see the file comment).
 *
 * @param a A pattern.
 * @param b Another pattern.
 * @returns A number whose sign orders the patterns.
 * @example comparePatterns(compilePattern("/a/b"), compilePattern("/a/**")) < 0; // true
 * @since 1.0.0
 */
export function comparePatterns(a: CompiledPattern, b: CompiledPattern): number {
  const sa = a.specificity;
  const sb = b.specificity;
  const length = Math.min(sa.length, sb.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (sb[index] ?? 0) - (sa[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return sa.length - sb.length;
}
