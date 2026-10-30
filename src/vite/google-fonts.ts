import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FontDisplay } from "../shared/font";
import { CSS_VARIABLE, checkedFallback, checkedWeight } from "./font-values";
import type { FontDefinition, FontFile } from "./fonts";

/**
 * Google Fonts at build time. `defineFonts({ google: [...] })` asks the CSS2 API for the faces of each family (the
 * subsets, weights, styles and variable axes you name), downloads the files they point at, and vendors them into
 * `public/fonts/google/` under a name taken from their hash. The result is the same stylesheet and preloads as the
 * offline path, so the page never talks to Google.
 *
 * Determinism and offline builds: every downloaded file and CSS response has an SRI hash (`sha256-…`) recorded in
 * `fonts.lock.json` at the project root. A cached copy (`node_modules/.cache/dusk/fonts`) or a vendored file is used
 * when the network is down, and only if it matches the lock. With `frozen`, a download that differs from the lock is
 * an error (CI); otherwise the lock is updated and the change shows in review.
 * @packageDocumentation
 */

/** A Google Fonts family and the faces to take from it. @since 1.0.0 */
export interface GoogleFont {
  /** The family name as the API spells it (`Inter`, `Roboto Flex`). Letters, digits and spaces only. */
  readonly family: string;
  /** CSS custom property that holds the font stack, for example `--font-sans`. */
  readonly variable?: string;
  /** Static weights (`[400, 700]`), when the family has no `wght` axis you vary. Not with `axes.wght`. */
  readonly weights?: readonly number[];
  /**
   * Variable axes: a value (`400`) or a range (`"100..900"`) per axis tag (`wght`, `wdth`, `opsz`, `slnt`, `GRAD`).
   * Every combination is requested.
   */
  readonly axes?: Readonly<Record<string, number | string>>;
  /** Also request the italic faces (the `ital` axis). Default false. */
  readonly italic?: boolean;
  /** Only these subsets (`latin`, `latin-ext`, `cyrillic`, ...). Default: every subset the API returns. */
  readonly subsets?: readonly string[];
  /**
   * What to preload in the head. Default (absent or `true`): the first subset you declare in `subsets`, or `latin` when
   * you declare none, as `next/font` preloads the first screen's text font and not every script. Only the subsets and
   * weights you asked for are downloaded at all. `false`: nothing. A list: exactly those subsets.
   */
  readonly preload?: boolean | readonly string[];
  /** Default `swap`. */
  readonly display?: FontDisplay;
  /** Generic and system families after the font. Default `["sans-serif"]`. */
  readonly fallback?: readonly string[];
  /**
   * The size-adjusted fallback face, built from the downloaded file's metrics and measured against this system font (the
   * family is then `"<family> fallback"` in the stack). Absent: the face is built against Arial, or against Times New
   * Roman when `fallback` has `serif`, as `next/font`'s `adjustFontFallback` does. `false`: no fallback face.
   */
  readonly fallbackFace?: false | "Arial" | "Times New Roman";
}

