import type { HeadAttributeValue, HeadTag } from "@shadow-js/web";
import { viewportContent } from "./merge";
import type {
  IconDescriptor,
  Icons,
  LinkDescriptor,
  Metadata,
  MetadataUrl,
  OpenGraphImageInput,
  Robots,
  RobotsDirectives,
  ThemeColorDescriptor,
  Viewport,
} from "./types";
import { resolveMetadataUrl, resolvePageUrl, safeHref, type TrailingSlashPolicy } from "./url";

/**
 * Turns merged metadata into the head tags the registry takes (`useHead`, `ServerHead`) and the JSON-LD blocks the
 * document shell writes (scripts are not head tags, so they take their own route with the CSP nonce).
 *
 * Tag identities decide what repeats. Several values of one property (`og:image`, `article:tag`, `twitter:image`,
 * `alternate` links) are kept, one tag each; a single-valued property is last-wins. Sub-properties of an image
 * (`og:image:width` and so on) are written for the first image only, because they share one identity.
 */

/** Everything the tag builder reads. @internal */
export interface HeadInput {
  readonly metadata: Metadata;
  readonly viewport: Viewport;
  readonly links: readonly LinkDescriptor[];
  /** Tags of the `meta` export (React Router style), already in head form. */
  readonly metaTags: readonly HeadTag[];
  /** The `metadataBase`, resolved. */
  readonly base: URL | undefined;
  /** The page's pathname: a `./` canonical is this path (Next's rule). `/` when omitted. */
  readonly pathname?: string | undefined;
  /** The app's trailing-slash policy: a canonical or alternate on the app's origin follows it. `preserve` when omitted. */
  readonly trailingSlash?: TrailingSlashPolicy | undefined;
}

/** The output of the builder. @internal */
export interface HeadOutput {
  readonly tags: HeadTag[];
  readonly jsonLd: string[];
}

/**
 * Largest JSON-LD block written, in characters. Larger values are refused, not truncated.
 *
 * @example
 * MAX_JSON_LD_LENGTH; // 100000
 * @since 1.0.0
 */
export const MAX_JSON_LD_LENGTH = 100_000;

type Props = Record<string, HeadAttributeValue>;

function meta(name: "name" | "property" | "http-equiv", key: string, content: string): HeadTag {
  return { tag: "meta", props: { [name]: key, content } };
}

function link(props: Props): HeadTag {
  return { tag: "link", props };
}

/**
 * Writes a JSON-LD value as safe script text: `<`, `>`, `&` and the line separators become escapes.
 *
 * @param value An object or an array, as JSON-LD requires.
 * @returns The JSON text, safe to put in a script element.
 * @throws TypeError when the value is not an object or an array.
 * @throws RangeError when the text is longer than {@link MAX_JSON_LD_LENGTH}.
 * @example
 * import { jsonLdText } from the "@shadow-js/dusk" subpath;
 * jsonLdText({ "@type": "Organization", name: "Example <beta>" }); // '{"@type":"Organization","name":"Example \u003cbeta\u003e"}'
 * @since 1.0.0
 */
export function jsonLdText(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || typeof value !== "object" || value === null) {
    throw new TypeError(
      __DEV__ ? "jsonLd: a JSON-LD value must be an object or an array." : "DUSK_META_6",
    );
  }
  const text = json.replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (text.length > MAX_JSON_LD_LENGTH) {
    throw new RangeError(
      __DEV__ ? `jsonLd: a block may be at most ${MAX_JSON_LD_LENGTH} characters.` : "DUSK_META_7",
    );
  }
  return text;
}

/**
 * The robots directives as Next.js writes them: `index` or `noindex`, `follow` or `nofollow`, then the other
 * directives in Next's fixed order. A boolean `true` is the bare name; a value is `name:value` (no space); `false` and
 * unset are omitted. Joined with `, `.
 */
