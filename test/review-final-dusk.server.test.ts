import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  json,
} from "../src/server/index";

/** Defects found by the final review of the size-trim round. Each test pins what the code does once the defect is fixed. */

const ORIGIN = "https://app.test";

function boot(routes: Record<string, unknown>): DuskHandler {
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: Object.entries(routes).map(([path, module]) => ({
      id: path,
      path,
      load: async () => module as never,
    })),
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
  };
  return createHandler({
    features: [apiRoutes()],
    manifest,
    dev: false,
    security: { allowedHosts: ["app.test"], cors: { origins: ["https://partner.example"] } },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

describe("CORS and Vary through event.responseHeaders", () => {
  it("[REVIEW-FINAL-DUSK-1] a route that sets Vary on event.responseHeaders still varies on Origin when it grants CORS", async () => {
    const handler = boot({
      "/items": apiRoute({
        GET: (event: { responseHeaders: Headers }) => {
          event.responseHeaders.set("vary", "accept-language");
          return json({ ok: true });
        },
      }),
    });
    const response = await handler.fetch(
      new Request(`${ORIGIN}/items`, { headers: { origin: "https://partner.example" } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("https://partner.example");
    const vary = (response.headers.get("vary") ?? "").toLowerCase().split(/\s*,\s*/);
    expect(vary).toContain("origin");
    expect(vary).toContain("accept-language");
  });
});

describe("the dev watcher and the build scan agree", () => {
  it("[REVIEW-FINAL-DUSK-3] a dot-named file is no server function source, as the scan skips it", async () => {
    const { isServerFnSource } = await import("../src/vite/project");
    expect(isServerFnSource("/app/src", "/app/src/server/posts.ts")).toBe(true);
    expect(isServerFnSource("/app/src", "/app/src/.posts.ts")).toBe(false);
    expect(isServerFnSource("/app/src", "/app/src/server/.posts.ts")).toBe(false);
    expect(isServerFnSource("/app/src", "/app/src/.hidden/posts.ts")).toBe(false);
  });
});
