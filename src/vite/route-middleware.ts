import type { ScanResult } from "@shadow-js/router/vite";

/**
 * The server-only middleware of a scan, in the form the server entry imports it: which module holds
 * each route's `middleware` export and each `_middleware` folder, and which folders apply to each page
 * and API route. Built from the scan only; nothing here is written into the browser's route tree.
 */

/**
 * A module that exports `middleware`, by the key the server looks it up with.
 * @since 1.0.0
 */
export interface MiddlewareSourceModule {
  readonly key: string;
  readonly absolutePath: string;
}

/** The middleware manifest source of an app. @since 1.0.0 */
export interface RouteMiddlewareSource {
  /** Route-level modules, keyed by route id (pages and layouts with a `middleware` export). */
  readonly routes: readonly MiddlewareSourceModule[];
  /** `_middleware` modules, keyed by folder (`""` for the routes root). */
  readonly directories: readonly MiddlewareSourceModule[];
  /** Page route id to the folders whose `_middleware` applies, outermost first. */
  readonly pages: readonly { readonly id: string; readonly folders: readonly string[] }[];
  /** API route id to the folders whose `_middleware` applies, outermost first. */
  readonly apis: readonly { readonly id: string; readonly folders: readonly string[] }[];
}

/**
 * The folders above a file, outermost first, the routes root (`""`) included.
 * @internal
 */
function foldersAbove(file: string): string[] {
  const out = [""];
  let folder = "";
  for (const part of file.split("/").slice(0, -1)) {
    folder = folder === "" ? part : `${folder}/${part}`;
    out.push(folder);
  }
  return out;
}

/**
 * Builds the middleware source of a scan.
 *
 * @param scan A successful route scan.
 * @returns The modules and the folder chains the server entry needs.
 * @example
 * const source = routeMiddlewareSource(await scanRoutes({ routesDir }));
 * @since 1.0.0
 */
export function routeMiddlewareSource(scan: ScanResult): RouteMiddlewareSource {
  const withMiddleware = new Set((scan.middleware ?? []).map((entry) => entry.folder));
  const scopeOf = (file: string): string[] =>
    foldersAbove(file).filter((folder) => withMiddleware.has(folder));
  const routes: MiddlewareSourceModule[] = [];
  const pages: { id: string; folders: string[] }[] = [];
  for (const entry of scan.entries) {
    if (entry.info.exports.includes("middleware")) {
      routes.push({ key: entry.id, absolutePath: entry.absolutePath });
    }
    if (entry.kind === "page") {
      const folders = scopeOf(entry.file);
      if (folders.length > 0) pages.push({ id: entry.id, folders });
    }
  }
  const apis: { id: string; folders: string[] }[] = [];
  for (const api of scan.api) {
    const folders = scopeOf(api.file);
    if (folders.length > 0) apis.push({ id: api.id, folders });
  }
  return {
    routes,
    directories: (scan.middleware ?? []).map((entry) => ({
      key: entry.folder,
      absolutePath: entry.absolutePath,
    })),
    pages,
    apis,
  };
}