function robotsText(directives: RobotsDirectives): string {
  const parts: string[] = [];
  if (directives.index !== undefined) parts.push(directives.index ? "index" : "noindex");
  if (directives.follow !== undefined) parts.push(directives.follow ? "follow" : "nofollow");
  const extras: readonly (readonly [string, unknown])[] = [
    ["noarchive", directives.noarchive],
    ["nosnippet", directives.nosnippet],
    ["noimageindex", directives.noimageindex],
    ["nocache", directives.nocache],
    ["notranslate", directives.notranslate],
    ["indexifembedded", directives.indexifembedded],
    ["nositelinkssearchbox", directives.nositelinkssearchbox],
    ["unavailable_after", directives.unavailable_after],
    ["max-video-preview", directives["max-video-preview"]],
    ["max-image-preview", directives["max-image-preview"]],
    ["max-snippet", directives["max-snippet"]],
  ];
  for (const [name, value] of extras) {
    if (value === undefined || value === false) continue;
    parts.push(typeof value === "boolean" ? name : `${name}:${String(value)}`);
  }
  return parts.join(", ");
}

/** Robots tags: `robots` and, when set, `googlebot`. A string is written as it is. */
function robotsTags(robots: string | Robots | undefined): HeadTag[] {
  if (robots === undefined) return [];
  if (typeof robots === "string") return robots === "" ? [] : [meta("name", "robots", robots)];
  const tags: HeadTag[] = [];
  const main = robotsText(robots);
  if (main !== "") tags.push(meta("name", "robots", main));
  const google = robots.googleBot;
  if (google !== undefined) {
    const text = typeof google === "string" ? google : robotsText(google);
    if (text !== "") tags.push(meta("name", "googlebot", text));
  }
  return tags;
}

/** One icon as a link. `apple` icons are `apple-touch-icon`; `shortcut` is `shortcut icon`. */
function iconLink(rel: string, entry: MetadataUrl | IconDescriptor): HeadTag | undefined {
  const descriptor: IconDescriptor =
    typeof entry === "string" || entry instanceof URL ? { url: entry } : entry;
  // Next writes an icon's address as given (a URL object as its text); `metadataBase` does not apply to icons.
  // The scheme is still checked: an icon address may come from a profile or a row, and `javascript:` has no place in a link.
  const href = safeHref(
    descriptor.url === undefined || descriptor.url === null ? "" : String(descriptor.url),
    { dataImage: true },
  );
  if (href === undefined) return undefined;
  return link({
    rel: descriptor.rel ?? rel,
    href,
    ...optional("type", descriptor.type),
    ...optional("sizes", descriptor.sizes),
    ...optional("media", descriptor.media),
    ...optional("color", descriptor.color),
  });
}

function iconTags(icons: Icons | undefined): HeadTag[] {
  if (icons === undefined) return [];
  const out: (HeadTag | undefined)[] = [];
  if (typeof icons === "string" || icons instanceof URL) {
    out.push(iconLink("icon", icons));
  } else if (Array.isArray(icons)) {
    for (const entry of icons as readonly (MetadataUrl | IconDescriptor)[])
      out.push(iconLink("icon", entry));
  } else {
    const grouped = icons as Exclude<Icons, MetadataUrl | readonly unknown[]>;
    const groups: [
      string,
      MetadataUrl | IconDescriptor | readonly (MetadataUrl | IconDescriptor)[] | undefined,
    ][] = [
      ["icon", grouped.icon],
      ["shortcut icon", grouped.shortcut],
      ["apple-touch-icon", grouped.apple],
    ];
    for (const [rel, value] of groups) {
      if (value === undefined) continue;
      for (const entry of listOf(value)) out.push(iconLink(rel, entry));
    }
    for (const entry of grouped.other ?? []) out.push(iconLink(entry.rel ?? "icon", entry));
  }
  return out.filter((tag): tag is HeadTag => tag !== undefined);
}

/** A list of metadata URLs as links with one rel. */
function urlLinks(
  rel: string,
  value: MetadataUrl | readonly MetadataUrl[] | undefined,
  base: URL | undefined,
): HeadTag[] {
  if (value === undefined) return [];
  const list = typeof value === "string" || value instanceof URL ? [value] : value;
  const out: HeadTag[] = [];
  for (const entry of list) {
    const href = resolveMetadataUrl(entry, base);
    if (href !== undefined) out.push(link({ rel, href }));
  }
  return out;
}

