import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { HeadTag } from "@shadow-js/web";
import {
  type FontDisplay,
  type FontFormat,
  type FontMetrics,
  fallbackFontFace,
  fontFace,
  fontPreloadTag,
} from "../shared/font";
import { type FontFileMetrics, readFontMetrics } from "./font-metrics";
import {
  type FontReport,
  type FontReportFile,
  type FontRoutePreloads,
  formatFontReport,
} from "./font-report";
import {
  CSS_VARIABLE,
  checkedFallback,
  checkedOrigin,
  checkedStyle,
  checkedWeight,
} from "./font-values";
import { compileGlob } from "./glob";
import {
  type GoogleFont,
  type GoogleFontsOptions,
  googleContext,
  readLock,
  resolveGoogleFamily,
  saveLock,
} from "./google-fonts";

/**
 * Build-time font pipeline. The offline path: the font files are vendored into `public/` (for example
 * `public/fonts/InstrumentSans.woff2`), and `defineFonts` checks they exist, writes the `@font-face` rules
 * (with `font-display`, the width axis and the size-adjusted fallback), the CSS variables, and the preload tags.
 * The defaults follow `next/font`: files are preloaded, the fallback face is built whenever the file's metrics can be read,
 * and `font-display` is `swap`; each has an explicit way out. Nothing here touches the network: a missing file is a
 * build error that names the file.
 * @packageDocumentation
 */

/** One font file, relative to the public directory. @since 1.0.0 */
export interface FontFile {
  /** Path under `public/`, for example `fonts/InstrumentSans.woff2`. No `..`, no backslash, no leading slash. */
  readonly file: string;
  /** Inferred from the extension when omitted (`woff2`, `woff`, `ttf`, `otf`). */
  readonly format?: FontFormat;
  /** A weight, or a range for a variable font (`"400 700"`). Default 400. */
  readonly weight?: string | number;
  readonly style?: "normal" | "italic";
  /** The width axis: `"75% 100%"` for a variable `wdth` axis. */
  readonly stretch?: string;
  readonly unicodeRange?: string;
  /**
   * Preload this file in the head. Default: the family's `preload`, else true, except for a file with a `unicodeRange`
   * (a slice of the family that is fetched only when its characters are used), which defaults to false.
   */
  readonly preload?: boolean;
}

/** A font family: its files, its CSS variable, and its fallback metrics. @since 1.0.0 */
export interface FontDefinition {
  /** The family name the CSS uses. */
  readonly family: string;
  /** CSS custom property that holds the font stack, for example `--font-sans`. */
  readonly variable?: string;
  readonly files: readonly FontFile[];
  /** Generic and system families after the font. Default `["sans-serif"]`. */
  readonly fallback?: readonly string[];
  /** Default `swap`. */
  readonly display?: FontDisplay;
  /** Whether the family's files are preloaded unless a file says otherwise. Default true (see {@link FontFile.preload}). */
  readonly preload?: boolean;
  /**
   * The size-adjusted fallback face (the `size-adjust` technique), so the text does not jump when the web font arrives.
   *
   * Absent: the face is built when the metrics of the family's files can be read (Arial, or Times New Roman when the
   * `fallback` stack has `serif`), and left out, without an error, when they cannot. `false`: no fallback face.
   * An object asks for the face and makes an unreadable file an error: `local` is the system font it is built from
   * (`Arial`, `Times New Roman`); `font` defaults to the metrics the family's files declare (`readFontMetrics`, from the
   * file nearest to weight 400 that has the Latin letters); `fallback` defaults to the system font's measured values in
   * `SYSTEM_FALLBACKS`. Pass both to use other values (for example Next.js's capsize table).
   */
  readonly metrics?:
    | false
    | {
        readonly local: string;
        readonly font?: FontMetrics;
        readonly fallback?: { readonly unitsPerEm: number; readonly xWidthAvg: number };
      };
}

/**
 * The system fonts a size-adjusted fallback can be built from, with the average width of each measured the way a
 * web font's is (`FontFileMetrics.azAvgWidth`: the advance averaged over Next.js's sample text). The values are the ones
 * Next.js uses, and they match what `readFontMetrics` measures on macOS's Arial and Times New Roman. The defaults are
 * Next.js's fallbacks: Arial for sans-serif text, Times New Roman for serif.
 * @example SYSTEM_FALLBACKS.Arial.unitsPerEm
 * @since 1.0.0
 */
