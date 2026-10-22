import type { HeadTag } from "@shadow-js/web";
import { describe, expect, it } from "vitest";
import { buildHead, jsonLdText, MAX_JSON_LD_LENGTH } from "../../src/metadata/to-head";
import type { Metadata, Viewport } from "../../src/metadata/types";

const base = new URL("https://malaf.dev/");

/** Builds the head of one metadata object (no viewport, no links). */
function headOf(
  metadata: Metadata,
  viewport: Viewport = {},
  resolvedBase: URL | undefined = base,
): HeadTag[] {
  return buildHead({ metadata, viewport, links: [], metaTags: [], base: resolvedBase }).tags;
}

/** One attribute of a head tag, read by name (the props are a record). */
function attr(tag: HeadTag | undefined, name: string): unknown {
  return tag?.props?.[name];
}

/** The props of the meta with a given name or property, for compact assertions. */
function metaContent(tags: readonly HeadTag[], key: string): string | undefined {
  const tag = tags.find(
    (item) => item.tag === "meta" && (attr(item, "name") === key || attr(item, "property") === key),
  );
  return attr(tag, "content") as string | undefined;
}

describe("basic fields", () => {
  it("[MD-HEAD-01] title, description, application name, generator, keywords and referrer", () => {
    const tags = headOf({
      title: "Docs",
      description: "How to use it",
      applicationName: "Malaf",
      generator: "Dusk",
      keywords: ["agent", "storage"],
      referrer: "origin-when-cross-origin",
    });
    expect(tags).toContainEqual({ tag: "title", children: "Docs" });
    expect(metaContent(tags, "description")).toBe("How to use it");
    expect(metaContent(tags, "application-name")).toBe("Malaf");
    expect(metaContent(tags, "generator")).toBe("Dusk");
    expect(metaContent(tags, "keywords")).toBe("agent,storage");
    expect(metaContent(tags, "referrer")).toBe("origin-when-cross-origin");
  });

  it("[MD-HEAD-02] authors give an author meta and a link to the profile", () => {
    const tags = headOf({
      authors: [{ name: "Jehaad", url: "https://jehaad.dev" }, { name: "Team" }],
    });
    expect(
      tags
        .filter((tag) => tag.tag === "meta" && attr(tag, "name") === "author")
        .map((tag) => attr(tag, "content")),
    ).toEqual(["Jehaad", "Team"]);
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "author", href: "https://jehaad.dev" },
    });
  });

  it("[MD-HEAD-03] creator, publisher, category, classification and the verification codes", () => {
    const tags = headOf({
      creator: "A",
      publisher: "B",
      category: "technology",
      classification: "tools",
      verification: {
        google: "g1",
        yahoo: "y1",
        yandex: "x1",
        me: "me1",
        other: { "custom-verify": ["c1", "c2"] },
      },
    });
    expect(metaContent(tags, "creator")).toBe("A");
    expect(metaContent(tags, "publisher")).toBe("B");
    expect(metaContent(tags, "category")).toBe("technology");
    expect(metaContent(tags, "classification")).toBe("tools");
    expect(metaContent(tags, "google-site-verification")).toBe("g1");
    expect(metaContent(tags, "y_key")).toBe("y1");
    expect(metaContent(tags, "yandex-verification")).toBe("x1");
    expect(metaContent(tags, "me")).toBe("me1");
    expect(
      tags
        .filter((tag) => attr(tag, "name") === "custom-verify")
        .map((tag) => attr(tag, "content")),
    ).toEqual(["c1", "c2"]);
  });

  it("[MD-HEAD-04] the other field writes one meta per value", () => {
    const tags = headOf({ other: { "msapplication-TileColor": "#000", "x-list": ["a", 2] } });
    expect(metaContent(tags, "msapplication-TileColor")).toBe("#000");
    expect(
      tags.filter((tag) => attr(tag, "name") === "x-list").map((tag) => attr(tag, "content")),
    ).toEqual(["a", "2"]);
  });
});

describe("robots", () => {
  it("[MD-HEAD-10] directives form one robots content string; googleBot is its own meta", () => {
    const tags = headOf({
      robots: {
        index: true,
        follow: false,
        noarchive: true,
        "max-snippet": -1,
        "max-image-preview": "large",
        googleBot: { index: false, "max-video-preview": 5 },
      },
    });
    expect(metaContent(tags, "robots")).toBe(
      // Next's order: max-image-preview comes before max-snippet.
      "index, nofollow, noarchive, max-image-preview:large, max-snippet:-1",
    );
    expect(metaContent(tags, "googlebot")).toBe("noindex, max-video-preview:5");
  });

  it("[MD-HEAD-11] a string robots value is written as it is", () => {
    expect(metaContent(headOf({ robots: "noindex, nofollow" }), "robots")).toBe(
      "noindex, nofollow",
    );
  });
});

