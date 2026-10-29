import { createComponent, renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { loadComponent } from "./support/compile";

type Module = { Image: (props: Record<string, unknown>) => unknown };

/**
 * An empty `alt` is how an author marks an image decorative: screen readers skip it. An `<img>` with no `alt` at all
 * is announced by its file name instead, so the empty value must be written, never dropped like an empty class.
 */
describe("<Image> alt", () => {
  it('[DUSK-R3-1] a decorative image keeps alt="" (optimized, unoptimized and with art direction)', async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const cases: Record<string, unknown>[] = [
      { src: "/photo.jpg", width: 300, height: 200, alt: "" },
      { src: "https://cdn.example/a.png", width: 300, height: 200, alt: "", unoptimized: true },
      {
        src: "/photo.jpg",
        width: 300,
        height: 200,
        alt: "",
        art: [{ media: "(max-width: 600px)", src: "/small.jpg", width: 150, height: 100 }],
      },
    ];
    for (const props of cases) {
      const html = renderToString(() => createComponent(mod.Image as never, props));
      expect(html).toMatch(/<img[^>]* alt=""/);
    }
  });

  it("[DUSK-R3-1] a described image keeps its text", async () => {
    const mod = await loadComponent<Module>("ssr", "image");
    const html = renderToString(() =>
      createComponent(mod.Image as never, {
        src: "/photo.jpg",
        width: 300,
        height: 200,
        alt: "A red door",
      }),
    );
    expect(html).toContain('alt="A red door"');
  });
});
