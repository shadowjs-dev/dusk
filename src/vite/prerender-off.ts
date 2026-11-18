/**
 * The warning of a build where `prerender: false` turns prerendering off while routes ask for it. Without it the
 * build prints no prerender step at all and the pages are silently rendered per request.
 *
 * @packageDocumentation
 */

/**
 * The build warning for pages whose prerender request `prerender: false` overrides.
 * @param paths The pages that ask to be prerendered (route exports or route rules), at least one.
 * @returns The warning text, naming at most ten pages.
 * @example prerenderOffWarning(["/", "/ar"]); // "dusk: prerender: false turns prerendering off, so ..."
 * @internal
 * @since 1.1.0
 */
export function prerenderOffWarning(paths: readonly string[]): string {
  const shown =
    paths.length > 10
      ? `${paths.slice(0, 10).join(", ")} and ${paths.length - 10} more`
      : paths.join(", ");
  return (
    `dusk: prerender: false turns prerendering off, so ${shown} ${paths.length === 1 ? "is" : "are"} rendered per ` +
    "request although the route or a route rule asks to prerender. Remove prerender: false (dusk() option or " +
    "dusk.config.ts) to prerender them, or remove their prerender flag to keep it off."
  );
}
