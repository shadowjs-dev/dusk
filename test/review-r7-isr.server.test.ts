import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/** A param page and a static page, both cached: the key must keep the case of a param value and fold the rest. */
const SOURCE = `
import { defineRoute, useParams } from "@shadow-js/router";
import { revalidatePath } from "@start/server";

const item = defineRoute("/p/:id", {
  id: "item",
  revalidate: 60,
  component: () => { const params = useParams(); return <p class="item">{"item " + params.id}</p>; },
});
const doc = defineRoute("/Docs/:slug", {
  id: "doc",
  revalidate: 60,
  component: () => { const params = useParams(); return <p class="doc">{"doc " + params.slug}</p>; },
});
const files = defineRoute("/files/*rest", {
  id: "files",
  revalidate: 60,
  component: () => { const params = useParams(); return <p class="files">{"files " + params.rest}</p>; },
});
const purge = defineRoute("/purge", {
  id: "purge",
  loader: async () => { await revalidatePath("/p/AbC"); return 1; },
  component: () => <p>purged</p>,
});
export const routes = [item, doc, files, purge];
export function App(props) { return <main>{props.children}</main>; }
`;

interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
}

async function boot(): Promise<(path: string) => Promise<Response>> {
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
    security: { allowedHosts: ["example.com"] },
    onWarning: () => undefined,
  });
  return (path) => handler.fetch(new Request(`https://example.com${path}`));
}

describe("ISR keys keep the case of param values", () => {
  it("[DUSK-R7-1] /p/AbC and /p/abc are two cache entries, each with its own page", async () => {
    const get = await boot();
    const upper = await get("/p/AbC");
    expect(await upper.text()).toContain("item AbC");
    const lower = await get("/p/abc");
    expect(lower.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await lower.text()).toContain("item abc");
    const again = await get("/p/AbC");
    expect(again.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await again.text()).toContain("item AbC");
  });

  it("[DUSK-R7-1] the case of a static segment is still folded: /DOCS/Intro and /docs/Intro share an entry", async () => {
    const get = await boot();
    await get("/DOCS/Intro");
    const second = await get("/docs/Intro");
    expect(second.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await second.text()).toContain("doc Intro");
    const other = await get("/docs/intro");
    expect(other.headers.get("x-dusk-cache")).toBe("MISS");
  });

  it("[DUSK-R7-1] a splat keeps its case and revalidatePath reaches the entry of the exact spelling", async () => {
    const get = await boot();
    await get("/files/A/B");
    expect((await get("/files/A/B")).headers.get("x-dusk-cache")).toBe("HIT");
    expect((await get("/files/a/b")).headers.get("x-dusk-cache")).toBe("MISS");
    await get("/p/AbC");
    await get("/p/abc");
    await get("/purge");
    expect((await get("/p/AbC")).headers.get("x-dusk-cache")).toBe("MISS");
    expect((await get("/p/abc")).headers.get("x-dusk-cache")).toBe("HIT");
  });
});
