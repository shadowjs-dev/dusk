import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import { createHandler } from "../src/server/index";
import type { DuskRuntimeManifest } from "../src/server/types";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

const open: ServerHandle[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

type Assets = DuskRuntimeManifest["assets"];

/** What a browser sends when the user navigates to a page. */
const NAVIGATE = { "sec-fetch-mode": "navigate" };

const ASSETS: Assets = {
  entry: "/assets/entry-abc123.js",
  css: ["/assets/app-def456.css"],
  preloads: {
    post: ["/assets/post-chunk-111.js", "/assets/post-font-222.woff2"],
    home: ["/assets/home-chunk-222.js"],
  },
  base: "/",
};

async function boot(assets: Assets = ASSETS, options: Parameters<typeof serve>[1] = {}) {
  const app = await loadApp();
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, { assets }),
    dev: true,
    onError: log.onError,
  });
  const server = await serve(handler, { port: 0, shutdownSignals: false, ...options });
  open.push(server);
  return { app, log, server, handler };
}

interface Seen {
  /** Every informational response before the final one, with its raw `Link` lines. */
  readonly hints: Array<{ status: number; links: string[] }>;
  readonly status: number;
  readonly finalLink: string | undefined;
  /** What `hints` held when the final response arrived (hints come first). */
  readonly hintsBeforeFinal: number;
}

