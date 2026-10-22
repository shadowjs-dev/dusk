/**
 * The typed metadata surface of Dusk: the `metadata` and `viewport` exports of a route or layout module, and the
 * `generateMetadata` / `generateViewport` functions that compute them. The shape follows the Next.js `Metadata` and
 * `Viewport` types field for field, so a migrated object keeps its meaning. Every field is optional.
 *
 * Merging across the layout chain is described in `merge.ts`; the tags each field produces are in `to-head.ts`.
 * @packageDocumentation
 */

/** A URL as a string or a `URL`. Relative values resolve against `metadataBase` (see `url.ts`). @since 1.0.0 */
export type MetadataUrl = string | URL;

/** One author: a name and an optional profile URL. @since 1.0.0 */
export interface Author {
  readonly name?: string;
  readonly url?: MetadataUrl;
}

/** Where a referrer policy applies. @since 1.0.0 */
export type ReferrerPolicy =
  | "no-referrer"
  | "origin"
  | "no-referrer-when-downgrade"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

/** A theme color, optionally for one `media` query. @since 1.0.0 */
export interface ThemeColorDescriptor {
  readonly color: string;
  readonly media?: string;
}

/** The `color-scheme` values. @since 1.0.0 */
export type ColorScheme =
  | "normal"
  | "light"
  | "dark"
  | "light dark"
  | "dark light"
  | "only light"
  | "only dark";

/** `max-image-preview` values. @since 1.0.0 */
export type MaxImagePreview = "none" | "standard" | "large";

/**
 * The robots directives. `googleBot` takes the same directives for Google's crawler; `"max-snippet"` takes a number
 * (`-1` for no limit).
 * @since 1.0.0
 */
export interface RobotsDirectives {
  readonly index?: boolean;
  readonly follow?: boolean;
  readonly noarchive?: boolean;
  readonly nosnippet?: boolean;
  readonly noimageindex?: boolean;
  readonly nocache?: boolean;
  readonly notranslate?: boolean;
  readonly indexifembedded?: boolean;
  readonly nositelinkssearchbox?: boolean;
  readonly unavailable_after?: string;
  readonly "max-snippet"?: number;
  readonly "max-image-preview"?: MaxImagePreview;
  readonly "max-video-preview"?: number;
}

/** Robots: directives, plus a `googleBot` block for Google's crawler. @since 1.0.0 */
export interface Robots extends RobotsDirectives {
  readonly googleBot?: RobotsDirectives | string;
}

/**
 * Alternate URLs: the canonical address, the same page in other languages, for other media, and feeds.
 * Relative values resolve against `metadataBase`.
 * @since 1.0.0
 */
export interface Alternates {
  readonly canonical?: MetadataUrl | null;
  /** `hreflang` value to URL. */
  readonly languages?: Readonly<Record<string, readonly MetadataUrl[] | MetadataUrl>>;
  /** `media` value to URL (for example a print or mobile version). */
  readonly media?: Readonly<Record<string, MetadataUrl>>;
  /** MIME type to URL (feeds). */
  readonly types?: Readonly<Record<string, readonly MetadataUrl[] | MetadataUrl>>;
}

/** An image of an icon or of a social card. @since 1.0.0 */
export interface IconDescriptor {
  readonly url: MetadataUrl;
  readonly type?: string;
  readonly sizes?: string;
  readonly media?: string;
  readonly color?: string;
  readonly rel?: string;
}

/**
 * Icons: one URL, a list of descriptors, or the grouped form (`icon`, `shortcut`, `apple`, `other`). `apple` renders
 * `rel="apple-touch-icon"`; `other` takes its own `rel`.
 * @since 1.0.0
 */
export type Icons =
  | MetadataUrl
  | readonly (MetadataUrl | IconDescriptor)[]
  | {
      readonly icon?: MetadataUrl | IconDescriptor | readonly (MetadataUrl | IconDescriptor)[];
      readonly shortcut?: MetadataUrl | IconDescriptor | readonly (MetadataUrl | IconDescriptor)[];
      readonly apple?: MetadataUrl | IconDescriptor | readonly (MetadataUrl | IconDescriptor)[];
      readonly other?: readonly IconDescriptor[];
    };

