import { describe, expect, it, vi } from "vitest";
import { createHandler, type DuskRuntimeManifest, type SseHandler } from "../src/server/index";
import { createEventLog, formatSseEvent, SseOverflowError } from "../src/server/sse";
import { allFeatures } from "./support/features";

/**
 * Server-sent events: the wire format, heartbeats, backpressure, abort on disconnect and the
 * Last-Event-ID resume helper. Routes are reached through `createHandler` (a stream route in the
 * manifest), so the headers and the body are the real ones.
 */

const BASE_MANIFEST = {
  routes: [],
  apiRoutes: [],
  serverFns: {},
  assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
  App: (props: { children?: unknown }) => props.children,
} satisfies Partial<DuskRuntimeManifest>;

interface Harness {
  readonly handler: ReturnType<typeof createHandler>;
  readonly errors: unknown[];
  readonly seen: { lastEventId: string | undefined; aborted: Promise<void> | undefined };
}

function harness(
  sse: SseHandler,
  options: { heartbeatMs?: number; maxBufferedEvents?: number } = {},
): Harness {
  const errors: unknown[] = [];
  const seen: Harness["seen"] = { lastEventId: undefined, aborted: undefined };
  const wrapped: SseHandler = (event, stream) => {
    seen.lastEventId = stream.lastEventId;
    seen.aborted = new Promise<void>((resolve) => {
      stream.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return sse(event, stream);
  };
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      ...BASE_MANIFEST,
      streams: [
        { id: "/feed", path: "/feed", kinds: ["SSE"], load: async () => ({ SSE: wrapped }) },
      ],
    },
    dev: true,
    security: { allowedHosts: ["example.com"] },
    streams: {
      sseHeartbeatMs: options.heartbeatMs ?? 60_000,
      sseMaxBufferedEvents: options.maxBufferedEvents ?? 256,
    },
    onError: (error) => void errors.push(error),
    onWarning: () => undefined,
  });
  return { handler, errors, seen };
}

