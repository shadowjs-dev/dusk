import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { StaticPage } from "../shared/static-page";
import type { DuskBuildBudgets } from "../vite/config-file";
import type { BuildReport, BuildStep } from "../vite/plugin";
import { isErrorCode } from "./errors";
import type { BuiltManifest, BuiltRoute } from "./manifest";
import { kilobytes } from "./output";

/**
 * The facts of `dusk build`'s summary: each page's first-load JavaScript (the gzip size of its entry, its stylesheets
 * and the chunks of its route), the shared part every page loads, the middleware that covers each route, and the
 * budget warnings. Pure apart from reading the client files; the text is in `output.ts`.
 *
 * @packageDocumentation
 */

/** The kinds of route the table tells apart; each has its own symbol in the table. @since 1.0.0 */
export type RouteFamily = "static" | "handler" | "isr" | "dynamic" | "client" | "api" | "stream";

/**
 * One row of the route table. `bytes` (the first load) is 0 for a row with no JavaScript (an API route), undefined when it
 * cannot be sized. `size` is the part of it that only this page loads (its route chunks, without the shared shell).
 */
export interface RouteRow {
  readonly path: string;
  readonly family: RouteFamily;
  /** The words of the Kind column: `static (file)`, `ISR 60s`, `dynamic`, `API`... */
  readonly kind: string;
  readonly bytes: number | undefined;
  readonly size?: number | undefined;
  readonly middleware: number;
  /** True when the page's first load is over its budget. */
  readonly overBudget?: boolean;
}

/** What the summary shows. @since 1.0.0 */
export interface BuildSummary {
  readonly version: string;
  /** The folder the build wrote, relative to the app, with `/` separators. Default `dist`. */
  readonly outDir?: string;
  readonly steps: readonly BuildStep[];
  readonly prerendered: number;
  readonly secretScan: { readonly enabled: boolean; readonly scanned: number };
  readonly adapter: { readonly name: string; readonly outDir: string } | undefined;
  readonly adapterLog: readonly string[];
  readonly routes: readonly RouteRow[];
  readonly shared: { readonly bytes: number | undefined; readonly files: number };
  readonly warnings: readonly string[];
  /** The total time of the build, in milliseconds. */
  readonly ms: number;
}

/** What {@link summarizeBuild} reads. @since 1.0.0 */
export interface BuildSummaryInput {
  readonly version: string;
  readonly manifest: BuiltManifest;
  /** The client folder of the build, absolute. */
  readonly clientDir: string;
  /** The folder the build wrote, relative to the app (`dusk({ outDir })`). Default `dist`. */
  readonly outDir?: string;
  readonly report: BuildReport | undefined;
  readonly budgets: DuskBuildBudgets | undefined;
  readonly ms: number;
  /** Reads a client file. Defaults to the file system; a test passes its own to count the reads. */
  readonly read?: (path: string) => Promise<Uint8Array>;
}

/** How many client files are read at once. A build of thousands of chunks must not open them all together. @since 1.0.0 */
export const READ_CONCURRENCY = 32;

/** A file that is not in the client folder (an absolute URL with an asset origin) cannot be sized here. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/** Runs tasks with at most `max` at a time. @internal */
function pool(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** The sizes of the client files: each file is read and compressed once, however many routes share it. @internal */
interface Sizes {
  /** The sum of the gzip sizes of the files, or undefined when one of them cannot be sized. */
  total(files: readonly string[]): Promise<number | undefined>;
}

function sizesOf(
  clientDir: string,
  read: (path: string) => Promise<Uint8Array>,
  concurrency: number,
): Sizes {
  const run = pool(concurrency);
  const memo = new Map<string, Promise<number | undefined>>();
  const one = (file: string): Promise<number | undefined> => {
    const known = memo.get(file);
    if (known !== undefined) return known;
    const size = REMOTE.test(file)
      ? Promise.resolve(undefined)
      : run(async () => {
          try {
            return gzipSync(await read(join(clientDir, file))).length;
          } catch (error) {
            if (isErrorCode(error, "ENOENT")) return undefined;
            throw error;
          }
        });
    memo.set(file, size);
    return size;
  };
  return {
    async total(files) {
      const sizes = await Promise.all([...new Set(files)].map(one));
      let total = 0;
      for (const size of sizes) {
        if (size === undefined) return undefined;
        total += size;
      }
      return total;
    },
  };
}

/**
 * True when a rendered path is one of the URLs a route pattern stands for (`/posts/:id` for `/posts/7`). A `:name`
 * segment matches one segment; a `*` segment matches the rest of the path.
 * @internal
 */
function isInstanceOf(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index] ?? "";
    if (segment === "*") return true;
    if (got[index] === undefined) return false;
    if (!segment.startsWith(":") && segment !== got[index]) return false;
  }
  return want.length === got.length;
}