/** An image of a social card (`openGraph.images`, `twitter.images`). @since 1.0.0 */
export interface OpenGraphImage {
  readonly url: MetadataUrl;
  readonly secureUrl?: MetadataUrl;
  readonly type?: string;
  readonly width?: number | string;
  readonly height?: number | string;
  readonly alt?: string;
}

/** A video of a social card. @since 1.0.0 */
export interface OpenGraphVideo {
  readonly url: MetadataUrl;
  readonly secureUrl?: MetadataUrl;
  readonly type?: string;
  readonly width?: number | string;
  readonly height?: number | string;
}

/** An audio clip of a social card. @since 1.0.0 */
export interface OpenGraphAudio {
  readonly url: MetadataUrl;
  readonly secureUrl?: MetadataUrl;
  readonly type?: string;
}

/** An image in a social card: a URL, a descriptor, or a bare string. @since 1.0.0 */
export type OpenGraphImageInput = MetadataUrl | OpenGraphImage;

/** Fields every Open Graph object carries. @since 1.0.0 */
export interface OpenGraphBase {
  readonly title?: string;
  readonly description?: string;
  readonly url?: MetadataUrl;
  readonly siteName?: string;
  readonly locale?: string;
  readonly alternateLocale?: string | readonly string[];
  readonly determiner?: "a" | "an" | "the" | "" | "auto";
  readonly emails?: readonly string[];
  readonly phoneNumbers?: readonly string[];
  readonly faxNumbers?: readonly string[];
  readonly countryName?: string;
  readonly ttl?: number;
  readonly images?: OpenGraphImageInput | readonly OpenGraphImageInput[];
  readonly videos?: OpenGraphVideo | MetadataUrl | readonly (OpenGraphVideo | MetadataUrl)[];
  readonly audio?: OpenGraphAudio | MetadataUrl | readonly (OpenGraphAudio | MetadataUrl)[];
}

/** `og:type` website. @since 1.0.0 */
export interface OpenGraphWebsite extends OpenGraphBase {
  readonly type: "website";
}

/** `og:type` article. @since 1.0.0 */
export interface OpenGraphArticle extends OpenGraphBase {
  readonly type: "article";
  readonly publishedTime?: string;
  readonly modifiedTime?: string;
  readonly expirationTime?: string;
  readonly authors?: readonly string[];
  readonly section?: string;
  readonly tags?: readonly string[];
}

/** `og:type` book. @since 1.0.0 */
export interface OpenGraphBook extends OpenGraphBase {
  readonly type: "book";
  readonly isbn?: string;
  readonly releaseDate?: string;
  readonly authors?: readonly string[];
  readonly tags?: readonly string[];
}

/** `og:type` profile. @since 1.0.0 */
export interface OpenGraphProfile extends OpenGraphBase {
  readonly type: "profile";
  readonly firstName?: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly gender?: string;
}

/** `og:type` music.song. @since 1.0.0 */
export interface OpenGraphMusicSong extends OpenGraphBase {
  readonly type: "music.song";
  readonly duration?: number;
  readonly album?: readonly (
    | MetadataUrl
    | { readonly url: MetadataUrl; readonly disc?: number; readonly track?: number }
  )[];
  readonly musicians?: readonly string[];
}

/** `og:type` music.album. @since 1.0.0 */
export interface OpenGraphMusicAlbum extends OpenGraphBase {
  readonly type: "music.album";
  readonly songs?: readonly (
    | MetadataUrl
    | { readonly url: MetadataUrl; readonly disc?: number; readonly track?: number }
  )[];
  readonly musicians?: readonly string[];
  readonly releaseDate?: string;
}

/** `og:type` music.playlist. @since 1.0.0 */
export interface OpenGraphMusicPlaylist extends OpenGraphBase {
  readonly type: "music.playlist";
  readonly songs?: readonly (
    | MetadataUrl
    | { readonly url: MetadataUrl; readonly disc?: number; readonly track?: number }
  )[];
  readonly creators?: readonly string[];
}

/** `og:type` music.radio_station. @since 1.0.0 */
export interface OpenGraphMusicRadioStation extends OpenGraphBase {
  readonly type: "music.radio_station";
  readonly creators?: readonly string[];
}

