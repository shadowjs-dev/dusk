import { deserialize, serialize } from "@shadow-js/web/server";
import { expect, it, vi } from "vitest";
import { serverStreamStub } from "../../src/client/stream";
import { rpc } from "../../src/features/rpc";
import { createHandler, serverFn } from "../../src/server/index";

const encoder = new TextEncoder();
const frame = (name: string, value: unknown): string =>
  `event: ${name}\ndata: ${serialize(value)}\n\n`;
const meta = { method: "POST", form: false, base: "" } as const;
const answer = (text: string): Response =>
  new Response(text, { headers: { "content-type": "text/event-stream" } });

it("[RPC-STREAM-SECURITY-01] missing opt-in, malicious batching and CSRF refusal run no generator", async () => {
  const generate = vi.fn(async function* () {
    yield 1;
  });
  const fn = serverFn({ stream: true }, generate);
  const onError = vi.fn();
  const manifest = {
    routes: [],
    apiRoutes: [],
    serverFns: { ticks: { load: async () => fn } },
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: () => "",
  };
  const headers = {
    "content-type": "application/json",
    "x-dusk-fn": "1",
    origin: "http://localhost",
  };
  const plain = createHandler({
    manifest,
    features: [rpc()],
    onError,
    security: { allowedHosts: ["localhost"] },
  });
  const refusal = await plain.fetch(
    new Request("http://localhost/_dusk/fn/ticks", {
      method: "POST",
      headers,
      body: serialize([]),
    }),
  );
  expect(refusal.status).toBe(500);
  expect(generate).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
  const streaming = createHandler({
    manifest,
    features: [rpc({ streams: {} })],
    onError,
    security: { allowedHosts: ["localhost"] },
  });
  const batch = await streaming.fetch(
    new Request("http://localhost/_dusk/fn/_batch", {
      method: "POST",
      headers,
      body: serialize([{ id: "ticks", input: undefined }]),
    }),
  );
  expect(deserialize(await batch.text())).toMatchObject([{ ok: false, error: { status: 400 } }]);
  expect(generate).not.toHaveBeenCalled();
  const csrf = await streaming.fetch(
    new Request("http://localhost/_dusk/fn/ticks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dusk-fn": "1" },
      body: serialize([]),
    }),
  );
  expect(csrf.status).toBe(403);
  expect(generate).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledTimes(1);
});

it("[RPC-STREAM-CLIENT-07] invalid UTF-8 is a protocol error and cancels its body", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([255]));
    },
    cancel,
  });
  const fetcher: typeof fetch = async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  const stream = await serverStreamStub("ticks", meta)(undefined, { fetch: fetcher });
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ServerFnProtocolError",
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("[RPC-STREAM-CLIENT-08] cleanup failure preserves the primary protocol failure and records both causes", async () => {
  const cleanup = new Error("cleanup failed");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame("unknown", {})));
    },
    cancel() {
      throw cleanup;
    },
  });
  const fetcher: typeof fetch = async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  const stream = await serverStreamStub("ticks", meta)(undefined, { fetch: fetcher });
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
    name: "ServerFnProtocolError",
    cause: { errors: [expect.any(Error), cleanup] },
  });
});

it("[RPC-STREAM-CLIENT-09] abort also cancels a held JSON refusal from a custom transport", async () => {
  const cancel = vi.fn();
  const abort = new AbortController();
  let entered: () => void = () => {
    throw new Error("missing resolver");
  };
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      entered();
    },
    cancel,
  });
  const fetcher: typeof fetch = async () =>
    new Response(body, { status: 403, headers: { "content-type": "application/json" } });
  const call = serverStreamStub("ticks", meta)(undefined, { fetch: fetcher, signal: abort.signal });
  const reason = new Error("client left");
  const rejection = expect(call).rejects.toBe(reason);
  await started;
  abort.abort(reason);
  await rejection;
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
});

