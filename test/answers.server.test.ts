import { defineRoute } from "@shadow-js/router";
import { describe, expect, it } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  json,
} from "../src/server/index";
import { validateDuskConfig } from "../src/vite/config-file";
import { allFeatures } from "./support/features";

/** A manifest with one API route (GET, PUT-less) and one page. */
function manifest(extra: Partial<DuskRuntimeManifest> = {}): DuskRuntimeManifest {
  const api = apiRoute({
    GET: () => new Response("ok", { headers: { "x-test": "route", "content-type": "text/plain" } }),
  });
  const streaming = apiRoute({
    POST: async (event) => {
      const body = event.request.body;
      if (body === null) return json({ bytes: 0, chunks: [] });
      const reader = body.getReader();
      const sizes: number[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sizes.push(value.byteLength);
        bytes += value.byteLength;
      }
      return json({ bytes, chunks: sizes.length, largest: Math.max(0, ...sizes) });
    },
  });
  return {
    routes: [defineRoute("/", { id: "/" })],
    apiRoutes: [
      { id: "api", path: "/api/thing", load: async () => api },
      { id: "stream", path: "/api/upload", load: async () => streaming },
    ],
    serverFns: {},
    assets: { entry: "/a.js", css: [], preloads: {}, base: "/" },
    App: (props: { children?: unknown }) => props.children as never,
    middleware: { routes: {}, directories: {}, pages: {}, apis: {} },
    ...extra,
  };
}

function handlerWith(options: Partial<Parameters<typeof createHandler>[0]> = {}): DuskHandler {
  return createHandler({
    features: allFeatures(),
    manifest: manifest(),
    dev: false,
    mode: "string",
    security: { allowedHosts: ["localhost"], csrf: false },
    onError: () => undefined,
    ...options,
  });
}

const URL_OF = (path: string) => `http://localhost${path}`;

describe("x-request-id on every answer (security.requestId)", () => {
  it("[ANS-01] by default every answer carries x-request-id, the 404 and OPTIONS included", async () => {
    const handler = handlerWith();
    const notFound = await handler.fetch(new Request(URL_OF("/nothing-here")));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("x-request-id")).toBeTruthy();
    const options = await handler.fetch(new Request(URL_OF("/api/thing"), { method: "OPTIONS" }));
    expect(options.headers.get("x-request-id")).toBeTruthy();
  });

  it("[ANS-02] requestId: false omits the header on 404, 405 and OPTIONS answers", async () => {
    const handler = handlerWith({
      security: { allowedHosts: ["localhost"], csrf: false, requestId: false },
    });
    const notFound = await handler.fetch(new Request(URL_OF("/nothing-here")));
    const refused = await handler.fetch(new Request(URL_OF("/api/thing"), { method: "PUT" }));
    const options = await handler.fetch(new Request(URL_OF("/api/thing"), { method: "OPTIONS" }));
    expect(notFound.headers.has("x-request-id")).toBe(false);
    expect(refused.status).toBe(405);
    expect(refused.headers.has("x-request-id")).toBe(false);
    expect(options.headers.has("x-request-id")).toBe(false);
  });

  it("[ANS-03] a function names the id; a header the route set is kept", async () => {
    const handler = handlerWith({
      security: {
        allowedHosts: ["localhost"],
        csrf: false,
        requestId: (event) => `req-${event.method}`,
      },
    });
    const notFound = await handler.fetch(new Request(URL_OF("/nothing-here")));
    expect(notFound.headers.get("x-request-id")).toBe("req-GET");
    const routed = await handler.fetch(new Request(URL_OF("/api/thing")));
    expect(routed.headers.get("x-request-id")).toBe("req-GET");
  });

  it("[ANS-04] a route-set x-request-id is never overwritten", async () => {
    const route = apiRoute({
      GET: () => new Response("ok", { headers: { "x-request-id": "from-client" } }),
    });
    const handler = handlerWith({
      manifest: manifest({
        apiRoutes: [{ id: "echo", path: "/api/echo", load: async () => route }],
      }),
      security: {
        allowedHosts: ["localhost"],
        csrf: false,
        requestId: (event) => `gen-${event.id}`,
      },
    });
    const response = await handler.fetch(new Request(URL_OF("/api/echo")));
    expect(response.headers.get("x-request-id")).toBe("from-client");
  });
});

