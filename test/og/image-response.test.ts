import { describe, expect, it } from "vitest";
import { h } from "../../src/og/element";
import {
  checkedSize,
  defaultRenderers,
  ImageResponse,
  MAX_OG_SIDE,
  type OgRenderers,
} from "../../src/og/image-response";

/** Renderers that record their input and answer fixed bytes, so the response can be checked exactly. */
function recording(): { renderers: OgRenderers; calls: { svg: unknown[]; png: string[] } } {
  const calls = { svg: [] as unknown[], png: [] as string[] };
  const renderers: OgRenderers = {
    async svg(tree, size) {
      calls.svg.push({ tree, size });
      return `<svg width="${size.width}" height="${size.height}"/>`;
    },
    async png(svg) {
      calls.png.push(svg);
      return new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    },
  };
  return { renderers, calls };
}

describe("ImageResponse with injected renderers", () => {
  it("[OG-20] answers a PNG: the content type, the default size and a day of shared caching", async () => {
    const { renderers, calls } = recording();
    const response = new ImageResponse(h("div", null, "Hi"), { renderers });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      137, 80, 78, 71, 1, 2, 3,
    ]);
    expect(calls.svg[0]).toEqual({
      tree: { type: "div", props: { children: "Hi" } },
      size: { width: 1200, height: 630 },
    });
  });

  it("[OG-21] the size, status and headers come from the options; the caller's cache-control wins", async () => {
    const { renderers } = recording();
    const response = new ImageResponse(h("div", null), {
      renderers,
      width: 600,
      height: 315,
      status: 201,
      headers: { "Cache-Control": "no-store", "X-Card": "1" },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-card")).toBe("1");
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("[OG-22] a size outside 1 to 4096 whole pixels is refused before any drawing", () => {
    const { renderers, calls } = recording();
    expect(() => new ImageResponse(h("div", null), { renderers, width: 0 })).toThrow(RangeError);
    expect(() => new ImageResponse(h("div", null), { renderers, height: 1.5 })).toThrow(RangeError);
    expect(() => new ImageResponse(h("div", null), { renderers, width: MAX_OG_SIDE + 1 })).toThrow(
      RangeError,
    );
    expect(checkedSize(MAX_OG_SIDE, 1)).toEqual({ width: MAX_OG_SIDE, height: 1 });
    expect(calls.svg).toHaveLength(0);
  });

  it("[OG-23] a renderer that fails ends the body with that error (the status was already sent)", async () => {
    const failing: OgRenderers = {
      async svg() {
        throw new Error("font missing");
      },
      async png() {
        return new Uint8Array();
      },
    };
    const response = new ImageResponse(h("div", null, "text"), { renderers: failing });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow("font missing");
  });

  it("[OG-24] a response that is never read raises no unhandled rejection", async () => {
    const failing: OgRenderers = {
      async svg() {
        throw new Error("never read");
      },
      async png() {
        return new Uint8Array();
      },
    };
    new ImageResponse(h("div", null), { renderers: failing });
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    expect(true).toBe(true);
  });

  it("[OG-25] without fonts the default renderer names what is missing (a text tree needs one)", async () => {
    const response = new ImageResponse(h("div", null, "text"), { resvgWasm: new Uint8Array(4) });
    await expect(response.arrayBuffer()).rejects.toThrow(/at least one font/);
  });

  it("[OG-26] without resvg wasm the default rasterizer names what is missing", async () => {
    await expect(
      defaultRenderers({}).png('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        width: 10,
        height: 10,
      }),
    ).rejects.toThrow(/resvgWasm/);
  });
});
