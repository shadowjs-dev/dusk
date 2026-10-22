import type { HeadTag } from "@shadow-js/web";
import { describe, expect, it } from "vitest";
import { buildHead } from "../../src/metadata/to-head";
import type { Metadata } from "../../src/metadata/types";

/*
 * Output parity with Next.js 16 for the same metadata. The rules are read from Next's own source (the `next` package of
 * the Malaf reference build): `resolvers/resolve-opengraph.js` (`resolveOpenGraph`, `resolveTwitter`),
 * `resolve-metadata.js` (`inheritFromMetadata`, `postProcessMetadata`), `resolvers/resolve-basics.js` (`resolveRobotsValue`)
 * and `metadata.js` (`createMetadataElements`, the order of the tags and the attribute names).
 */

const base = new URL("https://malaf.dev/");

function head(metadata: Metadata): HeadTag[] {
  return buildHead({ metadata, viewport: {}, links: [], metaTags: [], base }).tags;
}

function meta(tags: readonly HeadTag[], key: string): string | undefined {
  const tag = tags.find(
    (item) =>
      item.tag === "meta" && (item.props?.["name"] === key || item.props?.["property"] === key),
  );
  return tag?.props?.["content"] as string | undefined;
}

describe("Open Graph (Next: resolveOpenGraph, createMetadataElements)", () => {
  it("[MDP-1] og:type is written only when the page sets a type (Next writes none otherwise)", () => {
    expect(meta(head({ openGraph: { title: "Docs" } }), "og:type")).toBeUndefined();
    expect(meta(head({ openGraph: { title: "Docs", type: "website" } }), "og:type")).toBe(
      "website",
    );
    expect(meta(head({ openGraph: { title: "Post", type: "article" } }), "og:type")).toBe(
      "article",
    );
  });

  it("[MDP-2] og:title and og:description fall back to the page's title and description only when openGraph is set", () => {
    const withOg = head({ title: "Docs · Malaf", description: "Read it", openGraph: {} });
    expect(meta(withOg, "og:title")).toBe("Docs · Malaf");
    expect(meta(withOg, "og:description")).toBe("Read it");
    // No openGraph object: nothing is inherited, so no og tags at all.
    const without = head({ title: "Docs · Malaf", description: "Read it" });
    expect(meta(without, "og:title")).toBeUndefined();
    expect(meta(without, "og:description")).toBeUndefined();
  });

  it("[MDP-2b] an openGraph title or description the page sets wins over the page's own", () => {
    const tags = head({
      title: "Docs",
      description: "Page",
      openGraph: { title: "Shared title", description: "Shared description" },
    });
    expect(meta(tags, "og:title")).toBe("Shared title");
    expect(meta(tags, "og:description")).toBe("Shared description");
  });
});

describe("Twitter (Next: resolveTwitter, postProcessMetadata)", () => {
  it("[MDP-3] a page with Open Graph and no Twitter block gets a Twitter card inherited from Open Graph", () => {
    const tags = head({
      title: "Docs · Malaf",
      description: "Read it",
      openGraph: { title: "Docs (OG)", description: "OG text" },
    });
    expect(meta(tags, "twitter:card")).toBe("summary");
    expect(meta(tags, "twitter:title")).toBe("Docs (OG)");
    expect(meta(tags, "twitter:description")).toBe("OG text");
  });

  it("[MDP-3b] the Twitter card is summary_large_image when an image is set (from Twitter or Open Graph), summary otherwise", () => {
    const withImage = head({
      openGraph: { images: ["https://malaf.dev/card.png"] },
      title: "Docs",
    });
    expect(meta(withImage, "twitter:card")).toBe("summary_large_image");
    expect(meta(withImage, "twitter:image")).toBe("https://malaf.dev/card.png");
    expect(meta(head({ title: "Docs", twitter: {} }), "twitter:card")).toBe("summary");
  });

  it("[MDP-3c] a Twitter block inherits the page title and description it does not set (Next's inheritFromMetadata)", () => {
    const tags = head({ title: "Docs", description: "Read it", twitter: { card: "summary" } });
    expect(meta(tags, "twitter:title")).toBe("Docs");
    expect(meta(tags, "twitter:description")).toBe("Read it");
  });

  it("[MDP-3d] a Twitter field the page sets is not replaced by the Open Graph fallback", () => {
    const tags = head({
      title: "Docs",
      openGraph: { title: "OG" },
      twitter: { title: "Tweet" },
    });
    expect(meta(tags, "twitter:title")).toBe("Tweet");
  });
});

