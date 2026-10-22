import type { DuskFeature } from "../server/features";
import { createImageRoute, type ImagesOptions } from "../server/image-route";
import { configureImageWidths } from "../shared/image-check";

/**
 * The `images()` feature: the image optimizer at `/_dusk/image` (`<Image>` of `@shadow-js/dusk/components`).
 * Local sources are read through the app's `source`, remote ones only from `remotePatterns`; a width, quality
 * and format outside the allow-lists is refused before the source is read.
 *
 * Without it, the path is not an endpoint (a 404), and an `images` option is refused at creation.
 *
 * @example
 * import { images } from the "@shadow-js/dusk/features/images" subpath;
 * const handler = createHandler({ manifest, features: [pages(), images()], images: { source } });
 * @returns The feature.
 * @since 1.0.0
 */
export function images(): DuskFeature {
  return {
    name: "images",
    install(host): void {
      const { options, runtime } = host;
      const images: ImagesOptions | undefined = options.images;
      // Server-rendered `<Image>` markup must name the widths the route serves: both read the same configuration.
      configureImageWidths(images?.widths);
      host.capabilities.images = {
        handle: createImageRoute(images, (error) => runtime.report(error, "request", undefined)),
      };
    },
  };
}
