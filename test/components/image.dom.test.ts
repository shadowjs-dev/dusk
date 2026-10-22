import { describe, expect, it } from "vitest";
import { loadComponent } from "./support/compile";
import { ssrAndHydrate } from "./support/dom";

/**
 * `<Image>` renders the markup `imageProps` computes, in the server render and in the browser, with the same
 * elements after hydration (the server's `<img>` is claimed, not rebuilt).
 */
type Image = (props: Record<string, unknown>) => unknown;
type Module = { Image: Image };

const PHOTO = { src: "/photo.jpg", width: 1200, height: 800, alt: "A photo" };

function renderedHtml(mod: Module, props: Record<string, unknown>): string {
  return ssrAndHydrate(mod.Image, mod.Image, props).html;
}

describe("<Image> markup", () => {
  it("[CIMG-1] an image has candidates, sizes, a lazy load and the aspect-ratio box", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const html = renderedHtml(mod, { ...PHOTO, sizes: "100vw" });
    expect(html).toContain('src="/_dusk/image?url=%2Fphoto.jpg&amp;w=1200&amp;q=75"');
    expect(html).toContain("1200w");
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("aspect-ratio: 1200 / 800");
  });

  it("[CIMG-2] a priority image loads now, with a high fetch priority", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const html = renderedHtml(mod, { ...PHOTO, priority: true });
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchpriority="high"');
  });

  it("[CIMG-3] an unoptimized image is served exactly as given, with no candidates", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const html = renderedHtml(mod, {
      ...PHOTO,
      src: "https://cdn.example/a.png",
      unoptimized: true,
    });
    expect(html).toContain('src="https://cdn.example/a.png"');
    expect(html).not.toContain("srcset");
  });

  it("[CIMG-4] fill mode covers the positioned parent and drops the width and height attributes", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const html = renderedHtml(mod, { ...PHOTO, fill: true });
    expect(html).toContain(
      "position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;",
    );
    expect(html).not.toMatch(/<img[^>]* width=/);
    expect(html).toContain('sizes="100vw"');
  });

  it("[CIMG-5] a blur placeholder needs a data URL, and a color placeholder needs a color", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const blur = "data:image/png;base64,iVBORw0KGgo=";
    const html = renderedHtml(mod, { ...PHOTO, placeholder: "blur", blurDataURL: blur });
    expect(html).toContain(`background-image: url(&quot;${blur}&quot;)`);
    expect(() =>
      renderedHtml(mod, { ...PHOTO, placeholder: "blur", blurDataURL: "javascript:1" }),
    ).toThrow(/placeholder="blur" needs blurDataURL/);
    const color = renderedHtml(mod, {
      ...PHOTO,
      placeholder: "color",
      placeholderColor: "#1a1a1a",
    });
    expect(color).toContain("background-color: #1a1a1a");
    expect(() =>
      renderedHtml(mod, { ...PHOTO, placeholder: "color", placeholderColor: "red;x" }),
    ).toThrow(/placeholder="color" needs placeholderColor/);
  });

  it("[CIMG-6] art direction renders a picture with one source per crop, typed by format", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const html = renderedHtml(mod, {
      ...PHOTO,
      art: [
        { media: "(max-width: 640px)", src: "/phone.jpg", width: 640, height: 900, format: "webp" },
      ],
    });
    expect(html).toMatch(/<picture[ >]/);
    expect(html).toContain('media="(max-width: 640px)"');
    expect(html).toContain('type="image/webp"');
    expect(html).toContain("<img");
  });

  it("[CIMG-7] a source that is not a path or an http(s) URL is refused, naming the prop", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    expect(() => renderedHtml(mod, { ...PHOTO, src: "javascript:alert(1)" })).toThrow(
      /must be a path/,
    );
  });

  it("[CIMG-8] hydration claims the server's <img>: the same element survives, with no second copy", async () => {
    const mod = await loadComponent<Module>("dom", "image");
    const server = await loadComponent<Module>("ssr", "image");
    const result = ssrAndHydrate(server.Image, mod.Image, { ...PHOTO, priority: true });
    try {
      const images = result.host.querySelectorAll("img");
      expect(images).toHaveLength(1);
      expect(images[0]).toBe(result.serverElements.find((element) => element.tagName === "IMG"));
      expect(images[0]?.getAttribute("src")).toContain("/_dusk/image");
    } finally {
      result.dispose();
    }
  });
});
