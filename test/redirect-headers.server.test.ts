import { beforeAll, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { type ErrorLog, errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * The header rules of the app's config (`headers` in `dusk.config`) match the path asked for, and a redirect is an
 * answer like any other: a rule that names the path adds its header to the 302 too (Next.js applies its `headers()`
 * before its redirects, with `continue`, so the redirect carries them: `next.js` routing, index.ts `...headers,` before
 * `...redirects,`). A header the redirect already sets (`cache-control: no-store`) is kept.
 */

const SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { redirect, apiRoute } from "@start/server";

const page = defineRoute("/go", {
  id: "go",
  loader: () => { throw redirect("/dest"); },
  component: () => <p>never</p>,
});
export const routes = [page];
export const App = (props) => <main>{props.children}</main>;
export const api = apiRoute({ GET: () => { throw redirect("/dest"); } });
`;

interface App {
  readonly routes: never[];
  readonly App: never;
  readonly api: never;
}

let app: App;
let log: ErrorLog;
let handler: DuskHandler;
let client: TestClient;

beforeAll(async () => {
  app = await load<App>(SOURCE);
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: [{ id: "api", path: "/api", load: async () => app.api }],
      serverFns: {},
      assets: { entry: "/e.js", css: [], preloads: {}, base: "/" },
      App: app.App,
    },
    dev: false,
    security: { allowedHosts: ["app.test"] },
    routing: {
      headers: [
        { source: "/go", headers: { "x-app-rule": "page" } },
        { source: "/api", headers: { "x-app-rule": "api" } },
      ],
    },
    onError: log.onError,
  });
  client = createTestClient(handler, { origin: "https://app.test" });
});

describe("header rules on redirect answers", () => {
  it("[RH-1] a page loader's redirect carries the header rule for its path", async () => {
    const response = await client.get("/go");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dest");
    expect(response.headers.get("x-app-rule")).toBe("page");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("[RH-2] an API redirect carries the header rule for its path", async () => {
    const response = await client.get("/api");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dest");
    expect(response.headers.get("x-app-rule")).toBe("api");
  });
});