describe("robots (Next: resolveRobotsValue)", () => {
  it("[MDP-4] the robots directives follow Next's fixed order and value format", () => {
    const tags = head({
      robots: {
        index: true,
        follow: false,
        noarchive: true,
        "max-snippet": -1,
        "max-image-preview": "large",
        "max-video-preview": 5,
        unavailable_after: "2030-01-01",
      },
    });
    expect(meta(tags, "robots")).toBe(
      "index, nofollow, noarchive, unavailable_after:2030-01-01, max-video-preview:5, max-image-preview:large, max-snippet:-1",
    );
  });

  it("[MDP-4b] a googleBot object is its own googlebot tag with the same format", () => {
    const tags = head({
      robots: { index: false, follow: false, googleBot: { index: true, "max-snippet": 10 } },
    });
    expect(meta(tags, "robots")).toBe("noindex, nofollow");
    expect(meta(tags, "googlebot")).toBe("index, max-snippet:10");
  });
});

describe("basic fields and the order of the tags (Next: createMetadataElements)", () => {
  it("[MDP-5] keywords are joined with a bare comma", () => {
    expect(meta(head({ keywords: ["a", "b", "c"] }), "keywords")).toBe("a,b,c");
  });

  it("[MDP-6] authors: the link comes before the meta, per author", () => {
    const tags = head({
      authors: [{ name: "Ada", url: "https://ada.example/" }],
    });
    const link = tags.findIndex((tag) => tag.tag === "link" && tag.props?.["rel"] === "author");
    const name = tags.findIndex((tag) => tag.tag === "meta" && tag.props?.["name"] === "author");
    expect(link).toBeLessThan(name);
  });

  it("[MDP-7] the head is written in Next's order: title, description, basics, robots, alternates, Open Graph, Twitter, icons", () => {
    const tags = head({
      title: "Docs",
      description: "Read it",
      keywords: ["k"],
      robots: { index: true },
      alternates: { canonical: "/docs" },
      openGraph: { title: "Docs", type: "website" },
      twitter: { card: "summary" },
      icons: { icon: "/icon.svg" },
    });
    const order = tags.map((tag) => {
      if (tag.tag === "title") return "title";
      const key = tag.props?.["name"] ?? tag.props?.["property"] ?? tag.props?.["rel"];
      return String(key);
    });
    const position = (key: string): number => order.indexOf(key);
    expect(position("title")).toBe(0);
    expect(position("description")).toBeLessThan(position("keywords"));
    expect(position("keywords")).toBeLessThan(position("robots"));
    expect(position("canonical")).toBeLessThan(position("og:type"));
    expect(position("og:type")).toBeLessThan(position("twitter:card"));
    expect(position("twitter:card")).toBeLessThan(position("icon"));
  });
});

describe("Open Graph tag order (Next: metadata.js, the Open Graph block)", () => {
  it("[MDP-13] the Open Graph tags follow Next's order: the generic fields, the images, videos and audio, the locale alternates, then og:type", () => {
    const tags = head({
      openGraph: {
        type: "website",
        title: "Sign in",
        description: "Read it",
        url: "/sign-in",
        siteName: "Malaf",
        locale: "en_US",
        images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
        alternateLocale: ["ar_AR"],
      },
    });
    const order = tags
      .filter((tag) => tag.tag === "meta" && String(tag.props?.["property"]).startsWith("og:"))
      .map((tag) => tag.props?.["property"]);
    expect(order).toEqual([
      "og:title",
      "og:description",
      "og:url",
      "og:site_name",
      "og:locale",
      "og:image",
      "og:image:width",
      "og:image:height",
      "og:locale:alternate",
      "og:type",
    ]);
  });
});

