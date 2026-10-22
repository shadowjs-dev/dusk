import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler, type HandlerOptions } from "../src/server/index";
import { type AppModule, errorLog, loadApp, manifestOf } from "./support/app";
import { deferred } from "./support/deferred";
import { allFeatures } from "./support/features";

let app: AppModule;
let handler: DuskHandler;
let log: ReturnType<typeof errorLog>;

async function boot(options: Partial<HandlerOptions> = {}): Promise<void> {
  app = await loadApp();
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    onError: log.onError,
    ...options,
  });
}

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return handler.fetch(new Request(`http://localhost${path}`, init));
}

/** Reads a body stream to the end, one decoded string per chunk. */
async function chunksOf(response: Response): Promise<string[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) return [];
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(decoder.decode(value, { stream: true }));
  }
}

function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

function gate(name: string): ReturnType<typeof deferred<string>> {
  const created = deferred<string>();
  app.gates[name] = created;
  return created;
}

describe("streaming pages", () => {
  beforeEach(async () => {
    await boot();
  });

  it("[SSTM-01] the head (status, headers) is final before the slow data arrives, and the shell shows the fallback", async () => {
    const slow = gate("a");
    const response = await get("/stream/a");
    // The request resolved while the gate is still closed: status and headers did not wait for data.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.startsWith("<!doctype html>")).toBe(true);
    expect(plain(first)).toContain("<h2>shell</h2>");
    expect(plain(first)).toContain('<p class="fallback">loading</p>');
    expect(first).not.toContain("DATA-A");
    slow.resolve("DATA-A");
    const rest: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(new TextDecoder().decode(value));
    }
    const tail = rest.join("");
    expect(tail).toContain("DATA-A");
    expect(tail).toContain('data-sh="0"');
    expect(tail.endsWith("</div></body></html>")).toBe(true);
  });

  it("[SSTM-02] the swap scripts and the late chunks keep the document well formed (one html, one body)", async () => {
    const slow = gate("b");
    const response = await get("/stream/b");
    const collected = chunksOf(response);
    slow.resolve("DATA-B");
    const html = (await collected).join("");
    expect(html.match(/<html/g)).toHaveLength(1);
    expect(html.match(/<\/body>/g)).toHaveLength(1);
    expect(html).toContain('<template id="s:');
    expect(html).toContain("$S(");
  });

  it("[SSTM-03] getRequestEvent() is the right event while a boundary renders late, for 20 interleaved streams", async () => {
    const names = Array.from({ length: 20 }, (_unused, n) => `s${String(n)}`);
    const gates = names.map((name) => gate(name));
    const responses = await Promise.all(names.map((name) => get(`/stream/${name}`)));
    const bodies = responses.map((response) => chunksOf(response));
    // Release in reverse order: completion order differs from request order.
    for (let index = gates.length - 1; index >= 0; index -= 1)
      gates[index]?.resolve(`DATA-${String(index)}`);
    const html = (await Promise.all(bodies)).map((parts) => parts.join(""));
    html.forEach((page, index) => {
      expect(page).toContain(`DATA-${String(index)}`);
      for (let other = 0; other < html.length; other += 1) {
        if (other !== index) expect(page).not.toContain(`DATA-${String(other)}<`);
      }
    });
    expect(app.seen.streamed).toHaveLength(20);
    names.forEach((name, index) => {
      const entry = app.seen.streamed.find((candidate) => candidate.name === name);
      expect(entry?.eventId).toBe(responses[index]?.headers.get("x-request-id"));
    });
  });

  it("[SSTM-04] a client that cancels the body stops the render and leaves nothing reported", async () => {
    gate("c");
    const response = await get("/stream/c");
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await reader.read();
    await reader.cancel(new Error("client went away"));
    expect(log.errors.map((entry) => `${entry.info.phase}: ${String(entry.error)}`)).toEqual([]);
  });

  it("[SSTM-05] a request whose signal aborts mid-stream ends the body with an error and is not reported as a fault", async () => {
    gate("d");
    const controller = new AbortController();
    const response = await get("/stream/d", { signal: controller.signal });
    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await reader.read();
    controller.abort(new DOMException("gone", "AbortError"));
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      })(),
    ).rejects.toBeDefined();
    expect(log.errors).toHaveLength(0);
  });

  it("[SSTM-06] a resource that rejects leaves the fallback; the page is still a complete 200", async () => {
    const slow = gate("e");
    const response = await get("/stream/e");
    const collected = chunksOf(response);
    slow.reject(new Error("upstream down"));
    const html = (await collected).join("");
    expect(response.status).toBe(200);
    expect(html).toContain("loading");
    expect(html.endsWith("</div></body></html>")).toBe(true);
  });

  it("[SSTM-07] x-dusk-render names the mode only when asked for", async () => {
    gate("f");
    expect((await get("/stream/f")).headers.get("x-dusk-render")).toBeNull();
    await boot({ renderHeader: true });
    gate("f");
    expect((await get("/stream/f")).headers.get("x-dusk-render")).toBe("stream");
  });
});

describe("async and string modes", () => {
  it("[SSTM-10] async mode waits for the data and sends one complete document with its data block", async () => {
    await boot({ mode: "async" });
    const slow = gate("g");
    const pending = get("/stream/g");
    slow.resolve("DATA-G");
    const response = await pending;
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("DATA-G");
    expect(html).not.toContain('<p class="fallback">');
    expect(html).toContain('<script type="application/json" data-sh="0">');
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(html).byteLength),
    );
  });

  it("[SSTM-11] string mode renders the fallback and does not wait", async () => {
    await boot({ mode: "string" });
    gate("h");
    const response = await get("/stream/h");
    const html = plain(await response.text());
    expect(html).toContain('<p class="fallback">loading</p>');
    expect(html).not.toContain('data-sh="');
  });

  it("[SSTM-12] every mode renders the same shell for a page without pending data", async () => {
    const outputs: string[] = [];
    for (const mode of ["stream", "async", "string"] as const) {
      await boot({ mode });
      const html = await (await get("/posts/5")).text();
      outputs.push(
        html.replace(/ data-hk="[^"]*"/g, "").replace(/"updatedAt":\d+/, '"updatedAt":0'),
      );
    }
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it("[SSTM-13] 100 interleaved page requests each render their own params and loader data", async () => {
    await boot();
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_unused, n) =>
        get(`/posts/${String(n)}`).then(async (r) => ({ n, html: await r.text() })),
      ),
    );
    for (const { n, html } of responses) {
      expect(plain(html)).toContain(`<h1>Post ${String(n)}</h1>`);
      expect(plain(html)).toContain(`<p>id=${String(n)}</p>`);
      expect(html).toContain(`<title data-shadow-head>Post ${String(n)}</title>`);
    }
    expect(app.calls.post).toBe(100);
  });

  it("[SSTM-14] an async render that never settles is a 504-free 500 page after the time budget, reported, with no partial document", async () => {
    await boot({
      mode: "async",
      dev: false,
      security: { allowedHosts: ["localhost"], limits: { streamTimeoutMs: 30 } },
    });
    gate("never");
    const response = await get("/stream/never");
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain("Internal Server Error");
    expect(html).not.toContain("loading");
    expect(log.errors.some((entry) => String(entry.error).includes("SSR_TIMEOUT"))).toBe(true);
  });
});
