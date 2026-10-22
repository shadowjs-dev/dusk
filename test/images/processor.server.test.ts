import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { sharpProcessor } from "../../src/server/image-sharp";
import {
  createHandler,
  type DuskRuntimeManifest,
  type ImagesOptions,
} from "../../src/server/index";
import { bakeServerConfig } from "../../src/vite/config-file";
import { allFeatures } from "../support/features";

/**
 * The image optimizer with a real codec: `sharpProcessor` decodes, resizes and encodes the source, the endpoint
 * negotiates the format from `Accept`, applies the allow-lists the config names, and answers with an ETag.
 */

const SOURCE_WIDTH = 400;
const SOURCE_HEIGHT = 300;

/** A PNG the codec made: a gradient, so a quality change shows in the size of a JPEG. */
async function photo(
  format: "png" | "jpeg" = "png",
  width = SOURCE_WIDTH,
  height = SOURCE_HEIGHT,
): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 255) / width;
      pixels[offset + 1] = (y * 255) / height;
      pixels[offset + 2] = ((x * y) % 255) | 0;
    }
  }
  const image = sharp(pixels, { raw: { width, height, channels: 3 } });
  const bytes =
    format === "png" ? await image.png().toBuffer() : await image.jpeg({ quality: 95 }).toBuffer();
  return new Uint8Array(bytes);
}

function handlerWith(images: ImagesOptions, onError: (error: unknown) => void = () => undefined) {
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
    onError,
    onWarning: () => undefined,
  });
}

function get(
  handler: ReturnType<typeof handlerWith>,
  query: string,
  headers: Record<string, string> = {},
) {
  return handler.fetch(new Request(`https://example.com/_dusk/image?${query}`, { headers }));
}

async function dimensionsOf(bytes: ArrayBuffer): Promise<{ width?: number; format?: string }> {
  const meta = await sharp(Buffer.from(bytes)).metadata();
  return { width: meta.width, format: meta.format };
}

async function localImages(bytes: Uint8Array, contentType: string): Promise<ImagesOptions> {
  return {
    processor: sharpProcessor(),
    source: async (path) => (path === "/hero.png" ? { bytes, contentType } : undefined),
  };
}