/** Reads the body until `done` says it has enough. The reader stays open: the caller decides. */
async function readSome(response: Response, done: (text: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { done: ended, value } = await reader.read();
    if (ended) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

/** Reads the whole body (the stream must end by itself), and returns it. */
async function readAll(response: Response): Promise<string> {
  return response.text();
}

describe("SSE: the response", () => {
  it("[SSE-01] a stream route answers GET with text/event-stream and no caching or buffering", async () => {
    const t = harness((_event, stream) => {
      void stream.send("hello");
    });
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
  });

  it("[SSE-02] other methods on a stream route are 405, and an unknown path is 404", async () => {
    const t = harness(() => undefined);
    const post = await t.handler.fetch(
      new Request("https://example.com/feed", {
        method: "POST",
        headers: { origin: "https://example.com" },
      }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const nothing = await t.handler.fetch(new Request("https://example.com/other"));
    expect(nothing.status).toBe(404);
  });
});

describe("SSE: the wire format", () => {
  it("[SSE-03] a message is written as id, event name, then one data line per line of data", () => {
    expect(formatSseEvent({ id: "7", event: "tick", data: "a\nb" })).toBe(
      "id: 7\nevent: tick\ndata: a\ndata: b\n\n",
    );
    expect(formatSseEvent({ data: { n: 1 } })).toBe('data: {"n":1}\n\n');
    expect(formatSseEvent({ data: "x", retry: 2500 })).toBe("retry: 2500\ndata: x\n\n");
  });

  it("[SSE-04] a field that could end the message early (a newline in an id or an event name, a NUL) is refused", () => {
    expect(() => formatSseEvent({ id: "a\nb", data: "x" })).toThrow(TypeError);
    expect(() => formatSseEvent({ event: "x\r\ny", data: "x" })).toThrow(TypeError);
    expect(() => formatSseEvent({ id: "a\u0000b", data: "x" })).toThrow(TypeError);
  });

  it("[SSE-05] a message larger than the event limit is refused before it is sent", () => {
    expect(() => formatSseEvent({ data: "x".repeat(70 * 1024) })).toThrow(RangeError);
  });

  it("[SSE-06] the stream sends what the handler sends, in order, as the body", async () => {
    const t = harness(async (_event, stream) => {
      await stream.send({ event: "a", data: "1", id: "1" });
      await stream.send({ data: "2", id: "2" });
      stream.close();
    });
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    expect(await readAll(response)).toBe("id: 1\nevent: a\ndata: 1\n\nid: 2\ndata: 2\n\n");
  });
});

describe("SSE: heartbeats, disconnects and backpressure", () => {
  it("[SSE-07] a heartbeat comment is written on the interval while the stream is open", async () => {
    const t = harness(() => undefined, { heartbeatMs: 5 });
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    const text = await readSome(response, (soFar) => soFar.split(": ping").length > 2);
    expect(text.split(": ping").length).toBeGreaterThan(2);
    await response.body?.cancel();
  });

  it("[SSE-08] a client that disconnects aborts the stream: the handler's signal fires", async () => {
    const t = harness(() => undefined, { heartbeatMs: 5 });
    const controller = new AbortController();
    const response = await t.handler.fetch(
      new Request("https://example.com/feed", { signal: controller.signal }),
    );
    await readSome(response, (soFar) => soFar.includes(": ping"));
    controller.abort();
    await t.seen.aborted;
    expect(t.errors).toEqual([]);
  });

  it("[SSE-09] a producer that does not wait for its sends: the send past the buffer bound rejects with SseOverflowError, and the stream closes", async () => {
    const rejected: unknown[] = [];
    const t = harness(
      async (_event, stream) => {
        const sends = Array.from({ length: 10 }, (_unused, index) =>
          stream.send({ data: String(index) }).catch((error: unknown) => {
            rejected.push(error);
          }),
        );
        await Promise.all(sends);
      },
      { maxBufferedEvents: 2 },
    );
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    await vi.waitFor(() => expect(rejected).toHaveLength(1));
    expect(rejected[0]).toBeInstanceOf(SseOverflowError);
    await response.body?.cancel();
  });

  it("[SSE-09b] a producer that awaits each send is paced by the consumer and is never cut off", async () => {
    const t = harness(
      async (_event, stream) => {
        for (let index = 0; index < 10; index += 1) await stream.send({ data: String(index) });
        stream.close();
      },
      { maxBufferedEvents: 2 },
    );
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    const text = await readAll(response);
    expect(text.split("data: ").length - 1).toBe(10);
    expect(t.errors).toEqual([]);
  });

  it("[SSE-10] a send after the stream closed does nothing (no throw, nothing written)", async () => {
    let after: Promise<void> | undefined;
    const t = harness((_event, stream) => {
      stream.close();
      after = stream.send("late");
    });
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    expect(await readAll(response)).toBe("");
    await expect(after).resolves.toBeUndefined();
  });

  it("[SSE-11] a handler that throws is reported once and its stream ends; the error text is not sent", async () => {
    const t = harness(() => {
      throw new Error("database password is hunter2");
    });
    const response = await t.handler.fetch(new Request("https://example.com/feed"));
    const text = await readAll(response);
    expect(text).not.toContain("hunter2");
    expect(t.errors).toHaveLength(1);
  });
});

describe("SSE: resuming with Last-Event-ID", () => {
  it("[SSE-12] the Last-Event-ID request header is available to the handler as stream.lastEventId", async () => {
    const t = harness((_event, stream) => {
      stream.close();
    });
    const response = await t.handler.fetch(
      new Request("https://example.com/feed", { headers: { "last-event-id": "41" } }),
    );
    await readAll(response);
    expect(t.seen.lastEventId).toBe("41");
  });

  it("[SSE-13] an event log replays what came after the last id, and says so when the id is no longer kept", () => {
    const log = createEventLog({ capacity: 3 });
    const first = log.append({ data: "a" }); // "1"
    log.append({ data: "b" }); // "2"
    const third = log.append({ data: "c" }); // "3"
    expect(log.since(undefined)).toEqual([]);
    expect(log.since(first)).toEqual([
      { id: "2", data: "b" },
      { id: third, data: "c" },
    ]);
    log.append({ data: "d" }); // "4": capacity 3, so "1" is gone
    expect(log.since("1")).toEqual([
      { id: "2", data: "b" },
      { id: "3", data: "c" },
      { id: "4", data: "d" },
    ]);
    // Id 0 is older than anything kept, so events were lost after it: the caller must resync.
    expect(log.since("0")).toBeUndefined();
    expect(log.since("999")).toBeUndefined();
    expect(log.since("3")).toEqual([{ id: "4", data: "d" }]);
  });

  it("[SSE-14] the event log is bounded: it never holds more than its capacity", () => {
    const log = createEventLog({ capacity: 2 });
    for (let index = 0; index < 100; index += 1) log.append({ data: index });
    expect(log.size).toBe(2);
  });
});
