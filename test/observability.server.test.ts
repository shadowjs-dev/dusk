import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type HandlerOptions,
  json,
} from "../src/server/index";
import { NOOP_TRACER, type SpanLike, type TracerLike } from "../src/server/instrumentation";
import type { Observation } from "../src/server/observe";
import type { MetricsLike, RequestTimings } from "../src/server/observe-types";
import {
  checkTimingName,
  cleanTimingDescription,
  serializeServerTiming,
} from "../src/server/server-timing";
import { timing } from "../src/server/timing";
import { createTestClient } from "../src/testing/index";
import { type AppModule, errorLog, loadApp, manifestOf } from "./support/app";
import { deferred } from "./support/deferred";
import { allFeatures } from "./support/features";

// --- helpers ------------------------------------------------------------------------------------------------------

interface RecordedSpan {
  readonly name: string;
  readonly parent: RecordedSpan | undefined;
  readonly attributes: Record<string, unknown>;
  readonly exceptions: unknown[];
  status: { code: number; message?: string } | undefined;
  ended: number;
}

/** A tracer with the OpenTelemetry shape that records every span, its parent (through async context) and its calls. */
function recordingTracer(): { tracer: TracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const active = new AsyncLocalStorage<RecordedSpan>();
  const tracer: TracerLike = {
    startActiveSpan(name, options, fn) {
      const recorded: RecordedSpan = {
        name,
        parent: active.getStore(),
        attributes: { ...options.attributes },
        exceptions: [],
        status: undefined,
        ended: 0,
      };
      spans.push(recorded);
      const span: SpanLike = {
        setAttribute: (key, value) => {
          recorded.attributes[key] = value;
        },
        recordException: (error) => {
          recorded.exceptions.push(error);
        },
        setStatus: (status) => {
          recorded.status = status;
        },
        end: () => {
          recorded.ended += 1;
        },
      };
      return active.run(recorded, () => fn(span));
    },
  };
  return { tracer, spans };
}

const named = (spans: readonly RecordedSpan[], name: string): RecordedSpan[] =>
  spans.filter((span) => span.name === name);

const only = (spans: readonly RecordedSpan[], name: string): RecordedSpan => {
  const found = named(spans, name);
  expect(found, `spans named ${name}`).toHaveLength(1);
  return found[0] as RecordedSpan;
};

/** Metrics of the Timing header as `name -> { dur, desc }`. */
function parseServerTiming(
  header: string | null,
): Map<string, { dur: number; desc: string | undefined }> {
  const out = new Map<string, { dur: number; desc: string | undefined }>();
  for (const entry of (header ?? "").split(", ")) {
    if (entry === "") continue;
    const [name = "", ...params] = entry.split(";");
    const desc = params.find((param) => param.startsWith("desc="));
    const dur = params.find((param) => param.startsWith("dur="));
    out.set(name, {
      dur: Number(dur?.slice(4)),
      desc: desc === undefined ? undefined : desc.slice(5).replace(/^"|"$/g, ""),
    });
  }
  return out;
}

const seenByRoutes: { obs: unknown; measured: unknown[] } = { obs: "unset", measured: [] };