it("[RPC-STREAM-CLIENT-01] typed streams round-trip codec values through the real RPC pipeline", async () => {
  const value = {
    date: new Date(0),
    map: new Map([["x", 1n]]),
    undef: undefined,
    text: "مرحبا 🌑",
  };
  const fn = serverFn({ stream: true }, async function* (input) {
    yield input;
    yield value;
  });
  const handler = createHandler({
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: { ticks: { load: async () => fn } },
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: () => "",
    },
    features: [rpc({ streams: {} })],
    security: { allowedHosts: ["localhost"] },
  });
  const fetcher: typeof fetch = async (url, init) =>
    handler.fetch(
      new Request(new URL(String(url), "http://localhost"), {
        ...init,
        headers: new Headers({
          ...Object.fromEntries(new Headers(init?.headers)),
          origin: "http://localhost",
        }),
      }),
    );
  const call = serverStreamStub<unknown, unknown>("ticks", meta);
  const stream = await call("input", { fetch: fetcher });
  const items: unknown[] = [];
  for await (const item of stream) items.push(item);
  expect(items).toEqual(["input", value]);
  expect(call.id).toBe("ticks");
  expect(call.url).toBe("/_dusk/fn/ticks");
});

it("[RPC-STREAM-CLIENT-02] arbitrary byte fragmentation preserves UTF-8 and SSE frames", async () => {
  const bytes = encoder.encode(frame("item", { value: "مرحبا 🌑" }) + frame("done", {}));
  let position = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (position === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(position, ++position));
    },
  });
  const fetcher: typeof fetch = async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  const values: unknown[] = [];
  for await (const value of await serverStreamStub("ticks", meta).with({ fetch: fetcher })()) {
    values.push(value);
  }
  expect(values).toEqual(["مرحبا 🌑"]);
});

it.each([
  frame("item", { value: 1 }),
  "event: item\ndata: broken\n\n",
  frame("unknown", {}),
  frame("item", {}),
  frame("done", {}) + frame("item", { value: 2 }),
  `event: item\ndata: ${"a".repeat(65_536)}\n\n`,
])(
  "[RPC-STREAM-CLIENT-03] malformed, oversized or truncated output rejects safely (%#)",
  async (text) => {
    const fetcher: typeof fetch = async () => answer(text);
    const stream = await serverStreamStub("ticks", meta)(undefined, { fetch: fetcher });
    await expect(async () => {
      for await (const _value of stream) {
        // Consume every frame to exercise the terminal marker and trailing-frame checks.
      }
    }).rejects.toMatchObject({ name: "ServerFnProtocolError" });
  },
);

it("[RPC-STREAM-CLIENT-04] breaking iteration cancels the response and prevents a second reader", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame("item", { value: 1 })));
    },
    cancel,
  });
  const fetcher: typeof fetch = async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  const stream = await serverStreamStub("ticks", meta)(undefined, { fetch: fetcher });
  for await (const value of stream) {
    expect(value).toBe(1);
    break;
  }
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(async () => {
    for await (const _value of stream) {
      // A network stream is single-consumer.
    }
  }).rejects.toMatchObject({ name: "ServerFnProtocolError" });
});

it("[RPC-STREAM-CLIENT-05] error frames and pre-stream JSON refusals retain safe server error details", async () => {
  for (const response of [
    answer(
      frame("error", {
        error: { name: "Error", message: "Internal Server Error", status: 500, requestId: "req" },
      }),
    ),
    new Response(
      serialize({
        ok: false,
        error: { name: "Error", message: "Internal Server Error", status: 500, requestId: "req" },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    ),
  ]) {
    const fetcher: typeof fetch = async () => response;
    await expect(async () => {
      for await (const _value of await serverStreamStub("ticks", meta)(undefined, {
        fetch: fetcher,
      })) {
        // Either the initial call or its iteration rejects.
      }
    }).rejects.toMatchObject({
      name: "ServerFnError",
      message: "Internal Server Error",
      requestId: "req",
    });
  }
});

it("[RPC-STREAM-CLIENT-06] GET payloads and required headers cannot be overridden", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => answer(frame("done", {})));
  const stream = await serverStreamStub("ticks", { ...meta, method: "GET", base: "/app" })(
    { n: 2 },
    {
      fetch: fetcher,
      headers: { "x-dusk-fn": "wrong", "content-type": "text/plain" },
    },
  );
  for await (const _value of stream) {
    // Exhaust the empty stream to release its body.
  }
  const [url, init] = fetcher.mock.calls[0] ?? [];
  expect(String(url)).toMatch(/^\/app\/_dusk\/fn\/ticks\?p=/);
  expect(init?.method).toBe("GET");
  expect(init?.body).toBeUndefined();
  expect(new Headers(init?.headers).get("x-dusk-fn")).toBe("1");
  expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  const encoded = new URL(String(url), "http://localhost").searchParams.get("p");
  expect(deserialize(Buffer.from(encoded ?? "", "base64url").toString())).toEqual([{ n: 2 }]);
});
