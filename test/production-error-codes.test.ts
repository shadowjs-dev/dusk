import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProduction, messageOf } from "./support/production-build";

type HeadersModule = typeof import("../src/shared/header-value");
type CookiesModule = typeof import("../src/server/cookies");
type CorsModule = typeof import("../src/server/cors");
type CspModule = typeof import("../src/server/csp");
type ResolveModule = typeof import("../src/metadata/resolve");
type UrlModule = typeof import("../src/metadata/url");
type ToHeadModule = typeof import("../src/metadata/to-head");

const CODE = /^DUSK_[A-Z]+(?:_\d+)?(?: \S+)?$/;

describe("production error codes of the server options", () => {
  it("[ERR-CODES-9] every refused header carries a DUSK_HEADER code and names the option, and different refusals differ", async () => {
    const headers = await loadProduction<HeadersModule>(
      join(import.meta.dirname, "../src/shared/header-value.ts"),
    );
    const where = "security.headers";
    const messages = {
      shape: messageOf(() => headers.headersOf(where, "text")),
      name: messageOf(() => headers.headersOf(where, { "bad name": "x" })),
      forbidden: messageOf(() => headers.headersOf(where, { "set-cookie": "x" })),
      type: messageOf(() => headers.headersOf(where, { "x-a": 1 })),
      control: messageOf(() => headers.headersOf(where, { "x-a": "a\nb" })),
      length: messageOf(() => headers.headersOf(where, { "x-a": "a".repeat(9000) })),
      empty: messageOf(() => headers.cacheControlOf(where, "")),
    };
    for (const [name, message] of Object.entries(messages)) {
      expect(message, name).toMatch(CODE);
      expect(message, name).toContain(where);
    }
    expect(new Set(Object.values(messages)).size).toBe(Object.keys(messages).length);
  });

  it("[ERR-CODES-10] every refused cookie attribute carries a DUSK_COOKIE code, and different refusals differ", async () => {
    const cookies = await loadProduction<CookiesModule>(
      join(import.meta.dirname, "../src/server/cookies.ts"),
    );
    const messages = {
      name: messageOf(() => cookies.serializeCookie("bad name", "x")),
      path: messageOf(() => cookies.serializeCookie("a", "x", { path: "no-slash" })),
      domain: messageOf(() => cookies.serializeCookie("a", "x", { domain: "bad domain" })),
      host: messageOf(() => cookies.serializeCookie("__Host-a", "x", { secure: false })),
      secure: messageOf(() => cookies.serializeCookie("__Secure-a", "x", { secure: false })),
      sameSite: messageOf(() =>
        cookies.serializeCookie("a", "x", { sameSite: "none", secure: false }),
      ),
      maxAge: messageOf(() => cookies.serializeCookie("a", "x", { maxAge: 1.5 })),
      expires: messageOf(() =>
        cookies.serializeCookie("a", "x", { expires: new Date(Number.NaN) }),
      ),
    };
    for (const [name, message] of Object.entries(messages)) {
      expect(message, name).toMatch(CODE);
    }
    expect(new Set(Object.values(messages)).size).toBe(Object.keys(messages).length);
  });

  it("[ERR-CODES-11] every refused CORS and CSP option carries a DUSK_ code, and different refusals differ", async () => {
    const cors = await loadProduction<CorsModule>(
      join(import.meta.dirname, "../src/server/cors.ts"),
    );
    const csp = await loadProduction<CspModule>(join(import.meta.dirname, "../src/server/csp.ts"));
    const messages = {
      origin: messageOf(() => cors.resolveCors({ origins: ["*"] })),
      method: messageOf(() =>
        cors.resolveCors({ origins: ["https://a.example"], methods: ["bad method"] }),
      ),
      header: messageOf(() =>
        cors.resolveCors({ origins: ["https://a.example"], headers: ["bad header"] }),
      ),
      maxAge: messageOf(() =>
        cors.resolveCors({ origins: ["https://a.example"], maxAgeSeconds: -1 }),
      ),
      directive: messageOf(() =>
        csp.buildCsp({ useDefaults: false, directives: { "bad directive": true } }, undefined),
      ),
      nonce: messageOf(() =>
        csp.buildCsp({ useDefaults: false, directives: { "script-src": ["{nonce}"] } }, undefined),
      ),
      source: messageOf(() =>
        csp.buildCsp({ useDefaults: false, directives: { "script-src": [""] } }, undefined),
      ),
    };
    for (const [name, message] of Object.entries(messages)) {
      expect(message, name).toMatch(CODE);
    }
    expect(new Set(Object.values(messages)).size).toBe(Object.keys(messages).length);
  });

  it("[ERR-CODES-12] metadata refusals carry a DUSK_META code in production, no development text", async () => {
    const dir = join(import.meta.dirname, "../src/metadata");
    const resolve = await loadProduction<ResolveModule>(join(dir, "resolve.ts"));
    const url = await loadProduction<UrlModule>(join(dir, "url.ts"));
    const toHead = await loadProduction<ToHeadModule>(join(dir, "to-head.ts"));
    const messages = {
      header: messageOf(() => resolve.checkedHeaders({ "bad name": "x" }, "blog")),
      base: messageOf(() => url.resolveMetadataBase("not a url")),
      jsonLd: messageOf(() => toHead.jsonLdText("text")),
      jsonLdLength: messageOf(() => toHead.jsonLdText({ a: "x".repeat(2_000_000) })),
    };
    expect(messages.header).toBe("DUSK_META_1 blog");
    for (const [name, message] of Object.entries(messages)) expect(message, name).toMatch(CODE);
    expect(new Set(Object.values(messages)).size).toBe(Object.keys(messages).length);
  });
});
