import { describe, expect, it } from "vitest";
import { pageRewritesOf } from "../src/netlify/index";
import type { StaticPage } from "../src/shared/static-page";
import { vercelRoutes } from "../src/vercel/index";

const page = (path: string): StaticPage => ({
  path,
  mode: "handler",
  headers: [],
  httpsHeaders: [],
  reason: "global middleware",
});

/** Spellings the Node, Bun and Cloudflare layers read as the page `/posts` (see `pageKeyOf`). */
const POSTS = [
  "/posts",
  "/posts/",
  "//posts",
  "//posts/",
  "/posts/index.html",
  "/posts/index.html/",
  "//posts/index.html",
  "/posts.html",
  "/posts.html/",
  "//posts.html/",
  "/posts//index.html",
];
const BLOG_POST = [
  "/blog/post",
  "/blog//post",
  "//blog/post",
  "//blog//post",
  "/blog/post/",
  "/blog//post/index.html",
  "/blog/post/index.html/",
  "//blog//post.html/",
];
const ROOT = ["/", "//", "/index.html", "/index.html/", "//index.html", "//index.html//"];

describe("the Vercel routes of a handler page catch every spelling of its file", () => {
  /** The `src` of the routes that send a URL to the function before the filesystem handler. */
  function catching(routes: Array<Record<string, unknown>>, url: string): boolean {
    const filesystem = routes.findIndex((route) => route["handle"] === "filesystem");
    return routes
      .slice(0, filesystem)
      .some(
        (route) =>
          typeof route["src"] === "string" &&
          route["dest"] === "/render" &&
          new RegExp(route["src"]).test(url),
      );
  }

  it("[DUSK-AUD-06] repeated slashes and a trailing slash after index.html or .html reach the function", () => {
    const routes = vercelRoutes([page("/posts"), page("/blog/post"), page("/")], "render");
    for (const url of [...POSTS, ...BLOG_POST, ...ROOT])
      expect(catching(routes, url), url).toBe(true);
  });

  it("[DUSK-AUD-06] they do not catch other paths", () => {
    const routes = vercelRoutes([page("/posts"), page("/blog/post")], "render");
    for (const url of [
      "/postsx",
      "/postsx/index.html",
      "/other/posts",
      "//other//posts.html",
      "/blog/postx",
      "/xblog/post",
      "/blog",
      "/post",
      "/posts/x",
    ]) {
      expect(catching(routes, url), url).toBe(false);
    }
  });
});

describe("the Netlify rules of a handler page cover the spellings _redirects can name", () => {
  const FN = "/.netlify/functions/render";
  const fromOf = (pages: StaticPage[]): Set<string> =>
    new Set(pageRewritesOf(pages, FN).map((line) => line.split(" ")[0] ?? ""));

  it("[DUSK-AUD-07] a rule exists for the doubled leading slash and a slash after the file forms", () => {
    const from = fromOf([page("/posts"), page("/blog/post"), page("/")]);
    for (const url of [
      "//posts",
      "//posts/index.html",
      "//posts.html",
      "/posts/index.html/",
      "/posts.html/",
      "//posts/index.html/",
      "//blog/post",
      "//blog//post",
      "/blog/post/index.html/",
      "//blog//post.html/",
      "//",
      "//index.html",
      "/index.html/",
    ]) {
      expect(from.has(url), url).toBe(true);
    }
  });

  it("[DUSK-AUD-07] no rule is written twice, and a static page gets none", () => {
    const lines = pageRewritesOf([page("/posts"), page("/blog/post")], FN);
    expect(new Set(lines).size).toBe(lines.length);
    const staticPage: StaticPage = { ...page("/about"), mode: "static" };
    expect(pageRewritesOf([staticPage], FN)).toEqual([]);
  });
});
