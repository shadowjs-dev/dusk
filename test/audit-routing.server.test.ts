import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest, type Middleware } from "../src/server/index";
import { clientEntrySource, serverEntrySource } from "../src/vite/virtual";
import { errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/*
 * Routing audit, area B: each test name carries its gap id.
 */

/** A page source with the given pages under one root. `pages` is the list of [route id, path, class] rows. */
function pagesSource(
  pages: readonly (readonly [string, string, string])[],
  apiSource = "",
): string {
  const defs = pages
    .map(
      ([id, path, cls]) =>
        `const ${id.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())} = defineRoute(${JSON.stringify(path)}, { id: ${JSON.stringify(id)}, component: () => <p class="${cls}">${cls}</p> });`,
    )
    .join("\n");
  const children = pages
    .map(([id]) => id.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase()))
    .join(", ");
  return `
import { defineRoute, Outlet } from "@shadow-js/router";
import { apiRoute, json } from "@start/server";
${defs}
const root = defineRoute("", { id: "root", component: function Root() { return <main><Outlet /></main>; }, children: [${children}] });
export const routes = [root];
export function App(props) { return <div class="app">{props.children}</div>; }
${apiSource}
`;
}

interface Boot {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  log: ReturnType<typeof errorLog>;
}

/** Boots a handler over the pages source. `options` is passed to `createHandler` (the manifest keys too). */
async function bootPages(
  source: string,
  options: {
    caseSensitive?: boolean;
    trailingSlash?: "never" | "always" | "preserve";
    /** The API routes of the manifest, given the loaded module namespace. */
    apis?: (app: Record<string, unknown>) => DuskRuntimeManifest["apiRoutes"];
    middleware?: Middleware[];
    /** Production by default in the G-B9 negotiation tests; the other groups run in development. */
    dev?: boolean;
    /** The mount base (`/app`), for the tests that check the base is kept on a redirect. */
    base?: string;
  } = {},
): Promise<Boot> {
  const app = await load<{
    routes: DuskRuntimeManifest["routes"];
    App: DuskRuntimeManifest["App"];
  }>(source);
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: options.apis === undefined ? [] : options.apis(app as Record<string, unknown>),
      serverFns: {},
      assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
      App: app.App,
      ...(options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
    },
    dev: options.dev ?? true,
    // A production handler refuses to start without the host names it answers for.
    security: { allowedHosts: ["localhost"] },
    onError: log.onError,
    middleware: options.middleware ?? [],
    ...(options.trailingSlash === undefined ? {} : { trailingSlash: options.trailingSlash }),
    ...(options.base === undefined ? {} : { base: options.base }),
  });
  return {
    log,
    fetch: (url, init) => handler.fetch(new Request(`http://localhost${url}`, init)),
  };
}

/** An API route entry whose module is `value`, a member of the loaded source. */
const apiEntry = (id: string, path: string, value: unknown) => ({
  id,
  path,
  load: async () => value as never,
});

/** The API exports of the routing test source (appended to a page source). */
const API_SOURCE = `
export const plain = apiRoute({ GET: () => json({ get: true }), POST: () => json({ post: true }) });
export const contactApi = apiRoute({ POST: () => json({ api: "contact-post" }) });
export const items = apiRoute({ GET: () => json({ items: true }), POST: () => json({ created: true }) });
export const home = apiRoute({ GET: () => json({ home: true }) });
`;

/** The ALL exports: only the G-B1 tests load them, so the other groups fail on their own cause. */
const ALL_SOURCE = `
export const catchAll = apiRoute({ ALL: (event) => json({ all: event.method }) });
export const mixed = apiRoute({ ALL: (event) => json({ all: event.method }), GET: () => json({ get: true }) });
`;

const ORIGIN = { origin: "http://localhost" };