/** Open Graph images, videos and audio: one tag per value, and the sub-properties of the first one. */
function mediaTags(
  kind: "image" | "video" | "audio",
  values: readonly (
    | OpenGraphImageInput
    | {
        readonly url: MetadataUrl;
        readonly secureUrl?: MetadataUrl;
        readonly type?: string;
        readonly width?: number | string;
        readonly height?: number | string;
        readonly alt?: string;
      }
  )[],
  base: URL | undefined,
  property: (suffix: string) => string,
): HeadTag[] {
  const out: HeadTag[] = [];
  values.forEach((entry, index) => {
    const descriptor = typeof entry === "string" || entry instanceof URL ? { url: entry } : entry;
    const url = resolveMetadataUrl(descriptor.url, base);
    if (url === undefined) return;
    out.push(meta("property", property(kind), url));
    if (index > 0) return;
    const d = descriptor as {
      secureUrl?: MetadataUrl;
      type?: string;
      width?: number | string;
      height?: number | string;
      alt?: string;
    };
    const secure = resolveMetadataUrl(d.secureUrl, base);
    if (secure !== undefined) out.push(meta("property", property(`${kind}:secure_url`), secure));
    if (d.type !== undefined) out.push(meta("property", property(`${kind}:type`), d.type));
    if (d.width !== undefined)
      out.push(meta("property", property(`${kind}:width`), String(d.width)));
    if (d.height !== undefined)
      out.push(meta("property", property(`${kind}:height`), String(d.height)));
    if (kind === "image" && d.alt !== undefined)
      out.push(meta("property", property("image:alt"), d.alt));
  });
  return out;
}

/** True when the viewport export set at least one field the `viewport` meta is built from. */
function hasViewportFields(viewport: Viewport): boolean {
  return (
    viewport.width !== undefined ||
    viewport.height !== undefined ||
    viewport.initialScale !== undefined ||
    viewport.minimumScale !== undefined ||
    viewport.maximumScale !== undefined ||
    viewport.userScalable !== undefined ||
    viewport.viewportFit !== undefined ||
    viewport.interactiveWidget !== undefined
  );
}

/** One optional attribute, present only when the value is set (so the spread adds nothing otherwise). */
function optional(name: string, value: string | undefined): Props {
  return value === undefined ? {} : { [name]: value };
}

