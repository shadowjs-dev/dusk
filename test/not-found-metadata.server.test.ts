import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest, type HandlerOptions } from "../src/server/index";
import { errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/*
 * The metadata of a not-found or error UI is its own: `notFoundMetadata` and `errorMetadata` (route options, exported
 * by the module that owns the UI) are merged on top of the chain of the route that renders it. The status is not
 * changed. The built-in 404 document has a title and `noindex` by default; `notFoundPage` configures it.
 */

const LAYOUT_APP = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { HttpError } from "@start/server";

const home = defineRoute("/", { id: "home", component: () => <p class="home">home</p> });
const broken = defineRoute("/broken", {
  id: "broken",
  loader: () => { throw new HttpError(403, "not for you"); },
  component: () => <p>never</p>,
  error: ({ error }) => <p class="broken">{error.message}</p>,
  errorMetadata: { robots: { index: false } },
});
const layout = defineRoute("", {
  id: "layout",
  metadata: { title: { default: "Site", template: "%s · Site" } },
  component: function Layout() { return <div class="layout"><Outlet /></div>; },
  notFound: () => <p class="nf">page not found</p>,
  notFoundMetadata: { title: "Not found", robots: { index: false } },
  children: [home, broken],
});
export const routes = [layout];
export function App(props) { return <div class="app">{props.children}</div>; }
`;

const PLAIN_APP = `
import { defineRoute } from "@shadow-js/router";
const home = defineRoute("/", { id: "home", component: () => <p class="home">home</p> });
export const routes = [home];
export function App(props) { return <div class="app">{props.children}</div>; }
`;

async function boot(source: string, options: Partial<HandlerOptions> = {}) {
  const app = await load<{
    routes: DuskRuntimeManifest["routes"];
    App: DuskRuntimeManifest["App"];
  }>(source);
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
      App: app.App,
    },
    dev: false,
    security: { allowedHosts: ["localhost"] },
    onError: log.onError,
    ...options,
  });
  return { handler, log };
}

describe("metadata of the not-found and error UIs (server)", () => {
  it("[NFM-2] a 404 rendered by the not-found UI of the root layout takes that UI's metadata over the layout's", async () => {
    const { handler } = await boot(LAYOUT_APP);
    const response = await handler.fetch(new Request("http://localhost/nothing-here"));
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("page not found");
    expect(body).toMatch(/<title[^>]*>Not found · Site<\/title>/);
    expect(body).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex"/);
  });

  it('[NFM-3] the built-in 404 has the title "Not found" and noindex by default', async () => {
    const { handler } = await boot(PLAIN_APP);
    const response = await handler.fetch(new Request("http://localhost/nothing-here"));
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("<title>Not found</title>");
    expect(body).toMatch(/<meta name="robots" content="noindex"/);
  });

  it("[NFM-4] `notFoundPage` configures the built-in 404: its title and whether it is indexable", async () => {
    const { handler } = await boot(PLAIN_APP, { notFoundPage: { title: "Gone", noindex: false } });
    const body = await (await handler.fetch(new Request("http://localhost/x"))).text();
    expect(body).toContain("<title>Gone</title>");
    expect(body).not.toContain("noindex");
  });

  it("[NFM-4b] `notFoundPage: false` keeps the old built-in page: the status title and no robots", async () => {
    const { handler } = await boot(PLAIN_APP, { notFoundPage: false });
    const body = await (await handler.fetch(new Request("http://localhost/x"))).text();
    expect(body).toContain("<title>404 Not Found</title>");
    expect(body).not.toContain("noindex");
  });

  it("[NFM-6] a UI's metadata without a title keeps the layout's title (merged, not replaced)", async () => {
    const { handler } = await boot(LAYOUT_APP);
    const body = await (await handler.fetch(new Request("http://localhost/broken"))).text();
    expect(body).toMatch(/<title[^>]*>Site<\/title>/);
    expect(body).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex"/);
  });

  it("[NFM-7] an error UI keeps its status (403) and takes its metadata over the chain", async () => {
    const { handler } = await boot(LAYOUT_APP);
    const response = await handler.fetch(new Request("http://localhost/broken"));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain('class="broken"');
    expect(body).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex"/);
  });

  it("[NFM-8] a page that renders normally gets none of the UI metadata (no robots noindex)", async () => {
    const { handler } = await boot(LAYOUT_APP);
    const body = await (await handler.fetch(new Request("http://localhost/"))).text();
    expect(body).toContain('class="home"');
    expect(body).not.toContain("noindex");
    expect(body).toMatch(/<title[^>]*>Site<\/title>/);
  });
});
