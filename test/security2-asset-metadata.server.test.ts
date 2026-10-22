import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { metaDescriptorTags } from "../src/metadata/resolve";
import { buildHead, jsonLdText, MAX_JSON_LD_LENGTH } from "../src/metadata/to-head";
import { resolveMetadataUrl } from "../src/metadata/url";
import {
  MAX_SITEMAP_IMAGES,
  MAX_SITEMAP_URLS,
  manifestJson,
  robotsTxt,
  sitemapIndexXml,
  sitemapXml,
  xmlEscape,
} from "../src/server/metadata-routes";

/**
 * PASS 2 audit, area ASSET (metadata routes and head tags): what a title, a URL or a path that came from a request
 * or a database row can do to `sitemap.xml`, `robots.txt`, `manifest.webmanifest` and the head tags. Ids are SEC2-ASSET-nn.
 */

const SEED = 20_261_010;
const base = new URL("https://malaf.dev/");

/**
 * A small well-formedness check for the documents this module writes: after the tags are removed, text holds no `<`,
 * no `]]>` and no `&` that is not one of the five entities; and no character XML 1.0 forbids appears anywhere.
 */
function assertWellFormed(xml: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
  expect(forbidden.test(xml)).toBe(false);
  // Lone surrogates are not XML characters either.
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(xml)).toBe(
    false,
  );
  const withoutTags = xml.replace(/<\?xml[^>]*\?>/g, "").replace(/<[^<>]*>/g, "");
  expect(withoutTags).not.toContain("<");
  expect(withoutTags).not.toContain("]]>");
  expect(/&(?!(?:amp|lt|gt|quot|apos);)/.test(xml)).toBe(false);
  // No attribute value holds a raw quote or `<`: every tag is `<name attr="x" ... >` with escaped values.
  for (const tag of xml.matchAll(/<[a-z][^<>]*>/gi)) {
    const values = [...tag[0].matchAll(/="([^"]*)"/g)].map((m) => m[1] ?? "");
    for (const value of values) expect(value).not.toMatch(/[<"]/);
  }
}

describe("SEC2-ASSET sitemap: escaping", () => {
  const nasty = [
    `</loc><loc>https://evil.example/</loc>`,
    `]]><![CDATA[<script>alert(1)</script>`,
    `a & b < c > d " e ' f`,
    `&amp;&lt;&#x3C;&#60;`,
    `<!-- x --><?pi y?>`,
  ];

  it("[SEC2-ASSET-70] a URL, title, caption, description and tag are escaped wherever they land", () => {
    for (const text of nasty) {
      const xml = sitemapXml(
        [
          {
            url: `https://malaf.dev/?q=${encodeURIComponent("x")}&t=${text}`,
            alternates: { languages: { [`en"${text}`]: `https://malaf.dev/en?x=${text}` } },
            images: [
              {
                loc: `https://malaf.dev/i.png?${text}`,
                caption: text,
                title: text,
                license: `https://l.example/?${text}`,
              },
            ],
            videos: [
              {
                thumbnailLoc: `https://malaf.dev/t.png?${text}`,
                title: text,
                description: text,
                contentLoc: `https://malaf.dev/v.mp4?${text}`,
                playerLoc: `https://malaf.dev/p?${text}`,
                tags: [text],
              },
            ],
          },
        ],
        { base },
      );
      assertWellFormed(xml);
      // The injected element never appears as markup.
      expect(xml).not.toContain("<script");
      expect(xml.match(/<loc>/g)).toHaveLength(1);
    }
    assertWellFormed(
      sitemapIndexXml([{ url: `https://malaf.dev/s.xml?${nasty.join("")}` }], { base }),
    );
  });

  it("[SEC2-ASSET-71] characters XML 1.0 forbids (NUL, C0 controls, U+FFFE, lone surrogates) never reach the file", () => {
    const bad = "a\u0000b\u0001c\u000bd\u000ce\u001ff\ufffeg\uffffh\ud800i\udc00j";
    const xml = sitemapXml(
      [
        {
          url: "https://malaf.dev/",
          images: [{ loc: "https://malaf.dev/i.png", caption: bad, title: bad }],
          videos: [
            { thumbnailLoc: "https://malaf.dev/t.png", title: bad, description: bad, tags: [bad] },
          ],
          alternates: { languages: { [bad]: "https://malaf.dev/x" } },
        },
      ],
      { base },
    );
    assertWellFormed(xml);
    expect(xml).toContain("abcdefghij");
    expect(xmlEscape(bad)).toBe("abcdefghij");
    // Tab, newline and carriage return are allowed in XML text and are kept.
    expect(xmlEscape("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    // Astral characters are pairs, and a valid pair stays whole.
    expect(xmlEscape("😀")).toBe("😀");
  });

  it("[SEC2-ASSET-72] fuzz: for any string in any text slot the document stays well formed and holds one url per entry", () => {
    return fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), (text) => {
        const xml = sitemapXml(
          [
            {
              url: "https://malaf.dev/a",
              images: [{ loc: "https://malaf.dev/i.png", caption: text, title: text }],
              videos: [
                {
                  thumbnailLoc: "https://malaf.dev/t.png",
                  title: text,
                  description: text,
                  tags: [text],
                },
              ],
              alternates: { languages: { [text === "" ? "x" : text]: "https://malaf.dev/b" } },
            },
          ],
          { base },
        );
        assertWellFormed(xml);
        expect(xml.match(/<url>/g)).toHaveLength(1);
        expect(xml.match(/<loc>/g)).toHaveLength(1);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});

describe("SEC2-ASSET sitemap: URLs", () => {
  it("[SEC2-ASSET-73] only http(s) URLs: javascript:, data:, vbscript:, file:, blob:, ftp: and mixed case are refused everywhere", () => {
    const bad = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://malaf.dev/uuid",
      "ftp://malaf.dev/x",
    ];
    for (const value of bad) {
      expect(() => sitemapXml([{ url: value }], { base }), value).toThrow(TypeError);
      expect(() => sitemapXml([{ url: "/", images: [value] }], { base }), value).toThrow(TypeError);
      expect(
        () =>
          sitemapXml(
            [
              {
                url: "/",
                videos: [{ thumbnailLoc: value, title: "t", description: "d" }],
              },
            ],
            { base },
          ),
        value,
      ).toThrow(TypeError);
      expect(
        () => sitemapXml([{ url: "/", alternates: { languages: { en: value } } }], { base }),
        value,
      ).toThrow(TypeError);
      expect(() => sitemapIndexXml([{ url: value }], { base }), value).toThrow(TypeError);
      expect(() => robotsTxt({ rules: { userAgent: "*" }, sitemap: value }), value).toThrow(
        TypeError,
      );
    }
  });

  it("[SEC2-ASSET-74] a relative value resolves on the base's own origin; a protocol-relative or backslash one is refused", () => {
    for (const value of [
      "//evil.example/x",
      "///evil.example/x",
      "/\\evil.example/x",
      "\\\\evil.example/x",
      "/\t/evil.example/x",
      " //evil.example/x",
    ]) {
      expect(() => sitemapXml([{ url: value }], { base }), JSON.stringify(value)).toThrow(
        TypeError,
      );
      expect(() => sitemapXml([{ url: "/", images: [value] }], { base })).toThrow(TypeError);
    }
    const xml = sitemapXml([{ url: "about" }, { url: "/team?x=1" }], { base });
    expect(xml).toContain("<loc>https://malaf.dev/about</loc>");
    expect(xml).toContain("<loc>https://malaf.dev/team?x=1</loc>");
  });

  it("[SEC2-ASSET-75] a URL with a control character, a line break or surrounding white space is refused, not written as given", () => {
    for (const value of [
      "https://malaf.dev/a\nb",
      "https://malaf.dev/a\tb",
      "https://malaf.dev/a\u0000b",
      " https://malaf.dev/a",
      "https://malaf.dev/a ",
      "https://malaf.dev/\r\n</loc><loc>https://evil.example/",
      "https:evil.example",
      "http:/evil.example",
    ]) {
      expect(() => sitemapXml([{ url: value }], { base }), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
  });

  it("[SEC2-ASSET-76] a URL object is written as its href, so it cannot carry anything its text did not", () => {
    const xml = sitemapXml([{ url: new URL("https://malaf.dev/a b?x=<y>&z=1") }], { base });
    assertWellFormed(xml);
    expect(xml).toContain("<loc>https://malaf.dev/a%20b?x=%3Cy%3E&amp;z=1</loc>");
  });

  it("[SEC2-ASSET-77] a video duration is a whole number of seconds; NaN, Infinity and negatives are refused", () => {
    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1e12]) {
      expect(
        () =>
          sitemapXml(
            [
              {
                url: "/",
                videos: [{ thumbnailLoc: "/t.png", title: "t", description: "d", duration }],
              },
            ],
            { base },
          ),
        String(duration),
      ).toThrow(RangeError);
    }
    expect(
      sitemapXml(
        [
          {
            url: "/",
            videos: [{ thumbnailLoc: "/t.png", title: "t", description: "d", duration: 90.7 }],
          },
        ],
        { base },
      ),
    ).toContain("<video:duration>90</video:duration>");
  });
});

describe("SEC2-ASSET sitemap: bounds", () => {
  it("[SEC2-ASSET-78] the documented maximum is 50 000 URLs per file, for a sitemap and for an index", () => {
    expect(MAX_SITEMAP_URLS).toBe(50_000);
    const entries = Array.from({ length: MAX_SITEMAP_URLS + 1 }, (_, index) => ({
      url: `https://malaf.dev/${index}`,
    }));
    expect(() => sitemapXml(entries, { base })).toThrow(RangeError);
    expect(() => sitemapIndexXml(entries, { base })).toThrow(RangeError);
    expect(sitemapXml(entries.slice(0, MAX_SITEMAP_URLS), { base }).match(/<url>/g)).toHaveLength(
      MAX_SITEMAP_URLS,
    );
  });

  it("[SEC2-ASSET-79] the byte limit counts UTF-8 bytes, not UTF-16 units, and stops the build early", () => {
    // 3 bytes per character in UTF-8, 1 code unit in UTF-16: under a character count the file is half the size.
    const caption = "€".repeat(1000);
    let visited = 0;
    const entries = Array.from({ length: 200 }, (_, index) => ({
      url: `https://malaf.dev/${index}`,
      get images() {
        visited += 1;
        return [{ loc: "https://malaf.dev/i.png", caption }];
      },
    }));
    expect(() => sitemapXml(entries, { base, maxBytes: 250_000 })).toThrow(RangeError);
    // 250 000 bytes hold about 80 captions of 3 000 bytes: the build stopped there, not after all 200 entries.
    expect(visited).toBeLessThan(120);
    expect(() =>
      sitemapIndexXml(
        entries.map((entry) => ({ url: entry.url })),
        { base, maxBytes: 4000 },
      ),
    ).toThrow(RangeError);
  });

  it("[SEC2-ASSET-80] per-entry lists are bounded: images, video tags, alternates and one text value", () => {
    const tooManyImages = Array.from(
      { length: MAX_SITEMAP_IMAGES + 1 },
      (_, index) => `/i${index}.png`,
    );
    expect(() => sitemapXml([{ url: "/", images: tooManyImages }], { base })).toThrow(RangeError);
    expect(() =>
      sitemapXml(
        [
          {
            url: "/",
            videos: [
              {
                thumbnailLoc: "/t.png",
                title: "t",
                description: "d",
                tags: Array.from({ length: 33 }, (_, index) => `t${index}`),
              },
            ],
          },
        ],
        { base },
      ),
    ).toThrow(RangeError);
    const languages = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [`l${index}`, `/l${index}`]),
    );
    expect(() => sitemapXml([{ url: "/", alternates: { languages } }], { base })).toThrow(
      RangeError,
    );
    expect(() =>
      sitemapXml([{ url: "/", images: [{ loc: "/i.png", caption: "x".repeat(10_000) }] }], {
        base,
      }),
    ).toThrow(RangeError);
  });
});

describe("SEC2-ASSET robots.txt", () => {
  const breaks = ["\n", "\r", "\r\n", "\u0085", "\u2028", "\u2029", "\u0000", "\u000b", "\u000c"];

  it("[SEC2-ASSET-81] a line break (any kind) in any value is refused, so no directive can be injected", () => {
    for (const lineBreak of breaks) {
      const inject = `/ok${lineBreak}Disallow: /`;
      const cases = [
        { rules: { userAgent: `*${lineBreak}Allow: /secret` } },
        { rules: { userAgent: "*", allow: inject } },
        { rules: { userAgent: "*", disallow: [inject] } },
        { rules: { userAgent: ["a", `b${lineBreak}User-Agent: evil`] } },
        {
          rules: { userAgent: "*" },
          host: `malaf.dev${lineBreak}Sitemap: https://evil.example/s.xml`,
        },
        {
          rules: { userAgent: "*" },
          sitemap: `https://malaf.dev/s.xml${lineBreak}Sitemap: https://evil.example/s.xml`,
        },
      ];
      for (const config of cases) {
        expect(() => robotsTxt(config), JSON.stringify(lineBreak)).toThrow(TypeError);
      }
    }
  });

  it("[SEC2-ASSET-82] an empty user agent, a non-string value and a bad crawl delay are refused", () => {
    expect(() => robotsTxt({ rules: { userAgent: "" } })).toThrow(TypeError);
    expect(() => robotsTxt({ rules: { userAgent: [] } })).toThrow(TypeError);
    expect(() => robotsTxt({ rules: { userAgent: 5 as never } })).toThrow(TypeError);
    expect(() => robotsTxt({ rules: { userAgent: "*", disallow: [{} as never] } })).toThrow(
      TypeError,
    );
    for (const crawlDelay of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => robotsTxt({ rules: { userAgent: "*", crawlDelay } })).toThrow(RangeError);
    }
  });

  it("[SEC2-ASSET-83] fuzz: an accepted file has exactly the lines the configuration asked for", () => {
    const value = fc.string({ unit: "binary", maxLength: 24 });
    return fc.assert(
      fc.property(
        value,
        fc.array(value, { maxLength: 4 }),
        fc.array(value, { maxLength: 4 }),
        (agent, allow, disallow) => {
          let text: string;
          try {
            text = robotsTxt({ rules: { userAgent: agent, allow, disallow } });
          } catch (error) {
            expect(error).toBeInstanceOf(TypeError);
            return;
          }
          const lines = text.split("\n");
          // Every non-empty line is one of the directives written from the configuration, and their count matches.
          const directives = lines.filter((line) => line !== "");
          expect(directives).toHaveLength(1 + allow.length + disallow.length);
          expect(directives.filter((line) => line.startsWith("User-Agent: "))).toHaveLength(1);
          expect(directives.filter((line) => line.startsWith("Allow: "))).toHaveLength(
            allow.length,
          );
          expect(directives.filter((line) => line.startsWith("Disallow: "))).toHaveLength(
            disallow.length,
          );
          expect(
            ["\r", "\u0085", "\u2028", "\u2029", "\u0000", "\u000b", "\u000c"].some((char) =>
              text.includes(char),
            ),
          ).toBe(false);
        },
      ),
      { seed: SEED, numRuns: 400 },
    );
  });
});

describe("SEC2-ASSET manifest", () => {
  it("[SEC2-ASSET-84] the JSON text has no raw <, >, &, U+2028 or U+2029, and parses back to the same value", () => {
    const value = {
      name: `</script><script>alert(1)</script> "quoted" \\ back \u2028 \u2029 & <!-- -->`,
      short_name: "a\u0000b",
      description: "x".repeat(10),
    };
    const text = manifestJson(value);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual(value);
  });

  it("[SEC2-ASSET-85] a lone surrogate is written as an escape, never as a raw character", () => {
    const text = manifestJson({ name: "a\ud800b" });
    expect(text).toContain("\\ud800");
    expect(JSON.parse(text)).toEqual({ name: "a\ud800b" });
  });

  it("[SEC2-ASSET-86] URLs in start_url, scope, id, icons, shortcuts, screenshots and related apps are http(s) or relative", () => {
    const bad = [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "vbscript:x",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "//evil.example/x",
      "/\\evil.example/x",
      " /x",
      "/x\n",
    ];
    for (const value of bad) {
      const manifests = [
        { start_url: value },
        { scope: value },
        { id: value },
        { icons: [{ src: value }] },
        { shortcuts: [{ name: "n", url: value }] },
        { shortcuts: [{ name: "n", url: "/", icons: [{ src: value }] }] },
        { screenshots: [{ src: value }] },
        { related_applications: [{ platform: "play", url: value }] },
        { share_target: { action: value } },
        { protocol_handlers: [{ protocol: "web+x", url: value }] },
      ];
      for (const manifest of manifests) {
        expect(() => manifestJson(manifest as never), `${JSON.stringify(manifest)}`).toThrow(
          TypeError,
        );
      }
    }
  });

  it("[SEC2-ASSET-87] ordinary manifests are untouched: relative, absolute and data:image icons", () => {
    const manifest = {
      name: "Malaf",
      start_url: "/?source=pwa",
      scope: "/",
      id: "/app",
      display: "standalone" as const,
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "https://cdn.malaf.dev/icon.png" },
        { src: "data:image/png;base64,AAAA" },
      ],
      related_applications: [
        {
          platform: "play",
          id: "dev.malaf.app",
          url: "https://play.google.com/store/apps/details?id=dev.malaf.app",
        },
      ],
    };
    expect(JSON.parse(manifestJson(manifest))).toEqual(manifest);
    // A data: URI is for icons and screenshots only.
    expect(() => manifestJson({ start_url: "data:image/png;base64,AAAA" })).toThrow(TypeError);
  });
});

