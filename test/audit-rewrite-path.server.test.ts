import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  json,
  type Middleware,
  rewrite,
} from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

describe("audit: middleware rewrite", () => {
  const rewriters: Middleware[] = [
    (event, next) => {
      const to = event.url.searchParams.get("to");
      return to === null ? next() : rewrite(to);
    },
  ];
  const target = apiRoute({
    GET: (event) => json({ origin: event.url.origin, path: event.url.pathname }),
  });

  async function boot(): Promise<DuskHandler> {
    const app = await loadApp();
    return createHandler({
      features: allFeatures(),
      manifest: manifestOf(app, {
        apiRoutes: [{ id: "target", path: "/api/target", load: async () => target as never }],
      }),
      dev: false,
      security: { allowedHosts: ["localhost"] },
      onError: errorLog().onError,
      middleware: rewriters,
    });
  }

  it("[DUSK-AUD-02] a destination that dot segments turn into //host is refused, so the event URL keeps its origin", async () => {
    const client = createTestClient(await boot());
    for (const to of ["/.//evil.example/api/target", "/a/..//evil.example", "/%2e//evil.example"]) {
      const response = await client.get(`/shop?to=${encodeURIComponent(to)}`);
      const text = await response.text();
      expect(text, to).not.toContain("evil.example");
    }
  });
});