/**
 * The kind of a page, as the table names it. A prerendered page is `static (file)` when its file answers the requests,
 * and `static (via handler)` when the app's rules apply to it and the handler answers (B2). A build without the decision
 * (an older manifest) reads as a file.
 * @internal
 */
function kindOf(
  route: BuiltRoute,
  prerendered: ReadonlySet<string>,
  modes: ReadonlyMap<string, StaticPage["mode"]>,
): { readonly family: RouteFamily; readonly kind: string } {
  const instances = [...prerendered].filter((path) => isInstanceOf(route.path, path));
  if (instances.length > 0) {
    return instances.some((path) => modes.get(path) === "handler")
      ? { family: "handler", kind: "static (via handler)" }
      : { family: "static", kind: "static (file)" };
  }
  if (route.revalidate !== undefined) return { family: "isr", kind: `ISR ${route.revalidate}s` };
  if (route.ssr === false) return { family: "client", kind: "client" };
  return { family: "dynamic", kind: "dynamic" };
}

/** How many middleware files cover a route file (the middleware of its folder and of every folder above it). @internal */
function coverage(file: string, middleware: readonly { readonly file: string }[]): number {
  const folder = dirname(file);
  return middleware.filter((entry) => {
    const home = dirname(entry.file);
    return folder === home || folder.startsWith(`${home}/`);
  }).length;
}

/**
 * The summary of a build: sizes from the client folder, the rows of the table, and the budget warnings.
 * @param input What the build produced.
 * @returns The summary.
 * @since 1.0.0
 */
export async function summarizeBuild(input: BuildSummaryInput): Promise<BuildSummary> {
  const { manifest, clientDir } = input;
  const sizes = sizesOf(clientDir, input.read ?? ((path) => readFile(path)), READ_CONCURRENCY);
  const prerendered = new Set(manifest.prerendered);
  const modes = new Map(manifest.staticPages.map((page) => [page.path, page.mode] as const));
  const shell = [...(manifest.entry === undefined ? [] : [manifest.entry]), ...manifest.css];
  const sharedBytes = manifest.entry === undefined ? undefined : await sizes.total(shell);
  const warnings: string[] = [];
  const own = new Set(shell);
  const routes = Object.values(manifest.routes)
    .filter((value) => value.kind === "page")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pages: RouteRow[] = await Promise.all(
    routes.map(async (route) => {
      const bytes = await sizes.total([...shell, ...route.preload]);
      const size = await sizes.total(route.preload.filter((file) => !own.has(file)));
      const limit = input.budgets?.routes?.[route.path] ?? input.budgets?.firstLoadJs;
      return {
        path: route.path,
        ...kindOf(route, prerendered, modes),
        bytes,
        size,
        middleware: coverage(route.file, manifest.middleware),
        overBudget: bytes !== undefined && limit !== undefined && bytes > limit,
      };
    }),
  );
  // The warnings come after the rows are known, in the order of the table.
  for (const row of pages) {
    const limit = input.budgets?.routes?.[row.path] ?? input.budgets?.firstLoadJs;
    if (row.overBudget === true && row.bytes !== undefined && limit !== undefined) {
      warnings.push(
        `${row.path} loads ${kilobytes(row.bytes)} of JavaScript first, over its budget of ${kilobytes(limit)} (build.budgets in dusk.config.ts).`,
      );
    }
  }
  for (const path of Object.keys(input.budgets?.routes ?? {})) {
    if (!pages.some((row) => row.path === path)) {
      warnings.push(`build.budgets.routes names ${path}, but no page has that path.`);
    }
  }
  const apis: RouteRow[] = manifest.api
    .map((api) => ({
      path: api.id,
      family: "api" as const,
      kind: "API",
      bytes: 0,
      middleware: coverage(api.file, manifest.middleware),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const streams: RouteRow[] = manifest.streams
    .map((stream) => ({
      path: stream.path,
      family: "stream" as const,
      kind: `stream ${stream.kinds.join("+")}`,
      bytes: 0,
      middleware: 0,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    version: input.version,
    outDir: input.outDir ?? "dist",
    steps: input.report?.steps ?? [],
    prerendered: input.report?.prerendered ?? manifest.prerendered.length,
    secretScan: input.report?.secretScan ?? { enabled: false, scanned: 0 },
    adapter: input.report?.adapter,
    adapterLog: input.report?.adapterLog ?? [],
    routes: [...pages, ...apis, ...streams],
    shared: { bytes: sharedBytes, files: shell.length },
    warnings,
    ms: input.ms,
  };
}
