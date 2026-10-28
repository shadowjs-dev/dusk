/**
 * Link discovery and the crawl loop shared by both prerender steps (`prerender()` in `./prerender`
 * and the build step in `../vite/build`). Pure apart from the `render` callback the caller gives:
 * the order of the output does not depend on how fast pages render.
 */
import { trimEndChar } from "../internal/text";

/** Crawl bounds: how many link hops from the listed paths, and how many pages the crawl may add. */
export interface CrawlPolicy {
  /** Link hops from the listed paths. `1` renders the listed paths and the pages they link to. */
  readonly depth: number;
  /** Most pages the crawl may add beyond the listed paths. */
  readonly limit: number;
}

/** What `crawlLinks: true` means. @since 1.0.0 */
export const DEFAULT_CRAWL: CrawlPolicy = { depth: 3, limit: 500 };

/** A page that did not render, with the reason (an `Error`, usually a `PrerenderError`). @since 1.0.0 */
export interface PrerenderFailure {
  readonly path: string;
  readonly error: unknown;
  /** True for a path the caller listed, false for a path the crawl found. */
  readonly explicit: boolean;
  /** For a path the crawl found: the page whose link led to it (the first by path, when several linked to it). */
  readonly from?: string;
}

/**
 * Turns the `crawlLinks` option into a policy. `undefined` or `false` disables crawling; `true` uses
 * {@link DEFAULT_CRAWL}.
 *
 * @throws TypeError for a depth below 1 or a limit below 0 (or not an integer).
 * @since 1.0.0
 */
export function crawlPolicyOf(
  option: boolean | { readonly depth?: number; readonly limit?: number } | undefined,
): CrawlPolicy | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return DEFAULT_CRAWL;
  const depth = option.depth ?? DEFAULT_CRAWL.depth;
  const limit = option.limit ?? DEFAULT_CRAWL.limit;
  if (!Number.isInteger(depth) || depth < 1) {
    throw new TypeError("prerender.crawlLinks.depth must be an integer of 1 or more");
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new TypeError("prerender.crawlLinks.limit must be an integer of 0 or more");
  }
  return { depth, limit };
}

/** The start of an anchor tag. */
const ANCHOR_OPEN = /<a\b/gi;

/** `href` of an anchor, quoted, single-quoted or bare. */
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;

/**
 * The `href` values of the anchors in `html`, in order. One regular expression for "an anchor, then lazily anything,
 * then `href`" retries the lazy part from every `<a` and takes quadratic time on `<a <a <a ...`. This scan keeps the
 * next `>` and the next `href` found and reuses them for every anchor before them, so each character is read a
 * bounded number of times.
 */
function* anchorHrefs(html: string): Generator<string> {
  let from = 0;
  let close: number | undefined;
  let found: RegExpExecArray | null | undefined;
  for (;;) {
    ANCHOR_OPEN.lastIndex = from;
    const open = ANCHOR_OPEN.exec(html);
    if (open === null) return;
    const start = open.index + open[0].length;
    if (close === undefined || (close !== -1 && close < start)) close = html.indexOf(">", start);
    if (found === undefined || (found !== null && found.index < start)) {
      HREF.lastIndex = start;
      found = HREF.exec(html);
    }
    if (found !== null && found.index < (close === -1 ? html.length : close)) {
      yield found[1] ?? found[2] ?? found[3] ?? "";
      from = found.index + found[0].length;
    } else {
      from = start;
    }
  }
}

