import { trimEndChar } from "../internal/text";

/**
 * The trailing-slash rule of the app's `trailingSlash` policy. It is pure, so both the server (API routes, sitemaps,
 * canonical URLs) and the metadata code that the browser also runs read it from here.
 *
 * The check works on the raw path, not on the router's canonical form: canonicalizing re-encodes segments, and a
 * `%2F` inside one segment would then become a separator. Only the trailing slashes change. The root (`/`) has no
 * trailing slash to add or remove, so it is never redirected.
 *
 * @param appPath The path below the base, as the request has it (`/items/`).
 * @param policy `always` adds the slash, `never` removes it, `preserve` leaves the path as it is.
 * @returns The canonical path when the request must be redirected to it, otherwise undefined.
 * @example trailingSlashTarget("/items", "always"); // "/items/"
 * @internal
 */
export function trailingSlashTarget(
  appPath: string,
  policy: "always" | "never" | "preserve",
): string | undefined {
  if (appPath === "" || appPath === "/" || policy === "preserve") return undefined;
  if (policy === "always") return appPath.endsWith("/") ? undefined : `${appPath}/`;
  if (!appPath.endsWith("/")) return undefined;
  const trimmed = trimEndChar(appPath, "/");
  return trimmed === "" ? "/" : trimmed;
}