describe("[G-B1] the ALL method export", () => {
  const apis = (app: Record<string, unknown>) => [
    apiEntry("catch-all", "/any", app["catchAll"]),
    apiEntry("mixed", "/mixed", app["mixed"]),
  ];

  it("[G-B1] ALL answers GET, POST, PUT, PATCH and DELETE with one handler", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE + ALL_SOURCE), { apis });
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.fetch("/any", { method, headers: ORIGIN });
      expect(await response.json(), method).toEqual({ all: method });
    }
  });

  it("[G-B1] ALL answers HEAD and OPTIONS when they are not exported (HEAD has no body)", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE + ALL_SOURCE), { apis });
    const head = await app.fetch("/any", { method: "HEAD", headers: ORIGIN });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const options = await app.fetch("/any", { method: "OPTIONS", headers: ORIGIN });
    expect(options.status).toBe(200);
    expect(await options.json()).toEqual({ all: "OPTIONS" });
  });

  it("[G-B1] an explicit method export wins over ALL; the other methods still reach ALL", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE + ALL_SOURCE), { apis });
    expect(await (await app.fetch("/mixed")).json()).toEqual({ get: true });
    expect(await (await app.fetch("/mixed", { method: "POST", headers: ORIGIN })).json()).toEqual({
      all: "POST",
    });
  });
});

describe("[G-B3] the trailing-slash policy applies to API routes", () => {
  const apis = (app: Record<string, unknown>) => [
    apiEntry("items", "/items", app["items"]),
    apiEntry("home", "/", app["home"]),
  ];

  it("[G-B3] always: /items is a 308 to /items/, and /items/ answers", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), { apis, trailingSlash: "always" });
    const redirect = await app.fetch("/items");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/items/");
    expect(await (await app.fetch("/items/")).json()).toEqual({ items: true });
  });

  it("[G-B3] always keeps the query string on the redirect", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), { apis, trailingSlash: "always" });
    const redirect = await app.fetch("/items?page=2");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/items/?page=2");
  });

  it("[G-B3] never: /items/ is a 308 to /items, and a POST keeps its method through the 308", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), { apis, trailingSlash: "never" });
    const redirect = await app.fetch("/items/");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/items");
    const post = await app.fetch("/items/", { method: "POST", headers: ORIGIN });
    expect(post.status).toBe(308);
    expect(post.headers.get("location")).toBe("/items");
    expect(await (await app.fetch("/items")).json()).toEqual({ items: true });
  });

  it('[G-B3] preserve (the audit\'s "ignore"): both forms answer, nothing is redirected', async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), { apis, trailingSlash: "preserve" });
    expect((await app.fetch("/items")).status).toBe(200);
    expect((await app.fetch("/items/")).status).toBe(200);
  });

  it("[G-B3] under a base path the redirect keeps the base, and the base root is not redirected", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), {
      apis,
      trailingSlash: "always",
      base: "/app",
    });
    const redirect = await app.fetch("/app/items?page=2");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/app/items/?page=2");
    expect((await app.fetch("/app/items/")).status).toBe(200);
    expect((await app.fetch("/app")).status).toBe(200);
  });

  it("[G-B3] the canonical form of / is never redirected, under every policy", async () => {
    for (const trailingSlash of ["always", "never", "preserve"] as const) {
      const app = await bootPages(pagesSource([], API_SOURCE), { apis, trailingSlash });
      const response = await app.fetch("/");
      expect(response.status, trailingSlash).toBe(200);
      expect(await response.json(), trailingSlash).toEqual({ home: true });
    }
  });
});