/** A value or a list of values as a list. */
function listOf<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** The Open Graph block: its type, the generic fields, and the fields of the type. */
function openGraphTags(
  og: NonNullable<Metadata["openGraph"]>,
  base: URL | undefined,
  pathname: string,
  trailingSlash: TrailingSlashPolicy,
): HeadTag[] {
  const out: HeadTag[] = [];
  const add = (property: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") out.push(meta("property", property, value));
  };
  // Next's order: the generic fields, the media, the contacts, the locale alternates, then og:type and the type's tags.
  add("og:determiner", og.determiner);
  add("og:title", og.title);
  add("og:description", og.description);
  add("og:url", resolvePageUrl(og.url, base, pathname, trailingSlash));
  add("og:site_name", og.siteName);
  add("og:locale", og.locale);
  add("og:country_name", og.countryName);
  add("og:ttl", og.ttl === undefined ? undefined : String(og.ttl));
  out.push(...mediaTags("image", listOf(og.images), base, (s) => `og:${s}`));
  out.push(...mediaTags("video", listOf(og.videos), base, (s) => `og:${s}`));
  out.push(...mediaTags("audio", listOf(og.audio), base, (s) => `og:${s}`));
  for (const email of og.emails ?? []) add("og:email", email);
  for (const phone of og.phoneNumbers ?? []) add("og:phone_number", phone);
  for (const fax of og.faxNumbers ?? []) add("og:fax_number", fax);
  for (const alternate of listOf(og.alternateLocale)) add("og:locale:alternate", alternate);
  // Written only when the page sets a type (Next writes no `og:type` otherwise).
  const type = og.type;
  if (type !== undefined) add("og:type", type);
  const typed = og as Record<string, unknown>;
  const field = (key: string): unknown => typed[key];
  const many = (key: string, prefix: string): void => {
    for (const value of listOf(field(key) as string | readonly string[] | undefined))
      add(prefix, value);
  };
  const songs = (key: string, prefix: string): void => {
    for (const entry of listOf(
      field(key) as
        | readonly (MetadataUrl | { url: MetadataUrl; disc?: number; track?: number })[]
        | undefined,
    )) {
      const url = typeof entry === "object" && !(entry instanceof URL) ? entry.url : entry;
      const href = resolveMetadataUrl(url, base);
      if (href === undefined) continue;
      add(prefix, href);
      if (typeof entry === "object" && !(entry instanceof URL)) {
        if (entry.disc !== undefined) add(`${prefix}:disc`, String(entry.disc));
        if (entry.track !== undefined) add(`${prefix}:track`, String(entry.track));
      }
    }
  };
  const people = (key: string, prefix: string): void => {
    for (const entry of listOf(
      field(key) as readonly (MetadataUrl | { profile?: MetadataUrl; role?: string })[] | undefined,
    )) {
      const profile = typeof entry === "object" && !(entry instanceof URL) ? entry.profile : entry;
      const href = resolveMetadataUrl(profile, base);
      if (href !== undefined) add(prefix, href);
      if (typeof entry === "object" && !(entry instanceof URL) && entry.role !== undefined)
        add(`${prefix}:role`, entry.role);
    }
  };
  const urls = (key: string, prefix: string): void => {
    for (const entry of listOf(field(key) as readonly MetadataUrl[] | undefined))
      add(prefix, resolveMetadataUrl(entry, base));
  };
  switch (type) {
    case "article":
      add("article:published_time", field("publishedTime") as string | undefined);
      add("article:modified_time", field("modifiedTime") as string | undefined);
      add("article:expiration_time", field("expirationTime") as string | undefined);
      many("authors", "article:author");
      add("article:section", field("section") as string | undefined);
      many("tags", "article:tag");
      break;
    case "book":
      add("book:isbn", field("isbn") as string | undefined);
      add("book:release_date", field("releaseDate") as string | undefined);
      many("authors", "book:author");
      many("tags", "book:tag");
      break;
    case "profile":
      add("profile:first_name", field("firstName") as string | undefined);
      add("profile:last_name", field("lastName") as string | undefined);
      add("profile:username", field("username") as string | undefined);
      add("profile:gender", field("gender") as string | undefined);
      break;
    case "music.song":
      add(
        "music:duration",
        field("duration") === undefined ? undefined : String(field("duration")),
      );
      songs("album", "music:album");
      many("musicians", "music:musician");
      break;
    case "music.album":
      songs("songs", "music:song");
      many("musicians", "music:musician");
      add("music:release_date", field("releaseDate") as string | undefined);
      break;
    case "music.playlist":
      songs("songs", "music:song");
      many("creators", "music:creator");
      break;
    case "music.radio_station":
      many("creators", "music:creator");
      break;
    case "video.movie":
    case "video.episode":
      people("actors", "video:actor");
      urls("directors", "video:director");
      urls("writers", "video:writer");
      add(
        "video:duration",
        field("duration") === undefined ? undefined : String(field("duration")),
      );
      add("video:release_date", field("releaseDate") as string | undefined);
      many("tags", "video:tag");
      if (type === "video.episode")
        add("video:series", resolveMetadataUrl(field("series") as MetadataUrl | undefined, base));
      break;
    case "video.tv_show":
      people("actors", "video:actor");
      urls("directors", "video:director");
      urls("writers", "video:writer");
      break;
    default:
      break;
  }
  return out;
}

