import { readFile } from "node:fs/promises";
import { isRecord } from "../shared/check";
import type { StaticPage } from "../shared/static-page";
import { CliError, isErrorCode } from "./errors";

/**
 * The part of `dusk-manifest.json` the bin reads: which adapter the build used, where it wrote its output, and the
 * routes, API routes, streams and middleware the build summary lists. The build writes the file; the bin only reads it
 * (it never re-evaluates `vite.config`). A field the file does not have is absent, so a manifest written by an older
 * build still reads.
 *
 * @packageDocumentation
 */

/** One page or layout of the build, as the bin needs it. @since 1.0.0 */
export interface BuiltRoute {
  readonly kind: "page" | "layout";
  /** The file of the route, relative to the project root. */
  readonly file: string;
  readonly path: string;
  /** Files of the client build (relative to the client folder, or absolute URLs with an asset origin). */
  readonly preload: readonly string[];
  readonly ssr?: boolean | "data-only";
  readonly prerender?: boolean | readonly string[];
  /** `export const dynamicParams`: `false` means a param the `prerender` export does not list is not found. */
  readonly dynamicParams?: boolean;
  readonly revalidate?: number;
}

/** What the bin needs from a build's manifest. @since 1.0.0 */
export interface BuiltManifest {
  readonly adapter?: { readonly name: string; readonly outDir: string };
  /** The build's assets folder (`assets` unless the build set `build.assetsDir`); absent in a manifest written before it. */
  readonly assetsDir?: string;
  /** The entry chunk of the client build (relative to the client folder). */
  readonly entry?: string;
  /** The stylesheets of the entry chunk. */
  readonly css: readonly string[];
  /** The routes by id. */
  readonly routes: Readonly<Record<string, BuiltRoute>>;
  /** The API routes: the id (the URL pattern), the file and the methods. */
  readonly api: readonly {
    readonly id: string;
    readonly file: string;
    readonly methods: readonly string[];
  }[];
  /** The stream routes: the URL pattern and the kinds the module exports. */
  readonly streams: readonly {
    readonly id: string;
    readonly path: string;
    readonly kinds: readonly string[];
  }[];
  /** The `_middleware` files, relative to the project root. */
  readonly middleware: readonly { readonly file: string }[];
  /** The URL paths the build rendered ahead of time. */
  readonly prerendered: readonly string[];
  /** How each prerendered page is answered (B2): a file with its headers, or the handler. Absent in an older build. */
  readonly staticPages: readonly StaticPage[];
}

const NOT_A_MANIFEST =
  "dist/dusk-manifest.json is not a manifest the build wrote. Run `dusk build` again.";

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function routesOf(value: unknown): Record<string, BuiltRoute> {
  const routes: Record<string, BuiltRoute> = {};
  const table = recordOf(value);
  if (table === undefined) return routes;
  for (const [id, raw] of Object.entries(table)) {
    const route = recordOf(raw);
    if (route === undefined) continue;
    const kind = route["kind"] === "layout" ? "layout" : "page";
    const path = typeof route["path"] === "string" ? route["path"] : id;
    const file = typeof route["file"] === "string" ? route["file"] : "";
    const revalidate = route["revalidate"];
    const ssr = route["ssr"];
    const prerender = route["prerender"];
    const dynamicParams = route["dynamicParams"];
    routes[id] = {
      kind,
      file,
      path,
      preload: stringsOf(route["preload"]),
      ...(ssr === true || ssr === false || ssr === "data-only" ? { ssr } : {}),
      ...(prerender === true || prerender === false
        ? { prerender }
        : Array.isArray(prerender)
          ? { prerender: stringsOf(prerender) }
          : {}),
      ...(typeof dynamicParams === "boolean" ? { dynamicParams } : {}),
      ...(typeof revalidate === "number" ? { revalidate } : {}),
    };
  }
  return routes;
}

function listOf<T>(
  value: unknown,
  read: (item: Readonly<Record<string, unknown>>) => T | undefined,
): T[] {
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  for (const raw of value) {
    const item = recordOf(raw);
    const parsed = item === undefined ? undefined : read(item);
    if (parsed !== undefined) items.push(parsed);
  }
  return items;
}

/**
 * Reads the manifest of a build.
 * @param file The path of `dusk-manifest.json`.
 * @returns The facts, or undefined when the file does not exist (no build).
 * @throws CliError when the file is not a manifest the build wrote.
 * @since 1.0.0
 */
export async function readBuildManifest(file: string): Promise<BuiltManifest | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError(NOT_A_MANIFEST, "DUSK_BAD_MANIFEST");
  }
  const record = recordOf(data);
  if (record === undefined) throw new CliError(NOT_A_MANIFEST, "DUSK_BAD_MANIFEST");
  const built: BuiltManifest = {
    css: stringsOf(record["css"]),
    routes: routesOf(record["routes"]),
    api: listOf(record["api"], (item) =>
      typeof item["id"] === "string"
        ? {
            id: item["id"],
            file: typeof item["file"] === "string" ? item["file"] : "",
            methods: stringsOf(item["methods"]),
          }
        : undefined,
    ),
    streams: listOf(record["streams"], (item) =>
      typeof item["id"] === "string" && typeof item["path"] === "string"
        ? { id: item["id"], path: item["path"], kinds: stringsOf(item["kinds"]) }
        : undefined,
    ),
    middleware: listOf(record["middleware"], (item) =>
      typeof item["file"] === "string" ? { file: item["file"] } : undefined,
    ),
    prerendered: stringsOf(record["prerendered"]),
    staticPages: staticPagesOf(record["staticPages"]),
  };
  const assetsDir =
    typeof record["assetsDir"] === "string" ? { assetsDir: record["assetsDir"] } : {};
  const entry = typeof record["entry"] === "string" ? { entry: record["entry"] } : {};
  const adapter = record["adapter"];
  if (adapter === undefined) return { ...built, ...assetsDir, ...entry };
  const adapterRecord = recordOf(adapter);
  const name = adapterRecord?.["name"];
  const outDir = adapterRecord?.["outDir"];
  if (typeof name !== "string" || typeof outDir !== "string")
    throw new CliError(NOT_A_MANIFEST, "DUSK_BAD_MANIFEST");
  return { ...built, ...assetsDir, ...entry, adapter: { name, outDir } };
}

/** The static pages of a manifest: each entry is a path and a mode, with its headers when it is a file. @internal */
function staticPagesOf(value: unknown): StaticPage[] {
  if (!Array.isArray(value)) return [];
  const pages: StaticPage[] = [];
  for (const item of value) {
    const record = recordOf(item);
    if (record === undefined || typeof record["path"] !== "string") continue;
    const mode = record["mode"] === "handler" ? "handler" : "static";
    pages.push({
      path: record["path"],
      mode,
      headers: pairsOf(record["headers"]),
      httpsHeaders: pairsOf(record["httpsHeaders"]),
      reason: typeof record["reason"] === "string" ? record["reason"] : undefined,
    });
  }
  return pages;
}

/** Name-value pairs of a manifest list, dropping anything that is not a pair of strings. @internal */
function pairsOf(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return [];
  const pairs: [string, string][] = [];
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string") {
      pairs.push([item[0], item[1]]);
    }
  }
  return pairs;
}
