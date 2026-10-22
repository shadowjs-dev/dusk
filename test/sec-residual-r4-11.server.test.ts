import { describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskRuntimeManifest,
  type ImageProcessor,
  type ImagesOptions,
} from "../src/server/index";
import { allFeatures } from "./support/features";

/**
 * Residual security risks R-4 and R-11 of Dusk:
 * the image endpoint caps the source fetches in flight (globally and per client address), and an SVG that
 * leaves it can never run script, whatever its declared type spelling or its body.
 */

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const encoder = new TextEncoder();

function handlerWith(images: ImagesOptions) {
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children,
  };
  return createHandler({
    features: allFeatures(),
    manifest,
    dev: true,
    security: { allowedHosts: ["example.com"] },
    images,
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

type Handler = ReturnType<typeof handlerWith>;

function remoteQuery(name: string): string {
  return `url=${encodeURIComponent(`https://cdn.example/${name}.png`)}&w=640&q=75`;
}

function ask(handler: Handler, query: string, clientAddress?: string): Promise<Response> {
  const request = new Request(`https://example.com/_dusk/image?${query}`);
  return clientAddress === undefined
    ? handler.fetch(request)
    : handler.fetch(request, { clientAddress });
}

/** A fetch whose answers the test settles by hand, so any number of requests stay in flight. */
function gatedFetch() {
  const pending: ((response: Response) => void)[] = [];
  const urls: string[] = [];
  const send: typeof fetch = (input) => {
    urls.push(String(input));
    return new Promise<Response>((resolve) => {
      pending.push(resolve);
    });
  };
  const png = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  return {
    send,
    urls,
    get inFlight(): number {
      return pending.length;
    },
    /** Answers the oldest request still waiting. */
    answer(): void {
      const next = pending.shift();
      if (next === undefined) throw new Error("no fetch is waiting");
      next(png());
    },
    answerAll(): void {
      while (pending.length > 0) this.answer();
    },
  };
}

/** Lets the handler run up to the awaited fetch of every request already started. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

describe("SEC-R4 image fetch concurrency", () => {
  it("SEC-R4-01 a client over its own cap gets 429 with Retry-After and its source is not fetched; another client is unaffected", async () => {
    const gate = gatedFetch();
    const handler = handlerWith({
      remotePatterns: ["https://cdn.example"],
      fetch: gate.send,
      maxConcurrentFetches: 10,
      maxConcurrentFetchesPerClient: 2,
    });
    const first = ask(handler, remoteQuery("a"), "203.0.113.5");
    const second = ask(handler, remoteQuery("b"), "203.0.113.5");
    await settle();
    expect(gate.inFlight).toBe(2);

    const refused = await ask(handler, remoteQuery("c"), "203.0.113.5");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(gate.urls).not.toContain("https://cdn.example/c.png");

    const other = ask(handler, remoteQuery("d"), "203.0.113.6");
    await settle();
    expect(gate.urls).toContain("https://cdn.example/d.png");

    gate.answerAll();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await other).status).toBe(200);
  });

  it("SEC-R4-02 over the global cap every client gets 503 with Retry-After, and a finished fetch frees its slot", async () => {
    const gate = gatedFetch();
    const handler = handlerWith({
      remotePatterns: ["https://cdn.example"],
      fetch: gate.send,
      maxConcurrentFetches: 2,
      maxConcurrentFetchesPerClient: 2,
    });
    const one = ask(handler, remoteQuery("a"), "203.0.113.1");
    const two = ask(handler, remoteQuery("b"), "203.0.113.2");
    await settle();
    const refused = await ask(handler, remoteQuery("c"), "203.0.113.3");
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(gate.urls).toEqual(["https://cdn.example/a.png", "https://cdn.example/b.png"]);

    gate.answer();
    expect((await one).status).toBe(200);
    const again = ask(handler, remoteQuery("c"), "203.0.113.3");
    await settle();
    expect(gate.urls).toContain("https://cdn.example/c.png");
    gate.answerAll();
    expect((await two).status).toBe(200);
    expect((await again).status).toBe(200);
  });

  it("SEC-R4-03 a slot is released when the source fails, or is too large", async () => {
    let mode: "reject" | "redirect" | "large" | "ok" = "reject";
    const send: typeof fetch = async () => {
      if (mode === "reject") throw new Error("socket hang up");
      if (mode === "redirect")
        return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      if (mode === "large")
        return new Response(new Uint8Array(64), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    };
    const handler = handlerWith({
      remotePatterns: ["https://cdn.example"],
      fetch: send,
      maxSourceBytes: 16,
      maxConcurrentFetches: 1,
      maxConcurrentFetchesPerClient: 1,
    });
    for (const next of ["reject", "redirect", "large"] as const) {
      mode = next;
      const failed = await ask(handler, remoteQuery(next), "203.0.113.9");
      expect([500, 502], next).toContain(failed.status);
    }
    mode = "ok";
    expect((await ask(handler, remoteQuery("fine"), "203.0.113.9")).status).toBe(200);
  });

  it("SEC-R4-04 a slow processor and a slow local source hold their slot too, and the slot is freed when the processor throws", async () => {
    const release: (() => void)[] = [];
    const processor: ImageProcessor = {
      process: () =>
        new Promise((resolve) => {
          release.push(() => resolve(undefined));
        }),
    };
    const handler = handlerWith({
      source: async () => ({ bytes: PNG, contentType: "image/png" }),
      processor,
      maxConcurrentFetches: 4,
      maxConcurrentFetchesPerClient: 1,
    });
    const slow = ask(handler, "url=%2Fa.png&w=640&q=75", "203.0.113.4");
    await settle();
    expect(release.length).toBe(1);
    const refused = await ask(handler, "url=%2Fb.png&w=640&q=75", "203.0.113.4");
    expect(refused.status).toBe(429);
    release.shift()?.();
    expect((await slow).status).toBe(200);

    const throwing = handlerWith({
      source: async () => ({ bytes: PNG, contentType: "image/png" }),
      processor: {
        process: () => Promise.reject(new Error("codec exploded")),
      },
      maxConcurrentFetches: 1,
      maxConcurrentFetchesPerClient: 1,
    });
    for (let round = 0; round < 3; round++) {
      expect((await ask(throwing, "url=%2Fa.png&w=640&q=75", "203.0.113.4")).status).toBe(500);
    }
  });

  it("SEC-R4-05 the bookkeeping is bounded: one entry per client in flight, at most the global cap, none when idle", async () => {
    const { createFetchLimiter } = await import("../src/server/image-limit");
    const limiter = createFetchLimiter({ global: 4, perClient: 2 });
    const releases: (() => void)[] = [];
    for (let client = 0; client < 4; client++) {
      const permit = limiter.acquire(`client-${client}`);
      expect(typeof permit).toBe("function");
      if (typeof permit === "function") releases.push(permit);
    }
    expect(limiter.clients).toBe(4);
    // At the bound: further distinct clients are refused and add nothing to the map.
    for (let client = 4; client < 1000; client++) {
      expect(limiter.acquire(`client-${client}`)).toBe("global");
    }
    expect(limiter.clients).toBe(4);
    expect(limiter.active).toBe(4);
    for (const release of releases) release();
    expect(limiter.clients).toBe(0);
    expect(limiter.active).toBe(0);

    // Many distinct clients over time never accumulate: the entry goes with its last permit.
    for (let client = 0; client < 5000; client++) {
      const permit = limiter.acquire(`visitor-${client}`);
      expect(typeof permit).toBe("function");
      if (typeof permit === "function") permit();
    }
    expect(limiter.clients).toBe(0);
  });

  it("SEC-R4-06 releasing twice frees one slot only, and a client without an address is held to the global cap alone", async () => {
    const { createFetchLimiter } = await import("../src/server/image-limit");
    const limiter = createFetchLimiter({ global: 3, perClient: 1 });
    const first = limiter.acquire("a");
    if (typeof first !== "function") throw new Error("expected a permit");
    expect(limiter.acquire("a")).toBe("client");
    first();
    first();
    expect(limiter.active).toBe(0);
    const again = limiter.acquire("a");
    expect(typeof again).toBe("function");
    // No address: the per-client cap does not apply (they would all share one bucket), the global one does.
    const anonymous = [limiter.acquire(undefined), limiter.acquire(undefined)];
    expect(anonymous.every((permit) => typeof permit === "function")).toBe(true);
    expect(limiter.clients).toBe(1);
    expect(limiter.acquire(undefined)).toBe("global");
  });

  it("SEC-R4-07 the defaults cap a client at 16 and the whole endpoint at 32, with no configuration", async () => {
    const gate = gatedFetch();
    const handler = handlerWith({ remotePatterns: ["https://cdn.example"], fetch: gate.send });
    const held: Promise<Response>[] = [];
    for (let n = 0; n < 16; n++) held.push(ask(handler, remoteQuery(`a${n}`), "198.51.100.1"));
    await settle();
    expect(gate.inFlight).toBe(16);
    expect((await ask(handler, remoteQuery("over"), "198.51.100.1")).status).toBe(429);
    for (let n = 0; n < 16; n++) held.push(ask(handler, remoteQuery(`b${n}`), "198.51.100.2"));
    await settle();
    expect(gate.inFlight).toBe(32);
    expect((await ask(handler, remoteQuery("full"), "198.51.100.3")).status).toBe(503);
    gate.answerAll();
    for (const response of await Promise.all(held)) expect(response.status).toBe(200);
  });

  it("SEC-R4-08 requests that behave keep working: sequential requests never meet the cap, a refused parameter does not take a slot", async () => {
    const gate = gatedFetch();
    const handler = handlerWith({
      remotePatterns: ["https://cdn.example"],
      fetch: gate.send,
      maxConcurrentFetches: 1,
      maxConcurrentFetchesPerClient: 1,
    });
    for (let n = 0; n < 5; n++) {
      const pending = ask(handler, remoteQuery(`s${n}`), "203.0.113.7");
      await settle();
      gate.answer();
      expect((await pending).status).toBe(200);
    }
    // Bad parameters are answered 400 before the cap is consulted.
    const held = ask(handler, remoteQuery("held"), "203.0.113.7");
    await settle();
    expect((await ask(handler, "url=%2Fa.png&w=641&q=75", "203.0.113.7")).status).toBe(400);
    gate.answerAll();
    expect((await held).status).toBe(200);
  });

  it("SEC-R4-09 the cap options are validated at creation and are known image options", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => handlerWith({ maxConcurrentFetches: bad }), `global ${bad}`).toThrow(RangeError);
      expect(() => handlerWith({ maxConcurrentFetchesPerClient: bad }), `client ${bad}`).toThrow(
        RangeError,
      );
    }
    expect(() =>
      handlerWith({ maxConcurrentFetches: 8, maxConcurrentFetchesPerClient: 4 }),
    ).not.toThrow();
  });
});

const SVG_WITH_ANIMATION = encoder.encode(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<a xlink:href="#"><animate attributeName="href" values="javascript:alert(1)"/>',
    '<set attributeName="href" to="javascript:alert(2)"/><text>x</text></a>',
    "<script>alert(3)</script>",
    "</svg>",
  ].join(""),
);

function expectLocked(response: Response): void {
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("sandbox");
  expect(csp).not.toContain("allow-scripts");
  expect(response.headers.get("content-disposition")).toBe("attachment");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("SEC-R11 SVG served by the image endpoint", () => {
  it("SEC-R11-01 an SVG with script and animated javascript: hrefs is served locked: sandbox policy, attachment, nosniff, bytes unchanged", async () => {
    const handler = handlerWith({
      source: async () => ({ bytes: SVG_WITH_ANIMATION, contentType: "image/svg+xml" }),
    });
    const response = await ask(handler, "url=%2Flogo.svg&w=640&q=75");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expectLocked(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(SVG_WITH_ANIMATION);
  });

  it("SEC-R11-02 the lock does not depend on how the type is spelled: parameters, case and spaces", async () => {
    for (const declared of [
      "image/svg+xml; charset=utf-8",
      "IMAGE/SVG+XML",
      "Image/Svg+Xml ;charset=UTF-8",
      " image/svg+xml",
    ]) {
      const handler = handlerWith({
        source: async () => ({ bytes: SVG_WITH_ANIMATION, contentType: declared }),
      });
      const response = await ask(handler, "url=%2Flogo.svg&w=640&q=75");
      expect(response.status, declared).toBe(200);
      expectLocked(response);
    }
  });

  it("SEC-R11-03 a remote SVG is locked, and its type is read case-insensitively", async () => {
    for (const declared of ["image/svg+xml", "image/svg+xml; charset=utf-8", "Image/SVG+XML"]) {
      const handler = handlerWith({
        remotePatterns: ["https://cdn.example"],
        fetch: async () =>
          new Response(SVG_WITH_ANIMATION, { status: 200, headers: { "content-type": declared } }),
      });
      const response = await ask(
        handler,
        `url=${encodeURIComponent("https://cdn.example/a.svg")}&w=640&q=75`,
      );
      expect(response.status, declared).toBe(200);
      expect(response.headers.get("content-type"), declared).toBe("image/svg+xml");
      expectLocked(response);
    }
  });

  it("SEC-R11-04 an SVG a processor returns is locked as well, and so is its 304", async () => {
    const processor: ImageProcessor = {
      process: async () => ({
        bytes: SVG_WITH_ANIMATION,
        contentType: "image/svg+xml; charset=utf-8",
      }),
    };
    const handler = handlerWith({
      source: async () => ({ bytes: PNG, contentType: "image/png" }),
      processor,
    });
    const response = await ask(handler, "url=%2Fhero.png&w=640&q=75");
    expect(response.status).toBe(200);
    expectLocked(response);
    const etag = response.headers.get("etag") ?? "";
    const revalidated = await handler.fetch(
      new Request("https://example.com/_dusk/image?url=%2Fhero.png&w=640&q=75", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(revalidated.status).toBe(304);
    expectLocked(revalidated);
  });

  it("SEC-R11-05 a raster image keeps its inline disposition and needs no sandbox policy", async () => {
    const handler = handlerWith({
      source: async () => ({ bytes: PNG, contentType: "image/png" }),
    });
    const response = await ask(handler, "url=%2Fhero.png&w=640&q=75");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