export const SYSTEM_FALLBACKS: Readonly<
  Record<string, { readonly unitsPerEm: number; readonly xWidthAvg: number }>
> = {
  Arial: { unitsPerEm: 2048, xWidthAvg: 934.5116279069767 },
  "Times New Roman": { unitsPerEm: 2048, xWidthAvg: 854.3953488372093 },
};

/** The class names a family gets (see {@link FontsOutput.classes}). @since 1.0.0 */
export interface FontClasses {
  /** A class that sets the family's font stack (the web font, its fallback, the generic families). */
  readonly className: string;
  /** A class that sets the family's CSS variable on the element it is applied to (`<body class>`); absent without `variable`. */
  readonly variableClass?: string;
}

/** Options of {@link defineFonts}. @since 1.0.0 */
export interface DefineFontsOptions extends GoogleFontsOptions {
  /** Absolute path of the app's `public/` directory: the files are read from here (and Google's are vendored here). */
  readonly publicDir: string;
  /** URL prefix the files are served under. Default `/` (so `fonts/x.woff2` is `/fonts/x.woff2`). */
  readonly urlPrefix?: string;
  /**
   * The element the CSS variables are set on: `":root"` (default), `"html"`, `"body"`, or a class (`".font-vars"`).
   * Next.js sets them on the `<body>` through the variable classes; a class is the same, under the app's control.
   */
  readonly variableTarget?: ":root" | "html" | "body" | `.${string}`;
  /**
   * The CDN origin the font files are served from (`https://cdn.example`; the same value as the `assetOrigin` of
   * `dusk()` when you upload `public/` there). The file URLs, the `@font-face` sources and the preload links then name
   * it, and `preconnects` has a link that opens the connection early. Absent: the files are served from the app's origin
   * and there is nothing to preconnect to. `dusk()`'s own `assetOrigin` does not move files in `public/`, so set this
   * only when the font files really are on that origin.
   */
  readonly assetOrigin?: string;
  /**
   * Fonts to preload on some routes only, for the fonts that should not load on every page: a route glob (`/`, `/blog/**`)
   * to the keys of the families whose files that route preloads (the files that are not turned off with
   * `preload: false`). `FontsOutput.routePreloads` has the tags and `fontPreloadsFor` picks them for a path. Pair it with
   * `preload: false` on the family, so `preloads` (every page) does not carry them.
   */
  readonly routes?: Readonly<Record<string, readonly string[]>>;
  /**
   * Print the font report (see `FontsOutput.report`): `true` writes it to the console, a function receives the text. Default:
   * no output; the report is always in the result.
   */
  readonly report?: boolean | ((text: string) => void);
}

/**
 * The input with Google Fonts: the families to fetch, and local families next to them. Google families are
 * resolved at build time (see `GoogleFontsOptions`), so `defineFonts` returns a promise for this input.
 * @since 1.0.0
 */
export interface DefineGoogleFontsInput {
  /** The families to take from Google Fonts. */
  readonly google: readonly GoogleFont[];
  /** Local families (vendored under `public/`), written into the same stylesheet. */
  readonly local?: Readonly<Record<string, FontDefinition>>;
}

/** What {@link defineFonts} produces. @since 1.0.0 */
export interface FontsOutput {
  /** The stylesheet text: every `@font-face` and one `:root` block with the variables. */
  readonly css: string;
  /** Head tags that preload the files that are preloaded (see {@link FontFile.preload}). */
  readonly preloads: readonly HeadTag[];
  /** Head tags that open the connection to the CDN (`assetOrigin`); empty without one. Put them before `preloads`. */
  readonly preconnects: readonly HeadTag[];
  /** Variable name to font stack, as written in the `:root` block. */
  readonly variables: Readonly<Record<string, string>>;
  /** URL paths of every file, in the order they are declared. */
  readonly urls: readonly string[];
  /**
   * The class names of each family, by the family's key in the input (`google:Inter` for a Google family). Apply
   * `className` to an element for the family's font; `variableClass` to set the family's variable on that element.
   */
  readonly classes: Readonly<Record<string, FontClasses>>;
  /** Preload tags for some routes only (`DefineFontsOptions.routes`); empty without it. Read them with `fontPreloadsFor`. */
  readonly routePreloads: readonly FontRoutePreloads[];
  /** Every font file with its size, and the bytes that every page preloads (see `formatFontReport`). */
  readonly report: FontReport;
}

