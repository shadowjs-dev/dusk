import { deserialize, serialize } from "@shadow-js/web/server";
import { beforeAll, describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { rpc } from "../src/features/rpc";
import { isHttpError } from "../src/internal/http-error";
import {
  type ApiHandler,
  apiHandler,
  BodyTooLargeError,
  createHandler,
  createMemoryRateLimitStore,
  createRateLimiter,
  type DuskHandler,
  type DuskRuntimeManifest,
  json,
  type Middleware,
  type RateLimiter,
  type RequestEvent,
  readJson,
  readJsonLimited,
  readTextLimited,
  serverFn,
} from "../src/server/index";
import { createTestClient, createTestEvent } from "../src/testing/index";
import { type AppModule, loadApp } from "./support/app";

/**
 * SEC-R2 (batch endpoint) and SEC-R14 (large-body routes) from the residual security risks of Dusk.
 * Every test runs the real handler in-process.
 */

let app: AppModule;

beforeAll(async () => {
  app = await loadApp();
});

const MIB = 1024 * 1024;

function manifestWith(
  parts: Pick<DuskRuntimeManifest, "serverFns" | "apiRoutes">,
): DuskRuntimeManifest {
  return {
    routes: [],
    apiRoutes: parts.apiRoutes,
    serverFns: parts.serverFns,
    assets: { entry: "/assets/app.js", css: [], preloads: {}, base: "/" },
    App: app.App,
  };
}

/** The wire answer of one call: a value, or an error with its status. */
interface Envelope {
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string; readonly status: number };
}

// ---------------------------------------------------------------------------------------------
// SEC-R2: batch amplification
// ---------------------------------------------------------------------------------------------

interface BatchApp {
  readonly handler: DuskHandler;
  readonly calls: { open: number; a: number; b: number; byUser: number };
  readonly clock: { now: number };
  readonly fnLimiter: RateLimiter;
  readonly fnStore: ReturnType<typeof createMemoryRateLimitStore>;
  readonly client: (address?: string) => ReturnType<typeof createTestClient>;
}

/**
 * Four server functions: `open` (no limit), `a` and `b` (the same limiter, 3 calls then refilling 1 per second)
 * and `byUser` (the limiter keyed by the `x-user` header). `middleware` is the app-wide chain.
 */
function batchApp(
  options: { middleware?: Middleware[]; maxKeys?: number; capacity?: number } = {},
): BatchApp {
  const calls = { open: 0, a: 0, b: 0, byUser: 0 };
  const clock = { now: 1_000_000 };
  const fnStore = createMemoryRateLimitStore({ maxKeys: options.maxKeys ?? 1000 });
  const fnLimiter = createRateLimiter({
    capacity: options.capacity ?? 3,
    refillPerSecond: 1,
    store: fnStore,
    now: () => clock.now,
    name: "fn",
  });
  const open = serverFn({}, () => {
    calls.open += 1;
    return "open";
  });
  const a = serverFn({ rateLimit: fnLimiter }, () => {
    calls.a += 1;
    return "a";
  });
  const b = serverFn({ rateLimit: fnLimiter }, () => {
    calls.b += 1;
    return "b";
  });
  const byUser = serverFn(
    {
      rateLimit: {
        limiter: fnLimiter,
        key: (event: RequestEvent) => event.request.headers.get("x-user") ?? "anonymous",
      },
    },
    () => {
      calls.byUser += 1;
      return "byUser";
    },
  );
  const lazy = (value: unknown) => ({ load: async () => value as never });
  const handler = createHandler({
    dev: true,
    features: [rpc()],
    manifest: manifestWith({
      apiRoutes: [],
      serverFns: { open: lazy(open), a: lazy(a), b: lazy(b), byUser: lazy(byUser) },
    }),
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
  });
  return {
    handler,
    calls,
    clock,
    fnLimiter,
    fnStore,
    client: (address = "203.0.113.1") => createTestClient(handler, { clientAddress: address }),
  };
}

