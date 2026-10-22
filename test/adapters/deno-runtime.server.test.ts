import { afterEach, describe, expect, it, vi } from "vitest";
import { deno, serve } from "../../src/deno/index";
import type { Handler } from "../../src/server/types";

/**
 * The Deno layer of `@shadow-js/dusk/deno` with web-standard fakes: a `Deno.serve` that records its options and
 * handler, and a `Request` in, `Response` out. No `deno` binary runs here, so these tests cover the code this package
 * owns (the listener mapping, the client address, the stop, and the error when the runtime is missing). The emitted
 * entry is run by the conformance suite when `deno` is on the PATH; that run is not part of this machine's checks.
 */

interface FakeServeCall {
  readonly options: { hostname: string; port: number; onListen(): void };
  readonly handler: (
    request: Request,
    info: { remoteAddr: { hostname: string } },
  ) => Promise<Response>;
}

/** Stubs `globalThis.Deno` with a `serve` that records the call and reports `port` as the bound port. */
function stubDeno(port = 4321): { calls: FakeServeCall[]; shutdowns: () => number } {
  const calls: FakeServeCall[] = [];
  let shutdowns = 0;
  vi.stubGlobal("Deno", {
    serve(options: FakeServeCall["options"], handler: FakeServeCall["handler"]) {
      calls.push({ options, handler });
      return {
        addr: { transport: "tcp", hostname: options.hostname, port },
        shutdown: () => {
          shutdowns += 1;
          return Promise.resolve();
        },
      };
    },
  });
  return { calls, shutdowns: () => shutdowns };
}

const handler: Handler = {
  fetch: (request, platform) => {
    const address =
      typeof platform === "object" && platform !== null
        ? Reflect.get(platform, "clientAddress")
        : undefined;
    return Promise.resolve(
      new Response(`${new URL(request.url).pathname} ${String(address)}`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  },
};

/** Servers a test started; each is closed after the test, so the process listeners it adds are removed. */
const running: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the Deno layer (DENO-*)", () => {
  it("[DENO-09] a rejected shutdown releases its signal listeners and deadline timer", async () => {
    vi.useFakeTimers();
    const error = new Error("shutdown failed");
    vi.stubGlobal("Deno", {
      serve: () => ({ addr: { port: 4321 }, shutdown: () => Promise.reject(error) }),
    });
    const before = process.listeners("SIGTERM");
    const server = await serve(handler, { port: 0, static: false, shutdownSignals: ["SIGTERM"] });
    try {
      await expect(server.close()).rejects.toThrow(error);
      expect(process.listeners("SIGTERM")).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (const listener of process.listeners("SIGTERM"))
        if (!before.includes(listener)) process.off("SIGTERM", listener);
    }
  });
  it("[DENO-08] the graceful deadline bounds an HTTP shutdown that never completes", async () => {
    vi.useFakeTimers();
    const shutdown = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal("Deno", { serve: () => ({ addr: { port: 4321 }, shutdown }) });
    const server = await serve(handler, {
      port: 0,
      static: false,
      shutdownSignals: false,
      gracefulShutdownMs: 10,
    });
    let finished = false;
    const closing = server.close().then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await closing;
  });
  it("[DENO-01] serve() outside Deno is an error that names the runtime, and nothing listens", async () => {
    vi.stubGlobal("Deno", undefined);
    await expect(serve(handler, { port: 0, static: false })).rejects.toThrow(
      /this runtime is not Deno/,
    );
  });

  it("[DENO-02] serve() passes the hostname and port to Deno.serve and reports the bound port and URL", async () => {
    const { calls } = stubDeno(4321);
    const server = await serve(handler, { port: 0, hostname: "127.0.0.1", static: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.hostname).toBe("127.0.0.1");
    expect(calls[0]?.options.port).toBe(0);
    expect(server.port).toBe(4321);
    expect(server.url).toBe("http://127.0.0.1:4321");
    await server.close();
  });

  it("[DENO-03] the client address is the remote address Deno reports, not a forwarded header", async () => {
    const { calls } = stubDeno();
    running.push(await serve(handler, { port: 0, hostname: "127.0.0.1", static: false }));
    const response = await calls[0]?.handler(
      new Request("http://app.test/who", { headers: { "x-forwarded-for": "198.51.100.1" } }),
      { remoteAddr: { hostname: "192.0.2.44" } },
    );
    expect(response).toBeDefined();
    expect(await response?.text()).toBe("/who 192.0.2.44");
  });

  it("[DENO-04] close() stops the Deno server once, however often it is called", async () => {
    const { shutdowns } = stubDeno();
    const server = await serve(handler, { port: 0, hostname: "127.0.0.1", static: false });
    await server.close();
    await server.close();
    expect(shutdowns()).toBe(1);
    expect(server.draining).toBe(true);
  });

  it("[DENO-05] a Deno.serve result without an address or a shutdown is refused, with the reason", () => {
    vi.stubGlobal("Deno", { serve: () => ({ addr: {} }) });
    return expect(serve(handler, { port: 0, static: false })).rejects.toThrow(
      /Deno\.serve returned an unexpected server/,
    );
  });

  it("[DENO-06] a handler failure is a plain 500, reported once, and the server keeps its handler", async () => {
    const failing: Handler = { fetch: () => Promise.reject(new Error("deno boom")) };
    const { calls } = stubDeno();
    const reported: unknown[] = [];
    running.push(
      await serve(failing, {
        port: 0,
        hostname: "127.0.0.1",
        static: false,
        onError: (error) => reported.push(error),
      }),
    );
    const answer = await calls[0]?.handler(new Request("http://app.test/x"), {
      remoteAddr: { hostname: "192.0.2.1" },
    });
    expect(answer?.status).toBe(500);
    expect(await answer?.text()).toBe("Internal Server Error");
    expect(reported).toHaveLength(1);
  });

  it("[DENO-07] the Deno adapter has its name, output folder and capabilities, and declares the file gate", () => {
    const adapter = deno();
    expect(adapter.name).toBe("deno");
    expect(adapter.outDir).toBe("dist/deno");
    expect(adapter.capabilities.websockets).toBe(true);
    expect(adapter.capabilities.middlewareForStaticFiles).toBe(true);
  });
});
