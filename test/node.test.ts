import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { negotiateEncoding, type ServerHandle, serve } from "../src/node/index";
import type { Handler } from "../src/server/types";
import { deferred } from "./support/deferred";
import { rawRequest, settled, statusOf } from "./support/net";

const open: ServerHandle[] = [];

async function start(
  fetch: Handler["fetch"],
  options: Parameters<typeof serve>[1] = {},
): Promise<ServerHandle> {
  const handle = await serve({ fetch }, { port: 0, shutdownSignals: false, ...options });
  open.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

const encoder = new TextEncoder();

describe("request and response bridging", () => {
  it("[SNOD-01] a request arrives with method, URL, headers and body; status, status text and several Set-Cookie lines go back", async () => {
    let seen:
      | {
          method: string;
          url: string;
          headers: Record<string, string>;
          body: string;
          peer: unknown;
        }
      | undefined;
    const server = await start(async (request, platform) => {
      seen = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
        peer: platform,
      };
      const headers = new Headers({ "content-type": "text/plain", "x-custom": "yes" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("created", { status: 201, statusText: "Made", headers });
    });
    const response = await fetch(`${server.url}/path/x?y=1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-in": "v" },
      body: '{"a":1}',
    });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Made");
    expect(response.headers.get("x-custom")).toBe("yes");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await response.text()).toBe("created");
    expect(seen).toMatchObject({
      method: "POST",
      url: `${server.url}/path/x?y=1`,
      body: '{"a":1}',
      peer: { clientAddress: "127.0.0.1" },
    });
    expect(seen?.headers["x-in"]).toBe("v");
  });

  it("[SNOD-02] the request body streams into the handler and the response body streams out, before either side is finished", async () => {
    const release = deferred<void>();
    const received: string[] = [];
    const server = await start(async (request) => {
      const reader = request.body?.getReader();
      const first = await reader?.read();
      received.push(new TextDecoder().decode(first?.value));
      release.resolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("one|"));
            await release.promise;
            controller.enqueue(encoder.encode("two"));
            controller.close();
          },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${server.url}/`, { method: "POST" }, (res) => {
        const chunks: string[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
        res.on("end", () => {
          expect(chunks.join("")).toBe("one|two");
          resolve();
        });
      });
      req.on("error", reject);
      req.write("first-part");
      // The handler answers after the first part; the rest of the upload is still to come.
      release.promise.then(() => {
        req.end("second-part");
      }, reject);
    });
    expect(received[0]).toBe("first-part");
  });

  it("[SNOD-03] a client that disconnects aborts the request signal and cancels the response body", async () => {
    const aborted = deferred<unknown>();
    const canceled = deferred<unknown>();
    const server = await start(async (request) => {
      request.signal.addEventListener("abort", () => aborted.resolve(request.signal.reason));
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("hello"));
          },
          cancel(reason) {
            canceled.resolve(reason);
          },
        }),
      );
    });
    const controller = new AbortController();
    const response = await fetch(`${server.url}/`, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    expect(await aborted.promise).toBeDefined();
    await canceled.promise;
  });

  it("[SNOD-04] backpressure: a client that does not read stops the producer after a bounded number of chunks", async () => {
    let produced = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const server = await start(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                produced += 1;
                controller.enqueue(chunk);
              },
            },
            { highWaterMark: 1 },
          ),
        ),
    );
    const socket = connect(server.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.pause();
    socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    const total = await settled(() => produced);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(200);
    socket.destroy();
  });

  it("[SNOD-05] HEAD answers headers only; a handler error body is never written for 204 and 304", async () => {
    const server = await start(async (request) =>
      request.url.endsWith("/nobody")
        ? new Response(null, { status: 204 })
        : new Response("body", { headers: { "content-length": "4" } }),
    );
    const head = await fetch(`${server.url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("");
    expect((await fetch(`${server.url}/nobody`)).status).toBe(204);
  });

  it("[SNOD-06] a handler that rejects is answered 500 and the server keeps working", async () => {
    let calls = 0;
    const failures: unknown[] = [];
    const server = await start(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return new Response("ok");
      },
      { onError: (error) => failures.push(error) },
    );
    const first = await fetch(`${server.url}/`);
    expect(first.status).toBe(500);
    expect(await first.text()).toBe("Internal Server Error");
    expect(await (await fetch(`${server.url}/`)).text()).toBe("ok");
    expect(failures).toHaveLength(1);
  });

  it("[SNOD-07] a body that fails after the status line breaks the connection instead of ending cleanly", async () => {
    const failures: unknown[] = [];
    const server = await start(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("partial"));
            },
            pull() {
              throw new Error("render failed");
            },
          }),
        ),
      { onError: (error) => failures.push(error) },
    );
    await expect(
      fetch(`${server.url}/`).then(async (response) => {
        expect(response.status).toBe(200);
        return response.text();
      }),
    ).rejects.toBeDefined();
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe("request line and framing", () => {
  const echo: Handler["fetch"] = async (request) =>
    new Response(JSON.stringify({ url: request.url, host: request.headers.get("host") }));

  it("[SNOD-10] a target starting with // stays a path on this host; an absolute-form target is refused", async () => {
    const server = await start(echo);
    const raw = await rawRequest(
      server.port,
      "GET //evil.test/x?y HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n",
    );
    expect(statusOf(raw)).toBe(200);
    expect(raw).toContain('"url":"http://app.test//evil.test/x?y"');
    expect(
      statusOf(
        await rawRequest(
          server.port,
          "GET http://evil.test/ HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n",
        ),
      ),
    ).toBe(400);
  });

  it("[SNOD-11] request smuggling shapes never reach the handler: repeated Content-Length or Host, Transfer-Encoding with Content-Length, odd codings", async () => {
    const reached: string[] = [];
    const server = await start(async (request) => {
      reached.push(request.url);
      return new Response("ok");
    });
    const attempts = [
      "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
      "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nContent-Length: 6\r\nConnection: close\r\n\r\nhello!",
      "POST / HTTP/1.1\r\nHost: a\r\nHost: b\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: identity\r\nConnection: close\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: xchunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
      "POST / HTTP/1.1\r\nHost: a\r\nContent-Length: abc\r\nConnection: close\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a/b\r\nConnection: close\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a@evil\r\nConnection: close\r\n\r\n",
      "GET / HTTP/1.1\r\nConnection: close\r\n\r\n",
    ];
    for (const attempt of attempts) {
      const before = reached.length;
      const status = statusOf(await rawRequest(server.port, attempt));
      expect([0, 400, 501], attempt).toContain(status);
      expect(reached.length, attempt).toBe(before);
    }
    expect(reached).toEqual([]);
  });

  it("[SNOD-12] OPTIONS * is answered by the server without calling the handler", async () => {
    let reached = 0;
    const server = await start(async () => {
      reached += 1;
      return new Response("x");
    });
    const raw = await rawRequest(
      server.port,
      "OPTIONS * HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
    );
    expect(statusOf(raw)).toBe(204);
    expect(raw.toLowerCase()).toContain("allow: get, head");
    expect(reached).toBe(0);
  });

  it("[SNOD-13] forwarded headers are believed only with trustProxy", async () => {
    const headers =
      "Host: internal:3000\r\nX-Forwarded-Host: public.test\r\nX-Forwarded-Proto: https\r\nConnection: close\r\n\r\n";
    const plain = await start(echo);
    expect(await rawRequest(plain.port, `GET /p HTTP/1.1\r\n${headers}`)).toContain(
      '"url":"http://internal:3000/p"',
    );
    const trusting = await start(echo, { trustProxy: true });
    expect(await rawRequest(trusting.port, `GET /p HTTP/1.1\r\n${headers}`)).toContain(
      '"url":"https://public.test/p"',
    );
    const evil = "Host: a\r\nX-Forwarded-Host: evil.test/path\r\nConnection: close\r\n\r\n";
    expect(statusOf(await rawRequest(trusting.port, `GET /p HTTP/1.1\r\n${evil}`))).toBe(400);
  });
});

describe("compression", () => {
  const big = JSON.stringify({
    items: Array.from({ length: 200 }, (_unused, n) => ({ n, text: "lorem ipsum" })),
  });
  const json = async (): Promise<Response> =>
    new Response(big, { headers: { "content-type": "application/json" } });

  /** Fetches without automatic decoding, to see the wire. */
  function wire(
    url: string,
    acceptEncoding: string | undefined,
    method = "GET",
  ): Promise<{ headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method,
          headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (part: Buffer) => parts.push(part));
          res.on("end", () =>
            resolve({ headers: res.headers as Record<string, string>, body: Buffer.concat(parts) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("[SNOD-20] brotli is preferred, gzip next, identity otherwise; the encoded body decodes to the original", async () => {
    const server = await start(json);
    const br = await wire(server.url, "gzip, br");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["vary"]).toContain("Accept-Encoding");
    expect(brotliDecompressSync(br.body).toString()).toBe(big);
    const gz = await wire(server.url, "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body).toString()).toBe(big);
    const none = await wire(server.url, undefined);
    expect(none.headers["content-encoding"]).toBeUndefined();
    expect(none.body.toString()).toBe(big);
    expect(
      (await wire(server.url, "br;q=0, gzip;q=0")).headers["content-encoding"],
    ).toBeUndefined();
  });

  it("[SNOD-21] small bodies, images, already-encoded and no-transform responses are not compressed; HEAD sends no body", async () => {
    const server = await start(async (request) => {
      if (request.url.endsWith("/small"))
        return new Response("tiny", {
          headers: { "content-type": "text/plain", "content-length": "4" },
        });
      if (request.url.endsWith("/png"))
        return new Response(big, { headers: { "content-type": "image/png" } });
      if (request.url.endsWith("/encoded"))
        return new Response(big, {
          headers: { "content-type": "text/plain", "content-encoding": "identity" },
        });
      if (request.url.endsWith("/notransform"))
        return new Response(big, {
          headers: { "content-type": "text/plain", "cache-control": "no-transform" },
        });
      return json();
    });
    for (const path of ["small", "png", "encoded", "notransform"]) {
      expect(["identity", undefined], path).toContain(
        (await wire(`${server.url}/${path}`, "br, gzip")).headers["content-encoding"],
      );
    }
    const head = await wire(`${server.url}/`, "br", "HEAD");
    expect(head.body.length).toBe(0);
  });

  it("[SNOD-22] a streamed response is compressed and flushed per chunk, so the first chunk arrives before the stream ends", async () => {
    const release = deferred<void>();
    const server = await start(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode(`<p>${"a".repeat(2000)}</p>`));
              await release.promise;
              controller.enqueue(encoder.encode("<p>end</p>"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
    );
    const received = deferred<void>();
    const done = new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        `${server.url}/`,
        { headers: { "accept-encoding": "gzip" } },
        (res) => {
          expect(res.headers["content-encoding"]).toBe("gzip");
          const parts: Buffer[] = [];
          res.on("data", (part: Buffer) => {
            parts.push(part);
            received.resolve();
          });
          res.on("end", () => resolve(gunzipSync(Buffer.concat(parts)).toString()));
        },
      );
      req.on("error", reject);
      req.end();
    });
    await received.promise;
    release.resolve();
    expect(await done).toContain("<p>end</p>");
  });

  it("[SNOD-23] bound: with maxConcurrent reached, further responses go out uncompressed", async () => {
    const hold = deferred<void>();
    const started = deferred<void>();
    const server = await start(
      async (request) => {
        if (request.url.endsWith("/slow")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(encoder.encode("x".repeat(2000)));
                started.resolve();
                await hold.promise;
                controller.close();
              },
            }),
            { headers: { "content-type": "text/plain" } },
          );
        }
        return json();
      },
      { compress: { maxConcurrent: 1 } },
    );
    const slow = wire(`${server.url}/slow`, "gzip");
    await started.promise;
    expect((await wire(`${server.url}/`, "gzip")).headers["content-encoding"]).toBeUndefined();
    hold.resolve();
    expect((await slow).headers["content-encoding"]).toBe("gzip");
    expect((await wire(`${server.url}/`, "gzip")).headers["content-encoding"]).toBe("gzip");
  });

  it("[SNOD-24] compress: false leaves the body alone", async () => {
    const server = await start(json, { compress: false });
    expect((await wire(server.url, "br")).headers["content-encoding"]).toBeUndefined();
  });

  it("[SNOD-25] negotiateEncoding: q-values, wildcard, bounds on header length and element count", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("br;q=0.5, gzip;q=0.9")).toBe("gzip");
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("*;q=0")).toBeUndefined();
    expect(negotiateEncoding("identity")).toBeUndefined();
    expect(negotiateEncoding("br;q=abc")).toBeUndefined();
    expect(negotiateEncoding(undefined)).toBeUndefined();
    expect(negotiateEncoding(`${"x, ".repeat(400)}gzip`)).toBeUndefined();
    expect(negotiateEncoding(`${"x, ".repeat(20)}gzip`)).toBeUndefined();
  });
});

describe("graceful shutdown", () => {
  it("[SNOD-30] close() lets a request in flight finish, refuses new work, and resolves when drained", async () => {
    const release = deferred<void>();
    const started = deferred<void>();
    const server = await start(async () => {
      started.resolve();
      await release.promise;
      return new Response("finished");
    });
    const inflight = fetch(`${server.url}/`);
    await started.promise;
    const closing = server.close();
    expect(server.draining).toBe(true);
    const during = await fetch(`${server.url}/`).then(
      (response) => response.status,
      () => "refused",
    );
    expect([503, "refused"]).toContain(during);
    release.resolve();
    expect(await (await inflight).text()).toBe("finished");
    await closing;
    await expect(fetch(`${server.url}/`)).rejects.toBeDefined();
  });

  it("[SNOD-32] a request that completes on an open connection after draining began gets 503 with Retry-After and Connection: close", async () => {
    const release = deferred<void>();
    const started = deferred<void>();
    let ran = 0;
    const server = await start(async (request) => {
      ran += 1;
      if (new URL(request.url).pathname === "/slow") {
        started.resolve();
        await release.promise;
      }
      return new Response("handled");
    });
    // A connection with a half-sent request is not idle, so draining leaves it open.
    const late = connect(server.port, "127.0.0.1");
    const parts: Buffer[] = [];
    late.on("data", (chunk: Buffer) => parts.push(chunk));
    const closed = new Promise<void>((resolve) => late.on("close", () => resolve()));
    await new Promise<void>((resolve) => late.on("connect", () => resolve()));
    late.write("GET /late HTTP/1.1\r\nHost: localhost\r\n");
    const slow = fetch(`${server.url}/slow`);
    await started.promise;
    const closing = server.close();
    expect(server.draining).toBe(true);
    late.write("\r\n");
    await closed;
    const raw = Buffer.concat(parts).toString("latin1");
    expect(statusOf(raw)).toBe(503);
    expect(raw.toLowerCase()).toContain("retry-after: 1");
    expect(raw.toLowerCase()).toContain("connection: close");
    expect(raw).toContain("Service Unavailable");
    // The handler never saw the refused request.
    expect(ran).toBe(1);
    release.resolve();
    expect(await (await slow).text()).toBe("handled");
    await closing;
  });

  it("[SNOD-31] bound: a request that never finishes is cut off after gracefulShutdownMs", async () => {
    const started = deferred<void>();
    const server = await start(
      async () => {
        started.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("x"));
            },
          }),
        );
      },
      { gracefulShutdownMs: 30 },
    );
    const response = await fetch(`${server.url}/`);
    await started.promise;
    const reading = response.text();
    await server.close();
    await expect(reading).rejects.toBeDefined();
  });

  it("[SNOD-32] close() is idempotent", async () => {
    const server = await start(async () => new Response("ok"));
    await Promise.all([server.close(), server.close()]);
    await server.close();
  });

  it("[SNOD-33] SIGTERM and SIGINT start the shutdown, then exit(0); the listeners are removed afterward", async () => {
    const target = new EventEmitter();
    const exited = deferred<number>();
    const server = await serve(
      { fetch: async () => new Response("ok") },
      { port: 0, signalTarget: target, exit: (code) => exited.resolve(code) },
    );
    expect(target.listenerCount("SIGTERM")).toBe(1);
    expect(target.listenerCount("SIGINT")).toBe(1);
    target.emit("SIGTERM");
    expect(await exited.promise).toBe(0);
    expect(server.draining).toBe(true);
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
  });

  it("[SNOD-34] exitOnSignal: false shuts down without exiting; shutdownSignals: false registers nothing", async () => {
    const target = new EventEmitter();
    let exits = 0;
    const server = await serve(
      { fetch: async () => new Response("ok") },
      {
        port: 0,
        signalTarget: target,
        exitOnSignal: false,
        exit: () => {
          exits += 1;
        },
        shutdownSignals: ["SIGHUP"],
      },
    );
    expect(target.listenerCount("SIGTERM")).toBe(0);
    target.emit("SIGHUP");
    await server.close();
    expect(exits).toBe(0);
    expect(server.draining).toBe(true);
    const quiet = await serve(
      { fetch: async () => new Response("ok") },
      { port: 0, signalTarget: target, shutdownSignals: false },
    );
    expect(target.listenerCount("SIGTERM")).toBe(0);
    await quiet.close();
  });

  it("[SNOD-35] serve rejects when the port is taken", async () => {
    const first = await start(async () => new Response("ok"));
    await expect(
      serve({ fetch: async () => new Response("x") }, { port: first.port, shutdownSignals: false }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
