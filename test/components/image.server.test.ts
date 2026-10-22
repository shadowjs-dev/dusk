import { createComponent, createServerHead, renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { loadComponent } from "./support/compile";

/**
 * The server half of `<Image>`: the priority preload is a head tag, so it is checked with the server's head
 * collector (this file runs in the node environment, where the components take their server path).
 */
type Module = { Image: (props: Record<string, unknown>) => unknown };

describe("<Image> on the server", () => {
  it("[CIMG-9] a priority image preloads its optimized candidates in the head", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const head = createServerHead();
    renderToString(
      () =>
        createComponent(mod.Image as never, {
          src: "/photo.jpg",
          width: 1200,
          height: 800,
          alt: "",
          priority: true,
          sizes: "100vw",
        }),
      { head },
    );
    const preload = head.html();
    expect(preload).toContain('rel="preload"');
    expect(preload).toContain('as="image"');
    expect(preload).toContain('fetchpriority="high"');
    expect(preload).toContain("imagesrcset=");
  });

  it("[CIMG-10] an unoptimized priority image preloads its own file, with no optimizer URL", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const head = createServerHead();
    renderToString(
      () =>
        createComponent(mod.Image as never, {
          src: "https://cdn.example/a.png",
          width: 10,
          height: 10,
          alt: "",
          priority: true,
          unoptimized: true,
        }),
      { head },
    );
    const preload = head.html();
    expect(preload).toContain('href="https://cdn.example/a.png"');
    expect(preload).not.toContain("/_dusk/image");
  });

  it("[CIMG-11] `<Image width={300}>` names only offered widths: the src is 384, not the 300 the optimizer refuses", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const offered = [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];
    for (const width of [1, 40, 300, 700, 1000, 1500, 2500, 5000]) {
      const html = renderToString(() =>
        createComponent(mod.Image as never, {
          src: "/photo.jpg",
          width,
          height: 100,
          alt: "",
          sizes: `${width}px`,
        }),
      );
      // The attributes are HTML: a `&` in a URL is written `&amp;`.
      const written = [...html.matchAll(/[?&](?:amp;)?w=(\d+)/g)].map((match) => Number(match[1]));
      expect(written.length).toBeGreaterThan(0);
      for (const w of written) expect(offered, `width ${width}`).toContain(w);
    }
    const html = renderToString(() =>
      createComponent(mod.Image as never, { src: "/photo.jpg", width: 300, height: 200, alt: "" }),
    );
    expect(html).toContain("w=384&amp;q=75");
    expect(html).not.toContain("w=300&");
  });
});
