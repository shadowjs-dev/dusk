import { beforeAll, describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { draftMode } from "../src/features/draft-mode";
import { images } from "../src/features/images";
import { isr } from "../src/features/isr";
import { pages } from "../src/features/pages";
import { routing } from "../src/features/routing";
import { rpc } from "../src/features/rpc";
import { streams } from "../src/features/streams";
import {
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  serverFn,
} from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { type AppModule, loadApp, manifestOf } from "./support/app";

/**
 * The features of a handler: nothing is in a handler unless it is listed, a manifest or option that needs a
 * missing feature is refused at creation with the factory to add, and a handler with some features answers
 * exactly those endpoints.
 */

let app: AppModule;

beforeAll(async () => {
  app = await loadApp();
});

/** A manifest with no routes, no API routes and no server functions: the smallest a handler accepts. */
function bareManifest(): DuskRuntimeManifest {
  return {
    routes: [],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/assets/app.js", css: [], preloads: {}, base: "/" },
    App: app.App,
  };
}

describe("a handler has only the features it is given", () => {
  it("[FEAT-01] with no features it answers the health endpoint and nothing else", async () => {
    const handler: DuskHandler = createHandler({ dev: true, manifest: bareManifest() });
    const client = createTestClient(handler);
    const health = await client.get("/_dusk/health");
    expect(health.status).toBe(200);
    expect((await client.get("/")).status).toBe(404);
    expect((await client.get("/api/plain")).status).toBe(404);
    expect(handler.upgrade).toBeUndefined();
    await expect(handler.renderShell()).rejects.toThrow(
      'createHandler: renderShell() needs pages(). Import it from the "@shadow-js/dusk/features/pages" subpath and add it to features.',
    );
  });

  it("[FEAT-02] with apiRoutes() alone, API routes answer and a page path is a 404", async () => {
    const manifest = { ...manifestOf(app), routes: [], serverFns: {} };
    const handler = createHandler({ dev: true, manifest, features: [apiRoutes()] });
    const client = createTestClient(handler);
    expect((await client.get("/api/plain")).status).toBe(200);
    expect((await client.get("/about")).status).toBe(404);
    expect(handler.upgrade).toBeUndefined();
  });

  it("[FEAT-13] server functions answer with rpc() alone: no pages are needed to call one", async () => {
    const handler = createHandler({
      dev: true,
      manifest: { ...manifestOf(app), routes: [], apiRoutes: [] },
      features: [rpc()],
    });
    const result = await createTestClient(handler).serverFn("echo", { text: "hi" });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ text: "hi" });
  });

  it("[FEAT-14] a single-flight server function without pages() fails with the factory to add", async () => {
    const single = serverFn({ singleFlight: true }, (input: unknown) => input);
    const handler = createHandler({
      dev: true,
      // The refusal is the expected outcome: it goes to the error sink, not to the console.
      onError: () => undefined,
      manifest: {
        ...manifestOf(app),
        routes: [],
        apiRoutes: [],
        serverFns: { once: { load: async () => single } },
      },
      features: [rpc()],
    });
    const result = await createTestClient(handler).serverFn("once", { ok: 1 });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("pages()");
  });

  it("[FEAT-03] features are installed in a fixed order, so the list order does not matter", () => {
    const first = createHandler({
      dev: true,
      manifest: bareManifest(),
      features: [isr(), pages()],
    });
    const second = createHandler({
      dev: true,
      manifest: bareManifest(),
      features: [pages(), isr()],
    });
    expect(typeof first.fetch).toBe("function");
    expect(typeof second.fetch).toBe("function");
  });
});

