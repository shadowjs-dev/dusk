import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseClient, type StreamStatus } from "../../src/client/streams";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function stream(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      // Left open: the client stays connected.
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function start(answers: Array<() => Response>) {
  const calls: number[] = [];
  const statuses: StreamStatus[] = [];
  const events: unknown[] = [];
  const send = vi.fn(async () => {
    calls.push(Date.now());
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next === undefined) throw new Error("no answer");
    return next();
  });
  const client = createSseClient({
    url: "/feed",
    fetch: send as unknown as typeof fetch,
    onEvent: (event) => events.push(event.data),
    onStatus: (status) => statuses.push(status),
  });
  return { client, send, calls, statuses, events };
}

describe("SSE client: status codes", () => {
  it("[DUSK-R2-3] 204 means stop reconnecting", async () => {
    const run = start([() => new Response(null, { status: 204 })]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.client.status).toBe("closed");
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "[DUSK-R2-3] %i is retried with backoff",
    async (code) => {
      const run = start([
        () => new Response(null, { status: code }),
        () => stream('data: "hi"\n\n'),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(run.send).toHaveBeenCalledTimes(1);
      expect(run.client.status).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(500);
      expect(run.send).toHaveBeenCalledTimes(2);
      expect(run.events).toEqual(["hi"]);
      expect(run.client.status).toBe("open");
      run.client.close();
    },
  );

  it("[DUSK-R2-3] a Retry-After in seconds sets the wait of a 429", async () => {
    const run = start([
      () => new Response(null, { status: 429, headers: { "retry-after": "7" } }),
      () => stream("data: 1\n\n"),
    ]);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(run.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.send).toHaveBeenCalledTimes(2);
    run.client.close();
  });

  it("[DUSK-R2-3] a Retry-After as an HTTP date sets the wait of a 503", async () => {
    const date = new Date(Date.now() + 4_000).toUTCString();
    const run = start([
      () => new Response(null, { status: 503, headers: { "retry-after": date } }),
      () => stream("data: 1\n\n"),
    ]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(run.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.send).toHaveBeenCalledTimes(2);
    run.client.close();
  });

  it("[DUSK-R2-3] a Retry-After is bounded (a day does not park the client for a day)", async () => {
    const run = start([
      () => new Response(null, { status: 429, headers: { "retry-after": "86400" } }),
      () => stream("data: 1\n\n"),
    ]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run.send).toHaveBeenCalledTimes(2);
    run.client.close();
  });

  it("[DUSK-R2-3] a nonsense Retry-After falls back to the backoff", async () => {
    const run = start([
      () => new Response(null, { status: 429, headers: { "retry-after": "soon" } }),
      () => stream("data: 1\n\n"),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(run.send).toHaveBeenCalledTimes(2);
    run.client.close();
  });

  it.each([400, 401, 403, 404, 410])(
    "[DUSK-R2-3] %i is still a refusal that stops",
    async (code) => {
      const run = start([() => new Response(null, { status: code })]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(run.send).toHaveBeenCalledTimes(1);
      expect(run.client.status).toBe("closed");
    },
  );
});
