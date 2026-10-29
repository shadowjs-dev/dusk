import { describe, expect, it } from "vitest";
import { pageRewritesOf } from "../src/netlify/index";
import type { StaticPage } from "../src/shared/static-page";
import { vercelRoutes } from "../src/vercel/index";

const page = (path: string, mode: StaticPage["mode"]): StaticPage => ({
  path,
  mode,
  headers: [],
  httpsHeaders: [],
  reason: mode === "handler" ? "global middleware" : undefined,
});

/** The URLs a page's prerendered file is served at by a filesystem handler. */
const FORMS = (path: string): string[] =>
  path === "/" ? ["/", "/index.html"] : [path, `${path}/`, `${path}/index.html`, `${path}.html`];

describe("a handler-mode page is not served from its file under any URL", () => {
  it("[DUSK-R7-7] Vercel routes every URL form of the page to the function before the filesystem", () => {
    const routes = vercelRoutes([page("/admin", "handler"), page("/", "handler")], "render");
    const filesystem = routes.findIndex((route) => route["handle"] === "filesystem");
    for (const path of ["/admin", "/"]) {
      for (const url of FORMS(path)) {
        const at = routes.findIndex(
          (route) =>
            typeof route["src"] === "string" &&
            route["dest"] === "/render" &&
            new RegExp(route["src"]).test(url),
        );
        expect(at, url).toBeGreaterThanOrEqual(0);
        expect(at, url).toBeLessThan(filesystem);
      }
    }
  });

  it("[DUSK-R7-7] the Vercel forms do not catch other pages", () => {
    const routes = vercelRoutes([page("/admin", "handler")], "render");
    const sources = routes.flatMap((route) =>
      typeof route["src"] === "string" && route["dest"] === "/render" ? [route["src"]] : [],
    );
    for (const url of ["/administrator.html", "/admin2/index.html", "/x/admin.html", "/about"]) {
      expect(
        sources.some((src) => src !== "/(.*)" && new RegExp(src).test(url)),
        url,
      ).toBe(false);
    }
  });

  it("[DUSK-R7-7] a static page gets no function route", () => {
    const routes = vercelRoutes([page("/about", "static")], "render");
    expect(routes.filter((route) => route["dest"] === "/render")).toEqual([
      { src: "/(.*)", dest: "/render" },
    ]);
  });

  it("[DUSK-R7-7] Netlify rewrites every URL form of the page to the function", () => {
    const lines = pageRewritesOf(
      [page("/admin", "handler"), page("/", "handler"), page("/about", "static")],
      "/.netlify/functions/render",
    );
    expect(lines).toEqual([
      "/admin /.netlify/functions/render 200!",
      "/admin/index.html /.netlify/functions/render 200!",
      "/admin.html /.netlify/functions/render 200!",
      "/ /.netlify/functions/render 200!",
      "/index.html /.netlify/functions/render 200!",
    ]);
  });
});
