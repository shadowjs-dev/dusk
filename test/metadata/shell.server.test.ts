import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler, type DuskRuntimeManifest } from "../../src/server/index";
import { errorLog, manifestOf } from "../support/app";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";

/**
 * A page with `ssr = false` ships no route content, but its static metadata (title, description, canonical,
 * Open Graph, route headers) belongs in the shell so crawlers and link previews see it. `generateMetadata` needs
 * the page's data, which a shell page does not load on the server, so it does not run there.
 */
const SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";


export const generated = { calls: 0 };

const layout = defineRoute("", {
  id: "root",
  metadata: {
    metadataBase: "https://malaf.test",
    title: { default: "Malaf", template: "%s · Malaf" },
    description: "Storage for agents",
  },
  component: function Layout() { return <div class="layout"><Outlet /></div>; },
  children: [
    defineRoute("/app", {
      id: "app",
      ssr: false,
      metadata: { title: "Dashboard", description: "Your files", openGraph: { type: "website" }, alternates: { canonical: "/app" } },
      headers: { "x-shell": "yes" },
      component: () => <p class="app-client">client only</p>,
    }),
    defineRoute("/app/settings", {
      id: "settings",
      ssr: false,
      metadata: { title: "Settings" },
      generateMetadata: () => { generated.calls += 1; return { title: "from generateMetadata" }; },
      component: () => <p class="settings-client">settings</p>,
    }),
    defineRoute("/public", {
      id: "public",
      metadata: { title: "Public" },
      component: () => <p class="public">server rendered</p>,
    }),
  ],
});

export const routes = [layout];

export function App(props) {
  return <main class="app">{props.children}</main>;
}
`;

interface Compiled {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly generated: { calls: number };
}

const ORIGIN = "http://localhost";
let compiled: Compiled;
let handler: DuskHandler;

beforeEach(async () => {
  compiled = await load<Compiled>(SOURCE);
  const log = errorLog();
  const manifest = manifestOf({ routes: compiled.routes, App: compiled.App } as never, {
    apiRoutes: [],
    serverFns: {},
  });
  handler = createHandler({ features: allFeatures(), manifest, dev: true, onError: log.onError });
});

function get(path: string): Promise<Response> {
  return handler.fetch(new Request(`${ORIGIN}${path}`));
}

describe("static metadata of an ssr = false page", () => {
  it("[MD-SHELL-01] the shell carries the page's title in the layout's template and its description, once", async () => {
    const response = await get("/app");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title data-shadow-head>Dashboard · Malaf</title>");
    expect(html.match(/<title[ >]/g)).toHaveLength(1);
    expect(html).toContain('<meta data-shadow-head name="description" content="Your files">');
    expect(html).toContain('<meta data-shadow-head property="og:type" content="website">');
    expect(html).toContain('<link data-shadow-head rel="canonical" href="https://malaf.test/app">');
  });

  it("[MD-SHELL-02] the page renders no route content in the shell, only the metadata", async () => {
    const html = await (await get("/app")).text();
    expect(html).not.toContain("client only");
    expect(html).not.toContain("app-client");
  });

  it("[MD-SHELL-03] route headers of a shell page are answered too (a denied name is still refused)", async () => {
    const response = await get("/app");
    expect(response.headers.get("x-shell")).toBe("yes");
  });

  it("[MD-SHELL-04] generateMetadata of a shell page does not run on the server; the layout's defaults do", async () => {
    const response = await get("/app/settings");
    const html = await response.text();
    expect(compiled.generated.calls).toBe(0);
    expect(html).toContain("<title data-shadow-head>Settings · Malaf</title>");
    expect(html).toContain(
      '<meta data-shadow-head name="description" content="Storage for agents">',
    );
  });

  it("[MD-SHELL-05] a page that renders on the server is unchanged by the shell path", async () => {
    const html = await (await get("/public")).text();
    expect(html).toContain("<title data-shadow-head>Public · Malaf</title>");
    expect(html).toContain("server rendered");
  });
});