describe("alternates, icons and links", () => {
  it("[MD-HEAD-20] canonical is resolved against metadataBase; languages, media and types become alternate links", () => {
    const tags = headOf({
      alternates: {
        canonical: "./docs",
        languages: { en: "/en", "ar-SA": ["/ar"] },
        media: { print: "/print" },
        types: { "application/rss+xml": "/feed.xml" },
      },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "canonical", href: "https://malaf.dev/docs" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "alternate", hreflang: "en", href: "https://malaf.dev/en" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "alternate", hreflang: "ar-SA", href: "https://malaf.dev/ar" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "alternate", media: "print", href: "https://malaf.dev/print" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "alternate", type: "application/rss+xml", href: "https://malaf.dev/feed.xml" },
    });
  });

  it("[MD-HEAD-21] an unsafe canonical is dropped, never written", () => {
    expect(
      headOf({ alternates: { canonical: "javascript:alert(1)" } }).some(
        (tag) => tag.tag === "link",
      ),
    ).toBe(false);
  });

  it("[MD-HEAD-22] icons: a string, a list, and the grouped form with apple and shortcut", () => {
    const tags = headOf({
      icons: {
        icon: [{ url: "/icon.svg", type: "image/svg+xml", sizes: "any" }],
        shortcut: "/fav.ico",
        apple: { url: "/apple-icon", sizes: "180x180", type: "image/png" },
        other: [{ url: "/mask.svg", rel: "mask-icon", color: "#000" }],
      },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: {
        rel: "icon",
        // Next writes an icon's address as given: a relative icon stays relative.
        href: "/icon.svg",
        type: "image/svg+xml",
        sizes: "any",
      },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "shortcut icon", href: "/fav.ico" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: {
        rel: "apple-touch-icon",
        href: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "mask-icon", href: "/mask.svg", color: "#000" },
    });
    expect(headOf({ icons: "/one.png" })).toContainEqual({
      tag: "link",
      props: { rel: "icon", href: "/one.png" },
    });
  });

  it("[MD-HEAD-23] manifest, archives, assets and bookmarks are links", () => {
    const tags = headOf({
      manifest: "/manifest.webmanifest",
      archives: "/archive",
      assets: ["/a1"],
      bookmarks: "/b",
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "manifest", href: "/manifest.webmanifest" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "archives", href: "https://malaf.dev/archive" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "assets", href: "https://malaf.dev/a1" },
    });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "bookmarks", href: "https://malaf.dev/b" },
    });
  });

  it("[MD-HEAD-24] relative values without a metadataBase are written as given", () => {
    const out = buildHead({
      metadata: { alternates: { canonical: "/docs" } },
      viewport: {},
      links: [],
      metaTags: [],
      base: undefined,
    });
    expect(out.tags).toContainEqual({
      tag: "link",
      props: { rel: "canonical", href: "/docs" },
    });
  });
});

