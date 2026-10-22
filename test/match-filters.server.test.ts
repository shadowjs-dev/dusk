import { defineRoute } from "@shadow-js/router";
import { describe, expect, it } from "vitest";
import { createHandler } from "../src/server/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

/** [A3-F6] The server enforces matchFilters the way the browser does: a value that fails is not found. */
describe("matchFilters on the server", () => {
  it("[A3-F6] a param that fails its rule is answered 404; one that passes is routed", async () => {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app, {
        routes: [defineRoute("/posts/:id", { matchFilters: { id: /^\d+$/ } })],
      }),
      dev: true,
      onError: errorLog().onError,
    });
    const missing = await handler.fetch(new Request("http://localhost/posts/abc"));
    expect(missing.status).toBe(404);
    const found = await handler.fetch(new Request("http://localhost/posts/42"));
    expect(found.status).not.toBe(404);
  });
});
