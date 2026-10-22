import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isNotFound, isRedirect, type RedirectSignal } from "@shadow-js/router/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerFnError, ServerFnProtocolError } from "../../src/client/errors";
import { serverFnStub } from "../../src/client/fn";
import { HttpError, isHttpError } from "../../src/internal/http-error";
import {
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  type ErrorInfo,
  notFound,
  redirect,
  serverFn,
} from "../../src/server/index";
import { allFeatures } from "../support/features";
import { browserFetch, serve, type TestServer } from "./support/http";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

interface Rig {
  readonly origin: string;
  readonly errors: unknown[];
  readonly seen: { method: string; url: string; headers: Headers; body: string }[];
  readonly handler: DuskHandler;
  call<I, O>(id: string, method?: "GET" | "POST", base?: string): (input?: I) => Promise<O>;
}

const gates = new Map<string, () => void>();

async function rig(): Promise<Rig> {
  const errors: unknown[] = [];
  const seen: Rig["seen"] = [];
  const fns = {
    echo: serverFn({}, async (input: unknown) => input),
    read: serverFn({ method: "GET" }, async (input: unknown) => ({ got: input })),
    forbidden: serverFn({}, async () => {
      throw new HttpError(403, "Not for you", { data: { why: "role" } });
    }),
    gone: serverFn({}, async () => {
      throw notFound();
    }),
    go: serverFn({}, async () => {
      throw redirect("/login?next=%2Fa", { status: 303 });
    }),
    away: serverFn({}, async () => {
      throw redirect("https://evil.example/steal");
    }),
    boom: serverFn({}, async () => {
      throw new Error("database password is hunter2");
    }),
    unavailable: serverFn({}, async () => {
      throw new HttpError(503, "replica db-7 is down", { data: { host: "db-7" } });
    }),
    maintenance: serverFn({}, async () => {
      throw new HttpError(503, "Back at noon", { expose: true, data: { retryAfter: 60 } });
    }),
    returnsError: serverFn({}, async () => new Error("database password is hunter2")),
    nestsError: serverFn({}, async () => ({ failed: [new TypeError("hunter2 inside")] })),
    checked: serverFn(
      {
        input: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) =>
              typeof value === "string"
                ? { value }
                : { issues: [{ message: "expected a string", path: [] }] },
          },
        },
      },
      async (input) => input,
    ),
    slow: serverFn({}, async () => {
      await new Promise<void>((resolve) => gates.set("slow", resolve));
      return "late";
    }),
  };
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: [],
    serverFns: Object.fromEntries(
      Object.entries(fns).map(([id, fn]) => [id, { load: async () => fn }]),
    ),
    assets: { entry: "", css: [], preloads: {}, base: "/" },
    App: ({ children }: { children?: unknown }) => children,
  };
  const handler = createHandler({
    features: allFeatures(),
    manifest,
    dev: false,
    // Production needs a host list (G-C6). The test server listens on a random port on 127.0.0.1.
    security: { allowedHosts: ["127.0.0.1"] },
    onError: (error: unknown, info: ErrorInfo) => {
      errors.push([error, info.phase]);
    },
    middleware: [
      async (event, next) => {
        seen.push({
          method: event.method,
          url: event.url.pathname + event.url.search,
          headers: event.request.headers,
          body: event.method === "POST" ? await event.request.clone().text() : "",
        });
        return next();
      },
    ],
  });
  const server = await serve((request) => handler.fetch(request));
  servers.push(server);
  const fetchImpl = browserFetch(server.origin);
  return {
    origin: server.origin,
    errors,
    seen,
    handler,
    call<I, O>(id: string, method: "GET" | "POST" = "POST", base = "") {
      const stub = serverFnStub<I, O>(id, { method, form: false, base });
      return stub.with({ fetch: fetchImpl });
    },
  };
}