const TARGET = /^(?::root|html|body|\.[A-Za-z_][\w-]*)$/;
const FORMATS: Readonly<Record<string, FontFormat>> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};
const MIME: Readonly<Record<FontFormat, string>> = {
  woff2: "font/woff2",
  woff: "font/woff",
  truetype: "font/ttf",
  opentype: "font/otf",
  "embedded-opentype": "application/vnd.ms-fontobject",
  svg: "image/svg+xml",
};

/** True for a C0 control character. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

/**
 * A font file path that stays under `public/`: relative, no dot segments, no backslash, no control characters.
 * @example
 * ```ts
 * import { checkedPath } from "./fonts";
 *
 * console.log(checkedPath("fonts/inter.woff2", "Inter")); // "fonts/inter.woff2"
 * ```
 * @since 1.0.0
 */
export function checkedPath(file: string, family: string): string {
  const parts = file.split("/");
  if (
    file === "" ||
    file.startsWith("/") ||
    file.includes("\\") ||
    hasControl(file) ||
    // The path is also the URL the stylesheet names, where a browser reads `%2e%2e` as `..` and `%2f` as `/`.
    /%(?:2e|2f|5c)/i.test(file) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(
      `defineFonts: the file ${JSON.stringify(file)} of "${family}" must be a relative path under public/.`,
    );
  }
  return file;
}

/** The format of a file: the one given, or the extension's. */
function formatOf(file: FontFile, family: string): FontFormat {
  if (file.format !== undefined) return file.format;
  const extension = posix.extname(file.file).slice(1).toLowerCase();
  const format = FORMATS[extension];
  if (format === undefined) {
    throw new TypeError(
      `defineFonts: cannot tell the format of ${JSON.stringify(file.file)} (${family}); set format.`,
    );
  }
  return format;
}

/** Whether the path names a regular file under `publicDir`. */
function isFileUnder(publicDir: string, file: string): boolean {
  try {
    return statSync(join(publicDir, ...file.split("/"))).isFile();
  } catch {
    // Missing, unreadable and not-a-directory all mean the same to the caller: there is no such file.
    return false;
  }
}

/** The size in bytes of a file that exists under `publicDir` (`requireFile` has checked it). */
function sizeOf(publicDir: string, file: string): number {
  return statSync(join(publicDir, ...file.split("/"))).size;
}

/** The file must exist as a regular file under `publicDir`. */
function requireFile(publicDir: string, file: string, family: string): void {
  if (!isFileUnder(publicDir, file)) {
    throw new Error(
      `defineFonts: "${family}" needs public/${file}. Vendor the font file into public/ (no network at build time).`,
    );
  }
}

/**
 * The stylesheet, the variables and the preloads of the given families. Local families are read from `publicDir`
 * (no network). A `{ google: [...] }` input is resolved at build time: the Google Fonts CSS and files are fetched,
 * cached and vendored into `public/fonts/google/`, and recorded in `fonts.lock.json`.
 *
 * @param input The local families keyed by a name of your choice (for example `sans`), or `{ google, local }`.
 * @param options The public directory, the URL prefix and the Google options.
 * @returns The stylesheet, the preload tags, the variables and the URLs. A promise for the Google input.
 * @throws Error when a file is missing or a Google face cannot be loaded; TypeError for a path, a format, a family or a
 *   variable name that is not allowed.
 * @example
 * const fonts = await defineFonts(
 *   { google: [{ family: "Inter", variable: "--font-sans", weights: [400, 700], subsets: ["latin"], preload: ["latin"] }] },
 *   { publicDir: join(root, "public") },
 * );
 * @since 1.0.0
 */
export function defineFonts(
  fonts: Readonly<Record<string, FontDefinition>>,
  options: DefineFontsOptions,
): FontsOutput;
export function defineFonts(
  input: DefineGoogleFontsInput,
  options: DefineFontsOptions,
): Promise<FontsOutput>;
export function defineFonts(
  input: Readonly<Record<string, FontDefinition>> | DefineGoogleFontsInput,
  options: DefineFontsOptions,
): FontsOutput | Promise<FontsOutput> {
  if (isGoogleInput(input)) return defineGoogleFonts(input, options);
  return localFonts(input, options);
}