describe("canonical and URL values (Next: resolveAbsoluteUrlWithPathname)", () => {
  const metaBase = new URL("https://malaf.dev");

  function canonicalOf(metadata: Metadata, pathname: string): string | undefined {
    const tags = buildHead({
      metadata,
      viewport: {},
      links: [],
      metaTags: [],
      base: metaBase,
      pathname,
    }).tags;
    const link = tags.find((tag) => tag.tag === "link" && tag.props?.["rel"] === "canonical");
    return link?.props?.["href"] as string | undefined;
  }

  it("[MDP-10] a canonical './' is the page's own path, so a page inheriting the root's sign-in canonical gets its URL", () => {
    expect(canonicalOf({ alternates: { canonical: "./" } }, "/sign-in")).toBe(
      "https://malaf.dev/sign-in",
    );
    expect(canonicalOf({ alternates: { canonical: "./" } }, "/docs/agent-skill")).toBe(
      "https://malaf.dev/docs/agent-skill",
    );
  });

  it("[MDP-11] a root URL is written without its slash (Next's origin rule), with metadataBase set", () => {
    expect(canonicalOf({ alternates: { canonical: "./" } }, "/")).toBe("https://malaf.dev");
    expect(canonicalOf({ alternates: { canonical: "/" } }, "/sign-in")).toBe("https://malaf.dev");
    expect(canonicalOf({ alternates: { canonical: "/docs" } }, "/")).toBe("https://malaf.dev/docs");
  });

  it("[MDP-12] without metadataBase a relative canonical is written as the path (Next writes it relative)", () => {
    const tags = buildHead({
      metadata: { alternates: { canonical: "./" } },
      viewport: {},
      links: [],
      metaTags: [],
      base: undefined,
      pathname: "/sign-in",
    }).tags;
    expect(tags).toContainEqual({ tag: "link", props: { rel: "canonical", href: "/sign-in" } });
  });
});

describe("Twitter image sub-properties (Next: metadata.js, the Twitter images)", () => {
  it("[MDP-9] each Twitter image writes its alt, secure_url, type, width and height after twitter:image, in Next's order", () => {
    const tags = head({
      twitter: {
        card: "summary_large_image",
        images: [
          {
            url: "/opengraph-image",
            secureUrl: "https://malaf.dev/opengraph-image.png",
            alt: "Malaf",
            type: "image/png",
            width: 1200,
            height: 630,
          },
        ],
      },
    });
    const names = tags
      .filter(
        (tag) => tag.tag === "meta" && String(tag.props?.["name"]).startsWith("twitter:image"),
      )
      .map((tag) => tag.props?.["name"]);
    expect(names).toEqual([
      "twitter:image",
      "twitter:image:alt",
      "twitter:image:secure_url",
      "twitter:image:type",
      "twitter:image:width",
      "twitter:image:height",
    ]);
    expect(meta(tags, "twitter:image")).toBe("https://malaf.dev/opengraph-image");
    expect(meta(tags, "twitter:image:width")).toBe("1200");
    expect(meta(tags, "twitter:image:height")).toBe("630");
    expect(meta(tags, "twitter:image:type")).toBe("image/png");
  });
});

describe("icons and the manifest (Next: resolveIcon, createMetadataElements)", () => {
  it("[MDP-8] an icon and the manifest are written as given: a relative address stays relative", () => {
    const tags = head({
      icons: { icon: "/icon.svg", shortcut: "/fav.ico" },
      manifest: "/manifest.webmanifest",
    });
    expect(tags).toContainEqual({ tag: "link", props: { rel: "icon", href: "/icon.svg" } });
    expect(tags).toContainEqual({ tag: "link", props: { rel: "shortcut icon", href: "/fav.ico" } });
    expect(tags).toContainEqual({
      tag: "link",
      props: { rel: "manifest", href: "/manifest.webmanifest" },
    });
  });
});