type Client = ReturnType<BatchApp["client"]>;

const CALL_HEADERS = { "x-dusk-fn": "1", "content-type": "application/json" };

function single(client: Client, id: string, headers: Record<string, string> = {}) {
  return client.post(`/_dusk/fn/${id}`, {
    headers: { ...CALL_HEADERS, ...headers },
    body: serialize([{}]),
  });
}

async function batch(client: Client, ids: readonly string[], headers: Record<string, string> = {}) {
  const response = await client.post("/_dusk/fn/_batch", {
    headers: { ...CALL_HEADERS, ...headers },
    body: serialize(ids.map((id) => ({ id, input: {} }))),
  });
  const text = await response.text();
  const answers = response.status === 200 ? (deserialize(text) as Envelope[]) : [];
  return { response, answers, text };
}

const repeat = (id: string, times: number): string[] => Array.from({ length: times }, () => id);
const okCount = (answers: readonly Envelope[]): number =>
  answers.filter((answer) => answer.ok === true).length;
const refusedCount = (answers: readonly Envelope[]): number =>
  answers.filter((answer) => answer.ok === false && answer.error?.status === 429).length;

describe("SEC-R2 the request-level limiter charges each call of a batch", () => {
  const requestLimiter = (capacity: number, cost?: number) => {
    const limiter = createRateLimiter({ capacity, refillPerSecond: 0.001, now: () => 1_000_000 });
    return limiter.middleware(cost === undefined ? {} : { cost });
  };

  it("SEC-R2-01 a batch of 25 calls to a limiter of 3 is refused with 429 before any call runs", async () => {
    const t = batchApp({ middleware: [requestLimiter(3)] });
    const { response } = await batch(t.client(), repeat("open", 25));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(response.headers.get("ratelimit-limit")).toBe("3");
    expect(t.calls.open).toBe(0);
  });

  it("SEC-R2-02 a batch of N calls takes N tokens: a batch of 3 drains a bucket of 3, the next single call is refused", async () => {
    const t = batchApp({ middleware: [requestLimiter(3)] });
    const client = t.client();
    const first = await batch(client, repeat("open", 3));
    expect(first.response.status).toBe(200);
    expect(okCount(first.answers)).toBe(3);
    expect((await single(client, "open")).status).toBe(429);
    expect(t.calls.open).toBe(3);
  });

  it("SEC-R2-03 single calls and a batch of one call cost one token each, as before", async () => {
    const t = batchApp({ middleware: [requestLimiter(3)] });
    const client = t.client();
    expect((await single(client, "open")).status).toBe(200);
    expect((await single(client, "open")).status).toBe(200);
    expect((await batch(client, ["open"])).response.status).toBe(200);
    expect((await single(client, "open")).status).toBe(429);
    expect((await batch(client, ["open"])).response.status).toBe(429);
  });

  it("SEC-R2-04 the cost option of the middleware applies to every call of the batch", async () => {
    const t = batchApp({ middleware: [requestLimiter(6, 2)] });
    const client = t.client();
    expect((await batch(client, repeat("open", 3))).response.status).toBe(200);
    expect((await single(client, "open")).status).toBe(429);
    const other = t.client("203.0.113.2");
    expect((await batch(other, repeat("open", 4))).response.status).toBe(429);
  });

  it("SEC-R2-05 a refused batch has the shape of a refused single call (status, body, rate limit headers)", async () => {
    const t = batchApp({ middleware: [requestLimiter(1)] });
    const client = t.client();
    expect((await single(client, "open")).status).toBe(200);
    const refusedSingle = await single(client, "open");
    const refusedBatch = await batch(client, repeat("open", 5));
    expect(refusedSingle.status).toBe(429);
    expect(refusedBatch.response.status).toBe(429);
    // Only the request id differs between two answers.
    const withoutId = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "<id>");
    expect(withoutId(refusedBatch.text)).toBe(withoutId(await refusedSingle.text()));
    for (const name of ["ratelimit-limit", "ratelimit-remaining", "retry-after"]) {
      expect(refusedBatch.response.headers.get(name)).toBe(refusedSingle.headers.get(name));
    }
  });

  it("SEC-R2-06 every limiter of the chain is charged, and a batch the first one allows can be refused by the second", async () => {
    const t = batchApp({ middleware: [requestLimiter(30), requestLimiter(5)] });
    const { response } = await batch(t.client(), repeat("open", 6));
    expect(response.status).toBe(429);
    expect(response.headers.get("ratelimit-limit")).toBe("5");
    expect(t.calls.open).toBe(0);
  });
});