/** API routes of the tests, next to the shared app's. */
const extraRoutes = {
  timed: apiRoute({
    GET: async (event) => {
      const rows = await event.timing.measure(
        "db",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 3;
        },
        "load rows",
      );
      const cache = event.timing.measure("cache", () => "hit");
      event.timing.add("external", 12.34, "partner api");
      event.timing.add("external", 1);
      return json({ rows, cache });
    },
  }),
  inline: apiRoute({ GET: async () => json({ value: await timing("lookup", () => 7) }) }),
  hostile: apiRoute({
    GET: (event) => {
      event.timing.add("ok", 1, 'x";dur=0, evil;desc="y\r\nSet-Cookie: a=b, é');
      const errors: string[] = [];
      for (const name of ["a b", "x,y", "x;y", 'q"', "x\r\ny", "", "total", "render", "é"]) {
        try {
          event.timing.add(name, 1);
        } catch (error) {
          errors.push(error instanceof TypeError ? "TypeError" : "other");
        }
      }
      return json({ errors });
    },
  }),
  many: apiRoute({
    GET: (event) => {
      for (let index = 0; index < 20; index += 1) event.timing.add(`m${index}`, 1);
      event.timing.add("m0", 1);
      let message = "";
      try {
        event.timing.add("m20", 1);
      } catch (error) {
        message = error instanceof Error ? error.message : "";
      }
      return json({ message });
    },
  }),
  own: apiRoute({
    GET: () => new Response("ok", { headers: { "server-timing": "mine;dur=1" } }),
  }),
  probe: apiRoute({
    GET: (event) => {
      seenByRoutes.obs = (event as unknown as { obs: Observation | undefined }).obs;
      seenByRoutes.measured.push(event.timing.measure("x", () => "ran"));
      return json({});
    },
  }),
  wait: apiRoute({
    GET: (event) =>
      new Promise<Response>((_resolve, reject) => {
        event.signal.addEventListener("abort", () => reject(event.signal.reason), { once: true });
      }),
  }),
  hang: apiRoute({ GET: () => new Promise<Response>(() => undefined) }),
};

interface Booted {
  readonly app: AppModule;
  readonly handler: DuskHandler;
  readonly log: ReturnType<typeof errorLog>;
  readonly client: ReturnType<typeof createTestClient>;
}

async function boot(options: Partial<HandlerOptions> = {}): Promise<Booted> {
  const app = await loadApp();
  const log = errorLog();
  const base = manifestOf(app);
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      ...base,
      apiRoutes: [
        ...base.apiRoutes,
        { id: "timed", path: "/api/timed", load: async () => extraRoutes.timed },
        { id: "inline", path: "/api/inline", load: async () => extraRoutes.inline },
        { id: "hostile", path: "/api/hostile", load: async () => extraRoutes.hostile },
        { id: "many", path: "/api/many", load: async () => extraRoutes.many },
        { id: "own", path: "/api/own", load: async () => extraRoutes.own },
        { id: "probe", path: "/api/probe", load: async () => extraRoutes.probe },
        { id: "wait", path: "/api/wait", load: async () => extraRoutes.wait },
        { id: "hang", path: "/api/hang", load: async () => extraRoutes.hang },
      ],
    },
    dev: false,
    onWarning: () => undefined,
    onError: log.onError,
    ...options,
  } as HandlerOptions);
  return { app, handler, log, client: createTestClient(handler) };
}

/** Counts the reads of `performance.now` made by the observation code (other code reads the clock too). */
function clockOfObservation(): { reads(): number; mockRestore(): void } {
  const original = performance.now.bind(performance);
  let count = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => {
    if ((new Error().stack ?? "").includes("/src/server/observe.ts")) count += 1;
    return original();
  });
  return { reads: () => count, mockRestore: () => spy.mockRestore() };
}

/** Reads a response body to its end. */
async function drain(response: Response): Promise<string> {
  return response.text();
}

// --- the header: names, descriptions, format ---------------------------------------------------------------------

