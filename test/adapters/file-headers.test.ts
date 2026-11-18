/**
 * The app's header rules for the client folder's files, and their Vercel routes (`file-headers.ts`, `vercelRoutes`).
 *
 * - FHDR-01 an unconditioned `headers` rule applies to the files it matches; a rule with conditions never does.
 * - FHDR-02 the last matching rule decides a name; route-rule headers fill in only what is absent.
 * - FHDR-03 headers a file response owns are never written; files no rule applies to are left out.
 * - FHDR-04 files with the same headers form one group.
 * - FHDR-05 Vercel: a route per group (exact, escaped paths, `continue: true`, no function), after the static pages'
 *   header routes and before the immutable folders and the filesystem handler.
 * - FHDR-06 Vercel: a large group is cut into routes of at most 100 files.
 */
import { describe, expect, it } from "vitest";
import { fileHeadersOf } from "../../src/adapter/file-headers";
import { validateRouting } from "../../src/shared/routing-config";
import { vercelRoutes } from "../../src/vercel/index";

const CACHE_FONTS = "public, max-age=31536000, immutable";

describe("fileHeadersOf", () => {
  it("[FHDR-01] an unconditioned rule applies to the files it matches; a conditional rule does not", () => {
    const routing = validateRouting({
      headers: [
        { source: "/fonts/*", headers: { "cache-control": CACHE_FONTS } },
        {
          source: "/icons/*",
          headers: { "cache-control": "no-store" },
          has: [{ type: "host", value: "beta.test" }],
        },
      ],
    });
    const groups = fileHeadersOf(["/fonts/a.woff2", "/icons/a.webp", "/robots.txt"], routing, true);
    expect(groups).toEqual([
      { paths: ["/fonts/a.woff2"], headers: [["cache-control", CACHE_FONTS]] },
    ]);
  });

  it("[FHDR-02] the last matching rule decides a name; a route rule fills in what is absent", () => {
    const routing = validateRouting({
      headers: [
        { source: "/**", headers: { "x-content-type-options": "nosniff", "cache-control": "a" } },
        { source: "/og/*", headers: { "cache-control": "b" } },
      ],
      routeRules: {
        "/og/**": { headers: { "cache-control": "c", "x-robots-tag": "noindex" } },
      },
    });
    const [group] = fileHeadersOf(["/og/card.png"], routing, true);
    expect(Object.fromEntries(group?.headers ?? [])).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": "b",
      "x-robots-tag": "noindex",
    });
  });

  it("[FHDR-03] a header the file response owns is dropped; a file with nothing left is not listed", () => {
    const routing = validateRouting({
      headers: [
        { source: "/data/*", headers: { "content-type": "text/plain", etag: "x" } },
        {
          source: "/fonts/*",
          headers: { "content-type": "font/woff2", "cache-control": "max-age=60" },
        },
      ],
    });
    expect(fileHeadersOf(["/data/a.json", "/fonts/a.woff2"], routing, true)).toEqual([
      { paths: ["/fonts/a.woff2"], headers: [["cache-control", "max-age=60"]] },
    ]);
  });

  it("[FHDR-04] files with the same headers are one group, in path order", () => {
    const routing = validateRouting({
      headers: [
        { source: "/fonts/*", headers: { "cache-control": CACHE_FONTS } },
        { source: "/icons/*", headers: { "cache-control": "public, max-age=86400" } },
      ],
    });
    const groups = fileHeadersOf(
      ["/icons/b.webp", "/fonts/b.woff2", "/fonts/a.woff2", "/icons/a.webp"],
      routing,
      true,
    );
    expect(groups.map((group) => group.paths)).toEqual([
      ["/fonts/a.woff2", "/fonts/b.woff2"],
      ["/icons/a.webp", "/icons/b.webp"],
    ]);
  });
});

describe("vercelRoutes with file headers", () => {
  it("[FHDR-05] one header route per group, between the page headers and the immutable folders", () => {
    const routes = vercelRoutes(
      [
        {
          path: "/",
          mode: "static",
          headers: [["x-frame-options", "DENY"]],
          httpsHeaders: [],
          reason: undefined,
        },
      ],
      "render",
      ["/assets"],
      [],
      [
        {
          paths: ["/fonts/a.woff2", "/fonts/b+c.woff2"],
          headers: [["cache-control", CACHE_FONTS]],
        },
      ],
    );
    const index = (match: (route: Record<string, unknown>) => boolean): number =>
      routes.findIndex(match);
    const page = index((route) => route["src"] === "^/+$" && route["headers"] !== undefined);
    const fonts = index((route) => String(route["src"]).includes("fonts"));
    const immutable = index(
      (route) => route["src"] === "^/assets/.+$" && route["continue"] === true,
    );
    const filesystem = index((route) => route["handle"] === "filesystem");
    expect(page).toBeLessThan(fonts);
    expect(fonts).toBeLessThan(immutable);
    expect(immutable).toBeLessThan(filesystem);
    expect(routes[fonts]).toEqual({
      src: "^(?:/fonts/a\\.woff2|/fonts/b\\+c\\.woff2)$",
      headers: { "cache-control": CACHE_FONTS },
      continue: true,
    });
    expect(new RegExp(String(routes[fonts]?.["src"])).test("/fonts/b+c.woff2")).toBe(true);
    expect(new RegExp(String(routes[fonts]?.["src"])).test("/fonts/bbc.woff2")).toBe(false);
  });

  it("[FHDR-06] a group of more than 100 files is written as several routes", () => {
    const paths = Array.from({ length: 250 }, (_, index) => `/icons/${index}.webp`);
    const routes = vercelRoutes(
      [],
      "render",
      [],
      [],
      [{ paths, headers: [["cache-control", "max-age=60"]] }],
    );
    const headerRoutes = routes.filter((route) => String(route["src"]).includes("icons"));
    expect(headerRoutes).toHaveLength(3);
    const covered = headerRoutes.flatMap((route) =>
      paths.filter((path) => new RegExp(String(route["src"])).test(path)),
    );
    expect(covered).toHaveLength(250);
  });
});