/** An actor or director of a video, by profile URL. @since 1.0.0 */
export interface VideoPerson {
  readonly profile?: MetadataUrl;
  readonly role?: string;
}

/** Fields of a video.movie and a video.episode. @since 1.0.0 */
interface OpenGraphVideoFields extends OpenGraphBase {
  readonly actors?: readonly (MetadataUrl | VideoPerson)[];
  readonly directors?: readonly MetadataUrl[];
  readonly writers?: readonly MetadataUrl[];
  readonly duration?: number;
  readonly releaseDate?: string;
  readonly tags?: readonly string[];
}

/** `og:type` video.movie. @since 1.0.0 */
export interface OpenGraphVideoMovie extends OpenGraphVideoFields {
  readonly type: "video.movie";
}

/** `og:type` video.episode. @since 1.0.0 */
export interface OpenGraphVideoEpisode extends OpenGraphVideoFields {
  readonly type: "video.episode";
  readonly series?: MetadataUrl;
}

/** `og:type` video.tv_show. @since 1.0.0 */
export interface OpenGraphVideoTvShow extends OpenGraphBase {
  readonly type: "video.tv_show";
  readonly actors?: readonly (MetadataUrl | VideoPerson)[];
  readonly directors?: readonly MetadataUrl[];
  readonly writers?: readonly MetadataUrl[];
}

/** `og:type` video.other. @since 1.0.0 */
export interface OpenGraphVideoOther extends OpenGraphBase {
  readonly type: "video.other";
}

/**
 * The Open Graph block. Each `type` takes its own fields (`article:published_time` for an article, and so on).
 * Without a `type` the block is written as the generic Open Graph fields.
 * @since 1.0.0
 */
export type OpenGraph =
  | OpenGraphWebsite
  | OpenGraphArticle
  | OpenGraphBook
  | OpenGraphProfile
  | OpenGraphMusicSong
  | OpenGraphMusicAlbum
  | OpenGraphMusicPlaylist
  | OpenGraphMusicRadioStation
  | OpenGraphVideoMovie
  | OpenGraphVideoEpisode
  | OpenGraphVideoTvShow
  | OpenGraphVideoOther
  | (OpenGraphBase & { readonly type?: undefined });

/** `twitter:card` values. @since 1.0.0 */
export type TwitterCard = "summary" | "summary_large_image" | "app" | "player";

/** Twitter's app card: the store IDs and the deep links. @since 1.0.0 */
export interface TwitterAppCard {
  readonly id: {
    readonly iphone?: string | number;
    readonly ipad?: string | number;
    readonly googleplay?: string;
  };
  readonly name?: string;
  readonly url?: {
    readonly iphone?: MetadataUrl;
    readonly ipad?: MetadataUrl;
    readonly googleplay?: MetadataUrl;
  };
}

/** Twitter's player card. @since 1.0.0 */
export interface TwitterPlayer {
  readonly playerUrl: MetadataUrl;
  readonly streamUrl?: MetadataUrl;
  readonly width?: number;
  readonly height?: number;
}

/** The Twitter card. @since 1.0.0 */
export type TwitterMetadata =
  | {
      readonly card?: "summary" | "summary_large_image";
      readonly site?: string;
      readonly siteId?: string;
      readonly creator?: string;
      readonly creatorId?: string;
      readonly title?: string;
      readonly description?: string;
      readonly images?: OpenGraphImageInput | readonly OpenGraphImageInput[];
    }
  | {
      readonly card: "app";
      readonly site?: string;
      readonly siteId?: string;
      readonly creator?: string;
      readonly creatorId?: string;
      readonly title?: string;
      readonly description?: string;
      readonly images?: OpenGraphImageInput | readonly OpenGraphImageInput[];
      readonly app: TwitterAppCard;
    }
  | {
      readonly card: "player";
      readonly site?: string;
      readonly siteId?: string;
      readonly creator?: string;
      readonly creatorId?: string;
      readonly title?: string;
      readonly description?: string;
      readonly images?: OpenGraphImageInput | readonly OpenGraphImageInput[];
      readonly player: TwitterPlayer | readonly TwitterPlayer[];
    };

/**
 * Site verification codes. `other` renders `<meta name="key" content="value">`; a list gives one tag per value.
 * @since 1.0.0
 */