describe("Server-Timing: names, descriptions and format", () => {
  it("[OBS-01] a metric name must be a token of 1 to 64 characters that the framework does not use", () => {
    for (const name of ["db", "cache-hit", "a.b_c~d", "x!#$%&'*+^`|", "A1", "a".repeat(64)]) {
      expect(checkTimingName(name)).toBe(name);
    }
    for (const bad of [
      "",
      "a b",
      "a,b",
      "a;b",
      'a"b',
      "a\r\nb",
      "a=b",
      "é",
      "a".repeat(65),
      "total",
      "route",
      "loaders",
      "render",
      1,
      undefined,
      null,
      {},
    ]) {
      expect(() => checkTimingName(bad)).toThrow(TypeError);
    }
  });

  it("[OBS-02] a description keeps printable ASCII only: quotes, backslashes, separators, controls and non-ASCII become _, and it is cut at 100", () => {
    expect(cleanTimingDescription("load user")).toBe("load user");
    expect(cleanTimingDescription("/posts/:id")).toBe("/posts/:id");
    expect(cleanTimingDescription('a"b\\c,d;e')).toBe("a_b_c_d_e");
    expect(cleanTimingDescription("x\r\nSet-Cookie: a=b")).toBe("x__Set-Cookie: a=b");
    expect(cleanTimingDescription("\u0000é ")).toBe("___");
    expect(cleanTimingDescription("a".repeat(150))).toHaveLength(100);
    expect(cleanTimingDescription("")).toBeUndefined();
    expect(cleanTimingDescription(5)).toBeUndefined();
  });

  it('[OBS-03] entries serialize as name;desc="text";dur=ms with one decimal, never a negative or NaN, and a bad name is skipped', () => {
    expect(
      serializeServerTiming([
        { name: "total", durationMs: 12.34 },
        { name: "route", durationMs: 0.04, description: "/posts/:id" },
        { name: "db", durationMs: 3, description: 'q";x' },
        { name: "neg", durationMs: -5 },
        { name: "nan", durationMs: Number.NaN },
        { name: "bad name", durationMs: 1 },
        { name: "evil\r\nx", durationMs: 1 },
      ]),
    ).toBe(
      'total;dur=12.3, route;desc="/posts/:id";dur=0, db;desc="q__x";dur=3, neg;dur=0, nan;dur=0',
    );
    expect(serializeServerTiming([])).toBeUndefined();
  });
});

// --- the header on responses ------------------------------------------------------------------------------------------

