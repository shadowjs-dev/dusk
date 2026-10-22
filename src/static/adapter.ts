import { checkOutDir } from "../adapter/paths";
import type { Adapter } from "../adapter/types";

/**
 * The static-site adapter: copies the prerendered client build (`dist/client`) to its own folder, for
 * any host that serves files (GitHub Pages, S3, a CDN). Pages without a prerendered HTML file are not
 * available there: a static host has no server to render them.
 * @packageDocumentation
 */

/** Options of the {@link staticSite} adapter. @since 1.0.0 */
export interface StaticSiteAdapterOptions {
  /** Output folder relative to the project. Default `dist/static`. */
  readonly outDir?: string;
}

/**
 * The static-site adapter.
 *
 * @param options See {@link StaticSiteAdapterOptions}.
 * @returns The adapter for `dusk({ adapter })`.
 * @throws TypeError for an invalid `outDir`.
 * @example
 * import { staticSite } from "@shadow-js/dusk/static";
 * export default { plugins: [dusk({ adapter: staticSite() })] };
 * @since 1.0.0
 */
export function staticSite(options: StaticSiteAdapterOptions = {}): Adapter {
  return {
    name: "static",
    outDir: checkOutDir("staticSite()", options.outDir ?? "dist/static"),
    env: "process",
    bundling: "dependencies",
    capabilities: {
      streaming: false,
      asyncContext: false,
      staticAssets: "platform",
      websockets: false,
      serverSentEvents: false,
    },
    async build(context) {
      await context.copy(context.clientDir, ".");
      context.log(`copied the client build to ${context.outDir}`);
    },
  };
}
