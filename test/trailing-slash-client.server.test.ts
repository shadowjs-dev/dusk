import { describe, expect, it } from "vitest";
import { createHandler } from "../src/server/index";
import { loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

describe("the browser's trailing slash policy", () => {
  it.each(["string", "stream"] as const)(
    "[SLASH-CLIENT-01] %s pages carry the runtime policy from the server entry",
    async (mode) => {
      const app = await loadApp();
      const handler = createHandler({
        features: allFeatures(),
        manifest: manifestOf(app),
        trailingSlash: "always",
        mode,
      });
      const response = await handler.fetch(new Request("http://localhost/posts/1/"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="app" data-dusk-trailing-slash="always">');
    },
  );

  it("[SLASH-CLIENT-02] a SPA shell carries the preserve policy without a hydration payload", async () => {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app),
      trailingSlash: "preserve",
    });
    expect(await (await handler.renderShell(new Request("http://localhost/"))).text()).toContain(
      '<div id="app" data-dusk-trailing-slash="preserve">',
    );
  });
});
