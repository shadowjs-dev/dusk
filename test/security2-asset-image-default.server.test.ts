import { describe, expect, it, vi } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { allFeatures } from "./support/features";

/**
 * PASS 2 audit, area ASSET: on Node, an image route given no `fetch` connects through `safeImageFetch`, so a name that
 * resolves to a private address is refused at connect. The system resolver is replaced by a stub that answers loopback.
 */

vi.mock("node:dns", () => ({
  promises: { lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
}));

describe("SEC2-ASSET image route default fetch", () => {
  it("[SEC2-ASSET-36] with no images.fetch, a remote name that resolves to loopback is refused and the global fetch is not used", async () => {
    const manifest: DuskRuntimeManifest = {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
    };
    const errors: unknown[] = [];
    const handler = createHandler({
      features: allFeatures(),
      manifest,
      dev: true,
      security: { allowedHosts: ["example.com"] },
      images: { remotePatterns: ["https://rebind.example"] },
      onError: (error) => errors.push(error),
      onWarning: () => undefined,
    });
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const url = encodeURIComponent("https://rebind.example/a.png");
    const response = await handler.fetch(
      new Request(`https://example.com/_dusk/image?url=${url}&w=640&q=75`),
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(String(errors[0])).toMatch(/not allowed|refused/i);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });
});
