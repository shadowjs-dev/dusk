/**
 * `@shadow-js/dusk`: the code that is safe to import from anywhere, server or client bundle.
 * It holds the HTTP error, the redirect helpers and the shared types. The server runtime is in
 * `@shadow-js/dusk/server`.
 * @packageDocumentation
 */

export { HttpError, type HttpErrorOptions, isHttpError } from "./internal/http-error";
export {
  isNotFound,
  isRedirect,
  notFound,
  type RedirectOptions,
  type RedirectSignal,
  type RedirectStatus,
  redirect,
  redirectStatus,
} from "./internal/redirect";
export { metadataFeature } from "./metadata/feature";
export { viewportContent } from "./metadata/merge";
export { jsonLdText } from "./metadata/to-head";
export type {
  Alternates,
  AppLinks,
  AppleWebApp,
  Author,
  ColorScheme,
  FacebookMetadata,
  FormatDetection,
  HeadersArgs,
  IconDescriptor,
  Icons,
  ItunesApp,
  JsonLdValue,
  LinkDescriptor,
  MaxImagePreview,
  MetaArgs,
  MetaDescriptor,
  Metadata,
  MetadataArgs,
  MetadataTitle,
  MetadataUrl,
  OpenGraph,
  OpenGraphAudio,
  OpenGraphImage,
  OpenGraphImageInput,
  OpenGraphVideo,
  ReferrerPolicy,
  Robots,
  RobotsDirectives,
  ThemeColorDescriptor,
  TwitterAppCard,
  TwitterMetadata,
  TwitterPlayer,
  Verification,
  Viewport,
  ViewportFields,
} from "./metadata/types";
export {
  Fragment,
  h,
  jsx,
  jsxs,
  type OgComponent,
  type OgElement,
  type OgNode,
  type OgStyle,
} from "./og/element";
export {
  type FontDisplay,
  type FontFaceOptions,
  type FontFormat,
  type FontMetrics,
  type FontSource,
  fallbackFontFace,
  fontFace,
  fontPreloadTag,
} from "./shared/font";
export {
  IMAGE_WIDTHS,
  type ImageFormat,
  type ImageLoader,
  type ImageProps,
  type ImagePropsOptions,
  imageProps,
  preloadImageTag,
} from "./shared/image";
export { type IslandOptions, type IslandStrategy, islandAttributes } from "./shared/island";
export { type ResponseHandle, useResponse } from "./shared/response";
export { type ScriptOptions, type ScriptStrategy, scriptsHtml, scriptTag } from "./shared/script";