describe("serverFnStub: the request", () => {
  it("[SCLI-01] POST goes to {base}/_dusk/fn/<id> with the call header and a serialized [input] body", async () => {
    const r = await rig();
    const echo = r.call<{ a: number }, { a: number }>("echo");
    expect(await echo({ a: 1 })).toEqual({ a: 1 });
    const request = r.seen[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("/_dusk/fn/echo");
    expect(request?.headers.get("x-dusk-fn")).toBe("1");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toBeTruthy();
    expect(request?.body).toContain('"a"');
  });

  it("[SCLI-02] GET puts the call in ?p= and sends no body", async () => {
    const r = await rig();
    const read = r.call<{ q: string }, { got: { q: string } }>("read", "GET");
    expect(await read({ q: "x y" })).toEqual({ got: { q: "x y" } });
    const request = r.seen[0];
    expect(request?.method).toBe("GET");
    expect(request?.url.startsWith("/_dusk/fn/read?p=")).toBe(true);
    expect(request?.headers.get("x-dusk-fn")).toBe("1");
  });

  it("[SCLI-03] the stub knows its id and endpoint, and base is part of the URL", () => {
    const stub = serverFnStub("abc", { method: "POST", form: false, base: "/app" });
    expect(stub.id).toBe("abc");
    expect(stub.url).toBe("/app/_dusk/fn/abc");
  });

  it("[SCLI-04] with() adds headers; x-dusk-fn and content-type cannot be replaced", async () => {
    const r = await rig();
    const stub = serverFnStub("echo", { method: "POST", form: false, base: "" });
    const call = stub.with({
      fetch: browserFetch(r.origin),
      headers: { "x-custom": "yes", "x-dusk-fn": "0", "content-type": "text/plain" },
    });
    await call(1);
    expect(r.seen[0]?.headers.get("x-custom")).toBe("yes");
    expect(r.seen[0]?.headers.get("x-dusk-fn")).toBe("1");
    expect(r.seen[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("[SCLI-05] the codec carries Date, Map, Set, BigInt, undefined, NaN and cycles in both directions", async () => {
    const r = await rig();
    const echo = r.call<unknown, unknown>("echo");
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    const input = {
      when: new Date(86_400_000),
      m: new Map([["k", 1n]]),
      s: new Set([1, 2]),
      u: undefined,
      n: Number.NaN,
      negZero: -0,
      url: new URL("https://example.com/x"),
      cyclic,
    };
    const output = (await echo(input)) as typeof input;
    expect(output.when).toEqual(input.when);
    expect(output.m).toEqual(input.m);
    expect(output.s).toEqual(input.s);
    expect("u" in output && output.u === undefined).toBe(true);
    expect(Number.isNaN(output.n)).toBe(true);
    expect(Object.is(output.negZero, -0)).toBe(true);
    expect(output.url.href).toBe("https://example.com/x");
    expect(output.cyclic["self"]).toBe(output.cyclic);
  });

  it("[SCLI-06] functions and symbols in the input are rejected before anything is sent", async () => {
    const r = await rig();
    const echo = r.call<unknown, unknown>("echo");
    await expect(echo({ fn: () => 1 })).rejects.toBeInstanceOf(TypeError);
    await expect(echo(Symbol("s"))).rejects.toBeInstanceOf(TypeError);
    expect(r.seen).toHaveLength(0);
  });
});

describe("serverFnStub: the answer", () => {
  it("[SCLI-10] an HttpError arrives as an HttpError with status, message and data", async () => {
    const r = await rig();
    const error = await r
      .call("forbidden")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(HttpError);
    expect(isHttpError(error)).toBe(true);
    if (error instanceof HttpError) {
      expect(error.status).toBe(403);
      expect(error.message).toBe("Not for you");
      expect(error.data).toEqual({ why: "role" });
    }
  });

  it("[SCLI-11] a schema failure is an HttpError 400 with the issues", async () => {
    const r = await rig();
    const error = await r
      .call("checked")(42)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(HttpError);
    if (error instanceof HttpError) {
      expect(error.status).toBe(400);
      expect(error.data).toEqual({ issues: [{ message: "expected a string", path: [] }] });
    }
    expect(await r.call("checked")("ok")).toBe("ok");
  });

  it("[SCLI-12] a redirect rejects with the router's redirect signal, same origin only", async () => {
    const r = await rig();
    const error = await r
      .call("go")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isRedirect(error)).toBe(true);
    const signal = error as RedirectSignal;
    expect(signal.to).toBe("/login?next=%2Fa");
    // The server refuses an origin it does not trust, so the call fails instead of redirecting.
    const away = await r
      .call("away")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isRedirect(away)).toBe(false);
    expect(away).toBeInstanceOf(ServerFnError);
    expect(r.errors.length).toBeGreaterThan(0);
    r.errors.length = 0;
  });

  it("[SCLI-13] notFound() arrives as the router's notFound signal", async () => {
    const r = await rig();
    const error = await r
      .call("gone")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isNotFound(error)).toBe(true);
  });

  it("[SCLI-14] an unexpected server error is a ServerFnError with a request id and no server text", async () => {
    const r = await rig();
    const error = await r
      .call("boom")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ServerFnError);
    if (error instanceof ServerFnError) {
      expect(error.status).toBe(500);
      expect(error.requestId).toMatch(/\S/);
      expect(error.message).not.toContain("hunter2");
      expect(error.message).toBe("Internal Server Error");
    }
    expect(r.errors).toHaveLength(1);
    r.errors.length = 0;
  });

  it("[SCLI-15] an unknown id answers 404 like notFound() does, so the client sees the notFound signal", async () => {
    const r = await rig();
    const error = await r
      .call("nope")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isNotFound(error)).toBe(true);
  });

  it("[SCLI-16] a method the function does not accept is a ServerFnError 405", async () => {
    const r = await rig();
    const error = await r
      .call("read", "POST")()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ServerFnError);
    expect((error as ServerFnError).status).toBe(405);
  });
});