/** The Twitter card. Title and description are written only when set; images as `twitter:image`. */
function twitterTags(tw: NonNullable<Metadata["twitter"]>, base: URL | undefined): HeadTag[] {
  const out: HeadTag[] = [];
  const add = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") out.push(meta("name", name, value));
  };
  // Next's default card: a large image when there is an image, else the summary.
  const card =
    (tw as { card?: string }).card ??
    (listOf(tw.images).length > 0 ? "summary_large_image" : "summary");
  add("twitter:card", card);
  add("twitter:site", tw.site);
  add("twitter:site:id", tw.siteId);
  add("twitter:creator", tw.creator);
  add("twitter:creator:id", tw.creatorId);
  add("twitter:title", tw.title);
  add("twitter:description", tw.description);
  for (const image of listOf(tw.images)) {
    const descriptor = typeof image === "string" || image instanceof URL ? { url: image } : image;
    const url = resolveMetadataUrl(descriptor.url, base);
    if (url === undefined) continue;
    add("twitter:image", url);
    // Next writes an image's own fields after its URL, in this order, for every Twitter image.
    if (typeof image !== "string" && !(image instanceof URL)) {
      add("twitter:image:alt", image.alt);
      add("twitter:image:secure_url", resolveMetadataUrl(image.secureUrl, base));
      add("twitter:image:type", image.type);
      add("twitter:image:width", image.width === undefined ? undefined : String(image.width));
      add("twitter:image:height", image.height === undefined ? undefined : String(image.height));
    }
  }
  if (card === "app" && "app" in tw) {
    const app = tw.app;
    for (const platform of ["iphone", "ipad", "googleplay"] as const) {
      const id = app.id[platform];
      if (id !== undefined) add(`twitter:app:id:${platform}`, String(id));
      const url = app.url?.[platform];
      const href = resolveMetadataUrl(url, base, { customSchemes: true });
      if (href !== undefined) add(`twitter:app:url:${platform}`, href);
    }
    add("twitter:app:name:iphone", app.name);
    add("twitter:app:name:ipad", app.name);
    add("twitter:app:name:googleplay", app.name);
  }
  if (card === "player" && "player" in tw) {
    const first = listOf(tw.player)[0];
    if (first !== undefined) {
      add("twitter:player", resolveMetadataUrl(first.playerUrl, base));
      add("twitter:player:stream", resolveMetadataUrl(first.streamUrl, base));
      if (first.width !== undefined) add("twitter:player:width", String(first.width));
      if (first.height !== undefined) add("twitter:player:height", String(first.height));
    }
  }
  return out;
}

/** The theme colors: `viewport` wins over the deprecated `metadata.themeColor`. */
function themeColorTags(
  value: string | ThemeColorDescriptor | readonly ThemeColorDescriptor[] | undefined,
): HeadTag[] {
  if (value === undefined) return [];
  const list = typeof value === "string" ? [{ color: value }] : listOf(value);
  return list.map((entry) => {
    const descriptor = typeof entry === "string" ? { color: entry } : entry;
    return descriptor.media === undefined
      ? meta("name", "theme-color", descriptor.color)
      : {
          tag: "meta",
          props: { name: "theme-color", media: descriptor.media, content: descriptor.color },
        };
  });
}

/** Every `al:*` app-link tag, for the platforms of {@link AppLinks}. */
function appLinkTags(links: NonNullable<Metadata["appLinks"]>, base: URL | undefined): HeadTag[] {
  const out: HeadTag[] = [];
  const add = (property: string, value: string | number | undefined): void => {
    if (value !== undefined && value !== "") out.push(meta("property", property, String(value)));
  };
  const platforms = [
    "ios",
    "iphone",
    "ipad",
    "windows",
    "windows_phone",
    "windows_universal",
  ] as const;
  for (const platform of platforms) {
    const entry = links[platform];
    if (entry === undefined) continue;
    const prefix = `al:${platform}`;
    add(`${prefix}:url`, resolveMetadataUrl(entry.url, base, { customSchemes: true }));
    if ("app_store_id" in entry) add(`${prefix}:app_store_id`, entry.app_store_id);
    if ("app_id" in entry) add(`${prefix}:app_id`, entry.app_id);
    add(`${prefix}:app_name`, entry.app_name);
  }
  if (links.android !== undefined) {
    add("al:android:package", links.android.package);
    add("al:android:app_name", links.android.app_name);
    add("al:android:url", resolveMetadataUrl(links.android.url, base, { customSchemes: true }));
  }
  if (links.web !== undefined) {
    add("al:web:url", resolveMetadataUrl(links.web.url, base));
    if (links.web.should_fallback !== undefined)
      add("al:web:should_fallback", links.web.should_fallback ? "true" : "false");
  }
  return out;
}