describe("[G-B8] Allow lists and unrecognized methods", () => {
  it("[G-B8] a path with a page and an API route answers 405 with the union of both Allow lists", async () => {
    const app = await bootPages(
      pagesSource([["contact", "/contact", "contact-page"]], API_SOURCE),
      { apis: (mod) => [apiEntry("contact-api", "/contact", mod["contactApi"])] },
    );
    const refused = await app.fetch("/contact", { method: "PUT", headers: ORIGIN });
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
  });

  it("[G-B8] OPTIONS on a path with a page and an API route answers 204 with the union Allow", async () => {
    const app = await bootPages(
      pagesSource([["contact", "/contact", "contact-page"]], API_SOURCE),
      { apis: (mod) => [apiEntry("contact-api", "/contact", mod["contactApi"])] },
    );
    const options = await app.fetch("/contact", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
  });

  it("[G-B8] an unrecognized method token answers 501 with Allow, not 405", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), {
      apis: (mod) => [apiEntry("plain", "/plain", mod["plain"])],
    });
    for (const method of ["PURGE", "FOO"]) {
      const response = await app.fetch("/plain", { method, headers: ORIGIN });
      expect(response.status, method).toBe(501);
      expect(response.headers.get("allow"), method).toBe(
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
  });

  it("[G-B8] a known method the route does not export stays 405, with the route's own Allow", async () => {
    const app = await bootPages(pagesSource([], API_SOURCE), {
      apis: (mod) => [apiEntry("plain", "/plain", mod["plain"])],
    });
    const refused = await app.fetch("/plain", { method: "PUT", headers: ORIGIN });
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
  });
});

describe("[G-B4] router.caseSensitive holds at runtime", () => {
  const upper = [["about", "/About", "about-upper"]] as const;
  const both = [
    ["about", "/About", "about-upper"],
    ["about-lower", "/about", "about-lower"],
  ] as const;

  it("[G-B4] default policy: one page at /About answers /about too (ASCII case folds)", async () => {
    const app = await bootPages(pagesSource(upper));
    const lower = await app.fetch("/about");
    expect(lower.status).toBe(200);
    expect(await lower.text()).toContain('class="about-upper"');
    expect((await app.fetch("/About")).status).toBe(200);
  });

  it("[G-B4] caseSensitive: true, one page at /About: /About answers, /about is 404", async () => {
    const app = await bootPages(pagesSource(upper), { caseSensitive: true });
    expect((await app.fetch("/About")).status).toBe(200);
    expect((await app.fetch("/about")).status).toBe(404);
  });

  it("[G-B4] caseSensitive: true, pages at /About and /about: both answer their own page", async () => {
    const app = await bootPages(pagesSource(both), { caseSensitive: true });
    const upperResponse = await app.fetch("/About");
    expect(upperResponse.status).toBe(200);
    expect(await upperResponse.text()).toContain('class="about-upper"');
    const lowerResponse = await app.fetch("/about");
    expect(lowerResponse.status).toBe(200);
    expect(await lowerResponse.text()).toContain('class="about-lower"');
  });

  it("[G-B4] the server entry writes caseSensitive into the manifest only when the build sets it", () => {
    const input = {
      dev: false,
      base: "",
      generatedTree: "/app/src/routeTree.gen.ts",
      appFile: undefined,
      entryServerFile: undefined,
      apiRoutes: [],
      streams: [],
      serverFns: [],
      assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
    };
    const sensitive = serverEntrySource({ ...input, caseSensitive: true });
    expect(sensitive).toContain("App, caseSensitive: true };");
    expect(serverEntrySource(input)).not.toContain("caseSensitive");
  });

  it("[G-B4] the client entry starts the browser router case-sensitive when the build sets it", () => {
    const input = {
      base: "",
      generatedTree: "/app/src/routeTree.gen.ts",
      appFile: undefined,
    };
    expect(clientEntrySource({ ...input, caseSensitive: true })).toContain(
      "router: { caseSensitive: true }",
    );
    expect(clientEntrySource(input)).not.toContain("caseSensitive");
  });
});