describe("the image optimizer with a real codec", () => {
  it("[IMP-1] a source is resized to the requested width and encoded in its own format", async () => {
    const bytes = await photo("png", 1600, 1200);
    const handler = handlerWith(await localImages(bytes, "image/png"));
    const response = await get(handler, "url=%2Fhero.png&w=640&q=75");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await dimensionsOf(await response.arrayBuffer())).width).toBe(640);
  });

  it("[IMP-2] f=webp and f=avif convert the output, and the content type says so", async () => {
    const bytes = await photo();
    const handler = handlerWith(await localImages(bytes, "image/png"));
    const webp = await get(handler, "url=%2Fhero.png&w=640&q=75&f=webp");
    expect(webp.headers.get("content-type")).toBe("image/webp");
    expect((await dimensionsOf(await webp.arrayBuffer())).format).toBe("webp");
    const avif = await get(handler, "url=%2Fhero.png&w=640&q=75&f=avif");
    expect(avif.headers.get("content-type")).toBe("image/avif");
    expect((await dimensionsOf(await avif.arrayBuffer())).format).toBe("heif");
  });

  it("[IMP-3] an image is never enlarged: a width above the source keeps the source's width", async () => {
    const bytes = await photo();
    const handler = handlerWith(await localImages(bytes, "image/png"));
    const response = await get(handler, "url=%2Fhero.png&w=1080&q=75");
    expect((await dimensionsOf(await response.arrayBuffer())).width).toBe(SOURCE_WIDTH);
  });

  it("[IMP-4] a JPEG source with f=original stays a JPEG, and a lower quality is a smaller file", async () => {
    const bytes = await photo("jpeg", 1200, 900);
    const handler = handlerWith({
      ...(await localImages(bytes, "image/jpeg")),
      qualities: [20, 95],
    });
    const high = await get(handler, "url=%2Fhero.png&w=1200&q=95&f=original");
    const low = await get(handler, "url=%2Fhero.png&w=1200&q=20&f=original");
    expect(high.headers.get("content-type")).toBe("image/jpeg");
    const highBytes = (await high.arrayBuffer()).byteLength;
    const lowBytes = (await low.arrayBuffer()).byteLength;
    expect(lowBytes).toBeLessThan(highBytes);
  });

  it("[IMP-5] without f the format is negotiated from Accept: AVIF, then WebP, then the source's own; Vary says so", async () => {
    const bytes = await photo();
    const handler = handlerWith(await localImages(bytes, "image/png"));
    const avif = await get(handler, "url=%2Fhero.png&w=640&q=75", {
      accept: "image/avif,image/webp,*/*",
    });
    expect(avif.headers.get("content-type")).toBe("image/avif");
    expect(avif.headers.get("vary")).toMatch(/accept/i);
    const webp = await get(handler, "url=%2Fhero.png&w=640&q=75", { accept: "image/webp,*/*" });
    expect(webp.headers.get("content-type")).toBe("image/webp");
    const plain = await get(handler, "url=%2Fhero.png&w=640&q=75", { accept: "*/*" });
    expect(plain.headers.get("content-type")).toBe("image/png");
  });

  it("[IMP-6] the format and quality allow-lists refuse what they do not list", async () => {
    const bytes = await photo();
    const handler = handlerWith({
      ...(await localImages(bytes, "image/png")),
      formats: ["original", "webp"],
      qualities: [75],
    });
    expect((await get(handler, "url=%2Fhero.png&w=640&q=75&f=avif")).status).toBe(400);
    expect((await get(handler, "url=%2Fhero.png&w=640&q=50&f=webp")).status).toBe(400);
    expect((await get(handler, "url=%2Fhero.png&w=640&q=75&f=webp")).status).toBe(200);
  });

  it("[IMP-7] an ETag identifies the answer: the same request is a 304 when If-None-Match repeats it", async () => {
    const bytes = await photo();
    const handler = handlerWith(await localImages(bytes, "image/png"));
    const first = await get(handler, "url=%2Fhero.png&w=640&q=75&f=webp");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    await first.arrayBuffer();
    const again = await get(handler, "url=%2Fhero.png&w=640&q=75&f=webp", {
      "if-none-match": etag ?? "",
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const other = await get(handler, "url=%2Fhero.png&w=320&q=75&f=webp");
    expect(other.headers.get("etag")).not.toBe(etag);
  });

  it("[IMP-8] the answer is served inline, with nosniff and the caching the options name", async () => {
    const bytes = await photo();
    const handler = handlerWith({
      ...(await localImages(bytes, "image/png")),
      cacheControl: "public, max-age=600",
    });
    const response = await get(handler, "url=%2Fhero.png&w=640&q=75&f=webp");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
  });

  it("[IMP-9] an SVG is not raster: the codec passes it through unchanged", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    const processor = sharpProcessor();
    const out = await processor.process({
      source: { bytes: svg, contentType: "image/svg+xml" },
      width: 640,
      quality: 75,
      format: "webp",
    });
    expect(out).toBeUndefined();
    const handler = handlerWith({
      processor,
      source: async (path) =>
        path === "/logo.svg" ? { bytes: svg, contentType: "image/svg+xml" } : undefined,
    });
    const response = await get(handler, "url=%2Flogo.svg&w=640&q=75");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(svg);
  });

  it("[IMP-10] a corrupt source is a 500 that names no detail, and the codec's error is reported", async () => {
    const onError = vi.fn();
    const garbage = new TextEncoder().encode("not an image at all");
    const handler = handlerWith(
      {
        processor: sharpProcessor(),
        source: async (path) =>
          path === "/hero.png" ? { bytes: garbage, contentType: "image/png" } : undefined,
      },
      onError,
    );
    const response = await get(handler, "url=%2Fhero.png&w=640&q=75&f=webp");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("input");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("[IMP-11] dusk.config.ts names the formats, qualities and remote patterns of the optimizer", () => {
    const baked = bakeServerConfig({
      image: {
        domains: ["cdn.example"],
        remotePatterns: ["https://images.example"],
        formats: ["webp"],
        qualities: [60, 80],
        sizes: [640, 1200],
      },
    } as never);
    expect(baked.images?.remotePatterns).toEqual(["https://cdn.example", "https://images.example"]);
    expect(baked.images?.formats).toEqual(["webp"]);
    expect(baked.images?.qualities).toEqual([60, 80]);
    // `sizes` is the device list: the optimizer serves those widths and the small ones, and no others.
    expect(baked.images?.widths).toEqual({ deviceSizes: [640, 1200] });
    expect(baked.images?.maxWidth).toBeUndefined();
  });
});