describe("Open Graph", () => {
  it("[MD-HEAD-30] the generic fields and the type", () => {
    const tags = headOf({
      openGraph: {
        title: "Malaf",
        description: "Storage",
        url: "/",
        siteName: "Malaf",
        locale: "en_US",
        alternateLocale: ["ar_SA", "fr_FR"],
      },
    });
    // Next writes og:type only when the page sets one (this page does not).
    expect(metaContent(tags, "og:type")).toBeUndefined();
    expect(metaContent(tags, "og:title")).toBe("Malaf");
    // Next writes a root URL without its slash (resolveAbsoluteUrlWithPathname).
    expect(metaContent(tags, "og:url")).toBe("https://malaf.dev");
    expect(metaContent(tags, "og:site_name")).toBe("Malaf");
    expect(metaContent(tags, "og:locale")).toBe("en_US");
    expect(
      tags
        .filter((tag) => attr(tag, "property") === "og:locale:alternate")
        .map((tag) => attr(tag, "content")),
    ).toEqual(["ar_SA", "fr_FR"]);
  });

  it("[MD-HEAD-31] every image is a tag; the sub-properties come from the first image only", () => {
    const tags = headOf({
      openGraph: {
        images: [
          { url: "/one.png", width: 1200, height: 630, alt: "One", type: "image/png" },
          "/two.png",
        ],
      },
    });
    const images = tags
      .filter((tag) => attr(tag, "property") === "og:image")
      .map((tag) => attr(tag, "content"));
    expect(images).toEqual(["https://malaf.dev/one.png", "https://malaf.dev/two.png"]);
    expect(metaContent(tags, "og:image:width")).toBe("1200");
    expect(metaContent(tags, "og:image:height")).toBe("630");
    expect(metaContent(tags, "og:image:alt")).toBe("One");
    expect(metaContent(tags, "og:image:type")).toBe("image/png");
  });

  it("[MD-HEAD-32] article fields and the repeated tags of an article", () => {
    const tags = headOf({
      openGraph: {
        type: "article",
        publishedTime: "2026-01-01T00:00:00Z",
        authors: ["A", "B"],
        section: "Tech",
        tags: ["x", "y"],
      },
    });
    expect(metaContent(tags, "og:type")).toBe("article");
    expect(metaContent(tags, "article:published_time")).toBe("2026-01-01T00:00:00Z");
    expect(metaContent(tags, "article:section")).toBe("Tech");
    expect(
      tags
        .filter((tag) => attr(tag, "property") === "article:tag")
        .map((tag) => attr(tag, "content")),
    ).toEqual(["x", "y"]);
  });

  it("[MD-HEAD-33] the other Open Graph types write their own fields", () => {
    expect(
      metaContent(
        headOf({ openGraph: { type: "profile", username: "jehaad", firstName: "J" } }),
        "profile:username",
      ),
    ).toBe("jehaad");
    expect(
      metaContent(
        headOf({ openGraph: { type: "book", isbn: "123", releaseDate: "2020" } }),
        "book:isbn",
      ),
    ).toBe("123");
    expect(
      metaContent(headOf({ openGraph: { type: "music.song", duration: 120 } }), "music:duration"),
    ).toBe("120");
    expect(
      metaContent(
        headOf({ openGraph: { type: "video.episode", series: "/show", duration: 60 } }),
        "video:series",
      ),
    ).toBe("https://malaf.dev/show");
    expect(
      metaContent(headOf({ openGraph: { type: "video.movie", duration: 90 } }), "video:duration"),
    ).toBe("90");
    expect(metaContent(headOf({ openGraph: { type: "music.playlist" } }), "og:type")).toBe(
      "music.playlist",
    );
    expect(metaContent(headOf({ openGraph: { type: "video.tv_show" } }), "og:type")).toBe(
      "video.tv_show",
    );
    expect(metaContent(headOf({ openGraph: { type: "video.other" } }), "og:type")).toBe(
      "video.other",
    );
  });

  it("[MD-HEAD-34] videos and audio get their own properties", () => {
    const tags = headOf({
      openGraph: {
        videos: [{ url: "/v.mp4", type: "video/mp4", width: 640, height: 360 }],
        audio: "/a.mp3",
      },
    });
    expect(metaContent(tags, "og:video")).toBe("https://malaf.dev/v.mp4");
    expect(metaContent(tags, "og:video:type")).toBe("video/mp4");
    expect(metaContent(tags, "og:audio")).toBe("https://malaf.dev/a.mp3");
  });
});

describe("Twitter", () => {
  it("[MD-HEAD-40] summary card: card, site, creator, title, description and an image", () => {
    const tags = headOf({
      twitter: {
        card: "summary_large_image",
        site: "@malaf",
        creator: "@jehaad",
        title: "T",
        description: "D",
        images: [{ url: "/t.png", alt: "Alt" }],
      },
    });
    expect(metaContent(tags, "twitter:card")).toBe("summary_large_image");
    expect(metaContent(tags, "twitter:site")).toBe("@malaf");
    expect(metaContent(tags, "twitter:creator")).toBe("@jehaad");
    expect(metaContent(tags, "twitter:title")).toBe("T");
    expect(metaContent(tags, "twitter:image")).toBe("https://malaf.dev/t.png");
    expect(metaContent(tags, "twitter:image:alt")).toBe("Alt");
  });

  it("[MD-HEAD-41] app and player cards write their platform and player tags", () => {
    const app = headOf({
      twitter: {
        card: "app",
        app: {
          id: { iphone: 123, googleplay: "com.malaf" },
          name: "Malaf",
          url: { iphone: "malaf://open" },
        },
      },
    });
    expect(metaContent(app, "twitter:app:id:iphone")).toBe("123");
    expect(metaContent(app, "twitter:app:id:googleplay")).toBe("com.malaf");
    expect(metaContent(app, "twitter:app:url:iphone")).toBe("malaf://open");
    const player = headOf({
      twitter: { card: "player", player: { playerUrl: "/play", width: 480, height: 270 } },
    });
    expect(metaContent(player, "twitter:player")).toBe("https://malaf.dev/play");
    expect(metaContent(player, "twitter:player:width")).toBe("480");
  });
});