/** Options that control the Google step of {@link defineFonts}. @since 1.0.0 */
export interface GoogleFontsOptions {
  /** The project root: `fonts.lock.json` and the cache sit here. Default: the parent of `publicDir`. */
  readonly root?: string;
  /** Never touch the network: use the cache and the vendored files, which must match the lock. Default false. */
  readonly offline?: boolean;
  /**
   * Fail when the stylesheet differs from `fonts.lock.json` as well as when a file does (for CI). A file whose hash
   * differs from the lock fails the build in every mode, and is never written.
   */
  readonly frozen?: boolean;
  /**
   * Accept a file whose hash differs from `fonts.lock.json` and record the new hash. The URLs Google serves are
   * versioned, so the bytes behind one should never change: use this only when you have reviewed the change. Not with `frozen`.
   */
  readonly updateLock?: boolean;
  /** The `fetch` for the API and the files. Default: the global one. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const CSS_ENDPOINT = "https://fonts.googleapis.com/css2";
const FILE_HOST = "https://fonts.gstatic.com/";
const FILE_HOSTNAME = "fonts.gstatic.com";
/** The characters of a URL (RFC 3986), without whitespace, a backslash, a quote or anything outside ASCII. */
const FACE_URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]+$/;
const DISPLAYS: ReadonlySet<string> = new Set(["auto", "block", "swap", "fallback", "optional"]);
const FALLBACK_FACES: ReadonlySet<string> = new Set(["Arial", "Times New Roman"]);
const SUBSET = /^[a-z0-9-]{1,40}$/;
const UNICODE_RANGE = /^[Uu+0-9A-Fa-f?\-,\s]+$/;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,99}$/;
const AXIS = /^[A-Za-z]{4}$/;
const RANGE = /^\d{1,4}(?:\.\d{1,4})?\.\.\d{1,4}(?:\.\d{1,4})?$/;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 20_000;
const LOCK_VERSION = 1;
const MAX_FONT_BYTES = 8 * 1024 * 1024;
const MAX_CSS_BYTES = 1024 * 1024;

/** One face of the API's stylesheet. @internal */
export interface GoogleFace {
  readonly subset: string;
  readonly weight: string;
  readonly style: "normal" | "italic";
  readonly unicodeRange: string | undefined;
  readonly url: string;
  readonly format: "woff2" | "woff" | "truetype" | "opentype";
}

/** The lockfile: the SRI hash of each CSS response and each file, by URL. @internal */
export interface FontLock {
  readonly version: number;
  readonly fonts: Readonly<
    Record<string, { css: string; files: Readonly<Record<string, string>> }>
  >;
}

const dimensionValues = (tag: string, value: number | string): string[] => {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1)
      throw new TypeError(`defineFonts: axis ${tag} must be a positive integer or a range.`);
    return [String(value)];
  }
  if (!RANGE.test(value)) {
    throw new TypeError(
      `defineFonts: axis ${tag} must be a value or a range such as "100..900", not ${JSON.stringify(value)}.`,
    );
  }
  return [value];
};

/**
 * Checks everything about a family that ends up in the request, the stylesheet or a file name, before the first request
 * is made: the family, display, variable, fallback stack, fallback face, and the subset names.
 * @internal
 */
export function checkGoogleFont(font: GoogleFont): void {
  googleCssUrl(font, font.display ?? "swap");
  if (font.variable !== undefined && !CSS_VARIABLE.test(font.variable)) {
    throw new TypeError(
      `defineFonts: ${JSON.stringify(font.variable)} is not a custom property name (--name).`,
    );
  }
  if (font.fallback !== undefined) checkedFallback(font.fallback, font.family);
  if (
    font.fallbackFace !== undefined &&
    font.fallbackFace !== false &&
    !FALLBACK_FACES.has(font.fallbackFace)
  ) {
    throw new TypeError(
      `defineFonts: fallbackFace ${JSON.stringify(font.fallbackFace)} must be false, Arial or Times New Roman.`,
    );
  }
  if (
    font.preload !== undefined &&
    typeof font.preload !== "boolean" &&
    !Array.isArray(font.preload)
  ) {
    throw new TypeError("defineFonts: preload must be true, false or a list of subsets.");
  }
  const preloaded = Array.isArray(font.preload) ? font.preload : [];
  for (const subset of [...(font.subsets ?? []), ...preloaded]) {
    if (typeof subset !== "string" || !SUBSET.test(subset)) {
      throw new TypeError(
        `defineFonts: the subset ${JSON.stringify(subset)} is not a subset name.`,
      );
    }
  }
}

/**
 * The CSS2 request of one family: its axes (sorted, as the API requires) and one tuple per combination of values.
 * @internal
 */
