import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../../src/server/index";
import { imageProps } from "../../src/shared/image";
import { configureImageBase } from "../../src/shared/image-check";
import { allFeatures } from "../support/features";

/**
 * An app mounted at `/app`: the optimizer answers under the mount point, and the URL `<Image>` writes under that base is
 * the URL the handler answers (IMG-B4).
 */

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function mounted() {
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "/app" },
    App: (props: { children?: unknown }) => props.children,
  };
  return createHandler({
    features: allFeatures(),
    manifest,
    base: "/app",
    dev: true,
    security: { allowedHosts: ["example.com"] },
    images: {
      source: async (path: string) =>
        path === "/hero.png" ? { bytes: PNG, contentType: "image/png" } : undefined,
    },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

describe("the optimizer under a mounted base", () => {
  it("[IMG-B4] the src and candidates written under base /app are answered 200 by the mounted handler", async () => {
    const handler = mounted();
    configureImageBase("/app");
    try {
      const props = imageProps({ src: "/hero.png", width: 300, height: 100, alt: "" });
      for (const url of [
        props.src,
        ...props.srcset.split(", ").map((c) => c.split(" ")[0] ?? ""),
      ]) {
        const response = await handler.fetch(new Request(`https://example.com${url}`));
        expect(response.status, url).toBe(200);
      }
    } finally {
      configureImageBase("");
    }
  });
});
