import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeFetch } from "../src/adapter/native";
import type { AdapterContext } from "../src/adapter/types";
import { workerFetch } from "../src/cloudflare/index";
import { deno } from "../src/deno/index";
import { buildHead } from "../src/metadata/to-head";
import { type ServerHandle, serve } from "../src/node/index";
import {
  absoluteUrl,
  apiRoute,
  createFetch,
  createHandler,
  type DuskHandler,
  type HandlerOptions,
  json,
  type RequestEvent,
} from "../src/server/index";
import { sitemapRoute, sitemapXml } from "../src/server/metadata-routes";
import type { Handler } from "../src/server/types";
import { loadApp, manifestOf } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";
import { rawRequest, statusOf } from "./support/net";

const open: ServerHandle[] = [];

async function start(
  fetch: Handler["fetch"],
  options: Parameters<typeof serve>[1] = {},
): Promise<ServerHandle> {
  const handle = await serve({ fetch }, { port: 0, shutdownSignals: false, ...options });
  open.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

const echo: Handler["fetch"] = async (request) =>
  new Response(JSON.stringify({ url: request.url }));

describe("proxy headers (G-C6)", () => {
  it("[G-C6] behind a trusted proxy the rightmost X-Forwarded-Host and X-Forwarded-Proto win over the client's leftmost value", async () => {
    // The client sent `evil.test` and `http`; the proxy appended `public.test` and `https`.
    const server = await start(echo, { trustProxy: true });
    const raw = await rawRequest(
      server.port,
      "GET /p HTTP/1.1\r\nHost: internal:3000\r\nX-Forwarded-Host: evil.test, public.test\r\nX-Forwarded-Proto: http, https\r\nConnection: close\r\n\r\n",
    );
    expect(raw).toContain('"url":"https://public.test/p"');
  });

  it("[G-C6] a repeated X-Forwarded-Host line is read the same way: the last appended value wins", async () => {
    const server = await start(echo, { trustProxy: true });
    const raw = await rawRequest(
      server.port,
      "GET /p HTTP/1.1\r\nHost: internal:3000\r\nX-Forwarded-Host: evil.test\r\nX-Forwarded-Host: public.test\r\nConnection: close\r\n\r\n",
    );
    expect(raw).toContain('"url":"http://public.test/p"');
  });

  it("[G-C6] without trustProxy the client's forwarded headers are ignored entirely", async () => {
    const server = await start(echo);
    const raw = await rawRequest(
      server.port,
      "GET /p HTTP/1.1\r\nHost: internal:3000\r\nX-Forwarded-Host: evil.test, public.test\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n",
    );
    expect(raw).toContain('"url":"http://internal:3000/p"');
  });

  it("[G-C6] a rightmost forwarded host that is not a host name is refused", async () => {
    const server = await start(echo, { trustProxy: true });
    const raw = await rawRequest(
      server.port,
      "GET /p HTTP/1.1\r\nHost: internal:3000\r\nX-Forwarded-Host: public.test, evil.test/path\r\nConnection: close\r\n\r\n",
    );
    expect(statusOf(raw)).toBe(400);
  });
});

describe("allowedHosts in production (G-C6)", () => {
  async function boot(options: Partial<HandlerOptions>): Promise<DuskHandler> {
    const app = await loadApp();
    return createHandler({
      features: allFeatures(),
      manifest: manifestOf(app),
      dev: true,
      onError: () => undefined,
      ...options,
    });
  }

  it("[G-C6] production without security.allowedHosts starts with the defaults and warns, naming the option", async () => {
    const warnings: string[] = [];
    const handler = await boot({ dev: false, onWarning: (message) => warnings.push(message) });
    expect(warnings).toEqual([]);
    await handler.fetch(new Request("https://localhost/"));
    expect(warnings.join("\n")).toMatch(/security\.allowedHosts/);
  });

  it("[G-C6] development without allowedHosts starts silently, as before", async () => {
    const warnings: string[] = [];
    const handler = await boot({ dev: true, onWarning: (message) => warnings.push(message) });
    expect(handler).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it("[G-C6] NODE_ENV=production at start, with no dev option, is production: the unset host list warns", async () => {
    const before = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const app = await loadApp();
      const warnings: string[] = [];
      const handler = createHandler({
        features: allFeatures(),
        manifest: manifestOf(app),
        onError: () => undefined,
        onWarning: (message) => warnings.push(message),
      });
      await handler.fetch(new Request("https://localhost/"));
      expect(warnings.join("\n")).toMatch(/security\.allowedHosts/);
    } finally {
      if (before === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = before;
    }
  });

  it("[G-C6] production with allowedHosts: [] needs the acknowledgment too", async () => {
    await expect(boot({ dev: false, security: { allowedHosts: [] } })).rejects.toThrow(
      /acknowledgeNoHostCheck/,
    );
  });

  it("[G-C6] production with allowedHosts: [] and acknowledgeNoHostCheck starts and serves any host", async () => {
    const handler = await boot({
      dev: false,
      security: { allowedHosts: [], acknowledgeNoHostCheck: true },
    });
    const response = await handler.fetch(new Request("https://anything.test/"));
    expect(response.status).not.toBe(400);
  });

  it("[G-C6] production with a listed host answers that host and refuses another", async () => {
    const handler = await boot({ dev: false, security: { allowedHosts: ["app.test"] } });
    expect((await handler.fetch(new Request("https://app.test/"))).status).not.toBe(400);
    expect((await handler.fetch(new Request("https://evil.test/"))).status).toBe(400);
  });
});

/** A handler over the shared fixture app with one API route, for the URL tests. */
async function bootWithApi(
  routes: Record<string, ReturnType<typeof apiRoute>>,
  options: Partial<HandlerOptions> = {},
): Promise<DuskHandler> {
  const app = await loadApp();
  return createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      apiRoutes: Object.entries(routes).map(([path, module]) => ({
        id: path,
        path,
        load: async () => module,
      })),
    }),
    dev: true,
    onError: () => undefined,
    ...options,
  });
}

