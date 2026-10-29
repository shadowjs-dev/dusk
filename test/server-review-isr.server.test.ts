import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * A cached page served with a CSP nonce. Compiled with the real compiler, so the router and renderer are the real ones.
 */
const SOURCE = `
import { defineRoute } from "@shadow-js/router";

const nonce = defineRoute("/nonce", {
  id: "nonce",
  revalidate: 60,
  component: () => <p>nonce page</p>,
});
const plain = defineRoute("/plain", {
  id: "plain",
  revalidate: 60,
  component: () => <p>plain page</p>,
});
export const routes = [nonce, plain];
export function App(props) { return <main>{props.children}</main>; }
`;

interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
}

async function boot(csp: boolean) {
  const app = await load<Fixture>(SOURCE);
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: app.App,
    },
    dev: true,
    security: { allowedHosts: ["example.com"], ...(csp ? { csp: {} } : {}) },
    document: { head: (event) => `<script nonce="${event.nonce ?? ""}">window.x = 1;</script>` },
    onError: () => undefined,
    onWarning: () => undefined,
  });
  return (path: string, headers: Record<string, string> = {}) =>
    handler.fetch(new Request(`https://example.com${path}`, { headers }));
}

describe("a cached page with a CSP nonce and a conditional request", () => {
  it("[DUSK-SRV-REV-9] a matching If-None-Match gets the page again when the nonce of the response changed, not a 304", async () => {
    const get = await boot(true);
    const first = await get("/nonce");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    // A 304 keeps the browser's copy of the body (the first nonce) but carries the new response's CSP header (a new
    // nonce): every inline script of the page would be blocked.
    const second = await get("/nonce", { "if-none-match": etag ?? "" });
    expect(second.status).toBe(200);
    const nonce = /nonce-([A-Za-z0-9+/=_-]+)/.exec(
      second.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(nonce).toBeDefined();
    expect(await second.text()).toContain(`nonce="${nonce}"`);
  });

  it("[DUSK-SRV-REV-10] without a nonce the same conditional request is still a 304", async () => {
    const get = await boot(false);
    const first = await get("/plain");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const second = await get("/plain", { "if-none-match": etag ?? "" });
    expect(second.status).toBe(304);
  });
});