function isGoogleInput(
  input: Readonly<Record<string, FontDefinition>> | DefineGoogleFontsInput,
): input is DefineGoogleFontsInput {
  return Array.isArray(Reflect.get(input, "google"));
}

/** The Google step: resolve each family to vendored files, then build the stylesheet with the local ones. */
async function defineGoogleFonts(
  input: DefineGoogleFontsInput,
  options: DefineFontsOptions,
): Promise<FontsOutput> {
  const context = googleContext(options.publicDir, options);
  let lock = readLock(context.lockFile);
  const definitions: Record<string, FontDefinition> = { ...(input.local ?? {}) };
  for (const font of input.google) {
    const resolved = await resolveGoogleFamily(font, context, lock);
    lock = resolved.lock;
    definitions[`google:${font.family}`] = resolved.definition;
  }
  saveLock(context, lock);
  return localFonts(definitions, options);
}

/** The system font a fallback stack stands in for: Times New Roman for a serif stack, Arial otherwise (as Next.js does). */
function systemFontFor(stack: readonly string[]): "Arial" | "Times New Roman" {
  return stack.some((entry) => entry.toLowerCase() === "serif") ? "Times New Roman" : "Arial";
}

/** How far a weight (a number, a keyword, or a range) is from 400; a range that holds 400 is at 0. */
function weightDistance(weight: string | number | undefined): number {
  if (weight === undefined || weight === "normal") return 0;
  if (weight === "bold") return 300;
  const numbers =
    String(weight)
      .match(/\d+(?:\.\d+)?/g)
      ?.map(Number) ?? [];
  if (numbers.length === 0) return 0;
  const low = Math.min(...numbers);
  const high = Math.max(...numbers);
  return low <= 400 && 400 <= high ? 0 : Math.min(Math.abs(low - 400), Math.abs(high - 400));
}

/** Upright files first, then the ones nearest weight 400: the face that sets running text (Next.js picks the same). */
function measuringOrder(files: readonly FontFile[]): FontFile[] {
  const rank = (file: FontFile): number =>
    (file.style === "italic" ? 1000 : 0) + weightDistance(file.weight);
  return [...files].sort((a, b) => rank(a) - rank(b));
}

/**
 * The metrics of one file. Strict (an explicit `metrics` object): a path, a missing file or a damaged font is an error.
 * Lenient (the default fallback): such a file is skipped, because the main loop reports a bad path or missing file in
 * its own words, and a file that is not a font simply cannot be measured.
 */
