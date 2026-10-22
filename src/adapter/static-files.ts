/**
 * The build's check of `runMiddlewareForStaticFiles` against the platform: a platform whose runtime answers files before
 * the handler cannot run the middleware for them, so the build says so, naming the option.
 *
 * @packageDocumentation
 */

/**
 * The warning a build prints when `runMiddlewareForStaticFiles` is on and the platform cannot run the middleware for
 * files. Undefined when the option is off or the platform supports it.
 *
 * @param adapterName The adapter's name, such as `"vercel"`.
 * @param supported Whether the adapter's capabilities say the platform runs the gate (`middlewareForStaticFiles`).
 * @param enabled Whether the handler sets `runMiddlewareForStaticFiles: true`.
 * @returns The warning text, or `undefined`.
 * @example
 * staticFilesMiddlewareWarning("vercel", false, true); // names runMiddlewareForStaticFiles
 * @since 1.0.0
 */
export function staticFilesMiddlewareWarning(
  adapterName: string,
  supported: boolean,
  enabled: boolean,
): string | undefined {
  if (!enabled || supported) return undefined;
  return (
    `runMiddlewareForStaticFiles is set, but the "${adapterName}" output answers public/ and build files before any code runs, ` +
    "so the global middleware does not run for them on this platform. Remove the option, or deploy to a platform that runs " +
    "the middleware for files (the Node server or Cloudflare)."
  );
}
