import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { rpc } from "../src/features/rpc";
import { apiRoute, createHandler, type DuskHandler, json, serverFn } from "../src/server/index";

const ORIGIN = "https://app.test";
const PARTNER = "https://partner.example";

function boot(methods?: readonly string[]): DuskHandler {
  const items = apiRoute({ POST: () => json({ saved: true }), PUT: () => json({ saved: true }) });
  return createHandler({
    features: [apiRoutes(), rpc()],
    manifest: {
      routes: [],
      apiRoutes: [{ id: "items", path: "/items", load: async () => items }],
      serverFns: { save: { load: async () => serverFn({}, () => "saved") as never } },
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
    },
    dev: false,
    security: {
      allowedHosts: ["app.test"],
      cors: { origins: [PARTNER], ...(methods === undefined ? {} : { methods }) },
    },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

const cross = (method: string, origin: string): Request =>
  new Request(`${ORIGIN}/items`, {
    method,
    headers: { origin, "sec-fetch-site": "cross-site", "content-type": "application/json" },
    body: "{}",
  });

describe("CORS and CSRF agree on a listed origin", () => {
  it("[DUSK-R7-5] a POST from a listed origin that passed the preflight is not refused by CSRF", async () => {
    const handler = boot();
    const preflight = await handler.fetch(
      new Request(`${ORIGIN}/items`, {
        method: "OPTIONS",
        headers: { origin: PARTNER, "access-control-request-method": "POST" },
      }),
    );
    expect(preflight.status).toBe(204);
    const post = await handler.fetch(cross("POST", PARTNER));
    expect(post.status).toBe(200);
    expect(post.headers.get("access-control-allow-origin")).toBe(PARTNER);
  });

  it("[DUSK-R7-5] an origin that is not listed is still refused, and so is a method the rule does not allow", async () => {
    const handler = boot(["GET", "POST"]);
    expect((await handler.fetch(cross("POST", "https://evil.example"))).status).toBe(403);
    expect((await handler.fetch(cross("PUT", PARTNER))).status).toBe(403);
  });

  it("[DUSK-R7-5] the listed origin may call API routes only: a server function still refuses it", async () => {
    const handler = boot();
    const response = await handler.fetch(
      new Request(`${ORIGIN}/_dusk/fn/save`, {
        method: "POST",
        headers: {
          origin: PARTNER,
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
          "x-dusk-fn": "1",
        },
        body: "[{}]",
      }),
    );
    expect(response.status).toBe(403);
  });
});
