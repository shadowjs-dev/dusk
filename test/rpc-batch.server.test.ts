import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnStub } from "../src/client/fn";
import { isHttpError } from "../src/internal/http-error";
import { isRedirect } from "../src/internal/redirect";
import { createHandler, type DuskHandler, type DuskRuntimeManifest } from "../src/server/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * Batching and single flight: the browser stub sends the calls of one tick as one POST, and a
 * single-flight mutation answers with the loader data of the page the browser is on. Every test runs
 * the real handler in-process; `fetch` is replaced by a function that calls it, with the `Origin` a
 * browser sends.
 */
const SOURCE = `
import { defineRoute, Outlet, useLoaderData } from "@shadow-js/router";
import { serverFn, HttpError, redirect, getRequestEvent } from "@start/server";


export const calls = { add: 0, guarded: 0, flight: 0, news: 0, gate: 0 };
export const saved = [];

export const add = serverFn({}, (input) => { calls.add += 1; saved.push(input.n); return { n: input.n, total: saved.length }; });
export const fails = serverFn({}, () => { throw new HttpError(403, "no access to this item"); });
export const bounces = serverFn({}, () => { throw redirect("/news"); });
export const guarded = serverFn({
  middleware: [async ({ input }, next) => {
    calls.guarded += 1;
    if (input.token !== "ok") throw new HttpError(401, "missing token");
    return next();
  }],
}, () => "secret");
export const big = serverFn({}, () => "x".repeat(5000));
export const save = serverFn({ singleFlight: true }, (input) => { calls.flight += 1; saved.push(input.n); return { saved: input.n }; });
export const readOnly = serverFn({ method: "GET" }, () => "read");

function News() { const data = useLoaderData(); return <p class="news">news {data()?.n}</p>; }
const news = defineRoute("/news", {
  id: "news",
  loader: () => { calls.news += 1; return { n: calls.news, who: getRequestEvent().url.searchParams.get("who") }; },
  component: News,
});
const gate = defineRoute("/gate", {
  id: "gate",
  beforeLoad: () => { calls.gate += 1; throw redirect("/news"); },
  component: () => <p>never</p>,
});

export const routes = [news, gate];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly calls: Record<string, number>;
  readonly saved: number[];
  readonly add: (input: unknown) => unknown;
  readonly fails: () => unknown;
  readonly bounces: () => unknown;
  readonly guarded: unknown;
  readonly big: () => unknown;
  readonly save: unknown;
  readonly readOnly: unknown;
}

const lazy = (value: unknown) => ({ load: async () => value as never });

function manifestOf(app: Fixture): DuskRuntimeManifest {
  return {
    routes: app.routes,
    apiRoutes: [],
    serverFns: {
      add: lazy(app.add),
      fails: lazy(app.fails),
      bounces: lazy(app.bounces),
      guarded: lazy(app.guarded),
      big: lazy(app.big),
      save: lazy(app.save),
      readOnly: lazy(app.readOnly),
    },
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: app.App,
  };
}

interface Setup {
  readonly handler: DuskHandler;
  readonly app: Fixture;
  readonly requests: string[];
  readonly errors: unknown[];
  readonly stubs: {
    readonly add: (input: unknown, options?: object) => Promise<unknown>;
    readonly fails: () => Promise<unknown>;
    readonly bounces: () => Promise<unknown>;
    readonly guarded: (input: unknown) => Promise<unknown>;
    readonly big: () => Promise<unknown>;
    readonly save: (input: unknown) => Promise<unknown>;
    readonly readOnly: () => Promise<unknown>;
  };
}

async function setup(
  options: { maxResponseBytes?: number; maxBatchSize?: number; origin?: string } = {},
): Promise<Setup> {
  const app = await load<Fixture>(SOURCE);
  const errors: unknown[] = [];
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    security: { allowedHosts: ["example.com"] },
    rpc: {
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
      ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
    },
    onError: (error) => void errors.push(error),
    onWarning: () => undefined,
  });
  const requests: string[] = [];
  const origin = options.origin ?? "https://example.com";
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), "https://example.com");
      const headers = new Headers(init?.headers);
      // A browser always sends Origin on a POST; the test plays the page at `origin`.
      headers.set("origin", origin);
      const request = new Request(url, {
        method: init?.method ?? "GET",
        headers,
        ...(init?.body === undefined || init.body === null ? {} : { body: init.body }),
      });
      requests.push(`${request.method} ${url.pathname}`);
      return handler.fetch(request);
    },
  );
  const stubs = {
    add: serverFnStub<unknown, unknown>("add", { method: "POST", form: false, base: "" }),
    fails: serverFnStub<unknown, unknown>("fails", { method: "POST", form: false, base: "" }),
    bounces: serverFnStub<unknown, unknown>("bounces", { method: "POST", form: false, base: "" }),
    guarded: serverFnStub<unknown, unknown>("guarded", { method: "POST", form: false, base: "" }),
    big: serverFnStub<unknown, unknown>("big", { method: "POST", form: false, base: "" }),
    save: serverFnStub<unknown, unknown>("save", {
      method: "POST",
      form: false,
      base: "",
      singleFlight: true,
    }),
    readOnly: serverFnStub<unknown, unknown>("readOnly", { method: "GET", form: false, base: "" }),
  };
  return { handler, app, requests, errors, stubs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Settles every promise and returns the outcomes in order (value, or the error). */
async function outcomes(
  promises: Promise<unknown>[],
): Promise<{ ok: boolean; value?: unknown; error?: unknown }[]> {
  return Promise.all(
    promises.map((promise) =>
      promise.then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      ),
    ),
  );
}

describe("server function batching (browser stub)", () => {
  it("[BATCH-01] calls made in one tick travel in one POST to /_dusk/fn/_batch and resolve in order", async () => {
    const t = await setup();
    const results = await Promise.all([
      t.stubs.add({ n: 1 }),
      t.stubs.add({ n: 2 }),
      t.stubs.add({ n: 3 }),
    ]);
    expect(t.requests).toEqual(["POST /_dusk/fn/_batch"]);
    expect(results).toEqual([
      { n: 1, total: 1 },
      { n: 2, total: 2 },
      { n: 3, total: 3 },
    ]);
  });

  it("[BATCH-02] a single call in its tick is sent to its own endpoint, not the batch one", async () => {
    const t = await setup();
    expect(await t.stubs.add({ n: 9 })).toEqual({ n: 9, total: 1 });
    expect(t.requests).toEqual(["POST /_dusk/fn/add"]);
  });

  it("[BATCH-03] a function with batch: false is sent alone, even with others in the tick", async () => {
    const t = await setup();
    const alone = serverFnStub<unknown, unknown>("add", {
      method: "POST",
      form: false,
      base: "",
      batch: false,
    });
    await Promise.all([alone({ n: 1 }), alone({ n: 2 })]);
    expect(t.requests).toEqual(["POST /_dusk/fn/add", "POST /_dusk/fn/add"]);
  });

  it("[BATCH-04] one call's error rejects that call only; the others still resolve", async () => {
    const t = await setup();
    const settled = await outcomes([t.stubs.add({ n: 1 }), t.stubs.fails(), t.stubs.add({ n: 2 })]);
    expect(t.requests).toEqual(["POST /_dusk/fn/_batch"]);
    expect(settled[0]).toEqual({ ok: true, value: { n: 1, total: 1 } });
    expect(settled[2]).toEqual({ ok: true, value: { n: 2, total: 2 } });
    expect(settled[1]?.ok).toBe(false);
    expect(isHttpError(settled[1]?.error)).toBe(true);
    expect(settled[1]).toMatchObject({
      ok: false,
      error: { status: 403, message: "no access to this item" },
    });
  });

  it("[BATCH-05] one call's redirect reaches that call as the router's redirect signal", async () => {
    const t = await setup();
    const settled = await outcomes([t.stubs.add({ n: 1 }), t.stubs.bounces()]);
    expect(settled[0]?.ok).toBe(true);
    expect(settled[1]?.ok).toBe(false);
    expect(isRedirect(settled[1]?.error)).toBe(true);
    expect(settled[1]).toMatchObject({ ok: false, error: { to: "/news" } });
  });

  it("[BATCH-06] middleware runs per call: a rejected call does not stop the others", async () => {
    const t = await setup();
    const settled = await outcomes([
      t.stubs.guarded({ token: "ok" }),
      t.stubs.guarded({ token: "nope" }),
      t.stubs.guarded({ token: "ok" }),
    ]);
    expect(settled.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(settled[1]).toMatchObject({ ok: false, error: { status: 401 } });
    expect(t.app.calls["guarded"]).toBe(3);
    expect(t.requests).toEqual(["POST /_dusk/fn/_batch"]);
  });

  it("[BATCH-07] CSRF is checked once for the batch request: a cross-origin batch runs no call", async () => {
    const t = await setup({ origin: "https://evil.example" });
    const settled = await outcomes([t.stubs.add({ n: 1 }), t.stubs.add({ n: 2 })]);
    expect(settled.every((entry) => entry.ok === false)).toBe(true);
    expect(settled[0]).toMatchObject({ ok: false, error: { status: 403 } });
    expect(t.app.calls["add"]).toBe(0);
  });

  it("[BATCH-08] a batch carries at most 25 calls: the stub splits a larger tick into several requests", async () => {
    const t = await setup();
    const settled = await outcomes(Array.from({ length: 30 }, (_, n) => t.stubs.add({ n })));
    expect(settled.every((entry) => entry.ok)).toBe(true);
    expect(t.requests).toEqual(["POST /_dusk/fn/_batch", "POST /_dusk/fn/_batch"]);
    expect(t.app.calls["add"]).toBe(30);
  });

  it("[BATCH-09] the server refuses a batch larger than rpc.maxBatchSize with 413, and runs none of it", async () => {
    const t = await setup({ maxBatchSize: 2 });
    const { serialize } = await import("@shadow-js/web/server");
    const calls = Array.from({ length: 3 }, (_, n) => ({ id: "add", input: { n } }));
    const response = await t.handler.fetch(
      new Request("https://example.com/_dusk/fn/_batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dusk-fn": "1",
          origin: "https://example.com",
        },
        body: serialize(calls),
      }),
    );
    expect(response.status).toBe(413);
    expect(t.app.calls["add"]).toBe(0);
  });

  it("[BATCH-10] the batch answer has one budget: a call whose answer does not fit is answered with an error, the others are kept", async () => {
    const t = await setup({ maxResponseBytes: 1000 });
    const settled = await outcomes([t.stubs.add({ n: 1 }), t.stubs.big(), t.stubs.add({ n: 2 })]);
    expect(settled[0]).toEqual({ ok: true, value: { n: 1, total: 1 } });
    expect(settled[2]).toEqual({ ok: true, value: { n: 2, total: 2 } });
    expect(settled[1]?.ok).toBe(false);
    expect(settled[1]).toMatchObject({ ok: false, error: { status: 500 } });
  });

  it("[BATCH-11] a GET function is never batched: each call is its own GET request", async () => {
    const t = await setup();
    await Promise.all([t.stubs.readOnly(), t.stubs.readOnly()]);
    expect(t.requests).toEqual(["GET /_dusk/fn/readOnly", "GET /_dusk/fn/readOnly"]);
  });

  it("[BATCH-12] the batch endpoint refuses a missing call header (400) and a non-JSON body (415)", async () => {
    const t = await setup();
    const noHeader = await t.handler.fetch(
      new Request("https://example.com/_dusk/fn/_batch", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.com" },
        body: "[]",
      }),
    );
    expect(noHeader.status).toBe(400);
    const notJson = await t.handler.fetch(
      new Request("https://example.com/_dusk/fn/_batch", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-dusk-fn": "1",
          origin: "https://example.com",
        },
        body: "[]",
      }),
    );
    expect(notJson.status).toBe(415);
  });

  it("[BATCH-13] an unknown id in a batch fails that call with 404 and leaves the others", async () => {
    const t = await setup();
    const { serialize } = await import("@shadow-js/web/server");
    const response = await t.handler.fetch(
      new Request("https://example.com/_dusk/fn/_batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dusk-fn": "1",
          origin: "https://example.com",
        },
        body: serialize([
          { id: "nope", input: undefined },
          { id: "add", input: { n: 5 } },
        ]),
      }),
    );
    expect(response.status).toBe(200);
    const { deserialize } = await import("@shadow-js/web/server");
    const answers = deserialize(await response.text()) as {
      ok: boolean;
      error?: { status: number };
    }[];
    expect(answers[0]?.ok).toBe(false);
    expect(answers[0]?.error?.status).toBe(404);
    expect(answers[1]).toEqual({ ok: true, value: { n: 5, total: 1 } });
  });

  it("[BATCH-14] a call with a signal is not batched (its abort belongs to that call alone)", async () => {
    const t = await setup();
    const controller = new AbortController();
    await Promise.all([t.stubs.add({ n: 1 }), t.stubs.add({ n: 2 })]);
    const aside = serverFnStub<unknown, unknown>("add", { method: "POST", form: false, base: "" });
    await Promise.all([aside({ n: 3 }, { signal: controller.signal }), aside({ n: 4 })]);
    expect(t.requests).toEqual([
      "POST /_dusk/fn/_batch",
      "POST /_dusk/fn/add",
      "POST /_dusk/fn/add",
    ]);
  });
});

describe("single-flight mutations", () => {
  it("[FLIGHT-01] a singleFlight mutation answers with the loader data of the page the browser is on, in the same response", async () => {
    const t = await setup();
    vi.stubGlobal("location", { href: "https://example.com/news?who=ann" });
    const value = await t.stubs.save({ n: 4 });
    expect(value).toEqual({ saved: 4 });
    expect(t.requests).toEqual(["POST /_dusk/fn/save"]);
    expect(t.app.calls["news"]).toBe(1);
  });

  it("[FLIGHT-02] the client hands the revalidated data to the registered applier before the call resolves", async () => {
    const { registerRevalidation } = await import("../src/client/single-flight");
    const t = await setup();
    vi.stubGlobal("location", { href: "https://example.com/news?who=ann" });
    const applied: unknown[] = [];
    const unregister = registerRevalidation(
      async (data) => {
        applied.push(data);
      },
      () => undefined,
    );
    try {
      await t.stubs.save({ n: 6 });
    } finally {
      unregister();
    }
    expect(applied).toHaveLength(1);
    const data = applied[0] as {
      version: number;
      matches: { id: string; value: { who: string } }[];
    };
    expect(data.version).toBe(1);
    expect(data.matches.map((match) => match.id)).toEqual(["news"]);
    expect(data.matches[0]?.value.who).toBe("ann");
  });

  it("[FLIGHT-03] no revalidated data for a missing or foreign location (the browser then loads as usual)", async () => {
    const t = await setup();
    const { serialize } = await import("@shadow-js/web/server");
    const send = async (location: string | undefined): Promise<unknown> => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-dusk-fn": "1",
        origin: "https://example.com",
      };
      if (location !== undefined) headers["x-dusk-location"] = location;
      const response = await t.handler.fetch(
        new Request("https://example.com/_dusk/fn/save", {
          method: "POST",
          headers,
          body: serialize([{ n: 1 }]),
        }),
      );
      const { deserialize } = await import("@shadow-js/web/server");
      return deserialize(await response.text());
    };
    expect(await send(undefined)).toEqual({ ok: true, value: { saved: 1 } });
    expect(await send("//evil.example/news")).toEqual({ ok: true, value: { saved: 1 } });
    expect(await send("https://evil.example/news")).toEqual({ ok: true, value: { saved: 1 } });
    expect(await send("/news\\evil")).toEqual({ ok: true, value: { saved: 1 } });
    expect(t.app.calls["news"]).toBe(0);
  });

  it("[FLIGHT-04] a page that redirects gets no revalidated data: the loaders of a redirect are not sent", async () => {
    const t = await setup();
    vi.stubGlobal("location", { href: "https://example.com/gate" });
    const value = await t.stubs.save({ n: 7 });
    expect(value).toEqual({ saved: 7 });
    expect(t.app.calls["gate"]).toBe(1);
  });

  it("[FLIGHT-05] in a batch the revalidation runs once, and every successful singleFlight call carries it", async () => {
    const t = await setup();
    vi.stubGlobal("location", { href: "https://example.com/news" });
    const settled = await outcomes([
      t.stubs.save({ n: 8 }),
      t.stubs.add({ n: 9 }),
      t.stubs.save({ n: 10 }),
    ]);
    expect(settled.map((entry) => entry.ok)).toEqual([true, true, true]);
    expect(t.requests).toEqual(["POST /_dusk/fn/_batch"]);
    expect(t.app.calls["news"]).toBe(1);
    expect(t.app.calls["flight"]).toBe(2);
  });
});