/** Verification tags: one `<meta name>` per code. */
function verificationTags(v: NonNullable<Metadata["verification"]>): HeadTag[] {
  const out: HeadTag[] = [];
  const named: [string, string | readonly string[] | undefined][] = [
    ["google-site-verification", v.google],
    ["y_key", v.yahoo],
    ["yandex-verification", v.yandex],
    ["me", v.me],
  ];
  for (const [name, value] of named)
    for (const code of listOf(value)) out.push(meta("name", name, code));
  for (const [name, value] of Object.entries(v.other ?? {})) {
    for (const code of listOf(value)) out.push(meta("name", name, String(code)));
  }
  return out;
}

/** The `other` escape hatch: one `<meta name>` per value. */
function otherTags(other: NonNullable<Metadata["other"]>): HeadTag[] {
  const out: HeadTag[] = [];
  for (const [name, value] of Object.entries(other)) {
    for (const item of listOf(value)) out.push(meta("name", name, String(item)));
  }
  return out;
}

/** The `links` export as link tags. Attribute names are written in their HTML spelling. */
function linkDescriptorTags(links: readonly LinkDescriptor[]): HeadTag[] {
  const out: HeadTag[] = [];
  for (const descriptor of links) {
    // Attributes keep the order the descriptor lists them in; an href that is not a safe URL drops the link.
    const props: Props = {};
    let dropped = false;
    for (const [key, value] of Object.entries(descriptor)) {
      if (value === undefined) continue;
      if (key === "href") {
        const href = resolveMetadataUrl(String(value), undefined);
        if (href === undefined) dropped = true;
        else Object.assign(props, { href });
        continue;
      }
      const name =
        key === "hrefLang"
          ? "hreflang"
          : key === "crossOrigin"
            ? "crossorigin"
            : key === "imageSrcSet"
              ? "imagesrcset"
              : key === "imageSizes"
                ? "imagesizes"
                : key;
      props[name] = String(value);
    }
    if (!dropped) out.push(link(props));
  }
  return out;
}

/**
 * Builds the head tags and the JSON-LD blocks of one resolved chain.
 *
 * @param input The merged metadata, viewport, `links` and `meta` tags, and the resolved `metadataBase`.
 * @returns The tags in the order the page writes them, and the JSON-LD texts.
 * @throws TypeError or RangeError for a JSON-LD value that cannot be written (see {@link jsonLdText}).
 * @example
 * buildHead({ metadata: { title: "Docs" }, viewport: {}, links: [], metaTags: [], base: undefined });
 * @since 1.0.0
 */
/**
 * The head tags of the merged metadata, in the order Next.js writes them: the viewport block, the title, the basic
 * tags, authors, manifest, the keywords and the rest of the basic tags, robots, the rel lists, alternates, the platform
 * tags (iTunes, Facebook, Pinterest, format detection, verification, Apple web app), Open Graph, Twitter, app links,
 * icons. Open Graph and Twitter inherit the page title and description (and Twitter the Open Graph images) as Next does
 * (`inheritFromMetadata`, `postProcessMetadata`).
 *
 * @param input The merged metadata, viewport, links and tags of a page.
 * @returns The head tags and the JSON-LD texts.
 * @example
 * buildHead({ metadata: { title: "Docs" }, viewport: {}, links: [], metaTags: [], base: undefined }).tags.find((tag) => tag.tag === "title"); // { tag: "title", children: "Docs" }
 * @since 1.0.0
 */
