import { describe, expect, it } from "vitest";
import {
  MAX_SITEMAP_URLS,
  manifestJson,
  manifestRoute,
  robotsRoute,
  robotsTxt,
  sitemapIndexRoute,
  sitemapIndexXml,
  sitemapRoute,
  sitemapXml,
  xmlEscape,
} from "../../src/server/metadata-routes";
import type { RequestEvent } from "../../src/server/types";

const base = new URL("https://malaf.dev");

/** A request event with only the fields the metadata routes read. */
function eventFor(path: string, method = "GET"): RequestEvent {
  const url = new URL(path, base);
  return { url, method, base: "", trailingSlash: "preserve" } as unknown as RequestEvent;
}

describe("sitemap.xml", () => {
  it("[MD-RTE-01] one url per entry, absolute and escaped, with the optional fields in protocol order", () => {
    const xml = sitemapXml(
      [
        {
          url: "/",
          lastModified: "2026-10-09",
          changeFrequency: "daily",
          priority: 1,
        },
        { url: "https://malaf.dev/a?x=1&y=2", priority: 0.5 },
      ],
      { base },
    );
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
      ),
    ).toBe(true);
    expect(xml).toContain(
      "<url>\n<loc>https://malaf.dev/</loc>\n<lastmod>2026-10-09</lastmod>\n<changefreq>daily</changefreq>\n<priority>1</priority>\n</url>\n",
    );
    expect(xml).toContain("<loc>https://malaf.dev/a?x=1&amp;y=2</loc>");
    expect(xml.endsWith("</urlset>\n")).toBe(true);
  });

  it("[MD-RTE-02] language alternates use the xhtml namespace and are declared only when used", () => {
    const xml = sitemapXml([{ url: "/en", alternates: { languages: { en: "/en", ar: "/ar" } } }], {
      base,
    });
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="ar" href="https://malaf.dev/ar" />',
    );
    expect(sitemapXml([{ url: "/" }], { base })).not.toContain("xmlns:xhtml");
  });

  it("[MD-RTE-03] images and videos use their namespaces; their text is escaped", () => {
    const xml = sitemapXml(
      [
        {
          url: "/gallery",
          images: [
            "/a.png",
            { loc: "/b.png", caption: "B & C", title: "T", license: "https://license.example/" },
          ],
          videos: [
            {
              thumbnailLoc: "/t.jpg",
              title: "Video <1>",
              description: "d",
              contentLoc: "/v.mp4",
              duration: 42.9,
              publicationDate: "2026-01-02",
              familyFriendly: true,
              tags: ["x"],
            },
          ],
        },
      ],
      { base },
    );
    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain(
      "<image:loc>https://malaf.dev/b.png</image:loc>\n<image:caption>B &amp; C</image:caption>\n",
    );
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain("<video:title>Video &lt;1&gt;</video:title>");
    expect(xml).toContain("<video:duration>42</video:duration>");
    expect(xml).toContain("<video:family_friendly>yes</video:family_friendly>");
  });

  it("[MD-RTE-04] values the protocol does not accept are refused with a message", () => {
    expect(() => sitemapXml([{ url: "javascript:alert(1)" }], { base })).toThrow(TypeError);
    expect(() => sitemapXml([{ url: "/", priority: 2 }], { base })).toThrow(RangeError);
    expect(() => sitemapXml([{ url: "/", lastModified: "yesterday" }], { base })).toThrow(
      RangeError,
    );
    expect(() =>
      sitemapXml([{ url: "/", changeFrequency: "sometimes" as never }], { base }),
    ).toThrow(RangeError);
    expect(() => sitemapXml([{ url: "/" }])).toThrow(TypeError);
  });

  it("[MD-RTE-05] a file past the protocol's 50 000 URLs is refused (generateSitemaps splits it)", () => {
    const entries = Array.from({ length: MAX_SITEMAP_URLS + 1 }, (_, index) => ({
      url: `/p${index}`,
    }));
    expect(() => sitemapXml(entries, { base })).toThrow(RangeError);
  });

  it("[MD-RTE-06] the index lists sitemap files, absolute, with their dates", () => {
    const xml = sitemapIndexXml(
      [{ url: "/sitemap/0.xml", lastModified: new Date("2026-10-09T00:00:00Z") }],
      { base },
    );
    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(
      "<sitemap>\n<loc>https://malaf.dev/sitemap/0.xml</loc>\n<lastmod>2026-10-09T00:00:00.000Z</lastmod>\n</sitemap>\n",
    );
    expect(() => sitemapIndexXml([{ url: new URL("ftp://x.example/a") }])).toThrow(TypeError);
  });

  it("[MD-RTE-07] xmlEscape escapes the five XML characters", () => {
    expect(xmlEscape(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;",
    );
  });

  it("[MD-RTE-08] an absolute URL is written as given: a bare origin keeps no trailing slash (Next's <loc>)", () => {
    const xml = sitemapXml([{ url: "https://malaf.dev" }, { url: "https://malaf.dev/docs" }], {
      base,
    });
    expect(xml).toContain("<url>\n<loc>https://malaf.dev</loc>\n</url>\n");
    expect(xml).toContain("<loc>https://malaf.dev/docs</loc>");
    // A relative value still resolves against the base, so "/" becomes the origin with its slash.
    expect(sitemapXml([{ url: "/" }], { base })).toContain("<loc>https://malaf.dev/</loc>");
  });

  it("[MD-RTE-09] the sitemap text is Next's bytes for a plain page list: one element per line, final newline", () => {
    expect(
      sitemapXml(
        [
          {
            url: "https://malaf.dev",
            lastModified: "2026-10-09T19:31:02.744Z",
            changeFrequency: "weekly",
            priority: 1,
          },
        ],
        { base },
      ),
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url>\n<loc>https://malaf.dev</loc>\n<lastmod>2026-10-09T19:31:02.744Z</lastmod>\n<changefreq>weekly</changefreq>\n<priority>1</priority>\n</url>\n</urlset>\n',
    );
  });
});

