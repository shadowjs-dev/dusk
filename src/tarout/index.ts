/**
 * `@shadow-js/dusk/tarout`: the Tarout adapter. Tarout's documented contract is a Node app with a
 * `start` script that listens on `process.env.PORT`, deployed from the project folder (Tarout builds
 * it). The adapter writes the Node layout (`dist/tarout/server.mjs`) that meets it; set the
 * project's `start` script to `node dist/tarout/server.mjs`.
 *
 * What a deployment to Tarout showed: Tarout sets `PORT` (3000); its health check calls `GET /` on
 * `127.0.0.1:<PORT>` from inside the container and wants a 200, so an app that answers only for its public host
 * must also allow `127.0.0.1` (the handler answers `/_dusk/health` whatever the host); and the check runs `wget` or
 * `curl`, so the image needs one. The deployment guide has the details.
 * @packageDocumentation
 */

import { checkOutDir } from "../adapter/paths";
import type { Adapter } from "../adapter/types";
import { nodeLayout } from "../node/adapter";

/** Options of the {@link tarout} adapter. @since 1.0.0 */
export interface TaroutAdapterOptions {
  /** Output folder relative to the project. Default `dist/tarout`. */
  readonly outDir?: string;
}

/**
 * The Tarout adapter.
 *
 * @param options See {@link TaroutAdapterOptions}.
 * @returns The adapter for `dusk({ adapter })`.
 * @throws TypeError for an invalid `outDir`.
 * @example
 * import { tarout } from "@shadow-js/dusk/tarout";
 * export default { plugins: [dusk({ adapter: tarout() })] };
 * @since 1.0.0
 */
export function tarout(options: TaroutAdapterOptions = {}): Adapter {
  return nodeLayout({
    name: "tarout",
    outDir: checkOutDir("tarout()", options.outDir ?? "dist/tarout"),
    note: 'Set the "start" script to: node dist/tarout/server.mjs (Tarout runs it with PORT set).',
  });
}
