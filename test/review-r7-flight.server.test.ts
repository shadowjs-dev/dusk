import { defineRoute } from "@shadow-js/router";
import { deserialize, serialize } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  getRequestEvent,
  serverFn,
} from "../src/server/index";
import { allFeatures } from "./support/features";

const ORIGIN = "https://example.com";

const page = defineRoute("/me", {
  id: "me",
  loader: () => ({ theme: getRequestEvent().cookies.get("theme") ?? "none" }),
});

const change = serverFn({ singleFlight: true }, () => {
  const { cookies } = getRequestEvent();
  cookies.set("theme", "dark; odd");
  cookies.delete("legacy");
  return "changed";
});

function boot(): DuskHandler {
  const manifest: DuskRuntimeManifest = {
    routes: [page],
    apiRoutes: [],
    serverFns: { change: { load: async () => change as never } },
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children as never,
  };
  return createHandler({
    features: allFeatures(),
    manifest,
    dev: false,
    security: { allowedHosts: ["example.com"] },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

async function call(handler: DuskHandler, cookie: string): Promise<unknown> {
  const response = await handler.fetch(
    new Request(`${ORIGIN}/_dusk/fn/change`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-dusk-fn": "1",
        "x-dusk-location": "/me",
        cookie,
      },
      body: serialize([{}]),
    }),
  );
  return deserialize(await response.text());
}

describe("single flight sees the cookies the mutation set", () => {
  it("[DUSK-R7-4] the revalidated loader reads the cookie the mutation set, not the one the browser sent", async () => {
    const answer = (await call(boot(), "theme=light; legacy=1")) as {
      revalidated?: { matches: { value: unknown }[] };
    };
    expect(answer.revalidated?.matches[0]?.value).toEqual({ theme: "dark; odd" });
  });

  it("[DUSK-R7-4] a cookie the mutation deleted is gone from the revalidated request", async () => {
    const deletes = defineRoute("/legacy", {
      id: "legacy",
      loader: () => ({ legacy: getRequestEvent().cookies.get("legacy") ?? "gone" }),
    });
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: [deletes],
        apiRoutes: [],
        serverFns: { change: { load: async () => change as never } },
        assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
        App: (props: { children?: unknown }) => props.children as never,
      },
      dev: false,
      security: { allowedHosts: ["example.com"] },
      onError: () => undefined,
      onWarning: () => undefined,
    });
    const response = await handler.fetch(
      new Request(`${ORIGIN}/_dusk/fn/change`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          "x-dusk-fn": "1",
          "x-dusk-location": "/legacy",
          cookie: "legacy=1",
        },
        body: serialize([{}]),
      }),
    );
    const answer = deserialize(await response.text()) as {
      revalidated?: { matches: { value: unknown }[] };
    };
    expect(answer.revalidated?.matches[0]?.value).toEqual({ legacy: "gone" });
  });
});