export function buildHead(input: HeadInput): HeadOutput {
  const { metadata: m, viewport, base } = input;
  const pathname = input.pathname ?? "/";
  const policy = input.trailingSlash ?? "preserve";
  const tags: HeadTag[] = [];
  const title = typeof m.title === "string" ? m.title : undefined;
  const description = m.description ?? undefined;
  // The viewport block comes first (Next's viewport elements), then the title.
  tags.push(...themeColorTags(viewport.themeColor ?? m.themeColor));
  const colorScheme = viewport.colorScheme ?? m.colorScheme;
  // The viewport export builds the meta; a string `metadata.viewport` is used only when no viewport export set a field.
  const content = viewportContent(hasViewportFields(viewport) ? viewport : (m.viewport ?? ""));
  if (content !== undefined) tags.push(meta("name", "viewport", content));
  if (colorScheme !== undefined) tags.push(meta("name", "color-scheme", colorScheme));
  if (title !== undefined) tags.push({ tag: "title", children: title });
  if (description !== undefined && description !== null)
    tags.push(meta("name", "description", description));
  if (m.applicationName !== undefined)
    tags.push(meta("name", "application-name", m.applicationName));
  for (const author of listOf(m.authors)) {
    const href = resolveMetadataUrl(author.url, base);
    if (href !== undefined) tags.push(link({ rel: "author", href }));
    if (author.name !== undefined) tags.push(meta("name", "author", author.name));
  }
  if (m.manifest !== undefined) {
    const href = safeHref(String(m.manifest));
    if (href !== undefined) tags.push(link({ rel: "manifest", href }));
  }
  if (m.generator !== undefined) tags.push(meta("name", "generator", m.generator));
  if (m.keywords !== undefined) {
    // Next joins the keywords with a bare comma.
    const keywords = listOf(m.keywords).join(",");
    if (keywords !== "") tags.push(meta("name", "keywords", keywords));
  }
  if (m.referrer !== undefined) tags.push(meta("name", "referrer", m.referrer));
  if (m.creator !== undefined) tags.push(meta("name", "creator", m.creator));
  if (m.publisher !== undefined) tags.push(meta("name", "publisher", m.publisher));
  tags.push(...robotsTags(m.robots));
  tags.push(...urlLinks("archives", m.archives, base));
  tags.push(...urlLinks("assets", m.assets, base));
  tags.push(...urlLinks("bookmarks", m.bookmarks, base));
  if (m.category !== undefined) tags.push(meta("name", "category", m.category));
  if (m.classification !== undefined) tags.push(meta("name", "classification", m.classification));
  if (m.other !== undefined) tags.push(...otherTags(m.other));
  const alternates = m.alternates;
  if (alternates !== undefined) {
    const canonical = resolvePageUrl(alternates.canonical ?? undefined, base, pathname, policy);
    if (canonical !== undefined) tags.push(link({ rel: "canonical", href: canonical }));
    for (const [lang, value] of Object.entries(alternates.languages ?? {})) {
      for (const url of listOf(value)) {
        const href = resolvePageUrl(url, base, pathname, policy);
        if (href !== undefined) tags.push(link({ rel: "alternate", hreflang: lang, href }));
      }
    }
    for (const [media, url] of Object.entries(alternates.media ?? {})) {
      const href = resolvePageUrl(url, base, pathname, policy);
      if (href !== undefined) tags.push(link({ rel: "alternate", media, href }));
    }
    for (const [type, value] of Object.entries(alternates.types ?? {})) {
      for (const url of listOf(value)) {
        const href = resolvePageUrl(url, base, pathname, policy);
        if (href !== undefined) tags.push(link({ rel: "alternate", type, href }));
      }
    }
  }
  if (m.itunes !== undefined) {
    const parts = [`app-id=${m.itunes.appId}`];
    if (m.itunes.appArgument !== undefined) parts.push(`app-argument=${m.itunes.appArgument}`);
    tags.push(meta("name", "apple-itunes-app", parts.join(", ")));
  }
  if (m.facebook !== undefined) {
    if (m.facebook.appId !== undefined) tags.push(meta("property", "fb:app_id", m.facebook.appId));
    for (const admin of m.facebook.admins ?? []) tags.push(meta("property", "fb:admins", admin));
  }
  if (m.pinterest?.richPin !== undefined)
    tags.push(meta("name", "pinterest-rich-pin", m.pinterest.richPin ? "true" : "false"));
  if (m.formatDetection !== undefined) {
    const parts = Object.entries(m.formatDetection)
      .filter(([, on]) => on !== undefined)
      .map(([key, on]) => `${key}=${on ? "yes" : "no"}`);
    if (parts.length > 0) tags.push(meta("name", "format-detection", parts.join(", ")));
  }
  if (m.verification !== undefined) tags.push(...verificationTags(m.verification));
  if (m.appleWebApp !== undefined) tags.push(...appleWebAppTags(m.appleWebApp, base));
  // Open Graph inherits the page's title and description when it does not set them (Next's inheritFromMetadata).
  if (m.openGraph !== undefined) {
    const ogTitle = m.openGraph.title ?? title;
    const ogDescription = m.openGraph.description || description;
    tags.push(
      ...openGraphTags(
        {
          ...m.openGraph,
          ...(ogTitle === undefined ? {} : { title: ogTitle }),
          ...(ogDescription === undefined ? {} : { description: ogDescription }),
        },
        base,
        pathname,
        policy,
      ),
    );
  }
  if (m.twitter !== undefined || m.openGraph !== undefined) {
    tags.push(...twitterTags(twitterFallbacks(m, title, description), base));
  }
  if (m.appLinks !== undefined) tags.push(...appLinkTags(m.appLinks, base));
  tags.push(...linkDescriptorTags(input.links));
  tags.push(...iconTags(m.icons));
  tags.push(...input.metaTags);
  const jsonLd = listOf(m.jsonLd).map((value) => jsonLdText(value));
  return { tags, jsonLd };
}