export interface Verification {
  readonly google?: string | readonly string[];
  readonly yahoo?: string | readonly string[];
  readonly yandex?: string | readonly string[];
  readonly me?: string | readonly string[];
  readonly other?: Readonly<Record<string, string | number | readonly (string | number)[]>>;
}

/** Safari's web app settings. @since 1.0.0 */
export interface AppleWebApp {
  readonly capable?: boolean;
  readonly title?: string;
  readonly startupImage?:
    | MetadataUrl
    | readonly (MetadataUrl | { readonly url: MetadataUrl; readonly media?: string })[];
  readonly statusBarStyle?: "default" | "black" | "black-translucent";
}

/** Phone numbers, e-mail and addresses detection (`format-detection`). @since 1.0.0 */
export interface FormatDetection {
  readonly telephone?: boolean;
  readonly date?: boolean;
  readonly address?: boolean;
  readonly email?: boolean;
  readonly url?: boolean;
}

/** The iTunes app banner. @since 1.0.0 */
export interface ItunesApp {
  readonly appId: string;
  readonly appArgument?: string;
}

/** Facebook settings. @since 1.0.0 */
export interface FacebookMetadata {
  readonly appId?: string;
  readonly admins?: readonly string[];
}

/** Deep links for app-link services (`al:*` tags). @since 1.0.0 */
export interface AppLinks {
  readonly ios?: {
    readonly url: MetadataUrl;
    readonly app_store_id?: string | number;
    readonly app_name?: string;
  };
  readonly iphone?: {
    readonly url: MetadataUrl;
    readonly app_store_id?: string | number;
    readonly app_name?: string;
  };
  readonly ipad?: {
    readonly url: MetadataUrl;
    readonly app_store_id?: string | number;
    readonly app_name?: string;
  };
  readonly android?: {
    readonly package: string;
    readonly app_name?: string;
    readonly url?: MetadataUrl;
  };
  readonly windows?: {
    readonly url: MetadataUrl;
    readonly app_id?: string;
    readonly app_name?: string;
  };
  readonly windows_phone?: {
    readonly url: MetadataUrl;
    readonly app_id?: string;
    readonly app_name?: string;
  };
  readonly windows_universal?: {
    readonly url: MetadataUrl;
    readonly app_id?: string;
    readonly app_name?: string;
  };
  readonly web?: { readonly url: MetadataUrl; readonly should_fallback?: boolean };
}

/** The `other` escape hatch: name to value, arrays give one tag per value. @since 1.0.0 */
export type OtherMetadata = Readonly<
  Record<string, string | number | readonly (string | number)[]>
>;

/**
 * The title. A string is the page title (a layout's `template` wraps it). The object form sets a `default` used when
 * no page sets one, a `template` for the titles below (`%s` is replaced), or an `absolute` title that skips the
 * template.
 * @since 1.0.0
 */
export type MetadataTitle =
  | string
  | {
      readonly default?: string;
      readonly template?: string | null;
      readonly absolute?: string;
    };

/**
 * The document metadata of a route or layout (the `metadata` export, or what `generateMetadata` returns). Every
 * field is optional and each one has a documented rule for how layers combine (see `merge.ts`).
 * @since 1.0.0
 */
export interface Metadata {
  /** Base for relative URLs (canonical, Open Graph, icons, manifest, alternates). */
  readonly metadataBase?: URL | string | null;
  readonly title?: MetadataTitle | null;
  readonly description?: string | null;
  readonly applicationName?: string;
  readonly authors?: Author | readonly Author[];
  readonly generator?: string;
  readonly keywords?: string | readonly string[];
  readonly referrer?: ReferrerPolicy;
  readonly themeColor?: string | ThemeColorDescriptor | readonly ThemeColorDescriptor[];
  readonly colorScheme?: ColorScheme;
  /** A viewport string written as is. Prefer the `viewport` export, which builds it from fields. */
  readonly viewport?: string | ViewportFields;
  readonly creator?: string;
  readonly publisher?: string;
  readonly robots?: string | Robots;
  readonly alternates?: Alternates;
  readonly icons?: Icons;
  readonly manifest?: MetadataUrl;
  readonly openGraph?: OpenGraph;
  readonly twitter?: TwitterMetadata;
  readonly verification?: Verification;
  readonly appleWebApp?: AppleWebApp | true;
  readonly formatDetection?: FormatDetection;
  readonly itunes?: ItunesApp;
  readonly facebook?: FacebookMetadata;
  readonly pinterest?: { readonly richPin?: boolean };
  readonly appLinks?: AppLinks;
  readonly archives?: MetadataUrl | readonly MetadataUrl[];
  readonly assets?: MetadataUrl | readonly MetadataUrl[];
  readonly bookmarks?: MetadataUrl | readonly MetadataUrl[];
  readonly category?: string;
  readonly classification?: string;
  /** Extra `<meta name>` tags. */
  readonly other?: OtherMetadata;
  /** JSON-LD structured data: each value becomes one `<script type="application/ld+json">`. */
  readonly jsonLd?: JsonLdValue | readonly JsonLdValue[];
}

