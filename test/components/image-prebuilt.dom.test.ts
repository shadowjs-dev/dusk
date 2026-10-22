import { describe, expect, it } from "vitest";
import { loadComponent } from "./support/compile";
import { ssrAndHydrate } from "./support/dom";

/**
 * `<Image>` with the images a build prepared (`configureImageVariants`): a `<picture>` whose sources are the prepared AVIF
 * and WebP files, the same elements after hydration, and every prop the files cannot honor keeps the plain markup.
 */
type Component = (props: Record<string, unknown>) => unknown;
interface Module {
  readonly Image: Component;
  configureImageVariants(images: Record<string, unknown>): void;
}

const MAP = {
  "/photo.jpg": {
    d: "/assets/img/photo",
    w: [640, 960],
    a: ["aaaaaaaa", "bbbbbbbb"],
    p: ["cccccccc", "dddddddd"],
  },
};
const PHOTO = { src: "/photo.jpg", width: 1200, height: 800, alt: "A photo", sizes: "100vw" };

async function configured(): Promise<{ ssr: Module; dom: Module }> {
  const ssr = await loadComponent<Module>("ssr", "image");
  const dom = await loadComponent<Module>("dom", "image");
  ssr.configureImageVariants(MAP);
  dom.configureImageVariants(MAP);
  return { ssr, dom };
}

describe("<Image> with prepared images", () => {
  it("[CIMG-P1] a prepared image is a picture: AVIF first, then WebP, the sizes on each, the optimizer img last", async () => {
    const { ssr, dom } = await configured();
    const result = ssrAndHydrate(ssr.Image, dom.Image, PHOTO);
    expect(result.html).toMatch(
      /<picture[^>]*><!--\[--><source[^>]* type="image\/avif" srcset="\/assets\/img\/photo-640w-aaaaaaaa\.avif 640w, \/assets\/img\/photo-960w-bbbbbbbb\.avif 960w" sizes="100vw"><source[^>]* type="image\/webp" srcset="\/assets\/img\/photo-640w-cccccccc\.webp 640w, \/assets\/img\/photo-960w-dddddddd\.webp 960w" sizes="100vw"><!--\]--><img src="\/_dusk\/image\?url=%2Fphoto\.jpg/,
    );
    // The browser claims the server's elements; it builds none of its own.
    const after = [...result.host.querySelectorAll("*")];
    expect(after).toHaveLength(result.serverElements.length);
    for (const element of result.serverElements) expect(after).toContain(element);
    result.dispose();
  });

  it("[CIMG-P3] unoptimized, a loader, a format and art direction keep their own markup", async () => {
    const { ssr, dom } = await configured();
    const plain = (extra: Record<string, unknown>): string => {
      const result = ssrAndHydrate(ssr.Image, dom.Image, { ...PHOTO, ...extra });
      result.dispose();
      return result.html;
    };
    expect(plain({ unoptimized: true })).not.toContain("<picture");
    expect(plain({ unoptimized: true })).toContain('src="/photo.jpg"');
    expect(
      plain({ loader: ({ src, width }: { src: string; width: number }) => `${src}?w=${width}` }),
    ).not.toContain("<picture");
    expect(plain({ format: "webp" })).not.toContain("<picture");
    const art = plain({
      art: [{ media: "(max-width: 640px)", src: "/crop.jpg", width: 640, height: 640 }],
    });
    expect(art).toContain('media="(max-width: 640px)"');
    expect(art).not.toContain("photo-640w");
  });

  it("[CIMG-P4] an image that was not prepared, or a name from the prototype, is the plain img", async () => {
    const { ssr, dom } = await configured();
    for (const src of [
      "/other.jpg",
      "/constructor",
      "/__proto__",
      "https://cdn.example/photo.jpg",
    ]) {
      const result = ssrAndHydrate(ssr.Image, dom.Image, { ...PHOTO, src });
      expect(result.html, src).not.toContain("<picture");
      expect(result.html, src).toContain("<img");
      result.dispose();
    }
  });
});