/** Requests a path and records the 103 responses that precede the answer. */
function visit(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Seen> {
  // A header given as an empty string is left out, to send a request without it.
  const sent = Object.fromEntries(
    Object.entries({ "accept-encoding": "identity", ...NAVIGATE, ...headers }).filter(
      ([, value]) => value !== "",
    ),
  );
  return new Promise((resolve, reject) => {
    const hints: Seen["hints"] = [];
    const req = httpRequest(url, { method, headers: sent }, (res: IncomingMessage) => {
      const hintsBeforeFinal = hints.length;
      res.resume();
      res.on("end", () =>
        resolve({
          hints,
          status: res.statusCode ?? 0,
          finalLink: [res.headers["link"]].flat().join(", "),
          hintsBeforeFinal,
        }),
      );
    });
    req.on("information", (info) => {
      const links: string[] = [];
      for (let index = 0; index < info.rawHeaders.length; index += 2) {
        if (info.rawHeaders[index]?.toLowerCase() === "link")
          links.push(...(info.rawHeaders[index + 1] ?? "").split(", "));
      }
      hints.push({ status: info.statusCode, links });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Early Hints", () => {
  it("[SHINT-01] a page request gets one 103 with the entry, the stylesheets and the matched route's preloads, before the final response", async () => {
    const { server } = await boot();
    const seen = await visit(`${server.url}/posts/7`);
    expect(seen.status).toBe(200);
    expect(seen.hints).toHaveLength(1);
    expect(seen.hintsBeforeFinal).toBe(1);
    expect(seen.hints[0]?.status).toBe(103);
    expect(seen.hints[0]?.links).toEqual([
      "</assets/app-def456.css>; rel=preload; as=style",
      "</assets/entry-abc123.js>; rel=modulepreload",
      "</assets/post-chunk-111.js>; rel=modulepreload",
      "</assets/post-font-222.woff2>; rel=preload; as=font; crossorigin",
    ]);
    // The final response keeps the same Link header, so a client that ignores 103 loses nothing.
    for (const link of seen.hints[0]?.links ?? []) expect(seen.finalLink).toContain(link);
  });

  it("[SHINT-02] another route gets its own preloads, not the first route's", async () => {
    const { server } = await boot();
    const seen = await visit(`${server.url}/`);
    const links = seen.hints[0]?.links ?? [];
    expect(links).toContain("</assets/home-chunk-222.js>; rel=modulepreload");
    expect(links.join(" ")).not.toContain("post-chunk");
  });

  it("[SHINT-03] the hints are sent before the route's loader runs", async () => {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app, { assets: ASSETS }),
      dev: true,
    });
    let loadersRunAtHint: number | undefined;
    const sent: string[][] = [];
    const platform = {
      earlyHints(links: readonly string[]) {
        loadersRunAtHint = app.calls.post;
        sent.push([...links]);
      },
    };
    const response = await handler.fetch(
      new Request("http://localhost/posts/3", { headers: NAVIGATE }),
      platform,
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(loadersRunAtHint).toBe(0);
    expect(app.calls.post).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("[SHINT-04] at most 8 links, in order: stylesheets first, then the entry, then the route's", async () => {
    const preloads = Array.from({ length: 14 }, (_unused, n) => `/assets/chunk-${n}.js`);
    const { server } = await boot({ ...ASSETS, preloads: { post: preloads } });
    const seen = await visit(`${server.url}/posts/1`);
    const links = seen.hints[0]?.links ?? [];
    expect(links).toHaveLength(8);
    expect(links[0]).toContain("app-def456.css");
    expect(links[1]).toContain("entry-abc123.js");
    expect(links[7]).toContain("chunk-5.js");
  });

  it("[SHINT-05] only same-origin assets are hinted; the final Link header is still sent", async () => {
    const { server } = await boot({
      entry: "entry.js",
      css: ["app.css"],
      preloads: { post: ["post.js"] },
      base: "https://cdn.example.test/build/",
    });
    const seen = await visit(`${server.url}/posts/1`);
    expect(seen.status).toBe(200);
    expect(seen.hints).toEqual([]);
    expect(seen.finalLink).toContain(
      "<https://cdn.example.test/build/entry.js>; rel=modulepreload",
    );
  });

  it("[SHINT-06] with a mix of same-origin and cross-origin assets, only the same-origin ones are hinted", async () => {
    const { server } = await boot({
      entry: "/assets/entry.js",
      css: ["https://cdn.example.test/app.css"],
      preloads: { post: [] },
      base: "/",
    });
    const seen = await visit(`${server.url}/posts/1`);
    expect(seen.hints[0]?.links).toEqual(["</assets/entry.js>; rel=modulepreload"]);
  });

  it("[SHINT-07] earlyHints: false sends no 103, and the final Link header stays", async () => {
    const { server } = await boot(ASSETS, { earlyHints: false });
    const seen = await visit(`${server.url}/posts/7`);
    expect(seen.hints).toEqual([]);
    expect(seen.finalLink).toContain("</assets/entry-abc123.js>; rel=modulepreload");
  });

  it("[SHINT-08] no 103 for an API route, or for a client that is not a browser navigation", async () => {
    const { server } = await boot();
    expect((await visit(`${server.url}/api/items/1`)).hints).toEqual([]);
    // A script, a crawler or a load tool sends no Sec-Fetch-Mode; a fetch() from a page sends cors or same-origin.
    for (const mode of [undefined, "cors", "no-cors", "same-origin"]) {
      const seen = await visit(
        `${server.url}/posts/7`,
        mode === undefined ? { "sec-fetch-mode": "" } : { "sec-fetch-mode": mode },
      );
      expect(seen.hints, String(mode)).toEqual([]);
      expect(seen.status).toBe(200);
    }
    expect((await visit(`${server.url}/posts/7`)).hints).toHaveLength(1);
  });

  it("[SHINT-09] a page that redirects or fails still answers correctly after its hints", async () => {
    const { server } = await boot();
    const redirect = await visit(`${server.url}/old`);
    expect(redirect.status).toBe(301);
    const missing = await visit(`${server.url}/no/such/page`);
    expect(missing.status).toBe(404);
    const broken = await visit(`${server.url}/broken`);
    expect(broken.status).toBeGreaterThanOrEqual(400);
  });

  it("[SHINT-10] a request that does not speak HTTP/1.1 gets no 103", async () => {
    const { server } = await boot();
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = connect(server.port, "127.0.0.1");
      socket.on("connect", () =>
        socket.write(
          `GET /posts/7 HTTP/1.0\r\nHost: 127.0.0.1:${server.port}\r\nSec-Fetch-Mode: navigate\r\n\r\n`,
        ),
      );
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    });
    expect(raw).not.toContain("103 Early Hints");
    expect(raw).toMatch(/^HTTP\/1\.[01] 200/);
  });

  it("[SHINT-11] a handler without the hook (any other platform) sends the page as before", async () => {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app, { assets: ASSETS }),
      dev: true,
    });
    for (const platform of [undefined, null, {}, { earlyHints: "yes" }, 42]) {
      const response = await handler.fetch(
        new Request("http://localhost/posts/3", { headers: NAVIGATE }),
        platform,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("link")).toContain("rel=modulepreload");
      await response.text();
    }
  });

  it("[SHINT-13] a route rule with csr: false ships no client code, so the page is not hinted", async () => {
    const app = await loadApp();
    const handler = createHandler({
      features: allFeatures(),
      manifest: manifestOf(app, { assets: ASSETS }),
      dev: true,
      routing: { routeRules: { "/": { csr: false } } },
    });
    const sent: Array<readonly string[]> = [];
    const platform = { earlyHints: (links: readonly string[]) => void sent.push(links) };
    await (await handler.fetch(new Request("http://localhost/"), platform)).text();
    expect(sent).toEqual([]);
    await (await handler.fetch(new Request("http://localhost/posts/1"), platform)).text();
    expect(sent).toHaveLength(1);
  });

  it("[SHINT-12] the host object stays plain: no hook shows up as an environment binding", async () => {
    const seen: unknown[] = [];
    const server = await serve(
      {
        fetch: async (_request, platform) => {
          seen.push(Object.keys(platform as object), JSON.stringify(platform));
          return new Response("ok");
        },
      },
      { port: 0, shutdownSignals: false },
    );
    open.push(server);
    await fetch(`${server.url}/`);
    expect(seen).toEqual([["clientAddress"], '{"clientAddress":"127.0.0.1"}']);
  });
});