describe("serverFnStub: typed errors", () => {
  /** Awaits a call and returns what it rejected with. */
  async function failure(id: string): Promise<unknown> {
    const r = await rig();
    const caught = await r
      .call(id)()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    r.errors.length = 0;
    return caught;
  }

  it("[SCLI-30] an HttpError 5xx arrives as an HttpError (not a ServerFnError) with the reason phrase, never its message or data", async () => {
    const error = await failure("unavailable");
    expect(isHttpError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ServerFnError);
    if (isHttpError(error)) {
      expect(error.status).toBe(503);
      expect(error.message).toBe("Service Unavailable");
      expect(error.data).toBeUndefined();
    }
  });

  it("[SCLI-31] an HttpError 5xx with expose: true keeps its message and data", async () => {
    const error = await failure("maintenance");
    expect(isHttpError(error)).toBe(true);
    if (isHttpError(error)) {
      expect(error.status).toBe(503);
      expect(error.message).toBe("Back at noon");
      expect(error.data).toEqual({ retryAfter: 60 });
    }
  });

  it("[SCLI-32] a plain Error is a ServerFnError with its status and the request id; the server's message and stack never arrive", async () => {
    const error = await failure("boom");
    expect(error).toBeInstanceOf(ServerFnError);
    expect(error).not.toSatisfy(isHttpError);
    if (error instanceof ServerFnError) {
      expect(error.name).toBe("ServerFnError");
      expect(error.status).toBe(500);
      expect(error.message).toBe("Internal Server Error");
      expect(error.requestId).toMatch(/\S/);
      expect(`${error.stack}${JSON.stringify(Object.entries(error))}`).not.toContain("hunter2");
      expect(error.cause).toBeUndefined();
    }
  });

  it("[SCLI-33] an Error returned as a value (or nested in one) is not a codec value: the call fails with a masked 500, reported once", async () => {
    for (const id of ["returnsError", "nestsError"]) {
      const r = await rig();
      const error = await r
        .call(id)()
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error, id).toBeInstanceOf(ServerFnError);
      if (error instanceof ServerFnError) {
        expect(error.status).toBe(500);
        expect(error.message).not.toContain("hunter2");
      }
      expect(r.errors, id).toHaveLength(1);
      r.errors.length = 0;
    }
  });
});

