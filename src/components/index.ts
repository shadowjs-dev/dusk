/**
 * The compiled components of Dusk: `Image`, `Script` and `Island`. Each lives in its own module, so a page that
 * imports one component ships only that component (the bundle gate measures it). The helpers they are built on
 * (`imageProps`, `scriptTag`, `islandAttributes`) are exported from the main entry too.
 * @packageDocumentation
 */

export {
  type ImageProps,
  type ImagePropsOptions,
  type ImageWidths,
  imageProps,
} from "../shared/image";
export { configureImageBase, configureImageWidths } from "../shared/image-check";
export { type IslandOptions, type IslandStrategy, islandAttributes } from "../shared/island";
export { type ScriptOptions, type ScriptStrategy, scriptTag } from "../shared/script";
export {
  type ArtDirectionSource,
  configureImageVariants,
  Image,
  type ImageComponentProps,
} from "./image";
export type { PrebuiltImage, PrebuiltImages } from "./image-prebuilt";
export { Island, type IslandProps } from "./island";
export { Script, type ScriptProps } from "./script";