describe("Server-Timing: the handler", () => {
  it("[OBS-10] serverTiming: true adds total, route, loaders and render to a page, and the route entry names the pattern", async () => {
    const { client } = await boot({ serverTiming: true });
    const response = await client.get("/posts/7");
    expect(response.status).toBe(200);
    const header = response.headers.get("server-timing");
    expect(header).toMatch(
      /^total;dur=[\d.]+, route;desc="\/posts\/:id";dur=[\d.]+, loaders;dur=[\d.]+, render;dur=[\d.]+$/,
    );
    const entries = parseServerTiming(header);
    expect(entries.get("route")?.desc).toBe("/posts/:id");
    // The total covers every other phase.
    const total = entries.get("total")?.dur ?? 0;
    expect(total).toBeGreaterThanOrEqual(entries.get("loaders")?.dur ?? Number.POSITIVE_INFINITY);
    await drain(response);
  });

  it("[OBS-11] an API route and a server function get total and route; an unmatched path gets total and a route entry described as unmatched", async () => {
    const { client } = await boot({ serverTiming: true });
    const api = parseServerTiming((await client.get("/api/items/1")).headers.get("server-timing"));
    expect([...api.keys()]).toEqual(["total", "route"]);
    expect(api.get("route")?.desc).toBe("/api/items/:id");
    const rpc = await client.serverFn("echo", { a: 1 });
    expect(parseServerTiming(rpc.response.headers.get("server-timing")).get("route")?.desc).toBe(
      "/_dusk/fn/:id",
    );
    const missing = await client.get("/api/nothing/here", {
      headers: { accept: "application/json" },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("server-timing")).toMatch(
      /^total;dur=[\d.]+, route;desc="unmatched";dur=[\d.]+/,
    );
    await drain(missing);
  });

  it("[OBS-12] the default follows the mode: on in development, off in production", async () => {
    const production = await boot();
    expect((await production.client.get("/api/items/1")).headers.has("server-timing")).toBe(false);
    const development = await boot({ dev: true });
    // The development default loads in the background; it never delays a request.
    await vi.waitFor(async () => {
      expect((await development.client.get("/api/items/1")).headers.has("server-timing")).toBe(
        true,
      );
    });
    const off = await boot({ dev: true, serverTiming: false });
    expect((await off.client.get("/api/items/1")).headers.has("server-timing")).toBe(false);
  });

  it("[OBS-13] a response that already has a Server-Timing header keeps it, whether the route or a middleware set it", async () => {
    const { client } = await boot({
      serverTiming: true,
      middleware: [
        async (event, next) => {
          const response = await next();
          if (event.url.pathname === "/api/items/9")
            response.headers.set("server-timing", "mw;dur=2");
          return response;
        },
      ],
    });
    expect((await client.get("/api/own")).headers.get("server-timing")).toBe("mine;dur=1");
    expect((await client.get("/api/items/9")).headers.get("server-timing")).toBe("mw;dur=2");
    expect((await client.get("/api/items/8")).headers.get("server-timing")).toMatch(/^total;/);
  });

  it("[OBS-14] event.timing.measure and add record your metrics in order; a repeated name adds up; a promise is measured until it settles", async () => {
    const { client } = await boot({ serverTiming: true });
    const response = await client.get("/api/timed");
    expect(await response.json()).toEqual({ rows: 3, cache: "hit" });
    const entries = parseServerTiming(response.headers.get("server-timing"));
    expect([...entries.keys()]).toEqual(["total", "route", "db", "cache", "external"]);
    expect(entries.get("db")?.desc).toBe("load rows");
    expect(entries.get("db")?.dur).toBeGreaterThanOrEqual(4);
    expect(entries.get("external")).toEqual({ dur: 13.3, desc: "partner api" });
    expect(entries.get("total")?.dur).toBeGreaterThanOrEqual(entries.get("db")?.dur ?? 0);
  });

  it("[OBS-15] timing(name, fn) measures in the running request", async () => {
    const { client } = await boot({ serverTiming: true });
    const response = await client.get("/api/inline");
    expect(await response.json()).toEqual({ value: 7 });
    expect(parseServerTiming(response.headers.get("server-timing")).has("lookup")).toBe(true);
  });

  it("[OBS-16] hostile names are refused with TypeError, hostile descriptions are neutralized, and the header has no line break", async () => {
    const { client } = await boot({ serverTiming: true });
    const response = await client.get("/api/hostile");
    expect((await response.json()).errors).toEqual(Array(9).fill("TypeError"));
    const header = response.headers.get("server-timing") ?? "";
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('ok;desc="x__dur=0_ evil_desc=_y__Set-Cookie: a=b_ _";dur=1');
    expect(response.headers.has("set-cookie")).toBe(false);
    // Every entry still parses as name[;desc="..."];dur=n.
    for (const entry of header.split(", ")) {
      expect(entry).toMatch(/^[\w!#$%&'*+.^`|~-]+(;desc="[ -~]*")?;dur=[\d.]+$/);
    }
  });

  it("[OBS-17] at most 20 distinct metrics: the 21st name is refused, a repeated name is not a new metric", async () => {
    const { client } = await boot({ serverTiming: true });
    const response = await client.get("/api/many");
    expect((await response.json()).message).toMatch(/at most 20/);
    expect(parseServerTiming(response.headers.get("server-timing")).size).toBe(2 + 20);
  });

  it("[OBS-18] a streamed page sends the header with the time to the shell; onTimings gets the full render time when the stream ends", async () => {
    const calls: RequestTimings[] = [];
    const { client, app } = await boot({
      serverTiming: { onTimings: (timings) => void calls.push(timings) },
    });
    const gate = deferred<string>();
    app.gates["late"] = gate;
    const response = await client.get("/stream/late");
    expect(response.status).toBe(200);
    const entries = parseServerTiming(response.headers.get("server-timing"));
    expect(entries.has("render")).toBe(true);
    const headerTotal = entries.get("total")?.dur ?? 0;
    // The body has not ended, so the request is not over.
    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    gate.resolve("DATA");
    expect(await drain(response)).toContain("DATA");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [timings] = calls as [RequestTimings];
    expect(timings.status).toBe(200);
    expect(timings.route).toBe("/stream/:name");
    expect(timings.aborted).toBe(false);
    expect(timings.streamMs).toBeGreaterThanOrEqual(timings.totalMs + 20);
    expect(timings.totalMs).toBeLessThan(headerTotal + 5);
    expect(timings.renderMs).toBeDefined();
    expect(timings.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("[OBS-19] serverTiming: { header: false } records for onTimings and keeps the numbers out of responses; a throwing hook is reported, not thrown", async () => {
    const calls: RequestTimings[] = [];
    const { client, log } = await boot({
      serverTiming: {
        header: false,
        onTimings: (timings) => {
          calls.push(timings);
          throw new Error("hook failed");
        },
      },
    });
    const response = await client.get("/api/timed");
    expect(response.status).toBe(200);
    expect(response.headers.has("server-timing")).toBe(false);
    await drain(response);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.metrics.map((metric) => metric.name)).toEqual(["db", "cache", "external"]);
    expect(calls[0]?.route).toBe("/api/timed");
    expect(log.errors.map((entry) => entry.info.phase)).toEqual(["instrumentation"]);
  });
});

// --- spans --------------------------------------------------------------------------------------------------------------

describe("child spans", () => {
  it("[OBS-20] a page request: request, page, loaders, loader (with the route id), render and stream spans in one tree, each ended once", async () => {
    const { tracer, spans } = recordingTracer();
    const { client } = await boot({ instrumentation: { tracer } });
    const response = await client.get("/posts/7");
    expect(response.status).toBe(200);
    await drain(response);
    await vi.waitFor(() => expect(only(spans, "dusk.page.stream").ended).toBe(1));
    const request = only(spans, "dusk.request");
    const page = only(spans, "dusk.page");
    const loaders = only(spans, "dusk.loaders");
    const loader = only(spans, "dusk.loader");
    const render = only(spans, "dusk.render");
    expect(page.parent).toBe(request);
    expect(loaders.parent).toBe(page);
    expect(loader.parent).toBe(loaders);
    expect(loader.attributes["dusk.route.id"]).toBe("post");
    expect(render.parent).toBe(page);
    expect(request.attributes).toMatchObject({
      "http.request.method": "GET",
      "url.path": "/posts/7",
      "http.response.status_code": 200,
      "http.route": "/posts/:id",
    });
    expect(page.attributes["http.response.status_code"]).toBe(200);
    for (const span of spans) expect(span.ended, span.name).toBe(1);
  });

  it("[OBS-21] an API route and a server function get a span with their name and status; a failure records the exception", async () => {
    const { tracer, spans } = recordingTracer();
    const { client, log } = await boot({ instrumentation: { tracer } });
    expect((await client.get("/api/items/5")).status).toBe(200);
    const api = only(spans, "dusk.api");
    expect(api.attributes).toMatchObject({
      "http.route": "/api/items/:id",
      "dusk.route.id": "items",
      "http.response.status_code": 200,
    });
    expect(api.status).toBeUndefined();

    spans.length = 0;
    const failed = await client.get("/api/throwing");
    expect(failed.status).toBe(500);
    const apiFailure = only(spans, "dusk.api");
    const requestFailure = only(spans, "dusk.request");
    expect(apiFailure.attributes["http.response.status_code"]).toBe(500);
    expect(apiFailure.attributes["error.type"]).toBe("Error");
    expect(apiFailure.status?.code).toBe(2);
    // The error was reported once; the request span recorded it with its type.
    expect(requestFailure.exceptions).toHaveLength(1);
    expect(requestFailure.attributes["error.type"]).toBeDefined();
    expect(requestFailure.attributes["http.response.status_code"]).toBe(500);
    expect(log.errors).toHaveLength(1);

    spans.length = 0;
    await client.serverFn("echo", { n: 1 });
    const rpc = only(spans, "dusk.rpc");
    expect(rpc.attributes).toMatchObject({
      "dusk.rpc.name": "echo",
      "http.response.status_code": 200,
    });
    spans.length = 0;
    await client.serverFn("failing", {});
    const rpcFailure = only(spans, "dusk.rpc");
    expect(rpcFailure.attributes["dusk.rpc.name"]).toBe("failing");
    expect(rpcFailure.attributes["http.response.status_code"]).toBe(500);
    expect(rpcFailure.status?.code).toBe(2);
    for (const span of spans) expect(span.ended, span.name).toBe(1);
  });

  it("[OBS-22] a loader that throws records the exception on its span and the request span; a redirect, a not-found and a 4xx are answers, not failures", async () => {
    const { tracer, spans } = recordingTracer();
    const { client } = await boot({ instrumentation: { tracer } });
    expect((await client.get("/broken")).status).toBe(500);
    const loader = only(spans, "dusk.loader");
    expect(loader.exceptions).toHaveLength(1);
    expect(loader.attributes["error.type"]).toBe("Error");
    expect(loader.status?.code).toBe(2);
    expect(only(spans, "dusk.request").exceptions).toHaveLength(1);

    for (const path of ["/forbidden", "/gone"]) {
      spans.length = 0;
      await drain(await client.get(path));
      const failed = named(spans, "dusk.loader");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.exceptions, path).toHaveLength(0);
      expect(failed[0]?.status, path).toBeUndefined();
    }
    spans.length = 0;
    const moved = await client.get("/old", { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(spans.every((span) => span.exceptions.length === 0)).toBe(true);
  });

  it("[OBS-23] an unmatched path records the 404 and no http.route", async () => {
    const { tracer, spans } = recordingTracer();
    const { client } = await boot({ instrumentation: { tracer } });
    const response = await client.get("/api/nothing/here", {
      headers: { accept: "application/json" },
    });
    expect(response.status).toBe(404);
    const request = only(spans, "dusk.request");
    expect(request.attributes["http.response.status_code"]).toBe(404);
    expect("http.route" in request.attributes).toBe(false);
    expect(named(spans, "dusk.none")).toHaveLength(0);
  });

  it("[OBS-24] a request that times out ends every span once, and the work finishing later ends nothing twice", async () => {
    const { tracer, spans } = recordingTracer();
    const { client } = await boot({
      instrumentation: { tracer },
      security: { limits: { requestTimeoutMs: 40 } },
    });
    const response = await client.get("/api/hang", { headers: { accept: "application/json" } });
    expect(response.status).toBe(504);
    const api = only(spans, "dusk.api");
    expect(api.ended).toBe(1);
    expect(api.attributes["error.type"]).toBe("timeout");
    expect(api.status?.code).toBe(2);
    const request = only(spans, "dusk.request");
    expect(request.ended).toBe(1);
    expect(request.attributes["http.response.status_code"]).toBe(504);
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const span of spans) expect(span.ended, span.name).toBe(1);
  });

  it("[OBS-25] a client that aborts ends every span once, with the reason on the one the request outlived", async () => {
    const { tracer, spans } = recordingTracer();
    const { handler } = await boot({ instrumentation: { tracer } });
    const controller = new AbortController();
    const pending = handler.fetch(
      new Request("http://localhost/api/wait", {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }),
    );
    await vi.waitFor(() => expect(named(spans, "dusk.api")).toHaveLength(1));
    controller.abort(new Error("gone"));
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const span of spans) expect(span.ended, span.name).toBe(1);
    expect(only(spans, "dusk.api").exceptions).toHaveLength(1);
  });

  it("[OBS-26] a stream the client cancels ends its span and completes the request as aborted", async () => {
    const { tracer, spans } = recordingTracer();
    const calls: RequestTimings[] = [];
    const { client, app } = await boot({
      instrumentation: { tracer },
      serverTiming: { header: false, onTimings: (timings) => void calls.push(timings) },
    });
    app.gates["never"] = deferred<string>();
    const response = await client.get("/stream/never");
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.streamMs).toBeUndefined();
    const stream = only(spans, "dusk.page.stream");
    expect(stream.ended).toBe(1);
    for (const span of spans) expect(span.ended, span.name).toBe(1);
  });

  it("[OBS-27] a tracer that throws never fails a request: it is reported once and spans stop", async () => {
    let calls = 0;
    const tracer: TracerLike = {
      startActiveSpan(name, _options, fn) {
        calls += 1;
        if (name !== "dusk.request") throw new Error("tracer is down");
        return fn({
          setAttribute: () => undefined,
          recordException: () => undefined,
          setStatus: () => undefined,
          end: () => undefined,
        });
      },
    };
    const { client, log } = await boot({ instrumentation: { tracer } });
    for (let index = 0; index < 3; index += 1) {
      const response = await client.get("/api/items/1");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "1", method: "GET" });
    }
    expect(log.errors.map((entry) => entry.info.phase)).toEqual(["instrumentation"]);
    // One request span per request, and one failed attempt at a child span before spans were turned off.
    expect(calls).toBe(3 + 1);
  });

  it("[OBS-28] event.timing.measure also makes a dusk.timing child span when a tracer is set", async () => {
    const { tracer, spans } = recordingTracer();
    const { client } = await boot({ instrumentation: { tracer } });
    await client.get("/api/timed");
    const measured = named(spans, "dusk.timing");
    expect(measured.map((span) => span.attributes["dusk.timing.name"])).toEqual(["db", "cache"]);
    expect(measured.every((span) => span.ended === 1)).toBe(true);
  });
});

// --- cost when unused ----------------------------------------------------------------------------------------------

describe("zero cost when unused", () => {
  it("[OBS-30] with the no-op tracer and no option in production nothing observes: no tracer call, no clock read, no observation", async () => {
    const { client } = await boot();
    const spy = vi.spyOn(NOOP_TRACER, "startActiveSpan");
    const clock = clockOfObservation();
    try {
      for (let index = 0; index < 10; index += 1) {
        await drain(await client.get("/api/items/1"));
        await drain(await client.get("/posts/1"));
      }
      await client.serverFn("echo", { a: 1 });
      expect(spy).not.toHaveBeenCalled();
      expect(clock.reads()).toBe(0);
      await client.get("/api/probe");
      expect(seenByRoutes.obs).toBeUndefined();
      expect(seenByRoutes.measured.at(-1)).toBe("ran");
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("[OBS-31] with a tracer, the calls are counted: 2 spans for an API request, and none of the timing clock without serverTiming", async () => {
    let started = 0;
    const tracer: TracerLike = {
      startActiveSpan(_name, _options, fn) {
        started += 1;
        return fn({
          setAttribute: () => undefined,
          recordException: () => undefined,
          setStatus: () => undefined,
          end: () => undefined,
        });
      },
    };
    const { client } = await boot({ instrumentation: { tracer }, serverTiming: false });
    for (let index = 0; index < 5; index += 1) await drain(await client.get("/api/items/1"));
    expect(started).toBe(5 * 2);
  });

  it("[OBS-32] a handler with serverTiming reads the clock, so the test above would see it", async () => {
    const { client } = await boot({ serverTiming: true });
    const clock = clockOfObservation();
    try {
      await drain(await client.get("/api/items/1"));
      expect(clock.reads()).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
  });
});

// --- metrics ---------------------------------------------------------------------------------------------------------------

describe("metrics", () => {
  function meter(): {
    meter: MetricsLike;
    counts: { value: number; attributes: unknown }[];
    durations: { value: number; attributes: unknown }[];
    created: string[];
  } {
    const counts: { value: number; attributes: unknown }[] = [];
    const durations: { value: number; attributes: unknown }[] = [];
    const created: string[] = [];
    return {
      counts,
      durations,
      created,
      meter: {
        createCounter: (name) => {
          created.push(name);
          return { add: (value, attributes) => void counts.push({ value, attributes }) };
        },
        createHistogram: (name) => {
          created.push(name);
          return { record: (value, attributes) => void durations.push({ value, attributes }) };
        },
      },
    };
  }

  it("[OBS-40] every request counts once and records its duration in seconds, by route, method and status class", async () => {
    const recorded = meter();
    const { client } = await boot({ metrics: recorded.meter });
    await drain(await client.get("/api/items/3"));
    await drain(
      await client.post("/api/items/3", {
        body: JSON.stringify({ a: 1 }),
        headers: { "content-type": "application/json" },
      }),
    );
    // The unmatched path renders the app's not-found page, a streamed body: it counts when read to the end.
    await drain(await client.get("/api/nothing/here", { headers: { accept: "application/json" } }));
    await drain(await client.get("/api/throwing", { headers: { accept: "application/json" } }));
    expect(recorded.created).toEqual(["dusk.server.requests", "http.server.request.duration"]);
    expect(recorded.counts.map((entry) => entry.value)).toEqual([1, 1, 1, 1]);
    expect(recorded.counts.map((entry) => entry.attributes)).toEqual([
      {
        "http.request.method": "GET",
        "http.response.status_class": "2xx",
        "http.route": "/api/items/:id",
      },
      {
        "http.request.method": "POST",
        "http.response.status_class": "2xx",
        "http.route": "/api/items/:id",
      },
      { "http.request.method": "GET", "http.response.status_class": "4xx" },
      {
        "http.request.method": "GET",
        "http.response.status_class": "5xx",
        "http.route": "/api/throwing",
      },
    ]);
    expect(recorded.durations).toHaveLength(4);
    for (const entry of recorded.durations) {
      expect(entry.value).toBeGreaterThan(0);
      expect(entry.value).toBeLessThan(2);
    }
  });

  it("[OBS-41] a streamed page is recorded when its body ends, not before", async () => {
    const recorded = meter();
    const { client, app } = await boot({ metrics: recorded.meter });
    const gate = deferred<string>();
    app.gates["m"] = gate;
    const response = await client.get("/stream/m");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(recorded.counts).toHaveLength(0);
    gate.resolve("x");
    await drain(response);
    await vi.waitFor(() => expect(recorded.counts).toHaveLength(1));
    expect(recorded.durations[0]?.value).toBeGreaterThanOrEqual(0.012);
  });

  it("[OBS-42] a meter that throws never fails a request and is reported", async () => {
    const { client, log } = await boot({
      metrics: {
        createCounter: () => ({
          add: () => {
            throw new Error("meter down");
          },
        }),
        createHistogram: () => ({ record: () => undefined }),
      },
    });
    const response = await client.get("/api/items/1");
    expect(response.status).toBe(200);
    expect(log.errors.map((entry) => entry.info.phase)).toContain("instrumentation");
  });

  it("[OBS-43] an option of the wrong shape is reported at the first request and the app still answers", async () => {
    for (const options of [
      { serverTiming: "yes" },
      { serverTiming: { header: "no" } },
      { serverTiming: { onTimings: 1 } },
      { metrics: {} },
    ]) {
      const { client, log } = await boot(options as unknown as Partial<HandlerOptions>);
      const response = await client.get("/api/items/1");
      expect(response.status).toBe(200);
      expect(response.headers.has("server-timing")).toBe(false);
      expect(log.errors).toHaveLength(1);
      expect(log.errors[0]?.info.phase).toBe("instrumentation");
      expect(log.errors[0]?.error).toBeInstanceOf(TypeError);
    }
  });
});
