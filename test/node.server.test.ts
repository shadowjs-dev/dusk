import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import { createHandler } from "../src/server/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { deferred } from "./support/deferred";
import { allFeatures } from "./support/features";

const servers: ServerHandle[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(staticFiles?: Record<string, string>) {
  const app = await loadApp();
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    onError: log.onError,
  });
  let dir: string | undefined;
  if (staticFiles !== undefined) {
    dir = mkdtempSync(join(tmpdir(), "start-e2e-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"), { recursive: true });
    for (const [name, content] of Object.entries(staticFiles))
      writeFileSync(join(dir, name), content);
  }
  const server = await serve(handler, {
    port: 0,
    shutdownSignals: false,
    ...(dir === undefined ? {} : { static: { dir } }),
  });
  servers.push(server);
  return { app, log, server, handler };
}

describe("a real server", () => {
  it("[SE2E-01] serves an SSR page over HTTP with security headers, a request id and the document", async () => {
    const { server } = await boot();
    const response = await fetch(`${server.url}/posts/7`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const html = await response.text();
    expect(html).toContain("Post 7");
    expect(html).toContain("<title data-shadow-head>Post 7</title>");
  });

  it("[SE2E-02] a streamed page arrives in pieces: the shell first, the late boundary when its data resolves", async () => {
    const { server, app } = await boot();
    const gate = deferred<string>();
    app.gates["live"] = gate;
    const response = await fetch(`${server.url}/stream/live`, {
      headers: { "accept-encoding": "identity" },
    });
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let received = decoder.decode((await reader.read()).value);
    expect(received).toContain("loading");
    expect(received).not.toContain("LIVE-DATA");
    gate.resolve("LIVE-DATA");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    expect(received).toContain("LIVE-DATA");
    expect(received.endsWith("</div></body></html>")).toBe(true);
  });

  it("[SE2E-03] the same streamed page works through brotli compression", async () => {
    const { server, app } = await boot();
    const gate = deferred<string>();
    app.gates["zip"] = gate;
    const response = await fetch(`${server.url}/stream/zip`, {
      headers: { "accept-encoding": "br" },
    });
    expect(response.headers.get("content-encoding")).toBe("br");
    const body = response.text();
    gate.resolve("ZIPPED");
    expect(await body).toContain("ZIPPED");
  });

  it("[SE2E-10] a compressed streamed page read slowly (backpressure) stays within Node's listener limit", async () => {
    // A slow reader makes the server wait for drain while it pipes a compressed body: the response
    // then holds more `close` listeners than Node's default limit of 10, which Node reports as a warning.
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);
    try {
      const { server, app } = await boot();
      const gate = deferred<string>();
      app.gates["zip"] = gate;
      const big = randomBytes(8 * 1024 * 1024).toString("base64");
      const received = await new Promise<number>((resolve, reject) => {
        const request = get(
          `${server.url}/stream/zip`,
          { headers: { "accept-encoding": "br" } },
          (response) => {
            response.pause();
            let bytes = 0;
            setTimeout(() => {
              response.on("data", (chunk: Buffer) => {
                bytes += chunk.length;
              });
              response.on("end", () => resolve(bytes));
              response.on("error", reject);
              response.resume();
            }, 150);
          },
        );
        request.on("error", reject);
        setTimeout(() => gate.resolve(big), 20);
      });
      expect(received).toBeGreaterThan(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  it("[SE2E-04] a browser-like server function call round trips over HTTP; the same call without the headers is refused", async () => {
    const { server, app } = await boot();
    const headers = {
      "content-type": "application/json",
      "x-dusk-fn": "1",
      origin: server.url,
      "accept-encoding": "identity",
    };
    const response = await fetch(`${server.url}/_dusk/fn/addTodo`, {
      method: "POST",
      headers,
      body: serialize([{ title: "over http" }]),
    });
    expect(response.status).toBe(200);
    expect(deserialize(await response.text())).toEqual({
      ok: true,
      value: { id: 1, title: "over http", by: true },
    });
    expect(app.calls.fn).toBe(1);
    const cross = await fetch(`${server.url}/_dusk/fn/addTodo`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.test" },
      body: serialize([{ title: "x" }]),
    });
    expect(cross.status).toBe(403);
    const bare = await fetch(`${server.url}/_dusk/fn/addTodo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dusk-fn": "1" },
      body: serialize([{ title: "x" }]),
    });
    expect(bare.status).toBe(403);
    expect(app.calls.fn).toBe(1);
  });

  it("[SE2E-05] an oversize upload is stopped with 413 over a real connection", async () => {
    const { server } = await boot();
    const response = await fetch(`${server.url}/_dusk/fn/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dusk-fn": "1", origin: server.url },
      body: serialize(["x".repeat(2 * 1024 * 1024)]),
    });
    expect(response.status).toBe(413);
  });

  it("[SE2E-06] static files are served before the handler, and the handler still owns everything else", async () => {
    const { server } = await boot({ "assets/entry-abc12345.js": "console.log(1)" });
    const asset = await fetch(`${server.url}/assets/entry-abc12345.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("console.log(1)");
    expect((await fetch(`${server.url}/posts/1`)).headers.get("content-type")).toContain(
      "text/html",
    );
    expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404);
  });

  it("[SE2E-07] a client that leaves a streamed page aborts the render: nothing is reported as a fault", async () => {
    const { server, app, log } = await boot();
    app.gates["gone"] = deferred<string>();
    const controller = new AbortController();
    const response = await fetch(`${server.url}/stream/gone`, {
      signal: controller.signal,
      headers: { "accept-encoding": "identity" },
    });
    await response.body?.getReader().read();
    controller.abort();
    await server.close();
    expect(log.errors).toHaveLength(0);
  });

  it("[SE2E-08] shutdown waits for a streamed page that is still rendering and the page completes", async () => {
    const { server, app } = await boot();
    const gate = deferred<string>();
    app.gates["drain"] = gate;
    const response = await fetch(`${server.url}/stream/drain`, {
      headers: { "accept-encoding": "identity" },
    });
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await reader.read();
    const closing = server.close();
    gate.resolve("DRAINED");
    let received = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    expect(received).toContain("DRAINED");
    await closing;
  });

  it("[SE2E-09] the health endpoint answers", async () => {
    const { server } = await boot();
    const ok = await fetch(`${server.url}/_dusk/health`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "ok" });
  });
});