describe("SEC2-ASSET head tags: metadata URLs", () => {
  const urls = [
    " javascript:alert(1)",
    "javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\nscript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    " //evil.example/x",
    "//evil.example/x",
    "/\\evil.example/x",
    "\\evil.example/x",
    "\\\\evil.example/x",
    " https://malaf.dev/x",
    "https://malaf.dev/x ",
    "https:evil.example",
    "http:evil.example",
    "https:/evil.example",
    "https:\\\\evil.example",
    "http:\\evil.example",
  ];

  it("[SEC2-ASSET-90] a script scheme, a protocol-relative or backslash host and a non-hierarchical http URL are dropped, with and without a base", () => {
    for (const value of urls) {
      expect(resolveMetadataUrl(value, base), JSON.stringify(value)).toBeUndefined();
      expect(resolveMetadataUrl(value, undefined), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("[SEC2-ASSET-91] every URL slot of the head uses that rule", () => {
    for (const value of urls) {
      const tags = buildHead({
        metadata: {
          alternates: { canonical: value, languages: { en: value } },
          openGraph: { url: value, images: [value] },
          twitter: { card: "summary_large_image", images: [value] },
          authors: [{ name: "n", url: value }],
          archives: [value],
          appleWebApp: { startupImage: [value] },
        },
        viewport: {},
        links: [],
        metaTags: [],
        base,
      }).tags;
      const text = JSON.stringify(tags);
      expect(text, JSON.stringify(value)).not.toMatch(/javascript:|evil\.example|data:text/i);
    }
  });

  it("[SEC2-ASSET-92] icons, the manifest link and meta-export links drop a script scheme but keep a data:image icon", () => {
    const tags = buildHead({
      metadata: {
        manifest: "javascript:alert(1)",
        icons: {
          icon: [
            "javascript:alert(1)",
            " javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "data:image/png;base64,AAAA",
            "/favicon.ico",
            "//cdn.example/favicon.ico",
          ],
          other: [{ rel: "mask-icon", url: "vbscript:x" }],
        },
      },
      viewport: {},
      links: [],
      metaTags: [],
      base,
    }).tags;
    const hrefs = tags.filter((tag) => tag.tag === "link").map((tag) => tag.props?.["href"]);
    expect(hrefs).toEqual([
      "data:image/png;base64,AAAA",
      "/favicon.ico",
      "//cdn.example/favicon.ico",
    ]);
    const viaMeta = metaDescriptorTags([
      { tagName: "link", rel: "icon", href: "javascript:alert(1)" },
      { tagName: "link", rel: "icon", href: "/ok.png" },
    ]);
    expect(viaMeta.map((tag) => tag.props?.["href"])).toEqual(["/ok.png"]);
  });

  it("[SEC2-ASSET-93] fuzz: a resolved URL is http(s) with slashes, or a path with no leading double slash or backslash", () => {
    return fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "http",
            "https",
            "javascript",
            "data",
            ":",
            "/",
            "//",
            "\\",
            " ",
            "\t",
            "\n",
            "evil.example",
            "x",
            "%2f",
            "..",
            ".",
            "?",
            "#",
            "@",
          ),
          { maxLength: 8 },
        ),
        fc.boolean(),
        (pieces, withBase) => {
          const value = pieces.join("");
          const out = resolveMetadataUrl(value, withBase ? base : undefined);
          if (out === undefined) return;
          expect(out.length).toBeLessThanOrEqual(2048);
          // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
          expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
          const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(value);
          if (/^[a-z][a-z0-9+.-]*:/i.test(out)) {
            expect(out).toMatch(/^https?:\/\//i);
          } else {
            expect(out.startsWith("//")).toBe(false);
            expect(out.startsWith("/\\")).toBe(false);
            expect(out.startsWith("\\")).toBe(false);
            expect(out.startsWith(" ")).toBe(false);
          }
          // A relative value stays on the base's own origin.
          if (withBase && !hasScheme) expect(new URL(out).origin).toBe(base.origin);
        },
      ),
      { seed: SEED, numRuns: 1500 },
    );
  });
});

describe("SEC2-ASSET JSON-LD", () => {
  it("[SEC2-ASSET-94] a script end tag, a comment opener and the line separators never survive in the block", () => {
    const text = jsonLdText({
      "@type": "Thing",
      name: `</script><script>alert(1)</script><!-- ]]> \u2028 \u2029 & "`,
    });
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text).name).toContain("</script>");
  });

  it("[SEC2-ASSET-95] fuzz: any value is escaped or refused; the output parses back to the input", () => {
    return fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
        if (typeof value !== "object" || value === null) return;
        let text: string;
        try {
          text = jsonLdText(value);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          return;
        }
        expect(text).not.toMatch(/[<>&\u2028\u2029]/);
        expect(text.length).toBeLessThanOrEqual(MAX_JSON_LD_LENGTH);
        expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(value)));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it("[SEC2-ASSET-96] a cyclic value, a bigint and a block past the limit are refused", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => jsonLdText(cyclic)).toThrow(TypeError);
    expect(() => jsonLdText({ n: 10n })).toThrow(TypeError);
    expect(() => jsonLdText({ big: "x".repeat(MAX_JSON_LD_LENGTH) })).toThrow(RangeError);
  });
});