describe("SEC-R2 a server function limit counts every call, single or batched", () => {
  it("SEC-R2-10 a batch of 25 calls to a function limited to 3 runs 3 and refuses 22 with the 429 error", async () => {
    const t = batchApp();
    const { response, answers } = await batch(t.client(), repeat("a", 25));
    expect(response.status).toBe(200);
    expect(answers).toHaveLength(25);
    expect(okCount(answers)).toBe(3);
    expect(refusedCount(answers)).toBe(22);
    expect(t.calls.a).toBe(3);
    // The first three are the ones that ran: order is kept.
    expect(answers.slice(0, 3).every((answer) => answer.ok === true)).toBe(true);
  });

  it("SEC-R2-11 single calls are refused after the same number, with 429, retry-after and the rate limit headers", async () => {
    const t = batchApp();
    const client = t.client();
    for (let index = 0; index < 3; index += 1) {
      const ok = await single(client, "a");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("ratelimit-limit")).toBe("3");
    }
    const refused = await single(client, "a");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(refused.headers.get("ratelimit-remaining")).toBe("0");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(t.calls.a).toBe(3);
  });

  it("SEC-R2-12 the refused entry of a batch carries the error a refused single call carries", async () => {
    const t = batchApp();
    const client = t.client();
    const { answers } = await batch(client, repeat("a", 4));
    const refusedEntry = answers[3]?.error;
    const refusedSingle = deserialize(await (await single(client, "a")).text()) as Envelope;
    expect(refusedEntry).toMatchObject({
      name: "HttpError",
      message: "Too Many Requests",
      status: 429,
    });
    expect(refusedSingle.error?.name).toBe(refusedEntry?.name);
    expect(refusedSingle.error?.message).toBe(refusedEntry?.message);
    expect(refusedSingle.error?.status).toBe(refusedEntry?.status);
  });

  it("SEC-R2-13 a batch and single calls draw on one bucket: 2 singles leave 1 call for a batch of 25", async () => {
    const t = batchApp();
    const client = t.client();
    await single(client, "a");
    await single(client, "a");
    const { answers } = await batch(client, repeat("a", 25));
    expect(okCount(answers)).toBe(1);
    expect(t.calls.a).toBe(3);
  });

  it("SEC-R2-14 the bucket is per function: exhausting a leaves b, and an unlimited function, untouched", async () => {
    const t = batchApp();
    const client = t.client();
    await batch(client, repeat("a", 10));
    const { answers } = await batch(client, ["b", "b", "b", "b", "open", "open"]);
    expect(answers.map((answer) => answer.ok)).toEqual([true, true, true, false, true, true]);
    expect(t.calls).toMatchObject({ a: 3, b: 3, open: 2 });
  });

  it("SEC-R2-15 a mixed batch is judged call by call, in order", async () => {
    const t = batchApp({ capacity: 2 });
    const { answers } = await batch(t.client(), ["a", "b", "a", "b", "a", "b", "open"]);
    expect(answers.map((answer) => answer.ok)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      true,
    ]);
  });

  it("SEC-R2-16 the bucket is per client: one client's batch does not use another's calls", async () => {
    const t = batchApp();
    const first = await batch(t.client("203.0.113.1"), repeat("a", 25));
    const second = await batch(t.client("203.0.113.2"), repeat("a", 25));
    expect(okCount(first.answers)).toBe(3);
    expect(okCount(second.answers)).toBe(3);
    expect(t.calls.a).toBe(6);
  });

  it("SEC-R2-17 tokens come back with time: the injected clock decides, and a refused call used none", async () => {
    const t = batchApp();
    const client = t.client();
    expect(okCount((await batch(client, repeat("a", 5))).answers)).toBe(3);
    t.clock.now += 2000;
    expect(okCount((await batch(client, repeat("a", 5))).answers)).toBe(2);
    expect(t.calls.a).toBe(5);
  });

  it("SEC-R2-18 the key option picks the caller: two users behind one address have their own bucket per function", async () => {
    const t = batchApp();
    const client = t.client();
    const alice = await batch(client, repeat("byUser", 5), { "x-user": "alice" });
    const bob = await batch(client, repeat("byUser", 5), { "x-user": "bob" });
    const aliceAgain = await batch(client, repeat("byUser", 1), { "x-user": "alice" });
    expect(okCount(alice.answers)).toBe(3);
    expect(okCount(bob.answers)).toBe(3);
    expect(okCount(aliceAgain.answers)).toBe(0);
    // `a` shares the limiter but not the function part of the key.
    expect(okCount((await batch(client, repeat("a", 5), { "x-user": "alice" })).answers)).toBe(3);
  });

  it("SEC-R2-19 an unknown id in a batch does not disturb the limits of the known ones", async () => {
    const t = batchApp();
    const { answers } = await batch(t.client(), ["a", "missing", "a", "a", "a"]);
    expect(answers.map((answer) => answer.ok)).toEqual([true, false, true, true, false]);
    expect(answers[1]?.error?.status).toBe(404);
    expect(answers[4]?.error?.status).toBe(429);
  });

  it("SEC-R2-20 the store stays bounded: a client per call never holds more buckets than maxKeys", async () => {
    const t = batchApp({ maxKeys: 4 });
    for (let index = 0; index < 12; index += 1) {
      await single(t.client(`198.51.100.${index}`), "a");
    }
    expect(t.fnStore.size).toBe(4);
  });

  it("SEC-R2-21 a call made from server code (fn.invoke) is not charged: only calls that arrive over HTTP are", async () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: () => 0 });
    let ran = 0;
    const limited = serverFn({ rateLimit: limiter }, () => {
      ran += 1;
      return "ok";
    });
    const testEvent = createTestEvent();
    for (let index = 0; index < 5; index += 1) await limited.invoke({}, testEvent);
    expect(ran).toBe(5);
  });

  it("SEC-R2-22 a rateLimit that is not a limiter, or with a bad cost, is refused when the function is defined", () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(() => serverFn({ rateLimit: {} as never }, () => 1)).toThrow(TypeError);
    expect(() => serverFn({ rateLimit: { limiter, cost: 0 } }, () => 1)).toThrow(TypeError);
    expect(() => serverFn({ rateLimit: { limiter, cost: Number.NaN } }, () => 1)).toThrow(
      TypeError,
    );
    expect(() => serverFn({ rateLimit: { limiter, key: "x" as never } }, () => 1)).toThrow(
      TypeError,
    );
    expect(() => serverFn({ rateLimit: limiter }, () => 1)).not.toThrow();
  });

  it("SEC-R2-23 a function without rateLimit and an app without a limiter behave as before", async () => {
    const t = batchApp();
    const { response, answers } = await batch(t.client(), repeat("open", 25));
    expect(response.status).toBe(200);
    expect(okCount(answers)).toBe(25);
    expect((await batch(t.client(), repeat("open", 26))).response.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------------------------
// SEC-R14: large-body routes
// ---------------------------------------------------------------------------------------------

/** A request whose body is a stream of `chunks` chunks of `size` bytes; `pulled` counts the chunks read so far. */
function streamed(
  chunks: number,
  size: number,
  init: { headers?: Record<string, string>; text?: boolean } = {},
): { request: Request; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(init.text === true ? 0x20 : 0x61));
    },
  });
  const request = new Request("https://app.test/upload", {
    method: "POST",
    body,
    duplex: "half",
    headers: init.headers ?? { "content-type": "application/json" },
  } as RequestInit);
  return { request, pulled: () => pulled };
}

