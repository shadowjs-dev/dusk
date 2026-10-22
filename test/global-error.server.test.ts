import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest, type HandlerOptions } from "../src/server/index";
import { errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/*
 * The global error (`src/routes/_global-error.tsx`): a document of its own, answered when the app itself fails to
 * render (the root layout, the providers). It replaces the whole document, so it carries its own `<html>` and `<body>`,
 * answers 500 with the public error only, and its module's `metadata` is the head. The route `error` UIs do not change.
 */

const APP_SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";
const home = defineRoute("/", { id: "home", component: () => <p class="home">home page</p> });
const root = defineRoute("", { id: "root", component: function Root() { return <main class="root"><Outlet /></main>; }, children: [home] });
export const routes = [root];
export function App() { throw new Error("database password is hunter2"); }
`;

const GLOBAL_ERROR_SOURCE = `
export const metadata = { title: "Malaf could not load", robots: { index: false } };
export default function GlobalError(props) {
  return (
    <html lang="en" class="global-html">
      <body class="global">
        <h1>Application error</h1>
        <p class="message">{props.error.message}</p>
        <span class="reset">{typeof props.reset}</span>
      </body>
    </html>
  );
}
`;

async function boot(options: Partial<HandlerOptions> = {}) {
  const app = await load<{
    routes: DuskRuntimeManifest["routes"];
    App: DuskRuntimeManifest["App"];
  }>(APP_SOURCE);
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

async function globalModule(): Promise<NonNullable<HandlerOptions["globalError"]>> {
  return load<NonNullable<HandlerOptions["globalError"]>>(GLOBAL_ERROR_SOURCE);
}

describe("the global error document", () => {
  it("[GERR-2] an app that fails to render is answered by its own document: 500, the public error, no app markup", async () => {
    const { handler, log } = await boot({ globalError: await globalModule() });
    const response = await handler.fetch(new Request("http://localhost/"));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body).toContain('class="global-html"');
    expect(body).toContain('class="global"');
    // The original message is kept out of the document: production shows the reason phrase.
    expect(body).toMatch(/class="message">(<!--\[-->)?Internal Server Error/);
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain('class="root"');
    expect(body).not.toContain('id="app"');
    // The failure is reported once, with the original error.
    expect(log.errors.map((entry) => entry.info.phase)).toEqual(["render"]);
  });

  it("[GERR-3] the module's metadata is the head of the document (title and robots)", async () => {
    const { handler } = await boot({ globalError: await globalModule() });
    const body = await (await handler.fetch(new Request("http://localhost/"))).text();
    expect(body).toMatch(/<title[^>]*>Malaf could not load<\/title>/);
    expect(body).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex"/);
    // The head sits inside the document's own <head>, not in a second one.
    expect(body.match(/<head\b/g)?.length).toBe(1);
  });

  it("[GERR-4] the server gives the component a reset function (a no-op on the server)", async () => {
    const { handler } = await boot({ globalError: await globalModule() });
    const body = await (await handler.fetch(new Request("http://localhost/"))).text();
    expect(body).toMatch(/class="reset">(<!--\[-->)?function/);
  });

  it("[GERR-5] HEAD is answered 500 with no body; without the option the built-in 500 page answers", async () => {
    const { handler } = await boot({ globalError: await globalModule() });
    const head = await handler.fetch(new Request("http://localhost/", { method: "HEAD" }));
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");

    const plain = await boot();
    const built = await plain.handler.fetch(new Request("http://localhost/"));
    expect(built.status).toBe(500);
    const text = await built.text();
    expect(text).not.toContain('class="global"');
    expect(text).not.toContain("hunter2");
  });

  it("[GERR-6] the option needs the pages feature: without it the handler is refused at creation, naming pages()", async () => {
    const app = await load<{
      routes: DuskRuntimeManifest["routes"];
      App: DuskRuntimeManifest["App"];
    }>(APP_SOURCE);
    const globalError = await globalModule();
    expect(() =>
      createHandler({
        features: [],
        manifest: {
          routes: [],
          apiRoutes: [],
          serverFns: {},
          assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
          App: app.App,
        },
        globalError,
      }),
    ).toThrow(/pages/);
  });
});
