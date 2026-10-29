import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type HandlerOptions,
  type Middleware,
  redirect,
} from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

const SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { redirect } from "@start/server";
const target = (context) => context.event.url.searchParams.get("to");
const before = defineRoute("/before", { id: "before", beforeLoad: ({ context }) => { throw redirect(target(context)); }, component: () => <p>never</p> });
export const routes = [before];
export const App = (props) => <main>{props.children}</main>;
`;

interface App {
  readonly routes: never[];
  readonly App: never;
}

const TARGETS = ["/dashboard", "/", "/dashboard?tab=1#top", "https://app.test/x"];

async function boot(middleware: readonly Middleware[] = [], extra: Partial<HandlerOptions> = {}) {
  const app = await load<App>(SOURCE);
  return createHandler({
    features: allFeatures(),
    base: "/app",
    middleware,
    manifest: {
      routes: app.routes,
      apiRoutes: [
        {
          id: "api",
          path: "/api",
          load: async () =>
            apiRoute({
              GET: (event) => {
                throw redirect(event.url.searchParams.get("to") ?? "/");
              },
            }),
        },
      ],
      serverFns: {},
      assets: { entry: "/e.js", css: [], preloads: {}, base: "/app/" },
      App: app.App,
    },
    dev: false,
    security: { allowedHosts: ["app.test"] },
    onError: () => undefined,
    ...extra,
  });
}

describe("a redirect thrown outside a page keeps the mount base", () => {
  it("[DUSK-R7-3] an API route redirect to a path gets the base, as a page redirect does", async () => {
    const handler = await boot();
    for (const to of TARGETS) {
      const query = `?to=${encodeURIComponent(to)}`;
      const page = await handler.fetch(new Request(`https://app.test/app/before${query}`));
      const api = await handler.fetch(new Request(`https://app.test/app/api${query}`));
      expect(api.status).toBe(page.status);
      expect(api.headers.get("location")).toBe(page.headers.get("location"));
    }
    const api = await handler.fetch(new Request("https://app.test/app/api?to=%2Fdashboard"));
    expect(api.headers.get("location")).toBe("/app/dashboard");
  });

  it("[DUSK-R7-3] a redirect thrown by global middleware gets the base; an absolute URL is unchanged", async () => {
    const handler = await boot([
      () => {
        throw redirect("/login");
      },
    ]);
    const response = await handler.fetch(new Request("https://app.test/app/api"));
    expect(response.headers.get("location")).toBe("/app/login");
    const absolute = await boot([
      () => {
        throw redirect("https://app.test/elsewhere");
      },
    ]);
    const kept = await absolute.fetch(new Request("https://app.test/app/api"));
    expect(kept.headers.get("location")).toBe("https://app.test/elsewhere");
  });

  it("[DUSK-R7-3] a config redirect to a path gets the base as well", async () => {
    const handler = await boot([], {
      routing: { redirects: [{ source: "/old", destination: "/new", permanent: true }] },
    });
    const response = await handler.fetch(new Request("https://app.test/app/old"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/app/new");
  });
});