describe("robots.txt", () => {
  it("[MD-RTE-10] groups in Next's order: User-Agent lines, a blank line per group, then Host, then Sitemap", () => {
    const text = robotsTxt({
      rules: [
        { userAgent: "*", allow: "/", disallow: ["/api/", "/dashboard"], crawlDelay: 5 },
        { userAgent: ["Googlebot", "Bingbot"], disallow: "/private" },
      ],
      sitemap: ["https://malaf.dev/sitemap.xml"],
      host: "malaf.dev",
    });
    expect(text).toBe(
      [
        "User-Agent: *",
        "Allow: /",
        "Disallow: /api/",
        "Disallow: /dashboard",
        "Crawl-delay: 5",
        "",
        "User-Agent: Googlebot",
        "User-Agent: Bingbot",
        "Disallow: /private",
        "",
        "Host: malaf.dev",
        "Sitemap: https://malaf.dev/sitemap.xml",
        "",
      ].join("\n"),
    );
  });

  it("[MD-RTE-11] a line break in a value is refused (no injected directive)", () => {
    expect(() => robotsTxt({ rules: { userAgent: "*", disallow: "/a\nAllow: /secret" } })).toThrow(
      TypeError,
    );
    expect(() => robotsTxt({ rules: [] })).toThrow(TypeError);
    expect(() => robotsTxt({ rules: { userAgent: "*" }, sitemap: "/relative.xml" })).toThrow(
      TypeError,
    );
  });
});

describe("manifest", () => {
  it("[MD-RTE-20] the manifest is JSON with its display mode checked", () => {
    const text = manifestJson({
      name: "Malaf",
      short_name: "Malaf",
      start_url: "/dashboard",
      display: "standalone",
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    });
    expect(JSON.parse(text)).toMatchObject({
      name: "Malaf",
      display: "standalone",
      icons: [{ src: "/icon.svg" }],
    });
    expect(() => manifestJson({ display: "kiosk" as never })).toThrow(RangeError);
  });
});