/**
 * The Twitter block with Next's fallbacks: a missing title, description or images come from the Open Graph block (or the
 * page), and a page with Open Graph and no Twitter block gets one (Next's `postProcessMetadata` and `inheritFromMetadata`).
 * The card defaults to `summary_large_image` when there is an image and to `summary` otherwise, in `twitterTags`.
 */
function twitterFallbacks(
  m: Metadata,
  title: string | undefined,
  description: string | undefined,
): NonNullable<Metadata["twitter"]> {
  const own: NonNullable<Metadata["twitter"]> = m.twitter ?? {};
  const og = m.openGraph;
  const ogTitle = og?.title === undefined || og.title === "" ? undefined : og.title;
  const ogDescription = og?.description || undefined;
  const fallbackTitle = own.title ?? ogTitle ?? title;
  const fallbackDescription = own.description ?? ogDescription ?? description;
  const images = own.images ?? og?.images;
  return {
    ...own,
    ...(fallbackTitle === undefined ? {} : { title: fallbackTitle }),
    ...(fallbackDescription === undefined || fallbackDescription === null
      ? {}
      : { description: fallbackDescription }),
    ...(images === undefined ? {} : { images }),
  };
}

function appleWebAppTags(
  value: NonNullable<Metadata["appleWebApp"]>,
  base: URL | undefined,
): HeadTag[] {
  if (value === true) return [meta("name", "apple-mobile-web-app-capable", "yes")];
  const out: HeadTag[] = [];
  if (value.capable !== undefined)
    out.push(meta("name", "apple-mobile-web-app-capable", value.capable ? "yes" : "no"));
  if (value.title !== undefined) out.push(meta("name", "apple-mobile-web-app-title", value.title));
  if (value.statusBarStyle !== undefined)
    out.push(meta("name", "apple-mobile-web-app-status-bar-style", value.statusBarStyle));
  for (const entry of listOf(value.startupImage)) {
    const descriptor = typeof entry === "string" || entry instanceof URL ? { url: entry } : entry;
    const href = resolveMetadataUrl(descriptor.url, base);
    if (href === undefined) continue;
    out.push(
      link({ rel: "apple-touch-startup-image", href, ...optional("media", descriptor.media) }),
    );
  }
  return out;
}
