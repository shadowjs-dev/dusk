import { describe, expect, it } from "vitest";
import { bootLocaleApp, htmlTag } from "./support";

/** The `Vary` names of a response, lowercased. */
function varyOf(response: Response): string[] {
  return (response.headers.get("vary") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
}

/** The `Set-Cookie` of the locale cookie, or undefined. */
function localeCookie(response: Response, name = "locale"): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

const fr = { headers: { "accept-language": "fr" } };

describe("locale routing: the root follows the visitor's preference (as-needed)", () => {
  it("[I18N-515] Accept-Language q-values: the highest supported q wins, ties keep header order, q=0 and * are ignored", async () => {
    const t = await bootLocaleApp();
    const cases: Array<[string, string | undefined]> = [
      ["fr;q=0.9, en;q=0.8", "/fr"],
      ["en;q=0.2, ar;q=0.9", "/ar"],
      ["de, fr;q=0.5, ar;q=0.5", "/fr"],
      ["de, ar;q=0.5, fr;q=0.5", "/ar"],
      ["fr;q=0, en", undefined],
      ["fr;q=0", undefined],
      ["*", undefined],
      ["*, ar;q=0.1", "/ar"],
      ["fr-CA", "/fr"],
      ["de", undefined],
      ["en-GB, fr;q=0.9", undefined],
    ];
    for (const [header, target] of cases) {
      const response = await t.fetch("/", { headers: { "accept-language": header } });
      if (target === undefined) {
        expect(response.status, header).toBe(200);
        expect(htmlTag(await response.text()), header).toContain('lang="en"');
      } else {
        expect(response.status, header).toBe(307);
        expect(response.headers.get("location"), header).toBe(target);
      }
    }
  });

  it("[I18N-516] the cookie comes before Accept-Language; the redirect and the root page vary on both", async () => {
    const t = await bootLocaleApp();
    const byCookie = await t.fetch("/", {
      headers: { cookie: "locale=ar", "accept-language": "fr" },
    });
    expect(byCookie.status).toBe(307);
    expect(byCookie.headers.get("location")).toBe("/ar");
    expect(varyOf(byCookie)).toEqual(expect.arrayContaining(["accept-language", "cookie"]));

    // A cookie that names the default locale keeps the visitor on the root, whatever the header says.
    const stays = await t.fetch("/", { headers: { cookie: "locale=en", "accept-language": "fr" } });
    expect(stays.status).toBe(200);
    expect(htmlTag(await stays.text())).toContain('lang="en"');
    expect(varyOf(stays)).toEqual(expect.arrayContaining(["accept-language", "cookie"]));
    expect(stays.headers.get("content-language")).toBe("en");

    // A cookie that names no supported locale is ignored.
    const unknown = await t.fetch("/", {
      headers: { cookie: "locale=xx", "accept-language": "fr" },
    });
    expect(unknown.headers.get("location")).toBe("/fr");
  });

  it("[I18N-517] the redirect keeps the query, is same origin, answers HEAD too, and never answers POST", async () => {
    const t = await bootLocaleApp();
    const withQuery = await t.fetch("/?tab=2&q=%C3%A9", fr);
    expect(withQuery.status).toBe(307);
    expect(withQuery.headers.get("location")).toBe("/fr?tab=2&q=%C3%A9");

    const head = await t.fetch("/", { ...fr, method: "HEAD" });
    expect(head.status).toBe(307);
    expect(head.headers.get("location")).toBe("/fr");

    const post = await t.fetch("/", {
      method: "POST",
      headers: {
        "accept-language": "fr",
        origin: "https://example.com",
        "content-type": "text/plain",
      },
      body: "x",
    });
    expect(post.status).not.toBe(307);
    expect(post.headers.get("location")).toBeNull();
  });

  it("[I18N-518] a URL with the default prefix is redirected to its canonical form, which does not vary on the visitor", async () => {
    const t = await bootLocaleApp();
    const response = await t.fetch("/en/about?x=1", fr);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/about?x=1");
    expect(varyOf(response)).not.toContain("accept-language");

    const upper = await t.fetch("/FR/about", fr);
    expect(upper.status).toBe(307);
    expect(upper.headers.get("location")).toBe("/fr/about");
  });

  it("[I18N-535] a path written to look like another host never yields a protocol-relative or off-site Location", async () => {
    const t = await bootLocaleApp({ prefix: "always" });
    const locations: string[] = [];
    for (const path of [
      "//evil.example/x",
      "/%2F%2Fevil.example/x",
      "/\\evil.example/x",
      "/fr//evil.example/x",
    ]) {
      const response = await t.fetch(path, fr);
      const location = response.headers.get("location");
      if (location === null) continue;
      locations.push(location);
      expect(location, path).toMatch(/^\/[^/\\]/);
      expect(new URL(location, "https://example.com").origin, path).toBe("https://example.com");
    }
    // The unprefixed spellings are redirected (to a path of this site); none is left unchecked.
    expect(locations.length).toBeGreaterThanOrEqual(2);
    expect(t.errors).toEqual([]);
  });
});

describe("locale routing: the URL prefix decides the page", () => {
  it("[I18N-519] /fr/about renders French with lang, Content-Language and no Vary on the visitor's headers", async () => {
    const t = await bootLocaleApp();
    const response = await t.fetch("/fr/about", { headers: { "accept-language": "ar" } });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(htmlTag(body)).toBe('<html lang="fr" dir="ltr">');
    expect(body).toContain("À propos");
    expect(response.headers.get("content-language")).toBe("fr");
    expect(varyOf(response)).not.toContain("accept-language");
    expect(varyOf(response)).not.toContain("cookie");
  });

  it("[I18N-520] an unprefixed page is the default locale's (no redirect from Accept-Language) under as-needed", async () => {
    const t = await bootLocaleApp();
    const response = await t.fetch("/about", fr);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(htmlTag(body)).toBe('<html lang="en" dir="ltr">');
    expect(body).toContain("About us");
  });

  it("[I18N-521] <html lang dir> follows the locale in the shell: Arabic is right to left", async () => {
    const t = await bootLocaleApp();
    const response = await t.fetch("/ar/about");
    const body = await response.text();
    expect(htmlTag(body)).toBe('<html lang="ar" dir="rtl">');
    expect(body).toContain("من نحن");
    expect(response.headers.get("content-language")).toBe("ar");
  });

  it("[I18N-522] the request's instance is on the event: a page reads it with getEventI18n", async () => {
    const t = await bootLocaleApp();
    const body = await (await t.fetch("/fr/event")).text();
    expect(body).toMatch(/class="event">(<!--\[-->)?À propos/);
    expect(t.errors).toEqual([]);
  });
});

describe("locale routing: the cookie", () => {
  it("[I18N-523] a URL that chose a locale is remembered: SameSite=Lax, Path=/, one year, Secure on https, readable by scripts", async () => {
    const t = await bootLocaleApp();
    const response = await t.fetch("/fr/about");
    const cookie = localeCookie(response);
    expect(cookie).toBeDefined();
    const parts = (cookie ?? "").split(";").map((part) => part.trim().toLowerCase());
    expect(parts[0]).toBe("locale=fr");
    expect(parts).toEqual(
      expect.arrayContaining(["path=/", "max-age=31536000", "samesite=lax", "secure"]),
    );
    expect(parts).not.toContain("httponly");
  });

  it("[I18N-524] the cookie is written only when it changes, and never from Accept-Language alone", async () => {
    const t = await bootLocaleApp();
    expect(
      localeCookie(await t.fetch("/fr/about", { headers: { cookie: "locale=fr" } })),
    ).toBeUndefined();
    expect(
      localeCookie(await t.fetch("/", { headers: { "accept-language": "en" } })),
    ).toBeUndefined();
    expect(localeCookie(await t.fetch("/ar", { headers: { cookie: "locale=fr" } }))).toMatch(
      /^locale=ar;/,
    );
  });

  it("[I18N-525] a development server on http://localhost writes the cookie without Secure; a custom name and age apply", async () => {
    const t = await bootLocaleApp(
      { cookie: { name: "lang", maxAge: 600 } },
      { dev: true, onWarning: () => undefined },
    );
    const response = await t.fetch("/fr/about", undefined, "http://localhost");
    const cookie = localeCookie(response, "lang") ?? "";
    const parts = cookie.split(";").map((part) => part.trim().toLowerCase());
    expect(parts[0]).toBe("lang=fr");
    expect(parts).toEqual(expect.arrayContaining(["max-age=600", "samesite=lax", "path=/"]));
    expect(parts).not.toContain("secure");
    // The custom cookie is the one detection reads.
    const root = await t.fetch("/", { headers: { cookie: "lang=ar" } }, "http://localhost");
    expect(root.headers.get("location")).toBe("/ar");
  });

  it("[I18N-526] cookie: false writes nothing; the cookie source then reads a cookie named locale", async () => {
    const t = await bootLocaleApp({ cookie: false });
    expect(localeCookie(await t.fetch("/fr/about"))).toBeUndefined();
    const root = await t.fetch("/", { headers: { cookie: "locale=ar" } });
    expect(root.headers.get("location")).toBe("/ar");
  });
});

describe("locale routing: other prefixes and detection orders", () => {
  it("[I18N-527] prefix always: every unprefixed page is redirected to the preferred locale", async () => {
    const t = await bootLocaleApp({ prefix: "always" });
    const about = await t.fetch("/about", fr);
    expect(about.status).toBe(307);
    expect(about.headers.get("location")).toBe("/fr/about");
    expect(varyOf(about)).toEqual(expect.arrayContaining(["accept-language", "cookie"]));
    const root = await t.fetch("/");
    expect(root.headers.get("location")).toBe("/en");
    const page = await t.fetch("/en/about");
    expect(page.status).toBe(200);
    expect(htmlTag(await page.text())).toContain('lang="en"');
    // A first segment shaped like a locale the app does not have is never redirected into a prefixed copy.
    const unsupported = await t.fetch("/xx/about", fr);
    expect(unsupported.status).not.toBe(307);
  });

  it("[I18N-528] prefix never: no redirect; the cookie or Accept-Language decides and the answer varies on them", async () => {
    const t = await bootLocaleApp({ prefix: "never" });
    const response = await t.fetch("/about", fr);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(htmlTag(body)).toContain('lang="fr"');
    expect(body).toContain("À propos");
    expect(varyOf(response)).toEqual(expect.arrayContaining(["accept-language", "cookie"]));
    expect(localeCookie(response)).toBeUndefined();
    // Every locale shares the URL: no hreflang alternates.
    expect(body).not.toContain("hreflang");
  });

  it('[I18N-529] detection: ["accept-language"] ignores the cookie and varies on Accept-Language only; [] means the default locale', async () => {
    const headerOnly = await bootLocaleApp({ detection: ["accept-language"] });
    const response = await headerOnly.fetch("/", {
      headers: { cookie: "locale=ar", "accept-language": "fr" },
    });
    expect(response.headers.get("location")).toBe("/fr");
    expect(varyOf(response)).toEqual(["accept-language"]);

    const none = await bootLocaleApp({ detection: [] });
    const root = await none.fetch("/", {
      headers: { cookie: "locale=ar", "accept-language": "fr" },
    });
    expect(root.status).toBe(200);
    expect(varyOf(root)).not.toContain("accept-language");
    expect(varyOf(root)).not.toContain("cookie");
  });
});

describe("locale routing leaves non-pages alone", () => {
  it("[I18N-530] /api, /_dusk, files and API routes outside /api are never localized or redirected", async () => {
    const t = await bootLocaleApp({ prefix: "always" });
    for (const path of ["/api/items", "/feed", "/_dusk/health", "/logo.png", "/sitemap.xml"]) {
      const response = await t.fetch(path, fr);
      expect(response.status, path).not.toBe(307);
      expect(response.headers.get("content-language"), path).toBeNull();
      expect(localeCookie(response), path).toBeUndefined();
    }
    const feed = await t.fetch("/feed", fr);
    expect(await feed.json()).toEqual({ feed: true });
    const post = await t.fetch("/api/items", {
      method: "POST",
      headers: { origin: "https://example.com", "accept-language": "fr" },
    });
    expect(await post.json()).toEqual({ posted: true });
  });
});

describe("locale routing: hreflang and canonical links", () => {
  it("[I18N-531] a French page has one alternate per locale, x-default and its own canonical, in that order", async () => {
    const t = await bootLocaleApp();
    const body = await (await t.fetch("/fr/about?tab=1")).text();
    expect(body).toContain(
      '<link rel="alternate" hreflang="en" href="https://example.com/about">' +
        '<link rel="alternate" hreflang="fr" href="https://example.com/fr/about">' +
        '<link rel="alternate" hreflang="ar" href="https://example.com/ar/about">' +
        '<link rel="alternate" hreflang="x-default" href="https://example.com/about">' +
        '<link rel="canonical" href="https://example.com/fr/about">',
    );
  });

  it("[I18N-532] the root and the default locale's pages, under as-needed and always", async () => {
    const asNeeded = await bootLocaleApp();
    const root = await (await asNeeded.fetch("/")).text();
    expect(root).toContain('<link rel="alternate" hreflang="fr" href="https://example.com/fr">');
    expect(root).toContain('<link rel="canonical" href="https://example.com/">');

    const always = await bootLocaleApp({ prefix: "always" });
    const page = await (await always.fetch("/en/about")).text();
    expect(page).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://example.com/en/about">',
    );
    expect(page).toContain('<link rel="canonical" href="https://example.com/en/about">');
  });

  it("[I18N-533] origin, the mount point and the trailing-slash policy shape the URLs; alternates: false writes none", async () => {
    const t = await bootLocaleApp(
      { origin: "https://www.example.org" },
      { base: "/app", trailingSlash: "always" },
    );
    const redirect = await t.fetch("/app/", fr);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/app/fr/");
    const response = await t.fetch("/app/fr/about/");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(htmlTag(body)).toContain('lang="fr"');
    expect(body).toContain(
      '<link rel="alternate" hreflang="en" href="https://www.example.org/app/about/">',
    );
    expect(body).toContain('<link rel="canonical" href="https://www.example.org/app/fr/about/">');

    const off = await bootLocaleApp({ alternates: false });
    const plain = await (await off.fetch("/fr/about")).text();
    expect(plain).not.toContain("hreflang");
    expect(plain).not.toContain('rel="canonical"');
  });

  it("[I18N-534] the app's own document head and middleware keep working: its head comes first, its middleware after", async () => {
    const seen: string[] = [];
    const t = await bootLocaleApp(
      {},
      {
        document: { head: (event) => `<meta name="from-app" content="${event.document.lang}">` },
        middleware: [
          async (event, next) => {
            seen.push(event.document.lang);
            return next();
          },
        ],
      },
    );
    const body = await (await t.fetch("/ar/about")).text();
    expect(body).toContain(
      '<meta name="from-app" content="ar"><link rel="alternate" hreflang="en"',
    );
    expect(seen).toEqual(["ar"]);
  });
});