describe("manifest bytes", () => {
  it("[MD-RTE-21] the manifest is compact JSON with no trailing newline (Next's JSON.stringify)", () => {
    expect(
      manifestJson({
        name: "Malaf",
        short_name: "Malaf",
        description: "A place for everything your agents make.",
        start_url: "/dashboard",
        display: "standalone",
        background_color: "#0b0b0a",
        theme_color: "#0b0b0a",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
          { src: "/apple-icon", sizes: "180x180", type: "image/png" },
        ],
      }),
    ).toBe(
      '{"name":"Malaf","short_name":"Malaf","description":"A place for everything your agents make.","start_url":"/dashboard","display":"standalone","background_color":"#0b0b0a","theme_color":"#0b0b0a","icons":[{"src":"/icon.svg","sizes":"any","type":"image/svg+xml"},{"src":"/apple-icon","sizes":"180x180","type":"image/png"}]}',
    );
  });
});

describe("response options", () => {
  it("[MD-RTE-34] contentType replaces the helper's type (Next writes robots as text/plain, without a charset)", async () => {
    const robots = (await robotsRoute(() => ({ rules: { userAgent: "*", allow: "/" } }), {
      contentType: "text/plain",
    })(eventFor("/robots.txt"))) as Response;
    expect(robots.headers.get("content-type")).toBe("text/plain");
    const sitemap = (await sitemapRoute(() => [{ url: "/" }], {
      contentType: "application/xml",
    })(eventFor("/sitemap.xml"))) as Response;
    expect(sitemap.headers.get("content-type")).toBe("application/xml");
    const manifest = (await manifestRoute(() => ({ name: "Malaf" }))(
      eventFor("/manifest.webmanifest"),
    )) as Response;
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
  });
});

describe("response helpers", () => {
  it("[MD-RTE-30] sitemapRoute answers application/xml with a day of shared caching, absolute to the request origin", async () => {
    const handler = sitemapRoute((event) => [{ url: `${event.url.origin}/` }]);
    const response = (await handler(eventFor("/sitemap.xml"))) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("<loc>https://malaf.dev/</loc>");
  });

  it("[MD-RTE-31] the answer depends on the request: a status host gets its own sitemap (host awareness)", async () => {
    const handler = sitemapRoute((event) =>
      event.url.host === "status.malaf.dev"
        ? [{ url: "https://status.malaf.dev/" }]
        : [{ url: "/docs" }],
    );
    const other = (await handler(eventFor("https://malaf.dev/sitemap.xml"))) as Response;
    expect(await other.text()).toContain("https://malaf.dev/docs");
    const status = (await handler(eventFor("https://status.malaf.dev/sitemap.xml"))) as Response;
    expect(await status.text()).toContain("https://status.malaf.dev/");
  });

  it("[MD-RTE-32] HEAD answers the headers with no body; robots and manifest have their own types", async () => {
    const head = (await sitemapRoute(() => [{ url: "/" }])(
      eventFor("/sitemap.xml", "HEAD"),
    )) as Response;
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const robots = (await robotsRoute(() => ({ rules: { userAgent: "*", allow: "/" } }))(
      eventFor("/robots.txt"),
    )) as Response;
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await robots.text()).toBe("User-Agent: *\nAllow: /\n\n");
    const manifest = (await manifestRoute(() => ({ name: "Malaf" }))(
      eventFor("/manifest.webmanifest"),
    )) as Response;
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
  });

  it("[MD-RTE-33] the index helper serves the sitemap index; a custom cache-control replaces the default", async () => {
    const response = (await sitemapIndexRoute(() => [{ url: "/sitemap/0.xml" }], {
      cacheControl: "no-store",
    })(eventFor("/sitemap-index.xml"))) as Response;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("<sitemapindex");
  });
});