const jsonRequest = (text: string, headers: Record<string, string> = {}): Request =>
  new Request("https://app.test/upload", {
    method: "POST",
    body: text,
    headers: { "content-type": "application/json", ...headers },
  });

describe("SEC-R14 readJsonLimited", () => {
  it("SEC-R14-01 parses a JSON body that fits its bound", async () => {
    const value = await readJsonLimited(jsonRequest('{"a":[1,2,{"b":"c"}]}'), 1024);
    expect(value).toEqual({ a: [1, 2, { b: "c" }] });
  });

  it("SEC-R14-02 refuses a body above its bound with BodyTooLargeError (413, the limit) and stops reading", async () => {
    const { request, pulled } = streamed(1000, 1024);
    const error = await readJsonLimited(request, 4096).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BodyTooLargeError);
    expect(isHttpError(error) && error.status).toBe(413);
    expect((error as BodyTooLargeError).limit).toBe(4096);
    // 5 chunks cross 4096 bytes; the other ~995 are never pulled.
    expect(pulled()).toBeLessThan(10);
  });

  it("SEC-R14-03 refuses a declared Content-Length above the bound before reading a byte", async () => {
    const { request, pulled } = streamed(10, 1024, {
      headers: { "content-type": "application/json", "content-length": "10240" },
    });
    await expect(readJsonLimited(request, 2048)).rejects.toBeInstanceOf(BodyTooLargeError);
    // The stream primes one chunk by itself once the request is built; the reader pulls none (10 would be the whole body).
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("SEC-R14-04 a body of exactly the bound is accepted", async () => {
    const text = JSON.stringify({ k: "x".repeat(20) });
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(await readJsonLimited(jsonRequest(text), bytes)).toEqual({ k: "x".repeat(20) });
    await expect(readJsonLimited(jsonRequest(text), bytes - 1)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("SEC-R14-05 keeps the checks of readJson: 415 for another content type, 400 for invalid JSON and for forbidden keys", async () => {
    const wrongType = new Request("https://app.test/x", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "text/plain" },
    });
    await expect(readJsonLimited(wrongType, 100)).rejects.toMatchObject({ status: 415 });
    await expect(readJsonLimited(jsonRequest("{nope"), 100)).rejects.toMatchObject({
      status: 400,
    });
    await expect(readJsonLimited(jsonRequest('{"__proto__":{"x":1}}'), 100)).rejects.toMatchObject({
      status: 400,
    });
    // An empty body is invalid JSON, as for readJson.
    await expect(readJsonLimited(jsonRequest(""), 100)).rejects.toMatchObject({ status: 400 });
  });

  it("SEC-R14-06 a bound that is not a number or is negative is a RangeError, never an unbounded read", async () => {
    for (const bad of [Number.NaN, -1]) {
      await expect(readJsonLimited(jsonRequest("{}"), bad)).rejects.toBeInstanceOf(RangeError);
      await expect(readTextLimited(jsonRequest("{}"), bad)).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("SEC-R14-07 readTextLimited also refuses a declared length above its bound without reading", async () => {
    const { request, pulled } = streamed(10, 1024, {
      headers: { "content-length": "10240" },
      text: true,
    });
    await expect(readTextLimited(request, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(1);
  });
});

interface BodyApp {
  readonly client: ReturnType<typeof createTestClient>;
  readonly warnings: string[];
  readonly request: { current: Request | undefined };
}

/**
 * A handler with API routes that read a body each way. `maxBodyBytes` is the app-wide limit; `dev` selects
 * the development behavior.
 */
function bodyApp(options: { maxBodyBytes?: number; dev?: boolean; routes?: number } = {}): BodyApp {
  const warnings: string[] = [];
  const request: { current: Request | undefined } = { current: undefined };
  const reading =
    (read: (event: RequestEvent) => Promise<unknown>): ApiHandler =>
    async (event) => {
      request.current = event.request;
      return json({ read: typeof (await read(event)) });
    };
  const routes: Record<string, ApiHandler> = {
    readJson: reading((event) => readJson(event.request)),
    readJsonLimited: reading((event) => readJsonLimited(event.request, 1024)),
    readTextLimited: reading((event) => readTextLimited(event.request, 1024)),
    text: reading((event) => event.request.text()),
    json: reading((event) => event.request.json()),
    formData: reading((event) => event.request.formData()),
    arrayBuffer: reading((event) => event.request.arrayBuffer()),
    blob: reading((event) => event.request.blob()),
    stream: reading(async (event) => {
      const reader = event.request.body?.getReader();
      const first = await reader?.read();
      reader?.releaseLock();
      return first?.value;
    }),
    apiHandlerUnbounded: apiHandler({ body: acceptAny }, ({ body }) => json({ body })),
    apiHandlerBounded: apiHandler({ body: acceptAny, maxBodyBytes: 64 }, ({ body }) =>
      json({ body }),
    ),
  };
  for (let index = 0; index < (options.routes ?? 0); index += 1) {
    routes[`many${index}`] = reading((event) => readJson(event.request));
  }
  const apiRouteList = Object.entries(routes).map(([name, handler]) => ({
    id: name,
    path: `/api/${name}`,
    load: async () => ({ POST: handler }),
  }));
  const handler = createHandler({
    dev: options.dev ?? true,
    features: [apiRoutes(), rpc()],
    manifest: manifestWith({
      apiRoutes: apiRouteList,
      serverFns: { echo: { load: async () => serverFn({}, (input: unknown) => input) as never } },
    }),
    security: {
      allowedHosts: ["localhost"],
      ...(options.maxBodyBytes === undefined
        ? {}
        : { limits: { maxBodyBytes: options.maxBodyBytes } }),
    },
    onWarning: (message) => void warnings.push(message),
  });
  return { client: createTestClient(handler), warnings, request };
}

/** A Standard Schema that accepts anything, for `apiHandler({ body })`. */
const acceptAny = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const post = (app: BodyApp, name: string, body = '{"a":1}') =>
  app.client.post(`/api/${name}`, {
    headers: { "content-type": "application/json" },
    body,
  });

describe("SEC-R14 the route that reads a body answers 413 above its own bound", () => {
  it("SEC-R14-10 a route with readJsonLimited refuses above its bound through the real handler, below the app limit", async () => {
    const app = bodyApp({ maxBodyBytes: 100 * MIB });
    expect((await post(app, "readJsonLimited", '{"a":1}')).status).toBe(200);
    const big = JSON.stringify({ pad: "x".repeat(5000) });
    expect((await post(app, "readJsonLimited", big)).status).toBe(413);
    expect((await post(app, "readTextLimited", big)).status).toBe(413);
    expect(app.warnings).toEqual([]);
  });

  it("SEC-R14-11 apiHandler({ maxBodyBytes }) bounds its JSON body below the app limit and does not warn", async () => {
    const app = bodyApp({ maxBodyBytes: 100 * MIB });
    expect((await post(app, "apiHandlerBounded", '{"a":1}')).status).toBe(200);
    expect(
      (await post(app, "apiHandlerBounded", JSON.stringify({ pad: "x".repeat(200) }))).status,
    ).toBe(413);
    expect(app.warnings).toEqual([]);
  });

  it("SEC-R14-12 apiHandler with no maxBodyBytes keeps reading up to the app limit (nothing changes for an app that works)", async () => {
    const app = bodyApp({ maxBodyBytes: 100 * MIB, dev: false });
    expect(
      (await post(app, "apiHandlerUnbounded", JSON.stringify({ pad: "x".repeat(5000) }))).status,
    ).toBe(200);
  });
});

describe("SEC-R14 development warning for a body read in full under a limit above 10 MiB", () => {
  it("SEC-R14-20 readJson on a route warns once, naming the route, the limit and the fix", async () => {
    const app = bodyApp({ maxBodyBytes: 50 * MIB });
    expect((await post(app, "readJson")).status).toBe(200);
    expect((await post(app, "readJson")).status).toBe(200);
    expect(app.warnings).toHaveLength(1);
    const [message] = app.warnings;
    expect(message).toContain("POST /api/readJson");
    expect(message).toContain("readJson()");
    expect(message).toContain("50 MiB");
    expect(message).toContain("readJsonLimited");
  });

  it("SEC-R14-21 a direct request.text(), json(), formData(), arrayBuffer() or blob() on the route's request warns too", async () => {
    const app = bodyApp({ maxBodyBytes: 50 * MIB });
    for (const name of ["text", "json", "arrayBuffer", "blob"]) {
      expect((await post(app, name)).status).toBe(200);
    }
    const form = await app.client.post("/api/formData", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(form.status).toBe(200);
    expect(app.warnings).toHaveLength(5);
    expect(app.warnings.map((message) => /request\.(\w+)\(\)/.exec(message)?.[1])).toEqual([
      "text",
      "json",
      "arrayBuffer",
      "blob",
      "formData",
    ]);
  });

  it("SEC-R14-22 reading through the bounded helpers or the body stream does not warn at any limit", async () => {
    const app = bodyApp({ maxBodyBytes: 512 * MIB });
    for (const name of ["readJsonLimited", "readTextLimited", "stream", "apiHandlerBounded"]) {
      expect((await post(app, name)).status).toBe(200);
    }
    expect(app.warnings).toEqual([]);
  });

  it("SEC-R14-23 at the default limit, and at exactly 10 MiB, nothing warns", async () => {
    for (const maxBodyBytes of [undefined, 10 * MIB]) {
      const app = bodyApp(maxBodyBytes === undefined ? {} : { maxBodyBytes });
      await post(app, "readJson");
      await post(app, "text");
      expect(app.warnings).toEqual([]);
    }
  });

  it("SEC-R14-24 in production (dev: false) nothing is watched: no warning and the request object is untouched", async () => {
    const app = bodyApp({ maxBodyBytes: 50 * MIB, dev: false });
    expect((await post(app, "readJson")).status).toBe(200);
    expect((await post(app, "text")).status).toBe(200);
    expect(app.warnings).toEqual([]);
    const seen = app.request.current;
    expect(seen).toBeDefined();
    expect(Object.hasOwn(seen as Request, "text")).toBe(false);
  });

  it("SEC-R14-25 the framework's own endpoints (a server function call) read their body without warning", async () => {
    const app = bodyApp({ maxBodyBytes: 50 * MIB });
    const response = await app.client.post("/_dusk/fn/echo", {
      headers: CALL_HEADERS,
      body: serialize([{ a: 1 }]),
    });
    expect(response.status).toBe(200);
    expect(app.warnings).toEqual([]);
  });

  it("SEC-R14-26 the list of routes already warned about is bounded: the oldest is forgotten past 64 and warns again", async () => {
    const app = bodyApp({ maxBodyBytes: 50 * MIB, routes: 70 });
    for (let index = 0; index < 70; index += 1) await post(app, `many${index}`);
    expect(app.warnings).toHaveLength(70);
    await post(app, "many69");
    expect(app.warnings).toHaveLength(70);
    await post(app, "many0");
    expect(app.warnings).toHaveLength(71);
  });

  it("SEC-R14-27 the wrapped reader still returns what the original returns", async () => {
    const app = bodyApp({ maxBodyBytes: 50 * MIB });
    const response = await post(app, "json", '{"a":1}');
    expect(await response.json()).toEqual({ read: "object" });
  });
});
