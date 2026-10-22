import { beforeAll, describe, expect, it } from "vitest";
import { createHandler } from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

const SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { redirect, serverFn } from "@start/server";

const old = defineRoute("/old", {
  id: "old",
  beforeLoad: () => { throw redirect({ to: "/posts/:id", params: { id: "7" }, search: { tab: "edit" }, hash: "top", status: 308 }); },
  component: () => <p>never</p>,
});
export const routes = [old];
export const App = (props) => <main>{props.children}</main>;
export const go = serverFn({}, () => { throw redirect({ to: "/posts/:id", params: { id: "9" }, status: 303 }); });
`;

interface App {
  readonly routes: never[];
  readonly App: never;
  readonly go: never;
}

let app: App;

beforeAll(async () => {
  app = await load<App>(SOURCE);
});

describe("Dusk redirect with an object target, answered by a server", () => {
  const client = () =>
    createTestClient(
      createHandler({
        features: allFeatures(),
        manifest: {
          routes: app.routes,
          apiRoutes: [],
          serverFns: { go: { load: async () => app.go } },
          assets: { entry: "/e.js", css: [], preloads: {}, base: "/" },
          App: app.App,
        },
        dev: false,
        security: { allowedHosts: ["app.test"] },
        onError: errorLog().onError,
      }),
      { origin: "https://app.test" },
    );

  it("[DRO-01] a page redirect builds Location from params, search and hash, with its status", async () => {
    const response = await client().get("/old");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/posts/7?tab=edit#top");
  });

  it("[DRO-04] a server function redirect carries the built target and its status", async () => {
    const result = await client().serverFn("go", undefined);
    expect(result.redirect).toEqual({ to: "/posts/9", status: 303 });
  });
});