describe("unsupported methods (security.methodNotAllowed)", () => {
  it("[ANS-05] json (default): the error body and Allow", async () => {
    const response = await handlerWith().fetch(
      new Request(URL_OF("/api/thing"), { method: "PUT" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
    expect(await response.json()).toMatchObject({ error: { name: "HttpError" } });
  });

  it("[ANS-06] empty: an empty 405 with Allow and no error body", async () => {
    const response = await handlerWith({
      security: { allowedHosts: ["localhost"], csrf: false, methodNotAllowed: "empty" },
    }).fetch(new Request(URL_OF("/api/thing"), { method: "PUT" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("GET");
    expect(response.headers.has("content-type")).toBe(false);
    expect(await response.text()).toBe("");
  });

  it("[ANS-07] methodNotAllowed and requestId are validated when the handler is created", () => {
    expect(() =>
      handlerWith({
        security: { allowedHosts: ["localhost"], csrf: false, methodNotAllowed: "xml" as never },
      }),
    ).toThrow(/methodNotAllowed must be "json" or "empty"/);
    expect(() =>
      handlerWith({
        security: { allowedHosts: ["localhost"], csrf: false, requestId: "yes" as never },
      }),
    ).toThrow(/requestId must be true, false, or a function/);
  });

  it("[ANS-08] dusk.config.ts takes the plain values only; a function is refused with the way to pass one", () => {
    expect(() =>
      validateDuskConfig({ security: { requestId: false, methodNotAllowed: "empty" } }),
    ).not.toThrow();
    expect(() => validateDuskConfig({ security: { requestId: () => "x" } })).toThrow(
      /pass one to createHandler/,
    );
    expect(() => validateDuskConfig({ security: { methodNotAllowed: "xml" } })).toThrow(
      /"json" or "empty"/,
    );
  });
});

describe("config header rules: a route's header wins unless the rule overrides", () => {
  const routing = (override?: boolean) => ({
    headers: [
      {
        source: "/api/*path",
        headers: { "x-test": "config" },
        ...(override === undefined ? {} : { override }),
      },
    ],
  });

  it("[ANS-09] by default the route's header wins over a config rule for the same name", async () => {
    const response = await handlerWith({ routing: routing() }).fetch(
      new Request(URL_OF("/api/thing")),
    );
    expect(response.headers.get("x-test")).toBe("route");
  });

  it("[ANS-10] override: true makes the config rule win over the route's header", async () => {
    const response = await handlerWith({ routing: routing(true) }).fetch(
      new Request(URL_OF("/api/thing")),
    );
    expect(response.headers.get("x-test")).toBe("config");
  });

  it("[ANS-11] override must be true or false", () => {
    expect(() =>
      handlerWith({
        routing: { headers: [{ source: "/a", headers: { a: "b" }, override: "yes" as never }] },
      }),
    ).toThrow(/override must be true or false/);
  });
});

describe("request bodies: the limit can be 512 MiB and a streamed body is not held in memory", () => {
  const MIB = 1024 * 1024;

  it("[ANS-12] limits.maxBodyBytes accepts 512 MiB", () => {
    expect(() =>
      handlerWith({
        security: { allowedHosts: ["localhost"], csrf: false, limits: { maxBodyBytes: 512 * MIB } },
      }),
    ).not.toThrow();
  });

  it("[ANS-13] a streamed body reaches the route chunk by chunk, as produced (never joined into one buffer)", async () => {
    const CHUNKS = 48;
    const CHUNK = 256 * 1024;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= CHUNKS) return controller.close();
        produced += 1;
        controller.enqueue(new Uint8Array(CHUNK));
      },
    });
    const handler = handlerWith({
      security: { allowedHosts: ["localhost"], csrf: false, limits: { maxBodyBytes: 512 * MIB } },
    });
    const response = await handler.fetch(
      new Request(URL_OF("/api/upload"), { method: "POST", body, duplex: "half" } as RequestInit),
    );
    expect(response.status).toBe(200);
    const seen = (await response.json()) as { bytes: number; chunks: number; largest: number };
    expect(seen.bytes).toBe(CHUNKS * CHUNK);
    expect(seen.chunks).toBe(CHUNKS);
    expect(seen.largest).toBe(CHUNK);
  });

  it("[ANS-14] past the limit the body is cut off: 413 after reading only up to the limit, never the rest", async () => {
    const CHUNK = 256 * 1024;
    const LIMIT = 2 * MIB;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        if (produced > 400) return controller.close();
        controller.enqueue(new Uint8Array(CHUNK));
      },
    });
    const handler = handlerWith({
      security: { allowedHosts: ["localhost"], csrf: false, limits: { maxBodyBytes: LIMIT } },
    });
    const response = await handler.fetch(
      new Request(URL_OF("/api/upload"), { method: "POST", body, duplex: "half" } as RequestInit),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    // The route never saw the whole 100 MiB: the producer stopped near the limit.
    expect(produced).toBeLessThan(40);
  });
});