/** Anything `JSON.stringify` writes as an object (structured data). @since 1.0.0 */
export type JsonLdValue = { readonly [key: string]: unknown };

/** The viewport fields that build the `viewport` meta. @since 1.0.0 */
export interface ViewportFields {
  readonly width?: "device-width" | number | string;
  readonly height?: "device-height" | number | string;
  readonly initialScale?: number;
  readonly minimumScale?: number;
  readonly maximumScale?: number;
  readonly userScalable?: boolean;
  readonly viewportFit?: "auto" | "cover" | "contain";
  readonly interactiveWidget?: "resizes-visual" | "resizes-content" | "overlays-content";
}

/**
 * The viewport of a route or layout (the `viewport` export, or what `generateViewport` returns): the `viewport` meta,
 * the theme color and the color scheme. A layer's values replace the ones above.
 * @since 1.0.0
 */
export interface Viewport extends ViewportFields {
  readonly themeColor?: string | ThemeColorDescriptor | readonly ThemeColorDescriptor[];
  readonly colorScheme?: ColorScheme;
}

/** `<link>` descriptor of the `links` export (React Router style). @since 1.0.0 */
export interface LinkDescriptor {
  readonly rel: string;
  readonly href?: string;
  readonly hrefLang?: string;
  readonly media?: string;
  readonly type?: string;
  readonly sizes?: string;
  readonly as?: string;
  readonly crossOrigin?: "anonymous" | "use-credentials";
  readonly imageSrcSet?: string;
  readonly imageSizes?: string;
  readonly title?: string;
  readonly color?: string;
}

/**
 * One entry of the `meta` export (React Router style): a `title`, a `<meta>` by `name`, `property` or `httpEquiv`
 * or `charSet`, or a `tagName: "link"` with link attributes.
 * @since 1.0.0
 */
export type MetaDescriptor =
  | { readonly title: string }
  | { readonly charSet: "utf-8" }
  | { readonly name: string; readonly content: string }
  | { readonly property: string; readonly content: string }
  | { readonly httpEquiv: string; readonly content: string }
  | ({ readonly tagName: "link"; readonly rel: string; readonly href?: string } & Readonly<
      Record<string, string>
    >);

/** Arguments of `generateMetadata` and `generateViewport`. @since 1.0.0 */
export interface MetadataArgs<P = Readonly<Record<string, string>>, L = unknown> {
  /** Route params of this layer. */
  readonly params: P;
  /** The raw query string as a record (not the validated search). A repeated key is an array. */
  readonly search: Readonly<Record<string, string | readonly string[]>>;
  /** The metadata resolved so far (the layers above this one). */
  readonly parent: Metadata;
  /** The loader data of this layer, when the route has a loader. */
  readonly loaderData: L | undefined;
}

/** Arguments of the `meta` export: the same as `MetadataArgs` without `parent`. @since 1.0.0 */
export interface MetaArgs<P = Readonly<Record<string, string>>, L = unknown> {
  readonly params: P;
  readonly loaderData: L | undefined;
}

/** Arguments of the `headers` export. @since 1.0.0 */
export interface HeadersArgs<P = Readonly<Record<string, string>>, L = unknown> {
  readonly params: P;
  readonly loaderData: L | undefined;
  /** The headers the response already has, from the layers above. */
  readonly parentHeaders: Readonly<Record<string, string>>;
}