describe("serverFnStub: abort", () => {
  it("[SCLI-20] aborting rejects with AbortError exactly once and leaves nothing pending", async () => {
    const r = await rig();
    const controller = new AbortController();
    const stub = serverFnStub<void, string>("slow", { method: "POST", form: false, base: "" });
    const outcomes: unknown[] = [];
    const promise = stub
      .with({ fetch: browserFetch(r.origin), signal: controller.signal })()
      .then(
        (value) => outcomes.push(["value", value]),
        (error: unknown) => outcomes.push(["error", error]),
      );
    // The request is in flight once the server function started waiting on its gate.
    while (!gates.has("slow")) await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await promise;
    gates.get("slow")?.();
    gates.delete("slow");
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0] as [string, unknown];
    expect(outcome[0]).toBe("error");
    expect((outcome[1] as Error).name).toBe("AbortError");
    r.errors.length = 0;
  });

  it("[SCLI-22] the stub takes call options as its last argument: { signal } aborts the request, so the stub fits (input, { signal }) callers", async () => {
    const r = await rig();
    const controller = new AbortController();
    const fetchImpl = browserFetch(r.origin);
    const sent: (RequestInit | undefined)[] = [];
    const recording: typeof fetch = (input, init) => {
      sent.push(init);
      return fetchImpl(input, init);
    };
    const stub = serverFnStub<void, string>("slow", { method: "POST", form: false, base: "" });
    const outcomes: unknown[] = [];
    const promise = stub(undefined, { signal: controller.signal, fetch: recording }).then(
      (value) => outcomes.push(["value", value]),
      (error: unknown) => outcomes.push(["error", error]),
    );
    while (!gates.has("slow")) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sent[0]?.signal).toBe(controller.signal);
    controller.abort();
    await promise;
    gates.get("slow")?.();
    gates.delete("slow");
    expect((outcomes[0] as [string, Error])[1].name).toBe("AbortError");
    r.errors.length = 0;
  });

  it("[SCLI-23] a last argument that is not an options object (the index of Array.map) is ignored", async () => {
    const r = await rig();
    const stub = serverFnStub<number, number>("echo", { method: "POST", form: false, base: "" });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("sec-fetch-site", "same-origin");
      return real(new URL(input, r.origin), { ...init, headers });
    });
    try {
      const loose = stub as unknown as (input: number, options: unknown) => Promise<number>;
      expect(await Promise.all([5, 6].map((n, index) => loose(n, index)))).toEqual([5, 6]);
      expect(await loose(7, [])).toBe(7);
      expect(await loose(8, null)).toBe(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("[SCLI-21] an already aborted signal rejects without sending", async () => {
    const r = await rig();
    const controller = new AbortController();
    controller.abort();
    const stub = serverFnStub("echo", { method: "POST", form: false, base: "" });
    const call = stub.with({ fetch: browserFetch(r.origin), signal: controller.signal });
    await expect(call(1)).rejects.toMatchObject({ name: "AbortError" });
    expect(r.seen).toHaveLength(0);
  });
});

describe("serverFnStub: answers that are not server function answers", () => {
  async function bare(
    respond: (res: import("node:http").ServerResponse) => void,
  ): Promise<{ call: () => Promise<unknown>; close: () => Promise<void> }> {
    const server = createServer((_req, res) => respond(res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stub = serverFnStub("x", { method: "POST", form: false, base: "" });
    return {
      call: () => stub.with({ fetch: browserFetch(origin) })(),
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  const bad: [string, (res: import("node:http").ServerResponse) => void][] = [
    [
      "an HTML error page",
      (res) => {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html>Bad gateway</html>");
      },
    ],
    [
      "truncated JSON",
      (res) => {
        res.writeHead(200);
        res.end('{"r":{"$":"obj","e":[["ok",true]');
      },
    ],
    [
      "an unknown envelope",
      (res) => {
        res.writeHead(200);
        res.end(JSON.stringify({ r: { $: "obj", e: [["hello", "world"]] }, t: [] }));
      },
    ],
    [
      "an empty body",
      (res) => {
        res.writeHead(200);
        res.end("");
      },
    ],
    [
      "a redirect the browser did not follow",
      (res) => {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
      },
    ],
    [
      "a failure envelope of the wrong shape",
      (res) => {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            r: {
              $: "obj",
              e: [
                ["ok", false],
                ["error", "text"],
              ],
            },
            t: [],
          }),
        );
      },
    ],
  ];

  it.each(bad)("[SCLI-30] %s is a ServerFnProtocolError", async (_name, respond) => {
    const server = await bare(respond);
    try {
      const error = await server.call().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ServerFnProtocolError);
      expect((error as Error).message).not.toContain("Bad gateway");
    } finally {
      await server.close();
    }
  });

  it("[SCLI-31] 1000 failing calls leave no unhandled rejection", async () => {
    const r = await rig();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const forbidden = r.call("forbidden");
      const results = await Promise.allSettled(Array.from({ length: 1000 }, () => forbidden()));
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });
});
