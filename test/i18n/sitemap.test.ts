import { createLocaleRouting } from "@shadow-js/i18n";
import { describe, expect, it } from "vitest";
import { localizedSitemap } from "../../src/i18n/server";
import { MAX_SITEMAP_URLS, sitemapRoute, sitemapXml } from "../../src/server/metadata-routes";
import type { RequestEvent } from "../../src/server/types";

const routing = createLocaleRouting({ locales: ["en", "fr", "pt-BR"], defaultLocale: "en" });
const base = new URL("https://example.com/");

/** The `<url>` blocks of a sitemap. */
function urlsOf(xml: string): string[] {
  return xml.split("<url>\n").slice(1);
}

describe("sitemap alternates with locale routing", () => {
  it("[I18N-540] each app path is listed once per locale, every copy with the whole set of alternates and x-default", () => {
    const xml = sitemapXml([{ url: "/about", changeFrequency: "weekly" }], {
      base,
      localize: localizedSitemap(routing),
    });
    const links =
      '<xhtml:link rel="alternate" hreflang="en" href="https://example.com/about" />\n' +
      '<xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/about" />\n' +
      '<xhtml:link rel="alternate" hreflang="pt-BR" href="https://example.com/pt-BR/about" />\n' +
      '<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about" />\n';
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
        `<url>\n<loc>https://example.com/about</loc>\n<changefreq>weekly</changefreq>\n${links}</url>\n` +
        `<url>\n<loc>https://example.com/fr/about</loc>\n<changefreq>weekly</changefreq>\n${links}</url>\n` +
        `<url>\n<loc>https://example.com/pt-BR/about</loc>\n<changefreq>weekly</changefreq>\n${links}</url>\n` +
        "</urlset>\n",
    );
  });

  it("[I18N-541] without the option the output is the helper's own, byte for byte", () => {
    const entries = [{ url: "/about" }, { url: "https://example.com/fr/x" }];
    expect(sitemapXml(entries, { base })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        "<url>\n<loc>https://example.com/about</loc>\n</url>\n" +
        "<url>\n<loc>https://example.com/fr/x</loc>\n</url>\n" +
        "</urlset>\n",
    );
  });

  it("[I18N-542] explicit alternates, other origins and already localized paths are kept as written", () => {
    const xml = sitemapXml(
      [
        { url: "/fr/contact" },
        { url: "https://other.example/about" },
        { url: "/legal", alternates: { languages: { de: "/de/legal" } } },
      ],
      { base, localize: localizedSitemap(routing) },
    );
    const urls = urlsOf(xml);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe("<loc>https://example.com/fr/contact</loc>\n</url>\n");
    expect(urls[1]).toBe("<loc>https://other.example/about</loc>\n</url>\n");
    expect(urls[2]).toContain('hreflang="de" href="https://example.com/de/legal"');
    expect(urls[2]).not.toContain('hreflang="fr"');
    // A value that is not an http(s) URL is passed on, and the sitemap refuses it as it always does.
    expect(() =>
      sitemapXml([{ url: "javascript:alert(1)" }], { base, localize: localizedSitemap(routing) }),
    ).toThrow(/must be an absolute http\(s\) URL/);
    // A URL parser would drop the line break or read `https:host` as a host: such text is refused, never localized.
    expect(() =>
      sitemapXml([{ url: "/ab\nout" }], { base, localize: localizedSitemap(routing) }),
    ).toThrow(/must not contain control characters/);
    expect(() =>
      sitemapXml([{ url: "https:example.com/about" }], { localize: localizedSitemap(routing) }),
    ).toThrow(/must be written with "\/\/" after the scheme/);
  });

  it("[I18N-543] the mount point, the trailing-slash policy and the query are kept; the URL limit counts every copy", () => {
    // Relative entries resolve under the mount point (`docs` is `/app/docs`).
    const mounted = sitemapXml([{ url: "./" }, { url: "docs?v=2" }], {
      base: new URL("https://example.com/app/"),
      trailingSlash: "always",
      localize: localizedSitemap(routing),
    });
    const urls = urlsOf(mounted);
    expect(urls).toHaveLength(6);
    expect(urls[0]).toContain("<loc>https://example.com/app/</loc>");
    expect(urls[1]).toContain("<loc>https://example.com/app/fr/</loc>");
    expect(urls[1]).toContain('hreflang="en" href="https://example.com/app/"');
    expect(urls[4]).toContain("<loc>https://example.com/app/fr/docs/?v=2</loc>");
    expect(urls[4]).toContain('hreflang="pt-BR" href="https://example.com/app/pt-BR/docs/?v=2"');
    // A path outside the mount point is not the app's: it is kept.
    expect(
      urlsOf(
        sitemapXml([{ url: "https://example.com/elsewhere" }], {
          base: new URL("https://example.com/app/"),
          localize: localizedSitemap(routing),
        }),
      ),
    ).toHaveLength(1);

    const many = Array.from({ length: Math.floor(MAX_SITEMAP_URLS / 3) + 1 }, (_, index) => ({
      url: `/p${index}`,
    }));
    expect(() => sitemapXml(many, { base, localize: localizedSitemap(routing) })).toThrow(
      /a sitemap holds at most 50000 URLs/,
    );
  });

  it("[I18N-544] sitemapRoute passes the option on, with the request's origin and mount point", async () => {
    const handler = sitemapRoute(() => [{ url: "about" }], { localize: localizedSitemap(routing) });
    const event = {
      url: new URL("https://example.com/app/sitemap.xml"),
      base: "/app",
      trailingSlash: "never",
      method: "GET",
    } as unknown as RequestEvent;
    const response = (await handler(event)) as Response;
    const xml = await response.text();
    expect(urlsOf(xml)).toHaveLength(3);
    expect(xml).toContain("<loc>https://example.com/app/fr/about</loc>");
    expect(xml).toContain('hreflang="x-default" href="https://example.com/app/about"');
  });
});