/** The few entities an attribute value may hold. */
function unescapeAttribute(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

/**
 * The app paths the links of a page lead to, sorted and unique. A link is kept when it is on the
 * same origin and under `basePath` (the base is removed from it); its query and fragment are dropped;
 * a fragment-only link, an external link, a link to a file (its last segment has a dot) and a link
 * under `/_dusk` are not kept.
 *
 * @param html The page markup.
 * @param page The URL the page was rendered for (relative links resolve against it).
 * @param origin The origin the pages are rendered from, for example `http://localhost`.
 * @param basePath The mount point without a trailing slash (`""` or `/app`).
 * @returns App paths such as `/about`, sorted.
 * @example internalLinks('<a href="/a?x=1#y">a</a>', new URL("http://localhost/"), "http://localhost", ""); // ["/a"]
 * @since 1.0.0
 */
export function internalLinks(html: string, page: URL, origin: string, basePath: string): string[] {
  const base = trimEndChar(basePath, "/");
  const found = new Set<string>();
  for (const value of anchorHrefs(html)) {
    const raw = unescapeAttribute(value.trim());
    if (raw === "" || raw.startsWith("#")) continue;
    if (!URL.canParse(raw, page)) continue;
    const target = new URL(raw, page);
    if (target.origin !== origin) continue;
    let pathname = target.pathname;
    if (base !== "") {
      if (pathname === base) pathname = "/";
      else if (pathname.startsWith(`${base}/`)) pathname = pathname.slice(base.length);
      else continue;
    }
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    if (pathname === "/_dusk" || pathname.startsWith("/_dusk/")) continue;
    const last = pathname.slice(pathname.lastIndexOf("/") + 1);
    if (last.includes(".")) continue;
    found.add(pathname);
  }
  return [...found].sort();
}

/** Runs `work` over `items` with at most `size` in flight. */
async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
}

/** What {@link runCrawl} needs. @since 1.0.0 */
export interface CrawlRun {
  /** Paths the caller asked for. */
  readonly paths: readonly string[];
  /** Pages in flight at once. */
  readonly concurrency: number;
  /** The crawl bounds, or `undefined` to render only `paths`. */
  readonly crawl: CrawlPolicy | undefined;
  /** Keeps a path out when it returns false (listed or found). */
  readonly filter: ((path: string) => boolean) | undefined;
  /**
   * Renders one path and resolves with the internal links of its page (the links are only read when
   * the crawl needs them). Rejects when the page did not render.
   */
  readonly render: (path: string, from: string | undefined) => Promise<readonly string[]>;
  /** Called once per failed path, listed or found. */
  readonly onFailure?: ((failure: PrerenderFailure) => void | Promise<void>) | undefined;
}

/**
 * Renders the listed paths, then the pages their links lead to, level by level, up to the crawl
 * depth. Each level is sorted before it is taken, and the crawl adds at most `limit` pages, so the
 * set of rendered pages does not depend on timing or concurrency. A listed path that fails is
 * returned; a found path that fails is only reported to `onFailure`.
 *
 * @returns The failures of the listed paths, sorted by path.
 * @since 1.0.0
 */
export async function runCrawl(run: CrawlRun): Promise<PrerenderFailure[]> {
  const accepted = (path: string): boolean => run.filter === undefined || run.filter(path);
  const seen = new Set<string>();
  const failures: PrerenderFailure[] = [];
  let level = [...new Set(run.paths)].filter(accepted).sort();
  for (const path of level) seen.add(path);
  let crawled = 0;
  // The page a found path was linked from. Several pages may link to one path: the smallest path is named, so the
  // answer does not depend on which page finished first.
  const linkedFrom = new Map<string, string>();
  for (let depth = 0; level.length > 0; depth += 1) {
    const explicit = depth === 0;
    const crawling = run.crawl !== undefined && depth < run.crawl.depth;
    const found = new Set<string>();
    await pool(level, run.concurrency, async (path) => {
      const from = linkedFrom.get(path);
      try {
        const links = await run.render(path, from);
        if (crawling) {
          for (const link of links) {
            found.add(link);
            const known = linkedFrom.get(link);
            if (known === undefined || path < known) linkedFrom.set(link, path);
          }
        }
      } catch (error) {
        const failure: PrerenderFailure = {
          path,
          error,
          explicit,
          ...(from === undefined ? {} : { from }),
        };
        if (explicit) failures.push(failure);
        await run.onFailure?.(failure);
      }
    });
    if (run.crawl === undefined || depth >= run.crawl.depth) break;
    const next = [...found].filter((path) => !seen.has(path) && accepted(path)).sort();
    level = next.slice(0, Math.max(0, run.crawl.limit - crawled));
    for (const path of level) seen.add(path);
    crawled += level.length;
  }
  return failures.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The reason of a failure, as text. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The text of a run that failed: every failing path on its own line, then the fix that applies to
 * all of them (`fix` names the options of the caller).
 *
 * @since 1.0.0
 */
export function describeFailures(failures: readonly PrerenderFailure[], fix: string): string {
  const count = failures.length;
  const lines = failures.map((failure) => `  ${reasonOf(failure.error)}`);
  return [`${count} page${count === 1 ? "" : "s"} failed to prerender:`, ...lines, fix].join("\n");
}
