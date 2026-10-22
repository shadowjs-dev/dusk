import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../../src/server/index";
import { errorLog, manifestOf } from "../support/app";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";
import { CLAIM_PATH, SERVER_HEAD } from "./support/claim-head";

/**
 * The server half of "server render, then hydrate": the page's head is written once, with the `data-shadow-head`
 * marks the browser claims. The browser test (claim.dom.test.ts) starts from SERVER_HEAD.
 */
const SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";


const layout = defineRoute("", {
  id: "root",
  metadata: {
    metadataBase: "https://malaf.test",
    title: { default: "Malaf", template: "%s · Malaf" },
    description: "Storage for agents",
  },
  component: function Layout() { return <div class="layout"><Outlet /></div>; },
  children: [
    defineRoute("/docs", {
      id: "docs",
      metadata: { title: "Docs", description: "How to use it", alternates: { canonical: "/docs" } },
      component: () => <p class="docs">docs</p>,
    }),
  ],
});

export const routes = [layout];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

describe("the server writes the head the browser claims", () => {
  it("[MD-CLAIM-01] the page head is the claim head: one title, one description, one canonical, all marked", async () => {
    const compiled = await load<{
      routes: DuskRuntimeManifest["routes"];
      App: DuskRuntimeManifest["App"];
    }>(SOURCE);
    const manifest = manifestOf({ routes: compiled.routes, App: compiled.App } as never, {
      apiRoutes: [],
      serverFns: {},
    });
    const handler = createHandler({
      features: allFeatures(),
      manifest,
      dev: true,
      onError: errorLog().onError,
    });
    const html = await (await handler.fetch(new Request(`http://localhost${CLAIM_PATH}`))).text();
    expect(html).toContain(SERVER_HEAD);
    expect(html.match(/<title[ >]/g)).toHaveLength(1);
  });
});
