import { beforeEach, describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  type ErrorInfo,
} from "../../src/server/index";
import { errorLog, manifestOf } from "../support/app";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";

/**
 * The metadata API on the server: a layout and pages export `metadata`, `generateMetadata`, `viewport`, `links`,
 * `headers` and `jsonLd`, and the page response carries the merged result. The generator copies the module exports
 * into the route options, so this app writes them as options directly (what the generated tree does).
 */
const SOURCE = `
import { defineRoute, Outlet, useLoaderData, useParams } from "@shadow-js/router";


const layout = defineRoute("", {
  id: "root",
  metadata: {
    metadataBase: "https://malaf.test",
    title: { default: "Malaf", template: "%s · Malaf" },
    description: "Storage for agents",
    alternates: { canonical: "./" },
    openGraph: { type: "website", siteName: "Malaf", images: ["/og.png"] },
    robots: { index: true, googleBot: { "max-image-preview": "large" } },
    jsonLd: { "@context": "https://schema.org", "@type": "WebSite", name: "</script><script>alert(1)</script>" },
  },
  viewport: { width: "device-width", initialScale: 1, themeColor: "#0b0b0a", colorScheme: "dark" },
  links: [{ rel: "preconnect", href: "https://fonts.example" }],
  component: function Layout() { return <div class="layout"><Outlet /></div>; },
  children: [
    defineRoute("/", { id: "home", metadata: { title: "Home", alternates: { canonical: "/" } }, component: () => <p class="home">home</p> }),
    defineRoute("/docs", { id: "docs", metadata: { title: "Docs", description: "How to use it" }, component: () => <p class="docs">docs</p> }),
    defineRoute("/absolute", { id: "absolute", metadata: { title: { absolute: "Raw" } }, component: () => <p class="absolute">raw</p> }),
    defineRoute("/posts/:id", {
      id: "post",
      loader: ({ params }) => ({ title: "Post " + params.id }),
      generateMetadata: async ({ loaderData, params, parent }) => ({
        title: loaderData.title,
        description: "post " + params.id + " after " + parent.title,
      }),
      component: function Post() { const params = useParams(); return <p class="post">post {params.id}</p>; },
    }),
    defineRoute("/broken", {
      id: "broken",
      generateMetadata: () => { throw new Error("metadata database is down"); },
      component: () => <p class="broken">still here</p>,
    }),
    defineRoute("/headers", {
      id: "headers",
      headers: { "cache-control": "public, max-age=60", "set-cookie": "stolen=1", "x-page": "headers" },
      component: () => <p class="headers">headers</p>,
    }),
    defineRoute("/xss/:value", {
      id: "xss",
      generateMetadata: ({ params }) => ({ title: "</title><script>alert(1)</script>", description: params.value }),
      component: () => <p class="xss">xss</p>,
    }),
    defineRoute("/head-loses", {
      id: "head-loses",
      head: () => [{ tag: "title", children: "From head" }],
      metadata: { title: "From metadata" },
      component: () => <p class="head-loses">both</p>,
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
}

const ORIGIN = "http://localhost";
let compiled: Compiled;
let handler: DuskHandler;
let log: ReturnType<typeof errorLog>;

function manifest(): DuskRuntimeManifest {
  return manifestOf({ routes: compiled.routes, App: compiled.App } as never, {
    apiRoutes: [],
    serverFns: {},
  });
}

async function boot(
  options: { mode?: "string" | "async" | "stream"; security?: { csp: Record<string, never> } } = {},
): Promise<void> {
  compiled = await load<Compiled>(SOURCE);
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: manifest(),
    dev: true,
    onError: log.onError,
    ...options,
  });
}

function get(path: string): Promise<Response> {
  return handler.fetch(new Request(`${ORIGIN}${path}`));
}

/** The reported errors of one phase. */
function phaseErrors(phase: ErrorInfo["phase"]): unknown[] {
  return log.errors.filter((entry) => entry.info.phase === phase).map((entry) => entry.error);
}

describe("metadata on the server", () => {
  beforeEach(async () => {
    await boot();
  });

  it("[MD-SSR-01] the page title is the page's title in the layout's template, once, as a data-shadow-head tag", async () => {
    const response = await get("/docs");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<title data-shadow-head>Docs · Malaf</title>");
    expect(html.match(/<title[ >]/g)).toHaveLength(1);
    expect(html).toContain('<meta data-shadow-head name="description" content="How to use it">');
  });

  it("[MD-SSR-02] the default title comes from the layout when the page sets none", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("<title data-shadow-head>Home · Malaf</title>");
  });

  it("[MD-SSR-03] an absolute title skips the template", async () => {
    const html = await (await get("/absolute")).text();
    expect(html).toContain("<title data-shadow-head>Raw</title>");
  });

  it("[MD-SSR-04] canonical and Open Graph URLs resolve against metadataBase; the page's own canonical wins", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('<link data-shadow-head rel="canonical" href="https://malaf.test">');
    expect(html).toContain(
      '<meta data-shadow-head property="og:image" content="https://malaf.test/og.png">',
    );
    expect(html).toContain('<meta data-shadow-head property="og:site_name" content="Malaf">');
    const docs = await (await get("/docs")).text();
    expect(docs).toContain(
      '<link data-shadow-head rel="canonical" href="https://malaf.test/docs">',
    );
  });

  it("[MD-SSR-05] viewport, theme color, color scheme and links come from the layout", async () => {
    const html = await (await get("/docs")).text();
    expect(html).toContain(
      '<meta data-shadow-head name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain('<meta data-shadow-head name="theme-color" content="#0b0b0a">');
    expect(html).toContain('<meta data-shadow-head name="color-scheme" content="dark">');
    expect(html).toContain('<link data-shadow-head rel="preconnect" href="https://fonts.example">');
  });

  it("[MD-SSR-06] JSON-LD is a script with the escaped value, not a head tag", async () => {
    const html = await (await get("/docs")).text();
    const block = /<script type="application\/ld\+json" data-shadow-jsonld>([^<]*)<\/script>/.exec(
      html,
    );
    expect(block).not.toBeNull();
    expect(block?.[1]).not.toContain("<");
    expect(JSON.parse(block?.[1] ?? "null")).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "</script><script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("[MD-SSR-07] JSON-LD scripts carry the request's CSP nonce", async () => {
    await boot({ security: { csp: {} } });
    const response = await get("/docs");
    const nonce = /'nonce-([^']+)'/.exec(
      response.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(nonce).toBeDefined();
    const html = await response.text();
    expect(html).toContain(
      `<script type="application/ld+json" data-shadow-jsonld nonce="${nonce ?? ""}">`,
    );
  });

  it("[MD-SSR-08] generateMetadata may be async: it gets the loader data and the parent metadata before the render", async () => {
    const html = await (await get("/posts/42")).text();
    expect(html).toContain("<title data-shadow-head>Post 42 · Malaf</title>");
    expect(html).toContain(
      '<meta data-shadow-head name="description" content="post 42 after Malaf">',
    );
  });

  it("[MD-SSR-09] a generator that throws is reported (phase head) and the page still renders", async () => {
    const response = await get("/broken");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("still here");
    const errors = phaseErrors("head");
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("metadata database is down");
  });

  it("[MD-SSR-10] titles and descriptions are escaped: a generated title cannot close the title element", async () => {
    const html = await (await get("/xss/abc")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; · Malaf");
  });

  it("[MD-SSR-11] the headers export sets response headers; a cookie or a framing header from a route is refused", async () => {
    const response = await get("/headers");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("x-page")).toBe("headers");
    expect(response.headers.get("set-cookie")).toBeNull();
    const refused = phaseErrors("head").map((error) => (error as Error).message);
    expect(refused).toContain('headers: a route cannot set "set-cookie".');
  });

  it("[MD-SSR-12] a route's metadata wins over its own head export for the same tag", async () => {
    const html = await (await get("/head-loses")).text();
    expect(html).toContain("<title data-shadow-head>From metadata · Malaf</title>");
    expect(html).not.toContain("From head");
  });

  it("[MD-SSR-13] streamed pages get the same head: the tags are written before the body", async () => {
    await boot({ mode: "stream" });
    const html = await (await get("/docs")).text();
    expect(html.indexOf("<title data-shadow-head>Docs · Malaf</title>")).toBeGreaterThan(-1);
    expect(html.indexOf("<title data-shadow-head>Docs · Malaf</title>")).toBeLessThan(
      html.indexOf('<div id="app">'),
    );
  });

  it("[MD-SSR-14] an invalid metadataBase is a configuration error: the page fails, it is not served without it", async () => {
    compiled = await load<Compiled>(
      SOURCE.replace('metadataBase: "https://malaf.test"', 'metadataBase: "relative"'),
    );
    log = errorLog();
    handler = createHandler({
      features: allFeatures(),
      manifest: manifest(),
      dev: true,
      onError: log.onError,
    });
    const response = await get("/docs");
    expect(response.status).toBe(500);
  });
});
