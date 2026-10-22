import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHandler } from "../src/server/index";
import { prerender } from "../src/static/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

describe("matched route stylesheets", () => {
  it.each(["string", "stream"] as const)(
    "[ASSET-ROUTE-01] %s HTML applies layout and leaf CSS before JavaScript runs",
    async (mode) => {
      const app = await loadApp();
      const log = errorLog();
      const handler = createHandler({
        features: allFeatures(),
        manifest: manifestOf(app, {
          assets: {
            entry: "entry.js",
            css: ["global.css"],
            base: "/app/",
            preloads: {
              layout: ["layout.css", "global.css"],
              post: ["layout.css", "post.css?v=1", "post.js", "font.woff2"],
              home: ["home.css"],
            },
          },
        }),
        mode,
        onError: log.onError,
      });
      const response = await handler.fetch(new Request("http://localhost/posts/1"));
      const html = await response.text();
      const head = html.slice(0, html.indexOf("</head>"));
      for (const href of ["global.css", "layout.css", "post.css?v=1"]) {
        expect(head).toContain(`<link rel="stylesheet" href="/app/${href}">`);
        expect(head.split(`href="/app/${href}"`)).toHaveLength(2);
      }
      expect(head).toContain('<link rel="modulepreload" href="/app/post.js">');
      expect(head).toContain('<link rel="preload" href="/app/font.woff2" as="font" crossorigin>');
      expect(head).not.toContain("home.css");
      expect(response.headers.get("link")).toContain("</app/post.css?v=1>; rel=preload; as=style");
      expect(log.errors).toEqual([]);
    },
  );

  it("[ASSET-ROUTE-02] prerendered HTML applies the route stylesheet without JavaScript", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dusk-route-css-"));
    try {
      const app = await loadApp();
      const handler = createHandler({
        features: allFeatures(),
        manifest: manifestOf(app, {
          assets: { entry: "app.js", css: [], base: "/", preloads: { post: ["post.css"] } },
        }),
      });
      await prerender({
        handler,
        outDir: dir,
        paths: ["/posts/1"],
        shell: false,
        notFoundPath: false,
      });
      expect(await readFile(join(dir, "posts/1/index.html"), "utf8")).toContain(
        '<link rel="stylesheet" href="/post.css">',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