export function googleCssUrl(font: GoogleFont, display: FontDisplay = "swap"): string {
  if (!DISPLAYS.has(display)) {
    throw new TypeError(
      `defineFonts: display ${JSON.stringify(display)} is not a font-display value.`,
    );
  }
  if (!FAMILY.test(font.family)) {
    throw new TypeError(
      `defineFonts: the Google family ${JSON.stringify(font.family)} must be letters, digits and spaces.`,
    );
  }
  if (font.weights !== undefined && font.axes?.["wght"] !== undefined) {
    throw new TypeError(
      `defineFonts: "${font.family}" gives weights and axes.wght; use one of them.`,
    );
  }
  const dimensions = new Map<string, string[]>();
  if (font.italic === true) dimensions.set("ital", ["0", "1"]);
  if (font.weights !== undefined) {
    if (font.weights.length === 0)
      throw new TypeError(`defineFonts: "${font.family}" lists no weights.`);
    dimensions.set(
      "wght",
      font.weights.map((weight) => dimensionValues("wght", weight)[0] ?? ""),
    );
  }
  for (const [tag, value] of Object.entries(font.axes ?? {})) {
    if (!AXIS.test(tag))
      throw new TypeError(
        `defineFonts: axis ${JSON.stringify(tag)} must be four letters (wght, wdth, opsz, ...).`,
      );
    if (tag === "ital") throw new TypeError('defineFonts: use italic: true, not an "ital" axis.');
    dimensions.set(tag, dimensionValues(tag, value));
  }
  if (dimensions.size === 0) dimensions.set("wght", ["400"]);
  const tags = [...dimensions.keys()].sort();
  let tuples: string[][] = [[]];
  for (const tag of tags) {
    const values = dimensions.get(tag) ?? [];
    tuples = tuples.flatMap((prefix) => values.map((value) => [...prefix, value]));
  }
  const spec = tags.length === 1 ? tags[0] : tags.join(",");
  const body = tuples.map((tuple) => tuple.join(",")).join(";");
  const family = font.family.replaceAll(" ", "+");
  return `${CSS_ENDPOINT}?family=${family}:${spec}@${body}&display=${display}`;
}

/**
 * A face URL is fetched, so it is parsed the way `fetch` will read it and judged on the result: https, the font CDN's host
 * and default port, no credentials, no fragment, and only URL characters in the text.
 */
function checkedFaceUrl(url: string): string {
  const refused = (): never => {
    throw new Error(
      `defineFonts: refused a font file from ${url.slice(0, 80).split("/").slice(0, 3).join("/")}; only ${FILE_HOST} is used.`,
    );
  };
  if (url.length > 2048 || !url.startsWith(FILE_HOST) || !FACE_URL_CHARS.test(url))
    return refused();
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (
    parsed === undefined ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== FILE_HOSTNAME ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    return refused();
  }
  return url;
}

/**
 * The @font-face rules of a CSS2 response. Only files on the font CDN are accepted: a stylesheet that names another
 * host is refused, so a file is never fetched from anywhere the response chooses.
 * @internal
 */