function measureFile(
  file: FontFile,
  family: string,
  publicDir: string,
  strict: boolean,
): FontFileMetrics | undefined {
  let path: string;
  try {
    path = checkedPath(file.file, family);
  } catch (error) {
    if (strict || !(error instanceof TypeError)) throw error;
    return undefined;
  }
  if (strict) requireFile(publicDir, path, family);
  else if (!isFileUnder(publicDir, path)) return undefined;
  const bytes = new Uint8Array(readFileSync(join(publicDir, ...path.split("/"))));
  if (strict) return readFontMetrics(bytes);
  try {
    return readFontMetrics(bytes);
  } catch (error) {
    // Not a readable font (a stand-in file, a format without the tables): no fallback face, and no error, by default.
    if (error instanceof TypeError || error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * The size-adjusted fallback's metrics of a family: the web font's (measured from its files unless given) and the
 * system font's (from `SYSTEM_FALLBACKS` unless given). Of the files, the first that has the Latin letters is measured;
 * a font that has none is set at the system font's width (size-adjust 100%), as Next.js does. Undefined only for the
 * default (no `metrics`) when no file can be measured. A system font without measured values is a build error.
 */
function fallbackMetricsOf(
  definition: FontDefinition,
  stack: readonly string[],
  publicDir: string,
):
  | {
      readonly local: string;
      readonly font: FontMetrics;
      readonly fallback: { readonly unitsPerEm: number; readonly xWidthAvg: number };
    }
  | undefined {
  const explicit =
    definition.metrics === undefined || definition.metrics === false
      ? undefined
      : definition.metrics;
  const local = explicit?.local ?? systemFontFor(stack);
  const fallback = explicit?.fallback ?? SYSTEM_FALLBACKS[local];
  if (fallback === undefined) {
    throw new TypeError(
      `defineFonts: "${definition.family}" builds its fallback from ${JSON.stringify(local)}, which has no measured values; pass metrics.fallback ({ unitsPerEm, xWidthAvg }) or use one of ${Object.keys(SYSTEM_FALLBACKS).join(", ")}.`,
    );
  }
  if (explicit?.font !== undefined) return { local, font: explicit.font, fallback };
  if (definition.files.length === 0)
    throw new TypeError(`defineFonts: "${definition.family}" lists no files.`);
  const strict = explicit !== undefined;
  let read: FontFileMetrics | undefined;
  for (const file of measuringOrder(definition.files)) {
    const measured = measureFile(file, definition.family, publicDir, strict);
    if (measured === undefined) continue;
    if (measured.azAvgWidth !== undefined) {
      read = measured;
      break;
    }
    read ??= measured;
  }
  if (read === undefined) return undefined;
  return {
    local,
    font: {
      unitsPerEm: read.unitsPerEm,
      // Without the Latin letters there is nothing to compare: the fallback keeps the system font's width.
      xWidthAvg: read.azAvgWidth ?? (fallback.xWidthAvg / fallback.unitsPerEm) * read.unitsPerEm,
      ascender: read.ascender,
      descender: read.descender,
      lineGap: read.lineGap,
    },
    fallback,
  };
}

/** A class name from a family key: lower-case letters, digits and dashes, stable across builds. */
function classSlug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The local path: files that exist under `publicDir`, built into one stylesheet. */
function localFonts(
  fonts: Readonly<Record<string, FontDefinition>>,
  options: DefineFontsOptions,
): FontsOutput {
  const prefix = options.urlPrefix ?? "/";
  if (!prefix.startsWith("/") || prefix.startsWith("//") || prefix.includes("\\")) {
    throw new TypeError('defineFonts: urlPrefix must start with "/" (for example "/").');
  }
  const target = options.variableTarget ?? ":root";
  if (!TARGET.test(target)) {
    throw new TypeError(
      `defineFonts: variableTarget ${JSON.stringify(target)} must be :root, html, body or a class (.name).`,
    );
  }
  const origin = options.assetOrigin === undefined ? undefined : checkedOrigin(options.assetOrigin);
  const base = `${origin ?? ""}${prefix.endsWith("/") ? prefix : `${prefix}/`}`;
  const rules: string[] = [];
  const classRules: string[] = [];
  const variables: Record<string, string> = {};
  const preloads: HeadTag[] = [];
  const urls: string[] = [];
  const reportFiles: FontReportFile[] = [];
  const familyPreloads = new Map<string, HeadTag[]>();
  const classes: Record<string, FontClasses> = {};
  const usedSlugs = new Map<string, string>();
  for (const [key, definition] of Object.entries(fonts)) {
    const { family } = definition;
    const slug = classSlug(key);
    const previous = usedSlugs.get(slug);
    if (previous !== undefined) {
      throw new TypeError(`defineFonts: "${key}" and "${previous}" give the same class name.`);
    }
    usedSlugs.set(slug, key);
    const fallback = checkedFallback(definition.fallback ?? ["sans-serif"], family);
    const stack: string[] = [`"${family}"`];
    const measured =
      definition.metrics === false
        ? undefined
        : fallbackMetricsOf(definition, fallback, options.publicDir);
    if (measured !== undefined) {
      rules.push(
        fallbackFontFace({
          family: `${family} fallback`,
          local: measured.local,
          font: measured.font,
          fallback: measured.fallback,
        }),
      );
      stack.push(`"${family} fallback"`);
    }
    stack.push(...fallback);
    const className = `__dusk_font_${slug}`;
    classRules.push(`.${className} { font-family: ${stack.join(", ")}; }`);
    const entry: { className: string; variableClass?: string } = { className };
    if (definition.variable !== undefined) {
      if (!CSS_VARIABLE.test(definition.variable)) {
        throw new TypeError(
          `defineFonts: ${JSON.stringify(definition.variable)} is not a custom property name (--name).`,
        );
      }
      if (Object.hasOwn(variables, definition.variable)) {
        throw new TypeError(`defineFonts: ${definition.variable} is set by two families.`);
      }
      variables[definition.variable] = stack.join(", ");
      const variableClass = `__dusk_var_${slug}`;
      entry.variableClass = variableClass;
      classRules.push(`.${variableClass} { ${definition.variable}: ${stack.join(", ")}; }`);
    }
    classes[key] = entry;
    if (definition.files.length === 0) {
      throw new TypeError(`defineFonts: "${family}" lists no files.`);
    }
    for (const file of definition.files) {
      const path = checkedPath(file.file, family);
      requireFile(options.publicDir, path, family);
      const format = formatOf(file, family);
      const url = `${base}${path}`;
      urls.push(url);
      rules.push(
        fontFace({
          family,
          src: [{ url, format }],
          ...(file.weight === undefined ? {} : { weight: checkedWeight(file.weight, family) }),
          ...(file.style === undefined ? {} : { style: checkedStyle(file.style, family) }),
          ...(file.stretch === undefined ? {} : { stretch: file.stretch }),
          ...(file.unicodeRange === undefined ? {} : { unicodeRange: file.unicodeRange }),
          display: definition.display ?? "swap",
        }),
      );
      // A slice of a family (a unicode-range file) is fetched when its characters are used, so it is not preloaded unless asked.
      const preload = file.preload ?? definition.preload ?? file.unicodeRange === undefined;
      if (preload) preloads.push(fontPreloadTag({ href: url, type: MIME[format] }));
      // A route can ask for the files of a family that is not preloaded everywhere. A file turned off by name stays off, and
      // a slice of a family (a unicode-range file) is preloaded only when its own `preload` says so.
      if (file.preload ?? file.unicodeRange === undefined) {
        const own = familyPreloads.get(key) ?? [];
        own.push(fontPreloadTag({ href: url, type: MIME[format] }));
        familyPreloads.set(key, own);
      }
      reportFiles.push({
        key,
        family,
        url,
        weight: file.weight === undefined ? undefined : String(file.weight),
        style: file.style ?? "normal",
        bytes: sizeOf(options.publicDir, path),
        preloaded: preload,
      });
    }
  }
  const routePreloads = routePreloadsOf(options.routes, familyPreloads, fonts);
  const report: FontReport = {
    files: reportFiles,
    totalBytes: reportFiles.reduce((sum, file) => sum + file.bytes, 0),
    preloadedBytes: reportFiles.reduce((sum, file) => sum + (file.preloaded ? file.bytes : 0), 0),
  };
  if (options.report === true) console.info(formatFontReport(report));
  else if (typeof options.report === "function") options.report(formatFontReport(report));
  const declarations = Object.entries(variables).map(([name, value]) => `  ${name}: ${value};`);
  const root = declarations.length === 0 ? "" : `${target} {\n${declarations.join("\n")}\n}`;
  const preconnects: HeadTag[] =
    origin === undefined
      ? []
      : [{ tag: "link", props: { rel: "preconnect", href: origin, crossorigin: "anonymous" } }];
  return {
    css: [...rules, root, ...classRules].filter((part) => part !== "").join("\n"),
    preloads,
    preconnects,
    variables,
    urls,
    classes,
    routePreloads,
    report,
  };
}

/** The route rules: each pattern compiled (a bad glob fails here) and each family key checked against the input. */
function routePreloadsOf(
  routes: DefineFontsOptions["routes"],
  byFamily: ReadonlyMap<string, readonly HeadTag[]>,
  fonts: Readonly<Record<string, FontDefinition>>,
): readonly FontRoutePreloads[] {
  if (routes === undefined) return [];
  return Object.entries(routes).map(([pattern, keys]) => {
    if (!pattern.startsWith("/")) {
      throw new TypeError(`defineFonts: the route ${JSON.stringify(pattern)} must start with "/".`);
    }
    compileGlob(pattern);
    if (!Array.isArray(keys)) {
      throw new TypeError(
        `defineFonts: routes[${JSON.stringify(pattern)}] must be a list of family keys.`,
      );
    }
    const preloads: HeadTag[] = [];
    for (const key of keys) {
      if (!Object.hasOwn(fonts, key)) {
        throw new TypeError(
          `defineFonts: routes[${JSON.stringify(pattern)}] names the family ${JSON.stringify(key)}, which is not in the input (keys: ${Object.keys(fonts).join(", ")}).`,
        );
      }
      preloads.push(...(byFamily.get(key) ?? []));
    }
    return { pattern, preloads };
  });
}