describe("viewport, theme color and the rest", () => {
  it("[MD-HEAD-50] the viewport export builds the viewport meta; theme color and color scheme follow it", () => {
    const tags = headOf(
      {},
      { width: "device-width", initialScale: 1, themeColor: "#0b0b0a", colorScheme: "dark" },
    );
    expect(metaContent(tags, "viewport")).toBe("width=device-width, initial-scale=1");
    expect(metaContent(tags, "theme-color")).toBe("#0b0b0a");
    expect(metaContent(tags, "color-scheme")).toBe("dark");
  });

  it("[MD-HEAD-51] a theme color with media writes the media attribute", () => {
    const tags = headOf(
      {},
      { themeColor: [{ color: "#fff", media: "(prefers-color-scheme: light)" }] },
    );
    expect(tags).toContainEqual({
      tag: "meta",
      props: { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#fff" },
    });
  });

  it("[MD-HEAD-52] the apple web app, format detection, itunes, facebook, pinterest and app links", () => {
    const tags = headOf({
      appleWebApp: {
        capable: true,
        title: "Malaf",
        statusBarStyle: "black-translucent",
        startupImage: "/splash.png",
      },
      formatDetection: { telephone: false, email: false },
      itunes: { appId: "123", appArgument: "/x" },
      facebook: { appId: "fb1", admins: ["a1"] },
      pinterest: { richPin: false },
      appLinks: {
        ios: { url: "malaf://ios", app_store_id: 1 },
        android: { package: "com.malaf", app_name: "Malaf" },
        web: { url: "/web", should_fallback: true },
      },
    });
    expect(metaContent(tags, "apple-mobile-web-app-capable")).toBe("yes");
    expect(metaContent(tags, "apple-mobile-web-app-title")).toBe("Malaf");
    expect(metaContent(tags, "apple-mobile-web-app-status-bar-style")).toBe("black-translucent");
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "apple-touch-startup-image", href: "https://malaf.dev/splash.png" },
    });
    expect(metaContent(tags, "format-detection")).toBe("telephone=no, email=no");
    expect(metaContent(tags, "apple-itunes-app")).toBe("app-id=123, app-argument=/x");
    expect(metaContent(tags, "fb:app_id")).toBe("fb1");
    expect(metaContent(tags, "fb:admins")).toBe("a1");
    expect(metaContent(tags, "pinterest-rich-pin")).toBe("false");
    expect(metaContent(tags, "al:ios:url")).toBe("malaf://ios");
    expect(metaContent(tags, "al:ios:app_store_id")).toBe("1");
    expect(metaContent(tags, "al:android:package")).toBe("com.malaf");
    expect(metaContent(tags, "al:web:url")).toBe("https://malaf.dev/web");
    expect(metaContent(tags, "al:web:should_fallback")).toBe("true");
  });
});

describe("JSON-LD", () => {
  it("[MD-HEAD-70] a JSON-LD value is written with <, >, & and the line separators escaped", () => {
    const text = jsonLdText({
      "@type": "Thing",
      name: "</script><script>alert(1)</script> & \u2028\u2029",
    });
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual({
      "@type": "Thing",
      name: "</script><script>alert(1)</script> & \u2028\u2029",
    });
  });

  it("[MD-HEAD-71] each jsonLd value becomes one block, and the block is not a head tag", () => {
    const out = buildHead({
      metadata: { jsonLd: [{ "@type": "A" }, { "@type": "B" }] },
      viewport: {},
      links: [],
      metaTags: [],
      base: undefined,
    });
    expect(out.jsonLd).toHaveLength(2);
    expect(out.tags.some((tag) => tag.tag === ("script" as HeadTag["tag"]))).toBe(false);
  });

  it("[MD-HEAD-72] a value that cannot be written as an object is refused", () => {
    expect(() => jsonLdText("text")).toThrow(TypeError);
    expect(() => jsonLdText(undefined)).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    Reflect.set(cyclic, "self", cyclic);
    expect(() => jsonLdText(cyclic)).toThrow();
  });

  it("[MD-HEAD-73] a block past the size bound is refused, not truncated", () => {
    expect(() => jsonLdText({ text: "x".repeat(MAX_JSON_LD_LENGTH) })).toThrow(RangeError);
  });
});
