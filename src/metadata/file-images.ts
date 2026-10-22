import type { MetadataState } from "./merge";
import type { Metadata } from "./types";

/**
 * Static `opengraph-image` and `twitter-image` files in the metadata chain.
 *
 * The build reads each file once (its size and type from the header, the hash of its bytes, the alt text file next to
 * it) and gives the routes of its folder a hook in the generated route tree. The hook is the only code that runs for
 * them: it comes from the virtual module `virtual:dusk/file-images` (see `vite/file-images.ts`), which only an app with
 * such files imports, so the metadata code every app ships carries nothing but the call of the hook.
 */

/**
 * What the build knows of one static image file.
 * @since 1.0.0
 */
export interface FileImage {
  /**
   * The URL path the file is served at, with the params of its folder as pattern segments
   * (`/blog/:slug/opengraph-image.png`). The hash is not part of it: it is only added to the URL of the tag.
   */
  readonly path: string;
  /** A short hash of the file's bytes: the cache-busting query of the tag's URL. */
  readonly hash: string;
  /** The MIME type the file's header says. */
  readonly type: string;
  readonly width: number;
  readonly height: number;
  /** The text of the `.alt.txt` file next to the image, when there is one. */
  readonly alt?: string | undefined;
}

/**
 * The static images that apply at one route: the Open Graph image and the Twitter image.
 * @since 1.0.0
 */
export interface FileImages {
  readonly openGraph?: FileImage | undefined;
  readonly twitter?: FileImage | undefined;
}

/**
 * Adds the static images of a route to the metadata the chain merged so far. A block whose `images` the route's own
 * metadata set stays as set; any other block gets the file's image as its only image (the images of the layers above
 * are replaced), as Next does for its metadata image files.
 *
 * @param merged The state of the chain after the route's own layer.
 * @param own The route's own metadata (the `metadata` export or what `generateMetadata` returned).
 * @param params The params of the route, for the dynamic segments of the image's folder.
 * @param routeId The route's id, for the error message.
 * @param onError Receives the error when a param of the image's folder has no value; `merged` is then returned as it was.
 * @returns The state with the images added to its metadata.
 * @since 1.0.0
 */
export type FileImagesHook = (
  merged: MetadataState,
  own: Metadata,
  params: Readonly<Record<string, string>>,
  routeId: string,
  onError: (error: unknown, routeId: string) => void,
) => MetadataState;
