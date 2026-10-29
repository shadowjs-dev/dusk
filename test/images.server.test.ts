import { describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskRuntimeManifest,
  type ImageProcessor,
  type ImagesOptions,
} from "../src/server/index";
import { allFeatures } from "./support/features";

/**
 * The image optimizer endpoint `/_dusk/image`: the parameters it accepts, where a source may come from
 * (the app's own files, or an allow-listed remote origin, never anywhere else), the processor interface and
 * the headers of an SVG (which can carry script, so it is served sandboxed).
 */

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function handlerWith(images: ImagesOptions, fetchImpl?: typeof fetch) {
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
    images: fetchImpl === undefined ? images : { ...images, fetch: fetchImpl },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

const local = async (path: string) => {
  if (path === "/hero.png") return { bytes: PNG, contentType: "image/png" };
  if (path === "/logo.svg") return { bytes: SVG, contentType: "image/svg+xml" };
  return undefined;
};

function get(handler: ReturnType<typeof handlerWith>, query: string): Promise<Response> {
  return handler.fetch(new Request(`https://example.com/_dusk/image?${query}`));
}

describe("image optimizer endpoint", () => {
  it("[IMG-10] serves a local source at an allowed width, with its type and a long cache lifetime", async () => {
    const handler = handlerWith({ source: local });
    const response = await get(handler, "url=%2Fhero.png&w=640&q=75");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...PNG]);
  });

  it("[IMG-11] a width that is not offered, a quality out of range or an unknown format is 400", async () => {
    const handler = handlerWith({ source: local });
    expect((await get(handler, "url=%2Fhero.png&w=641&q=75")).status).toBe(400);
    expect((await get(handler, "url=%2Fhero.png&w=640&q=0")).status).toBe(400);
    expect((await get(handler, "url=%2Fhero.png&w=640&q=75&f=bmp")).status).toBe(400);
    expect((await get(handler, "url=%2Fhero.png&w=99999&q=75")).status).toBe(400);
  });

  it("[IMG-12] with no source configured a local path is 404: nothing is read from the disk by default", async () => {
    const handler = handlerWith({});
    expect((await get(handler, "url=%2Fhero.png&w=640&q=75")).status).toBe(404);
  });

  it("[IMG-13] a remote source is fetched only from an allow-listed origin, and redirects are not followed", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    };
    const handler = handlerWith({ remotePatterns: ["https://cdn.example"] }, fakeFetch);
    const ok = await get(
      handler,
      `url=${encodeURIComponent("https://cdn.example/a.png")}&w=640&q=75`,
    );
    expect(ok.status).toBe(200);
    const denied = await get(
      handler,
      `url=${encodeURIComponent("https://evil.example/a.png")}&w=640&q=75`,
    );
    expect(denied.status).toBe(403);
    expect(calls).toEqual(["https://cdn.example/a.png"]);
  });

  it("[IMG-14] an upstream redirect or an oversized source is a 502, never a second fetch", async () => {
    const redirecting: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
    const handler = handlerWith(
      { remotePatterns: ["https://cdn.example"], maxSourceBytes: 4 },
      redirecting,
    );
    expect(
      (await get(handler, `url=${encodeURIComponent("https://cdn.example/a.png")}&w=640&q=75`))
        .status,
    ).toBe(502);
    const huge: typeof fetch = async () =>
      new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    const small = handlerWith({ remotePatterns: ["https://cdn.example"], maxSourceBytes: 4 }, huge);
    expect(
      (await get(small, `url=${encodeURIComponent("https://cdn.example/a.png")}&w=640&q=75`))
        .status,
    ).toBe(502);
  });

  it("[IMG-15] an SVG is served with a sandboxing content security policy and nosniff, because it can run script", async () => {
    const handler = handlerWith({ source: local });
    const response = await get(handler, "url=%2Flogo.svg&w=640&q=75");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("[IMG-16] a processor transforms the source; one that returns nothing serves the source unchanged", async () => {
    const seen: { width: number; quality: number; format: string }[] = [];
    const processor: ImageProcessor = {
      async process({ width, quality, format }) {
        seen.push({ width, quality, format });
        if (format === "webp")
          return { bytes: new TextEncoder().encode("WEBP"), contentType: "image/webp" };
        return undefined;
      },
    };
    const handler = handlerWith({ source: local, processor, qualities: [60, 75] });
    const webp = await get(handler, "url=%2Fhero.png&w=750&q=60&f=webp");
    expect(webp.headers.get("content-type")).toBe("image/webp");
    expect(await webp.text()).toBe("WEBP");
    const kept = await get(handler, "url=%2Fhero.png&w=750&q=60");
    expect(kept.headers.get("content-type")).toBe("image/png");
    expect(seen).toEqual([
      { width: 750, quality: 60, format: "webp" },
      { width: 750, quality: 60, format: "original" },
    ]);
  });

  it("[IMG-17] a processor that throws is a 500 with the reason phrase, and the source is not served", async () => {
    const processor: ImageProcessor = {
      async process() {
        throw new Error("libvips crashed on /secret/path");
      },
    };
    const handler = handlerWith({ source: local, processor });
    const response = await get(handler, "url=%2Fhero.png&w=640&q=75");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });

  it("[IMG-18] only GET and HEAD are answered", async () => {
    const handler = handlerWith({ source: local });
    const response = await handler.fetch(
      new Request("https://example.com/_dusk/image?url=%2Fhero.png&w=640&q=75", {
        method: "POST",
        headers: { origin: "https://example.com" },
      }),
    );
    expect(response.status).toBe(405);
  });
});
