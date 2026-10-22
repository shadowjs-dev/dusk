import { createComponent, createServerHead, renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { loadComponent } from "./support/compile";

/** The server half of `<Image>` with prepared images: the preload of a priority image is a head tag. */
interface Module {
  readonly Image: (props: Record<string, unknown>) => unknown;
  configureImageVariants(images: Record<string, unknown>): void;
}

describe("<Image> with prepared images on the server", () => {
  it("[CIMG-P2] a priority image preloads the best prepared format with its type, not the optimizer's candidates", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    mod.configureImageVariants({
      "/photo.jpg": {
        d: "/assets/img/photo",
        w: [640, 960],
        a: ["aaaaaaaa", "bbbbbbbb"],
        p: ["cccccccc", "dddddddd"],
      },
    });
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
    expect(preload).toContain('type="image/avif"');
    expect(preload).toContain("/assets/img/photo-640w-aaaaaaaa.avif 640w");
    expect(preload).toContain('imagesizes="100vw"');
    expect(preload).toContain('fetchpriority="high"');
    expect(preload).not.toContain("_dusk/image");
  });
});
