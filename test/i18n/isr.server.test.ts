import { describe, expect, it } from "vitest";
import { bootLocaleApp, htmlTag } from "./support";

/**
 * The page cache with locale routing: a page the URL localizes is cached per URL, one the cookie or `Accept-Language`
 * localizes is cached per `Accept-Language` value (its `Vary`), and a request that carries the locale cookie is not
 * answered from the shared cache. A French and an English visitor never get each other's `lang` or text.
 */
describe("locale routing and the page cache (ISR)", () => {
  it("[I18N-536] prefix never: an English and a French request for the same cached page each get their own entry", async () => {
    const t = await bootLocaleApp({ prefix: "never" });
    const fr = { headers: { "accept-language": "fr-FR,fr;q=0.9" } };
    const en = { headers: { "accept-language": "en-US,en;q=0.9" } };

    const firstFr = await t.fetch("/cached", fr);
    expect(firstFr.headers.get("x-dusk-cache")).toBe("MISS");
    const firstFrBody = await firstFr.text();
    expect(htmlTag(firstFrBody)).toContain('lang="fr"');
    expect(firstFrBody).toContain("Bonjour");

    const firstEn = await t.fetch("/cached", en);
    expect(firstEn.headers.get("x-dusk-cache")).toBe("MISS");
    const firstEnBody = await firstEn.text();
    expect(htmlTag(firstEnBody)).toContain('lang="en"');
    expect(firstEnBody).toContain("Hello");
    expect(firstEnBody).not.toContain("Bonjour");

    const againFr = await t.fetch("/cached", fr);
    expect(againFr.headers.get("x-dusk-cache")).toBe("HIT");
    const againFrBody = await againFr.text();
    expect(htmlTag(againFrBody)).toContain('lang="fr"');
    expect(againFrBody).toContain("Bonjour");
    expect(againFr.headers.get("content-language")).toBe("fr");
    const vary = (againFr.headers.get("vary") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase());
    expect(vary).toContain("accept-language");
    expect(new Set(vary).size).toBe(vary.length);

    const againEn = await t.fetch("/cached", en);
    expect(againEn.headers.get("x-dusk-cache")).toBe("HIT");
    const againEnBody = await againEn.text();
    expect(htmlTag(againEnBody)).toContain('lang="en"');
    expect(againEnBody).toContain("Hello");
    expect(againEn.headers.get("content-language")).toBe("en");
    expect(t.app.counts.cached).toBe(2);
    expect(t.errors).toEqual([]);
  });

  it("[I18N-537] prefix as-needed: /cached and /fr/cached are two entries, each with its own lang, dir and text", async () => {
    const t = await bootLocaleApp();
    const plain = { headers: { "accept-language": "fr" } };
    for (let round = 0; round < 2; round += 1) {
      const en = await t.fetch("/cached", plain);
      const enBody = await en.text();
      expect(en.headers.get("x-dusk-cache")).toBe(round === 0 ? "MISS" : "HIT");
      expect(htmlTag(enBody)).toContain('lang="en"');
      expect(enBody).toContain("Hello");
      expect(en.headers.get("content-language")).toBe("en");

      const ar = await t.fetch("/ar/cached", plain);
      const arBody = await ar.text();
      expect(ar.headers.get("x-dusk-cache")).toBe(round === 0 ? "MISS" : "HIT");
      expect(htmlTag(arBody)).toContain('lang="ar"');
      expect(htmlTag(arBody)).toContain('dir="rtl"');
      expect(arBody).toContain("مرحبا");
      expect(ar.headers.get("content-language")).toBe("ar");
    }
    // The URL decided both pages: the answers do not vary on the visitor's language.
    const en = await t.fetch("/cached", plain);
    expect(en.headers.get("vary")?.toLowerCase() ?? "").not.toContain("accept-language");
    expect(t.app.counts.cached).toBe(2);
    expect(t.errors).toEqual([]);
  });

  it("[I18N-538] a request with the locale cookie is answered by its own render (BYPASS) in its locale", async () => {
    const t = await bootLocaleApp({ prefix: "never" });
    await t.fetch("/cached", { headers: { "accept-language": "en" } });
    const response = await t.fetch("/cached", {
      headers: { cookie: "locale=ar", "accept-language": "en" },
    });
    expect(response.headers.get("x-dusk-cache")).toBe("BYPASS");
    const body = await response.text();
    expect(htmlTag(body)).toContain('lang="ar"');
    expect(htmlTag(body)).toContain('dir="rtl"');
    expect(body).toContain("مرحبا");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("cookie");
  });
});
