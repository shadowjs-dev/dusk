import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/** The global error document when the module writes no `<html>` of its own: the server wraps it. */
const APP_SOURCE = `
import { defineRoute } from "@shadow-js/router";
export const routes = [defineRoute("/", { id: "home", component: () => <p>home</p> })];
export function App() { throw new Error("boom"); }
`;
const GLOBAL_ERROR_SOURCE = `
export default function GlobalError() { return <p class="bare">Application error</p>; }
`;

describe("the global error document of a module without <html>", () => {
  it("[DUSK-SRV-REV-14] the language a middleware set on the request is escaped in the wrapping <html lang>", async () => {
    const app = await load<{
      routes: DuskRuntimeManifest["routes"];
      App: DuskRuntimeManifest["App"];
    }>(APP_SOURCE);
    const globalError =
      await load<NonNullable<Parameters<typeof createHandler>[0]["globalError"]>>(
        GLOBAL_ERROR_SOURCE,
      );
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
      globalError,
      // A locale middleware that trusts a header: the value reaches the document.
      middleware: [
        (event, next) => {
          event.document.lang = event.request.headers.get("x-lang") ?? "en";
          return next();
        },
      ],
      onError: () => undefined,
    });
    const response = await handler.fetch(
      new Request("http://localhost/", { headers: { "x-lang": 'en"><script>alert(1)</script>' } }),
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain('<html lang="en&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
  });
});
