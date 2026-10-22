import type { HeadTag } from "@shadow-js/web";
import { compileGlob } from "./glob";

/**
 * The parts of the font pipeline that describe its result: which files a route preloads, and a report of every font file
 * with its size. Pure functions of plain data (`fonts.ts` builds the data); the report is text for the build log.
 */

/**
 * One font file in the report.
 * @since 1.0.0
 */
export interface FontReportFile {
  /** The family's key in the input to `defineFonts` (`google:Inter` for a Google family). */
  readonly key: string;
  /** The family name. */
  readonly family: string;
  /** The URL the stylesheet names. */
  readonly url: string;
  /** The weight of the face (`400`, `"100 900"`), when declared. */
  readonly weight: string | undefined;
  /** `normal` or `italic`. */
  readonly style: "normal" | "italic";
  /** The size of the file on disk. */
  readonly bytes: number;
  /** Whether every page preloads the file (`preloads`). */
  readonly preloaded: boolean;
}

/**
 * What the build produced for fonts: every file with its size, and the totals.
 * @since 1.0.0
 */
export interface FontReport {
  readonly files: readonly FontReportFile[];
  /** The bytes of every file. */
  readonly totalBytes: number;
  /** The bytes of the files every page preloads: what the browser fetches before it paints text. */
  readonly preloadedBytes: number;
}

/**
 * The preload tags that belong to the routes matching a pattern.
 * @since 1.0.0
 */
export interface FontRoutePreloads {
  /** The route glob (`/`, `/blog/**`). */
  readonly pattern: string;
  readonly preloads: readonly HeadTag[];
}

/** The URL of a preload tag. */
function hrefOf(tag: HeadTag): string {
  return String(tag.props?.["href"] ?? "");
}

/**
 * The tags to preload on one route: those of every rule whose pattern matches the path, without a tag that `preloads`
 * (the ones every page loads) already has and without repeats.
 *
 * @param rules The route rules of `defineFonts`' output.
 * @param pathname The path of the page (`/blog/post`), without the query.
 * @param global The tags every page already preloads.
 * @returns The extra tags for this route, in the order of the rules.
 * @example
 * fontPreloadsFor(fonts.routePreloads, "/blog/post", fonts.preloads).map((tag) => tag.props?.href);
 * @since 1.0.0
 */
export function fontPreloadsFor(
  rules: readonly FontRoutePreloads[],
  pathname: string,
  global: readonly HeadTag[] = [],
): readonly HeadTag[] {
  const seen = new Set(global.map(hrefOf));
  const out: HeadTag[] = [];
  for (const rule of rules) {
    if (!compileGlob(rule.pattern)(pathname)) continue;
    for (const tag of rule.preloads) {
      const href = hrefOf(tag);
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(tag);
    }
  }
  return out;
}

/** `bytes` as `12.3 KiB`. */
function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`;
}

/**
 * The report as a table of text, one line per file, with the totals.
 *
 * @param report The report from `defineFonts`.
 * @returns Text for the build log.
 * @example
 * formatFontReport({ files: [], totalBytes: 0, preloadedBytes: 0 }); // "fonts: no files"
 * @since 1.0.0
 */
export function formatFontReport(report: FontReport): string {
  if (report.files.length === 0) return "fonts: no files";
  const rows = report.files.map((file) => ({
    name: `${file.family} ${file.weight ?? "400"}${file.style === "italic" ? " italic" : ""}`,
    size: size(file.bytes),
    note: file.preloaded ? "preloaded" : "",
    url: file.url,
  }));
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const sizeWidth = Math.max(...rows.map((row) => row.size.length));
  const lines = rows.map(
    (row) =>
      `  ${row.name.padEnd(nameWidth)}  ${row.size.padStart(sizeWidth)}  ${row.note.padEnd(9)}  ${row.url}`,
  );
  return [
    `fonts: ${report.files.length} file${report.files.length === 1 ? "" : "s"}, ${size(report.totalBytes)} (${size(report.preloadedBytes)} preloaded)`,
    ...lines,
  ].join("\n");
}