describe("creation-time refusals name the feature to add", () => {
  it("[FEAT-04] page routes without pages() are refused", () => {
    expect(() => createHandler({ dev: true, manifest: manifestOf(app) })).toThrow(
      /needs pages\(\)[\s\S]*"@shadow-js\/dusk\/features\/pages"/,
    );
  });

  it("[FEAT-05] API routes without apiRoutes() are refused", () => {
    expect(() =>
      createHandler({ dev: true, manifest: { ...manifestOf(app), routes: [] }, features: [] }),
    ).toThrow(/needs apiRoutes\(\)[\s\S]*"@shadow-js\/dusk\/features\/api-routes"/);
  });

  it("[FEAT-06] server functions without rpc() are refused", () => {
    expect(() =>
      createHandler({
        dev: true,
        manifest: { ...manifestOf(app), routes: [], apiRoutes: [] },
        features: [pages()],
      }),
    ).toThrow(/needs rpc\(\)[\s\S]*"@shadow-js\/dusk\/features\/rpc"/);
  });

  it("[FEAT-07] a stream route without streams() is refused", () => {
    const manifest: DuskRuntimeManifest = {
      ...bareManifest(),
      streams: [{ id: "feed", path: "/feed", kinds: ["SSE"], load: async () => ({}) }],
    };
    expect(() => createHandler({ dev: true, manifest })).toThrow(/needs streams\(\)/);
  });

  it("[FEAT-08] an option that needs a missing feature is refused and names the option", () => {
    const manifest = bareManifest();
    expect(() => createHandler({ dev: true, manifest, cache: { maxEntries: 10 } })).toThrow(
      /"cache" needs isr\(\)/,
    );
    expect(() =>
      createHandler({ dev: true, manifest, images: { source: async () => undefined } }),
    ).toThrow(/"images" needs images\(\)/);
    expect(() => createHandler({ dev: true, manifest, streams: { sseHeartbeatMs: 5 } })).toThrow(
      /"streams" needs streams\(\)/,
    );
    expect(() =>
      createHandler({ dev: true, manifest, draft: { secretEnv: "PREVIEW_SECRET" } }),
    ).toThrow(/"draft" needs draftMode\(\)/);
    expect(() => createHandler({ dev: true, manifest, rpc: { maxBatchSize: 3 } })).toThrow(
      /"rpc" needs rpc\(\)/,
    );
  });

  it("[FEAT-09] a page-only option without pages() is refused, not ignored", () => {
    expect(() =>
      createHandler({ dev: true, manifest: bareManifest(), document: { lang: "fr" } }),
    ).toThrow(/"document" needs pages\(\)/);
  });

  it("[FEAT-10] isr() without pages() is refused: the cache stores what the pages render", () => {
    expect(() => createHandler({ dev: true, manifest: bareManifest(), features: [isr()] })).toThrow(
      /isr\(\)[\s\S]*pages\(\)/,
    );
  });

  it("[FEAT-11] a feature listed twice, or something that is not a feature, is refused", () => {
    expect(() =>
      createHandler({ dev: true, manifest: bareManifest(), features: [pages(), pages()] }),
    ).toThrow(/pages\(\) is listed twice/);
    expect(() =>
      createHandler({
        dev: true,
        manifest: bareManifest(),
        features: [{ name: "nope" } as unknown as ReturnType<typeof pages>],
      }),
    ).toThrow(/feature objects/);
  });

  it("[FEAT-12] every feature factory returns a feature with its own name", () => {
    expect([
      pages().name,
      apiRoutes().name,
      isr().name,
      rpc().name,
      streams().name,
      images().name,
      draftMode().name,
      routing().name,
    ]).toEqual(["pages", "apiRoutes", "isr", "rpc", "streams", "images", "draftMode", "routing"]);
  });
});

describe("per-feature option resolution", () => {
  it("[FEAT-15] a routing option without routing() is refused and names the feature and subpath", () => {
    expect(() =>
      createHandler({
        dev: true,
        manifest: bareManifest(),
        routing: { redirects: [{ source: "/old", destination: "/new" }] },
      }),
    ).toThrow(
      'createHandler: the option "routing" needs routing(). Import it from the "@shadow-js/dusk/features/routing" subpath and add it to features.',
    );
  });

  it("[FEAT-16] routing() validates the option at creation: a bad rule throws before any request", () => {
    expect(() =>
      createHandler({
        dev: true,
        manifest: bareManifest(),
        features: [routing()],
        routing: { redirects: [{ source: "/old", destination: 42 as unknown as string }] },
      }),
    ).toThrow(TypeError);
  });

  it("[FEAT-17] routing() applies the declared redirect", async () => {
    const handler = createHandler({
      dev: true,
      manifest: bareManifest(),
      features: [routing()],
      routing: { redirects: [{ source: "/old", destination: "/new", permanent: true }] },
    });
    const response = await handler.fetch(new Request("http://localhost/old"));
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/new");
  });

  it("[FEAT-18] streams() still validates the streams option at creation", () => {
    expect(() =>
      createHandler({
        dev: true,
        manifest: bareManifest(),
        features: [streams()],
        streams: { sseHeartbeatMs: 0 },
      }),
    ).toThrow(/streams\.sseHeartbeatMs must be a positive integer/);
  });

  it("[FEAT-19] draftMode() still validates the draft option at creation", () => {
    expect(() =>
      createHandler({
        dev: true,
        manifest: bareManifest(),
        features: [draftMode()],
        draft: { secretEnv: "not a name" },
      }),
    ).toThrow(/draft\.secretEnv must be the name of an environment variable/);
  });

  it("[FEAT-20] a handler without the routing option needs no routing() feature", async () => {
    const handler = createHandler({ dev: true, manifest: bareManifest() });
    expect((await handler.fetch(new Request("http://localhost/old"))).status).toBe(404);
  });
});