describe("fragments never reach the server (G-C4)", () => {
  const probe = apiRoute({
    GET: (event) => json({ hash: event.url.hash, path: event.url.pathname }),
  });

  it("[G-C4] a Request built with /path#frag matches the route, and the handler sees an empty hash", async () => {
    const handler = await bootWithApi({ "/path": probe });
    const response = await handler.fetch(new Request("http://localhost/path#frag"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hash: "", path: "/path" });
  });

  it("[G-C4] a raw HTTP request whose target carries #frag is routed as /path with no hash", async () => {
    const handler = await bootWithApi({ "/path": probe });
    const server = await start((request) => handler.fetch(request));
    const raw = await rawRequest(
      server.port,
      "GET /path#frag HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(statusOf(raw)).toBe(200);
    expect(raw).toContain('"hash":""');
  });

  it("[G-C4] a configured redirect destination with a # is refused at startup", async () => {
    await expect(
      bootWithApi({}, { routing: { redirects: [{ source: "/old", destination: "/new#top" }] } }),
    ).rejects.toThrow(/must not contain a fragment/);
  });
});

describe("the base path under metadata, Deno and static serving (G-C5)", () => {
  it("[G-C5] a sitemap under base resolves a relative entry against the base path, not the origin root", async () => {
    const sitemap = apiRoute({ GET: sitemapRoute(() => [{ url: "about" }]) });
    const handler = await bootWithApi({ "/sitemap.xml": sitemap }, { base: "/app" });
    const response = await handler.fetch(new Request("https://site.test/app/sitemap.xml"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<loc>https://site.test/app/about</loc>");
  });

  it("[G-C5] without a base the same sitemap entry resolves at the origin root, as before", async () => {
    const sitemap = apiRoute({ GET: sitemapRoute(() => [{ url: "about" }]) });
    const handler = await bootWithApi({ "/sitemap.xml": sitemap });
    const response = await handler.fetch(new Request("https://site.test/sitemap.xml"));
    expect(await response.text()).toContain("<loc>https://site.test/about</loc>");
  });

  it("[G-C5] the Deno entry passes the static prefix from the build base", async () => {
    const emitted: string[] = [];
    const context = {
      root: "/tmp/app",
      outDir: "/tmp/app/dist/deno",
      clientDir: "/tmp/app/dist/client",
      serverEntry: "/tmp/app/dist/server/entry.js",
      manifest: { base: "/app", assetsDir: "assets" },
      routes: [],
      log: () => undefined,
      emit: async (_file: string, contents: string | Uint8Array) => {
        emitted.push(typeof contents === "string" ? contents : "");
      },
      copy: async () => undefined,
    } as unknown as AdapterContext;
    await deno().build(context);
    expect(emitted[0]).toContain('prefix: "/app"');
  });

  it("[G-C5] native static serving strips the prefix: /app/assets/x.js reads the client file, a path outside the prefix does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-g-c5-"));
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets", "x.js"), "console.log(1);");
      const fetch = createNativeFetch(
        { fetch: async () => new Response("handled", { status: 404 }) },
        { static: dir, compress: false, onError: () => undefined, prefix: "/app" },
      );
      const served = await fetch(new Request("http://site.test/app/assets/x.js"), undefined);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("console.log(1);");
      const outside = await fetch(new Request("http://site.test/assets/x.js"), undefined);
      expect(await outside.text()).toBe("handled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A page whose search validation rejects `?page=abc` (a Standard Schema issue, and a thrown SearchValidationError). */
const SEARCH_SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { SearchValidationError } from "@shadow-js/router/core";
const paged = defineRoute("/paged", {
  id: "paged",
  validateSearch: (raw) => {
    const page = raw.page;
    if (page !== undefined && typeof page !== "number") {
      throw new SearchValidationError([{ message: "page must be a whole number", path: ["page"] }]);
    }
    return { page: Number(page ?? 1) };
  },
  component: () => <p class="paged">paged</p>,
});
const crashing = defineRoute("/crash-search", {
  id: "crash-search",
  validateSearch: () => { throw new Error("validator bug"); },
  component: () => <p>never</p>,
});
export const routes = [paged, crashing];
export function App(props) {
  return <main>{props.children}</main>;
}
`;

describe("search validation failures (G-C3)", () => {
  async function bootSearch(): Promise<DuskHandler> {
    const app = await load<{
      routes: HandlerOptions["manifest"]["routes"];
      App: HandlerOptions["manifest"]["App"];
    }>(SEARCH_SOURCE);
    return createHandler({
      features: allFeatures(),
      manifest: {
        routes: app.routes,
        apiRoutes: [],
        serverFns: {},
        assets: { entry: "", css: [], preloads: {}, base: "/" },
        App: app.App,
      },
      dev: true,
      onError: () => undefined,
    });
  }

  it("[G-C3] a rejected query is a 400 HTML page that names the failing key and the SEARCH_INVALID code, not a 500", async () => {
    const handler = await bootSearch();
    const response = await handler.fetch(
      new Request("https://app.test/paged?page=abc", { headers: { accept: "text/html" } }),
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("SEARCH_INVALID");
    expect(body).toContain("page");
  });

  it("[G-C3] a valid query still renders the page", async () => {
    const handler = await bootSearch();
    const response = await handler.fetch(new Request("https://app.test/paged?page=2"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('class="paged"');
  });

  it("[G-C3] an ordinary error thrown by validateSearch is still a server fault: 500, and reported", async () => {
    const reported: unknown[] = [];
    const app = await load<{
      routes: HandlerOptions["manifest"]["routes"];
      App: HandlerOptions["manifest"]["App"];
    }>(SEARCH_SOURCE);
    const handler = createHandler({
      features: allFeatures(),
      manifest: {
        routes: app.routes,
        apiRoutes: [],
        serverFns: {},
        assets: { entry: "", css: [], preloads: {}, base: "/" },
        App: app.App,
      },
      dev: false,
      security: { allowedHosts: ["app.test"] },
      onError: (error) => void reported.push(error),
    });
    const response = await handler.fetch(new Request("https://app.test/crash-search"));
    expect(response.status).toBe(500);
    expect(reported.length).toBeGreaterThan(0);
  });
});

describe("redirect conditions and query (G-C9)", () => {
  /** The redirect answer of a request, or `undefined` when the request is not redirected. */
  async function redirectOf(
    routing: Partial<NonNullable<HandlerOptions["routing"]>>,
    request: Request,
  ): Promise<{ status: number; location: string | null } | undefined> {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app),
      dev: true,
      onError: () => undefined,
      routing,
    });
    const response = await handler.fetch(request);
    if (response.status < 300 || response.status > 399) return undefined;
    return { status: response.status, location: response.headers.get("location") };
  }

  it("[G-C9] a missing header condition redirects only when the header is absent", async () => {
    const routing = {
      redirects: [
        {
          source: "/g9/old",
          destination: "/new",
          missing: [{ type: "header" as const, key: "x-skip" }],
        },
      ],
    };
    expect((await redirectOf(routing, new Request("https://app.test/g9/old")))?.location).toBe(
      "/new",
    );
    expect(
      await redirectOf(
        routing,
        new Request("https://app.test/g9/old", { headers: { "x-skip": "1" } }),
      ),
    ).toBeUndefined();
  });

  it("[G-C9] a missing cookie condition redirects only when the cookie is absent", async () => {
    const routing = {
      redirects: [
        {
          source: "/g9/old",
          destination: "/new",
          missing: [{ type: "cookie" as const, key: "skip" }],
        },
      ],
    };
    expect((await redirectOf(routing, new Request("https://app.test/g9/old")))?.location).toBe(
      "/new",
    );
    expect(
      await redirectOf(
        routing,
        new Request("https://app.test/g9/old", { headers: { cookie: "skip=1" } }),
      ),
    ).toBeUndefined();
  });

  it("[G-C9] a missing query condition redirects only when the parameter is absent", async () => {
    const routing = {
      redirects: [
        {
          source: "/g9/old",
          destination: "/new",
          missing: [{ type: "query" as const, key: "skip" }],
        },
      ],
    };
    expect((await redirectOf(routing, new Request("https://app.test/g9/old")))?.location).toBe(
      "/new",
    );
    expect(
      await redirectOf(routing, new Request("https://app.test/g9/old?skip=1")),
    ).toBeUndefined();
  });

  it("[G-C9] a missing host condition redirects every host except the listed one", async () => {
    const routing = {
      redirects: [
        {
          source: "/g9/old",
          destination: "/new",
          missing: [{ type: "host" as const, value: "blocked.test" }],
        },
      ],
    };
    expect((await redirectOf(routing, new Request("https://app.test/g9/old")))?.location).toBe(
      "/new",
    );
    expect(await redirectOf(routing, new Request("https://blocked.test/g9/old"))).toBeUndefined();
  });

  it("[G-C9] a host condition without a port matches any port of that host", async () => {
    const routing = {
      redirects: [
        {
          source: "/g9/old",
          destination: "/new",
          has: [{ type: "host" as const, value: "app.test" }],
        },
      ],
    };
    expect((await redirectOf(routing, new Request("https://app.test:8443/g9/old")))?.location).toBe(
      "/new",
    );
    expect((await redirectOf(routing, new Request("https://app.test/g9/old")))?.location).toBe(
      "/new",
    );
  });

  it("[G-C9] a host condition with a port matches that port only", async () => {
    const routing = {
      redirects: [
        {
          source: "/g9/old",
          destination: "/new",
          has: [{ type: "host" as const, value: "app.test:8443" }],
        },
      ],
    };
    expect((await redirectOf(routing, new Request("https://app.test:8443/g9/old")))?.location).toBe(
      "/new",
    );
    expect(await redirectOf(routing, new Request("https://app.test/g9/old"))).toBeUndefined();
  });

  it("[G-C9] a redirect keeps the request query string when the destination has none", async () => {
    const routing = { redirects: [{ source: "/g9/old", destination: "/new" }] };
    expect(
      (await redirectOf(routing, new Request("https://app.test/g9/old?x=1&y=2")))?.location,
    ).toBe("/new?x=1&y=2");
  });

  it("[G-C9] a redirect whose destination has a query keeps the destination query, not the request's", async () => {
    const routing = { redirects: [{ source: "/g9/old", destination: "/new?from=rule" }] };
    expect((await redirectOf(routing, new Request("https://app.test/g9/old?x=1")))?.location).toBe(
      "/new?from=rule",
    );
  });

  it("[G-C9] a destination with a # is refused at startup (a fragment never reaches the server)", async () => {
    const app = await loadApp();
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: manifestOf(app),
        dev: true,
        onError: () => undefined,
        routing: { redirects: [{ source: "/g9/old", destination: "/new#top" }] },
      }),
    ).toThrow(/fragment/);
  });
});

describe("absolute URLs and the trailing slash (G-C10, G-C11)", () => {
  /** The event a route received for `url` (an API route that records it). */
  async function eventAt(url: string): Promise<RequestEvent> {
    let captured: RequestEvent | undefined;
    const probe = apiRoute({
      GET: (event) => {
        captured = event;
        return new Response("ok");
      },
    });
    const handler = await bootWithApi({ "/probe": probe });
    await handler.fetch(new Request(url));
    if (captured === undefined) throw new Error("the probe route did not run");
    return captured;
  }

  it("[G-C10] absoluteUrl uses metadataBase first: a path becomes a full URL on that base", () => {
    expect(
      absoluteUrl("/about", "https://malaf.dev", { metadataBase: "https://docs.malaf.dev" }),
    ).toBe("https://docs.malaf.dev/about");
  });

  it("[G-C10] without metadataBase the request origin is the base", async () => {
    const event = await eventAt("https://site.test/probe");
    expect(absoluteUrl("/about", event)).toBe("https://site.test/about");
    expect(absoluteUrl("https://other.test/x", event)).toBe("https://other.test/x");
  });

  it("[G-C10] an absolute http(s) value is returned as a full URL, unchanged except for the slash policy", () => {
    expect(
      absoluteUrl("https://site.test/a/", "https://site.test", { trailingSlash: "never" }),
    ).toBe("https://site.test/a");
  });

  it("[G-C10] the root is the bare origin, and a query stays on the URL", () => {
    expect(absoluteUrl("/", "https://site.test")).toBe("https://site.test");
    expect(absoluteUrl("/search?q=1", "https://site.test")).toBe("https://site.test/search?q=1");
  });

  it("[G-C11] the canonical keeps the slash under trailingSlash: always", () => {
    const head = buildHead({
      metadata: { alternates: { canonical: "/about" } },
      viewport: {},
      links: [],
      metaTags: [],
      base: new URL("https://site.test"),
      pathname: "/about",
      trailingSlash: "always",
    });
    expect(head.tags).toContainEqual({
      tag: "link",
      props: { rel: "canonical", href: "https://site.test/about/" },
    });
  });

  it("[G-C11] the canonical strips the slash under trailingSlash: never", () => {
    const head = buildHead({
      metadata: { alternates: { canonical: "/about/" } },
      viewport: {},
      links: [],
      metaTags: [],
      base: new URL("https://site.test"),
      pathname: "/about/",
      trailingSlash: "never",
    });
    expect(head.tags).toContainEqual({
      tag: "link",
      props: { rel: "canonical", href: "https://site.test/about" },
    });
  });

  it("[G-C11] a sitemap entry follows the same policy as the canonical", () => {
    const xml = sitemapXml([{ url: "/about" }], {
      base: new URL("https://site.test"),
      trailingSlash: "always",
    });
    expect(xml).toContain("<loc>https://site.test/about/</loc>");
    expect(
      sitemapXml([{ url: "/about/" }], {
        base: new URL("https://site.test"),
        trailingSlash: "never",
      }),
    ).toContain("<loc>https://site.test/about</loc>");
  });
});

describe("event.geo from the platform (G-C7)", () => {
  /** The geo of a request as a route sees it, through the given fetch function. */
  async function geoThrough(
    fetch: (request: Request) => Promise<Response>,
    request: Request,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(request);
    return (await response.json()) as Record<string, unknown>;
  }

  async function geoHandler(): Promise<DuskHandler> {
    return bootWithApi({
      "/geo": apiRoute({ GET: (event) => json(event.geo) }),
    });
  }

  it("[G-C7] Cloudflare: request.cf gives country, region, city, coordinates and timezone through workerFetch", async () => {
    const handler = await geoHandler();
    const worker = workerFetch(handler);
    const request = new Request("https://app.test/geo");
    Object.defineProperty(request, "cf", {
      value: {
        country: "GB",
        region: "England",
        city: "London",
        latitude: "51.50740",
        longitude: "-0.12780",
        timezone: "Europe/London",
      },
    });
    const geo = await geoThrough((req) => worker.fetch(req, undefined, undefined), request);
    expect(geo).toEqual({
      country: "GB",
      region: "England",
      city: "London",
      latitude: 51.5074,
      longitude: -0.1278,
      timezone: "Europe/London",
    });
  });

  it("[G-C7] Vercel: the x-vercel-ip-* headers, with the city URL-decoded, through createFetch(geo: vercel)", async () => {
    const handler = await geoHandler();
    const edge = createFetch(handler, { geo: "vercel" });
    const request = new Request("https://app.test/geo", {
      headers: {
        "x-vercel-ip-country": "FR",
        "x-vercel-ip-country-region": "IDF",
        "x-vercel-ip-city": "Saint%20Denis",
        "x-vercel-ip-latitude": "48.9362",
        "x-vercel-ip-longitude": "2.3574",
        "x-vercel-ip-timezone": "Europe/Paris",
      },
    });
    const geo = await geoThrough((req) => edge.fetch(req, undefined, undefined), request);
    expect(geo).toEqual({
      country: "FR",
      region: "IDF",
      city: "Saint Denis",
      latitude: 48.9362,
      longitude: 2.3574,
      timezone: "Europe/Paris",
    });
  });

  it("[G-C7] Netlify: the x-nf-geo JSON through createFetch(geo: netlify)", async () => {
    const handler = await geoHandler();
    const edge = createFetch(handler, { geo: "netlify" });
    const request = new Request("https://app.test/geo", {
      headers: {
        "x-nf-geo": JSON.stringify({
          city: "Austin",
          country: { code: "US", name: "United States" },
          subdivision: { code: "TX", name: "Texas" },
          timezone: "America/Chicago",
          latitude: 30.2672,
          longitude: -97.7431,
        }),
      },
    });
    const geo = await geoThrough((req) => edge.fetch(req, undefined, undefined), request);
    expect(geo).toEqual({
      country: "US",
      region: "TX",
      city: "Austin",
      latitude: 30.2672,
      longitude: -97.7431,
      timezone: "America/Chicago",
    });
  });

  it("[G-C7] an absent source gives undefined fields, and a malformed x-nf-geo gives none", async () => {
    const handler = await geoHandler();
    const edge = createFetch(handler, { geo: "netlify" });
    const empty = await geoThrough(
      (req) => edge.fetch(req, undefined, undefined),
      new Request("https://app.test/geo"),
    );
    expect(empty).toEqual({});
    const broken = await geoThrough(
      (req) => edge.fetch(req, undefined, undefined),
      new Request("https://app.test/geo", { headers: { "x-nf-geo": "{not json" } }),
    );
    expect(broken).toEqual({});
  });

  it("[G-C7] trust rule: a client's geo headers are ignored unless the platform adapter is active", async () => {
    const handler = await geoHandler();
    const spoofed = (): Request =>
      new Request("https://app.test/geo", {
        headers: {
          "x-vercel-ip-country": "XX",
          "x-nf-geo": JSON.stringify({ country: { code: "YY" } }),
        },
      });
    // Plain handler (Node, or an adapter that does not read geo): no geo at all.
    expect(await geoThrough((req) => handler.fetch(req), spoofed())).toEqual({});
    // A Vercel entry does not read the Netlify header, and a Netlify entry does not read the Vercel one.
    const vercel = createFetch(handler, { geo: "vercel" });
    expect(await geoThrough((req) => vercel.fetch(req, undefined, undefined), spoofed())).toEqual({
      country: "XX",
    });
    const netlify = createFetch(handler, { geo: "netlify" });
    expect(await geoThrough((req) => netlify.fetch(req, undefined, undefined), spoofed())).toEqual({
      country: "YY",
    });
  });
});

describe("the three query parsers (G-C1)", () => {
  // Router: `validateSearch` and loaders. A number-looking value is a number, a bare key is true.
  it("[G-C1] the router decodes numbers and bare keys: page=3 is 3, flag is true, empty= is an empty string", async () => {
    const { parseSearch } = await import("@shadow-js/router/core");
    expect(parseSearch("page=3&flag&empty=&word=abc")).toEqual({
      page: 3,
      flag: true,
      empty: "",
      word: "abc",
    });
  });

  it("[G-C1] the router keeps bracket keys as plain names: a[]=1 is the key a[], not an array", async () => {
    const { parseSearch } = await import("@shadow-js/router/core");
    expect(parseSearch("a[]=1&a[]=2")).toEqual({ "a[]": [1, 2] });
  });

  // API routes: event.url.searchParams, the WHATWG parser. Every value is a string; a bare key is "".
  it('[G-C1] an API route reads strings only: page is "3", a bare key is "", a bracket key is not parsed', async () => {
    const handler = await bootWithApi({
      "/q": apiRoute({
        GET: (event) =>
          json({
            page: event.url.searchParams.get("page"),
            flag: event.url.searchParams.get("flag"),
            bracket: event.url.searchParams.get("a[]"),
          }),
      }),
    });
    const response = await handler.fetch(new Request("https://app.test/q?page=3&flag&a[]=1"));
    expect(await response.json()).toEqual({ page: "3", flag: "", bracket: "1" });
  });

  // Metadata: the search the metadata functions receive keeps strings, empty values and repeats as arrays.
  it('[G-C1] the metadata search keeps strings and "" and makes a repeated key an array', async () => {
    const { searchRecord } = await import("../src/metadata/feature");
    expect(searchRecord("page=3&flag&tag=a&tag=b&a[]=1")).toEqual({
      page: "3",
      flag: "",
      tag: ["a", "b"],
      "a[]": "1",
    });
  });
});
