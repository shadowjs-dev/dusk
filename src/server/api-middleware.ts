import { folderChain } from "./route-middleware";
import type { Middleware, RouteMiddlewareManifest } from "./types";

/**
 * The `_middleware` folders above an API route, in run order (outermost first). The handler loads this module only when
 * the app has a `_middleware` file, so an app without one does not carry the folder chain for its API routes.
 *
 * @param manifest The middleware manifest, if any.
 * @param id The API route id.
 * @returns The middleware to run before the route module's own.
 * @internal
 */
export async function apiMiddlewareFor(
  manifest: RouteMiddlewareManifest | undefined,
  id: string,
): Promise<Middleware[]> {
  if (manifest === undefined) return [];
  return folderChain(manifest, manifest.apis[id] ?? []);
}