/** The response helper and stream sources of the G-B9 tests. */
const RESPONSE_SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { apiRoute, html, json } from "@start/server";
const boom = defineRoute("/boom", { id: "boom", loader: () => { throw new Error("db connection string postgres://user:pass@host"); }, component: () => <p>never</p> });
const root = defineRoute("", { id: "root", component: function Root() { return <main><Outlet /></main>; }, children: [boom] });
export const routes = [root];
export function App(props) { return <div class="app">{props.children}</div>; }
function streamOf(chunks) {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
}
export const page = apiRoute({ GET: () => html("<p class=\\"raw\\">hi</p>") });
export const streamed = apiRoute({ GET: () => new Response(streamOf(["a", "b"]), { status: 201, headers: { "content-type": "text/plain", "x-chunks": "2" } }) });
export const bareStream = apiRoute({ GET: () => streamOf(["x", "y"]) });
`;

const decoder = new TextDecoder();

/** The text of a streamed response, read chunk by chunk. */
async function readAll(response: Response): Promise<{ text: string; chunks: number }> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("the response has no body");
  let text = "";
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += 1;
    text += decoder.decode(value, { stream: true });
  }
  return { text, chunks };
}

describe("[G-B9] streaming, the html() helper and content negotiation", () => {
  const apis = (app: Record<string, unknown>) => [
    apiEntry("page", "/page", app["page"]),
    apiEntry("streamed", "/streamed", app["streamed"]),
    apiEntry("bare-stream", "/bare-stream", app["bareStream"]),
  ];

  it("[G-B9] a ReadableStream body returned by an API route is streamed through: status, headers and chunks", async () => {
    const app = await bootPages(RESPONSE_SOURCE, { apis });
    const response = await app.fetch("/streamed");
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-chunks")).toBe("2");
    const { text, chunks } = await readAll(response);
    expect(text).toBe("ab");
    expect(chunks).toBeGreaterThanOrEqual(1);
  });

  it("[G-B9] a bare ReadableStream returned by an API route is streamed, not serialized as JSON", async () => {
    const app = await bootPages(RESPONSE_SOURCE, { apis });
    const response = await app.fetch("/bare-stream");
    expect(response.status).toBe(200);
    expect((await readAll(response)).text).toBe("xy");
  });

  it("[G-B9] html() answers text/html with the given body, and keeps a content-type the handler set", async () => {
    const app = await bootPages(RESPONSE_SOURCE, { apis });
    const response = await app.fetch("/page");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe('<p class="raw">hi</p>');
  });

  it("[G-B9] production: Accept application/json on a failing page answers JSON, without the message", async () => {
    const app = await bootPages(RESPONSE_SOURCE, { dev: false });
    const response = await app.fetch("/boom", { headers: { accept: "application/json" } });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.text();
    expect(body).not.toContain("postgres://");
    expect(JSON.parse(body)).toMatchObject({ error: { status: 500 } });
  });

  it("[G-B9] production: Accept text/html, or no Accept, on the same failing page answers HTML", async () => {
    const app = await bootPages(RESPONSE_SOURCE, { dev: false });
    for (const accept of ["text/html", undefined, "text/html, application/json"]) {
      const response = await app.fetch(
        "/boom",
        accept === undefined ? {} : { headers: { accept } },
      );
      expect(response.status, String(accept)).toBe(500);
      expect(response.headers.get("content-type"), String(accept)).toContain("text/html");
      expect(await response.text(), String(accept)).not.toContain("postgres://");
    }
  });

  it("[G-B9] production: when the JSON type comes first in Accept, the JSON answer wins", async () => {
    const app = await bootPages(RESPONSE_SOURCE, { dev: false });
    const response = await app.fetch("/boom", {
      headers: { accept: "application/json, text/html" },
    });
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("[G-B2] a param is decoded, so %2F becomes / inside one segment", () => {
  it("[G-B2] the decode behavior is pinned: %2F in a param reaches the handler as /", async () => {
    const app = await bootPages(
      pagesSource(
        [],
        `${API_SOURCE}\nexport const file = apiRoute({ GET: (event) => json({ name: event.params.name }) });\n`,
      ),
      {
        apis: (mod) => [apiEntry("file", "/files/:name", mod["file"])],
      },
    );
    const response = await app.fetch("/files/a%2Fb.txt");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "a/b.txt" });
  });
});
