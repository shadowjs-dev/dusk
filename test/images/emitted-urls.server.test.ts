import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskRuntimeManifest,
  type ImagesOptions,
} from "../../src/server/index";
import { type ImageProps, type ImageWidths, imageProps } from "../../src/shared/image";
import { allFeatures } from "../support/features";

/**
 * End to end: the URLs `imageProps` writes (the src and every srcset candidate) are the URLs the optimizer answers.
 * The component and the route read one width list, so a page never links to an image the server refuses with a 400.
 */

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function handlerWith(images: ImagesOptions) {
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
  };
  return createHandler({
    features: allFeatures(),
    manifest,
    dev: true,
    security: { allowedHosts: ["example.com"] },
    images,
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

const local = async (path: string) =>
  path === "/hero.png" ? { bytes: PNG, contentType: "image/png" } : undefined;

/** The URLs an image's attributes point at: the src, then each srcset candidate (the URL before its descriptor). */
function urlsOf(props: ImageProps): string[] {
  return [props.src, ...props.srcset.split(", ").map((candidate) => candidate.split(" ")[0] ?? "")];
}

const WIDTHS: readonly (readonly [string, ImageWidths | undefined])[] = [
  ["the default widths", undefined],
  ["configured widths", { deviceSizes: [500, 1000], imageSizes: [50] }],
];

describe("the URLs of imageProps are served by the optimizer", () => {
  for (const [label, widths] of WIDTHS) {
    it(`[IMG-E2E-1] with ${label}, every src and candidate of a fixed or responsive image answers 200`, async () => {
      const handler = handlerWith({ source: local, ...(widths === undefined ? {} : { widths }) });
      const displays = [
        1, 20, 50, 97, 300, 384, 500, 641, 700, 999, 1200, 1500, 2100, 3000, 3840, 6000,
      ];
      for (const width of displays) {
        const fixed = imageProps({ src: "/hero.png", width, height: 10, alt: "" });
        const responsive = imageProps({
          src: "/hero.png",
          width,
          height: 10,
          alt: "",
          sizes: "(max-width: 600px) 50vw, 100vw",
        });
        for (const url of [...urlsOf(fixed), ...urlsOf(responsive)]) {
          const response = await handler.fetch(new Request(`https://example.com${url}`));
          expect(response.status, `${width}: ${url}`).toBe(200);
        }
      }
    });
  }

  it("[IMG-E2E-4] property: any display width and sizes give URLs the route answers 200 (fixed seed, configured widths)", async () => {
    const handler = handlerWith({
      source: local,
      widths: { deviceSizes: [500, 1000], imageSizes: [50] },
    });
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6000 }),
        fc.constantFrom(undefined, "100vw", "(max-width: 600px) 50vw, 100vw", "300px"),
        async (width, sizes) => {
          const props = imageProps({
            src: "/hero.png",
            width,
            height: 10,
            alt: "",
            ...(sizes === undefined ? {} : { sizes }),
          });
          for (const url of urlsOf(props)) {
            const response = await handler.fetch(new Request(`https://example.com${url}`));
            expect(response.status, `${width}: ${url}`).toBe(200);
          }
        },
      ),
      { seed: 20261010, numRuns: 60 },
    );
  });

  it("[IMG-E2E-2] a width the app does not offer is refused by the route (the 400 that the snapping avoids)", async () => {
    const handler = handlerWith({ source: local, widths: { deviceSizes: [500] } });
    const refused = await handler.fetch(
      new Request("https://example.com/_dusk/image?url=%2Fhero.png&w=640&q=75"),
    );
    expect(refused.status).toBe(400);
    const served = await handler.fetch(
      new Request("https://example.com/_dusk/image?url=%2Fhero.png&w=500&q=75"),
    );
    expect(served.status).toBe(200);
  });

  it("[IMG-E2E-3] a bad width configuration fails at createHandler, naming the key", () => {
    expect(() => handlerWith({ source: local, widths: { deviceSizes: [0] } })).toThrow(
      /images\.widths\.deviceSizes/,
    );
  });
});