export function parseGoogleCss(css: string): GoogleFace[] {
  const faces: GoogleFace[] = [];
  const block = /(?:\/\*\s*([a-z0-9-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/gi;
  for (const match of css.matchAll(block)) {
    const body = match[2] ?? "";
    const property = (name: string): string | undefined => {
      const found = new RegExp(`${name}\\s*:\\s*([^;]+);`, "i").exec(body);
      return found?.[1]?.trim();
    };
    const src = /url\(\s*['"]?([^'")]+)['"]?\s*\)\s*format\(\s*['"]?([a-z0-9]+)['"]?\s*\)/i.exec(
      body,
    );
    if (src === null)
      throw new Error("defineFonts: a Google Fonts face has no file the parser understands.");
    const url = checkedFaceUrl(src[1] ?? "");
    const format = (src[2] ?? "").toLowerCase();
    if (format !== "woff2" && format !== "woff" && format !== "truetype" && format !== "opentype") {
      throw new Error(`defineFonts: the Google Fonts format ${format} is not supported.`);
    }
    const style = property("font-style") === "italic" ? "italic" : "normal";
    const unicodeRange = property("unicode-range");
    if (unicodeRange !== undefined && !UNICODE_RANGE.test(unicodeRange)) {
      throw new Error(
        "defineFonts: a Google Fonts face has a unicode-range the parser does not accept.",
      );
    }
    faces.push({
      subset: match[1] ?? "default",
      // The weight is written into the stylesheet as it is, so it must be a weight and nothing else.
      weight: checkedWeight(property("font-weight") ?? "400", "a Google Fonts face"),
      style,
      unicodeRange,
      url,
      format,
    });
  }
  return faces;
}

/** The SRI hash of some bytes or text. @internal */
export function sriOf(bytes: Uint8Array | string): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function hexOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An own-property-only record: a key such as `__proto__` or `constructor` is data here, not a prototype member. */
function plain<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const out: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) out[key] = value;
  return out;
}

/**
 * Reads the lockfile; a missing one is an empty lock. A file that is not a lock is an error that names it.
 * Not a public symbol: only the `defineFonts` build step reads the lock, and `@shadow-js/dusk/vite`
 * re-exports just the types of this module.
 * @internal
 */
export function readLock(file: string): FontLock {
  if (!existsSync(file)) return { version: LOCK_VERSION, fonts: plain([]) };
  const bad = (why: string): Error =>
    new Error(`defineFonts: ${file} is not a valid fonts lock (${why}).`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`defineFonts: ${file} is not valid JSON.`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw bad("not an object");
  if (Reflect.get(parsed, "version") !== LOCK_VERSION) {
    throw new Error(`defineFonts: ${file} is not a fonts lock of version ${LOCK_VERSION}.`);
  }
  const fonts: unknown = Reflect.get(parsed, "fonts");
  if (typeof fonts !== "object" || fonts === null || Array.isArray(fonts))
    throw bad("no fonts object");
  const entries: [string, { css: string; files: Readonly<Record<string, string>> }][] = [];
  for (const [url, entry] of Object.entries(fonts)) {
    if (typeof entry !== "object" || entry === null) throw bad(`the entry for ${url}`);
    const css: unknown = Reflect.get(entry, "css");
    const files: unknown = Reflect.get(entry, "files");
    if (
      typeof css !== "string" ||
      typeof files !== "object" ||
      files === null ||
      Array.isArray(files)
    )
      throw bad(`the entry for ${url}`);
    const hashes: [string, string][] = [];
    for (const [name, hash] of Object.entries(files)) {
      if (typeof hash !== "string") throw bad(`the hash of ${name}`);
      hashes.push([name, hash]);
    }
    entries.push([url, { css, files: plain(hashes) }]);
  }
  return { version: LOCK_VERSION, fonts: plain(entries) };
}

/** Writes the lockfile with sorted keys, only when its text changes (deterministic builds). */
function writeLock(file: string, lock: FontLock): void {
  const sort = <T extends Readonly<Record<string, unknown>>>(record: T): T =>
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ) as T;
  const fonts = sort(lock.fonts);
  const text = `${JSON.stringify({ version: LOCK_VERSION, fonts: Object.fromEntries(Object.entries(fonts).map(([url, entry]) => [url, { css: entry.css, files: sort(entry.files) }])) }, null, 2)}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  writeFileSync(file, text);
}

/** The parts of one resolved download, by a function the caller passes in (the network is injected). @internal */
export interface GoogleContext {
  readonly publicDir: string;
  readonly cacheDir: string;
  readonly lockFile: string;
  readonly offline: boolean;
  readonly frozen: boolean;
  readonly updateLock: boolean;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * One GET, limited: no redirect is followed (and a `fetch` that followed one anyway is refused), a declared length over
 * `limit` ends the request before the body is read, and the body is read in pieces and cut off at `limit` bytes.
 */
async function download(
  context: GoogleContext,
  url: string,
  what: string,
  limit: number,
): Promise<Uint8Array> {
  const response = await context.fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  if (
    response.redirected ||
    (response.url !== "" &&
      URL.canParse(response.url) &&
      new URL(response.url).origin !== new URL(url).origin)
  ) {
    await response.body?.cancel();
    throw new Error(
      `defineFonts: ${what} was answered by another address (a redirect), which is refused.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`defineFonts: ${what} answered ${response.status}.`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error(`defineFonts: ${what} is larger than ${limit} bytes.`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`defineFonts: ${what} is larger than ${limit} bytes.`);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/** A value from the cache, checked against the lock when the lock has the entry. */
function cached(
  context: GoogleContext,
  name: string,
  expected: string | undefined,
): Uint8Array | undefined {
  const file = join(context.cacheDir, name);
  if (!existsSync(file)) return undefined;
  const bytes = new Uint8Array(readFileSync(file));
  if (expected !== undefined && sriOf(bytes) !== expected) return undefined;
  return bytes;
}

function storeCache(context: GoogleContext, name: string, bytes: Uint8Array): void {
  mkdirSync(context.cacheDir, { recursive: true });
  writeFileSync(join(context.cacheDir, name), bytes);
}

/**
 * Vendors a file under `public/fonts/google`, named by its hash. A file already there is kept only if it holds exactly
 * these bytes: the name says what it should be, the content is what is checked, so a copy that was changed on disk is
 * replaced by the verified one. Returns the path under `public/`.
 */
function vendor(context: GoogleContext, bytes: Uint8Array, extension: string): string {
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${extension}`;
  const directory = join(context.publicDir, "fonts", "google");
  const file = join(directory, name);
  if (!existsSync(file) || !Buffer.from(bytes).equals(readFileSync(file))) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, bytes);
  }
  return `fonts/google/${name}`;
}

const EXTENSION: Readonly<Record<GoogleFace["format"], string>> = {
  woff2: "woff2",
  woff: "woff",
  truetype: "ttf",
  opentype: "otf",
};

/**
 * The subsets to preload: none for `false`, the list for a list, else the first declared subset (`latin` when none is
 * declared), which is where the text of the first screen is.
 */
function preloadedSubsets(font: GoogleFont): ReadonlySet<string> {
  if (font.preload === false) return new Set();
  if (Array.isArray(font.preload)) return new Set(font.preload);
  return new Set([font.subsets?.[0] ?? "latin"]);
}

/**
 * Resolves one Google family to a font definition whose files are vendored under `public/`. The CSS and each file
 * come from the network when it is reachable, else from the cache or a vendored copy that matches the lock.
 * @internal
 */
export async function resolveGoogleFamily(
  font: GoogleFont,
  context: GoogleContext,
  lock: FontLock,
): Promise<{ definition: FontDefinition; lock: FontLock }> {
  // Everything that reaches the request, the stylesheet or a file name is checked before the first request.
  checkGoogleFont(font);
  const cssUrl = googleCssUrl(font, font.display ?? "swap");
  const known = lock.fonts[cssUrl];
  let css: string | undefined;
  let reason = "offline";
  if (!context.offline) {
    let body: Uint8Array | undefined;
    try {
      body = await download(
        context,
        cssUrl,
        `the Google Fonts CSS for ${font.family}`,
        MAX_CSS_BYTES,
      );
    } catch (error) {
      if (context.frozen) throw error;
      reason = error instanceof Error ? error.message : String(error);
    }
    if (body !== undefined) {
      css = new TextDecoder().decode(body);
      // A changed stylesheet is checked before it is cached: a frozen build keeps what it was given.
      if (known !== undefined && known.css !== sriOf(css) && context.frozen) {
        throw new Error(
          `defineFonts: the CSS for ${font.family} changed; update fonts.lock.json (frozen build).`,
        );
      }
      storeCache(context, `${hexOf(cssUrl)}.css`, body);
    }
  }
  if (css === undefined) {
    const bytes = cached(context, `${hexOf(cssUrl)}.css`, known?.css);
    if (bytes === undefined) {
      throw new Error(
        `defineFonts: cannot load the Google Fonts CSS for ${font.family} (${reason}), and there is no cached or locked copy. Connect once to fill the lock, or vendor the files into public/.`,
      );
    }
    css = new TextDecoder().decode(bytes);
  }
  const faces = parseGoogleCss(css);
  const wanted = font.subsets === undefined ? undefined : new Set(font.subsets);
  const selected = faces.filter((face) => wanted === undefined || wanted.has(face.subset));
  if (selected.length === 0) {
    throw new Error(
      `defineFonts: no face of ${font.family} matches the subsets ${[...(wanted ?? [])].join(", ")}.`,
    );
  }
  const files: Record<string, string> = {};
  const preload = preloadedSubsets(font);
  const fileFaces: FontFile[] = [];
  for (const face of selected) {
    const expected = known?.files[face.url];
    let bytes: Uint8Array | undefined;
    if (!context.offline) {
      try {
        bytes = await download(
          context,
          face.url,
          `the font file of ${font.family} (${face.subset})`,
          MAX_FONT_BYTES,
        );
      } catch (error) {
        if (context.frozen) throw error;
        bytes = undefined;
      }
      // The lock decides, before anything is written: the cache, the vendored copy and the lock all stay as they were.
      // The URLs are versioned, so different bytes behind a known URL are a change nobody reviewed.
      if (
        bytes !== undefined &&
        expected !== undefined &&
        expected !== sriOf(bytes) &&
        !context.updateLock
      ) {
        throw new Error(
          `defineFonts: a file of ${font.family} (${face.subset}) changed; update fonts.lock.json (${context.frozen ? "frozen build" : "its hash differs from the lock, so it was not written; pass updateLock: true after reviewing the change"}).`,
        );
      }
      if (bytes !== undefined) storeCache(context, `${hexOf(face.url)}.bin`, bytes);
    }
    if (bytes === undefined) bytes = cached(context, `${hexOf(face.url)}.bin`, expected);
    if (bytes === undefined) {
      throw new Error(
        `defineFonts: no copy of a ${font.family} (${face.subset}) font file is cached or locked; connect once to fill the lock.`,
      );
    }
    const path = vendor(context, bytes, EXTENSION[face.format]);
    files[face.url] = sriOf(bytes);
    fileFaces.push({
      file: path,
      format: face.format,
      weight: face.weight,
      style: face.style,
      ...(face.unicodeRange === undefined ? {} : { unicodeRange: face.unicodeRange }),
      preload: preload.has(face.subset),
    });
  }
  const nextLock: FontLock = {
    version: LOCK_VERSION,
    fonts: { ...lock.fonts, [cssUrl]: { css: sriOf(css), files } },
  };
  return {
    definition: {
      family: font.family,
      ...(font.variable === undefined ? {} : { variable: font.variable }),
      files: fileFaces,
      ...(font.fallback === undefined ? {} : { fallback: font.fallback }),
      ...(font.display === undefined ? {} : { display: font.display }),
      ...(font.fallbackFace === undefined
        ? {}
        : {
            metrics: font.fallbackFace === false ? (false as const) : { local: font.fallbackFace },
          }),
    },
    lock: nextLock,
  };
}

/** Where the lock and the cache of a project are, from the options. @internal */
export function googleContext(publicDir: string, options: GoogleFontsOptions): GoogleContext {
  if (options.frozen === true && options.updateLock === true) {
    throw new TypeError("defineFonts: frozen and updateLock contradict each other; pass one.");
  }
  const root = options.root ?? join(publicDir, "..");
  return {
    publicDir,
    cacheDir: join(root, "node_modules", ".cache", "dusk", "fonts"),
    lockFile: join(root, "fonts.lock.json"),
    offline: options.offline === true,
    frozen: options.frozen === true,
    updateLock: options.updateLock === true,
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
  };
}

/** Saves the lock when the resolution changed it. @internal */
export function saveLock(context: GoogleContext, lock: FontLock): void {
  writeLock(context.lockFile, lock);
}
