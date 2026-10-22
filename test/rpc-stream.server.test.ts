import { createRoot, useMemo, useSignal } from "@shadow-js/core";
import { deserialize } from "@shadow-js/web/server";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/internal/http-error";
import { resolveConfig } from "../src/server/config";
import { createKey, getRequestEvent } from "../src/server/context";
import { EventState } from "../src/server/event";
import { rpcStreamResponse } from "../src/server/rpc-stream";
import type { RpcRuntime } from "../src/server/runtime";
import type { RequestEvent, ServerFnDefinition } from "../src/server/types";
import { createTestEvent } from "../src/testing/event";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("uninitialized deferred");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(options: { signal?: AbortSignal; dev?: boolean } = {}) {
  const event = createTestEvent({
    ...options,
    dev: options.dev ?? false,
    url: "http://localhost/_dusk/fn/feed",
  });
  if (!(event instanceof EventState)) throw new Error("test event must be EventState");
  const errors: unknown[] = [];
  const config = resolveConfig({
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: (props: { children?: unknown }) => props.children,
    },
    security: { allowedHosts: ["localhost"] },
    dev: options.dev ?? false,
  });
  const runtime: RpcRuntime = {
    config,
    policyFor: () => ({ origin: "http://localhost", trustedOrigins: new Set<string>() }),
    report: (error) => {
      errors.push(error);
    },
    markReported: () => undefined,
  };
  return { event, runtime, errors };
}

function definition(handler: ServerFnDefinition["handler"]): ServerFnDefinition {
  return { method: "GET", input: undefined, middleware: [], form: false, handler };
}

const LIMITS = { maxDurationMs: 30_000, maxItems: 10_000 };

function frames(text: string): { event: string; payload: unknown }[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const lines = frame.split("\n");
      return { event: lines[0]?.slice(7) ?? "", payload: deserialize(lines[1]?.slice(6) ?? "") };
    });
}

function readerOf(response: Response) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("missing response body");
  return reader;
}

describe("typed server function stream transport", () => {
  it("[RPC-STREAM-S01] items use the RPC codec and exactly one done frame terminates the response", async () => {
    const t = harness();
    const value = { date: new Date("2026-01-01"), big: 7n, map: new Map([["key", new Set([1])]]) };
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition(async function* () {
        yield value;
        yield undefined;
      }),
      undefined,
      LIMITS,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(frames(await response.text())).toEqual([
      { event: "item", payload: { value } },
      { event: "item", payload: { value: undefined } },
      { event: "done", payload: {} },
    ]);
    expect(t.errors).toEqual([]);
  });

  it("[RPC-STREAM-S02] a rejected initial handler and invalid iterable propagate before commit", async () => {
    const t = harness();
    const error = new Error("initial failure");
    await expect(
      rpcStreamResponse(
        t.runtime,
        t.event,
        definition(() => {
          throw error;
        }),
        undefined,
        LIMITS,
      ),
    ).rejects.toBe(error);
    for (const invalid of [null, {}, [], 1]) {
      await expect(
        rpcStreamResponse(
          t.runtime,
          t.event,
          definition(() => invalid),
          undefined,
          LIMITS,
        ),
      ).rejects.toThrow(TypeError);
    }
    expect(t.errors).toEqual([]);
  });

  it("[RPC-STREAM-S03] an already aborted request invokes no user callback", async () => {
    const abort = new AbortController();
    const reason = new Error("gone");
    abort.abort(reason);
    const t = harness({ signal: abort.signal });
    const handler = vi.fn(async function* () {
      yield 1;
    });
    await expect(
      rpcStreamResponse(t.runtime, t.event, definition(handler), undefined, LIMITS),
    ).rejects.toBe(reason);
    expect(handler).not.toHaveBeenCalled();
  });

  it("[RPC-STREAM-S04] iterator errors after commit are reported once and redact production details", async () => {
    const t = harness();
    const error = new Error("secret database password");
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition(() => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw error;
          },
          return: returned,
        }),
      })),
      undefined,
      LIMITS,
    );
    const text = await response.text();
    expect(text).not.toContain("secret");
    expect(frames(text)).toEqual([
      {
        event: "error",
        payload: {
          error: {
            name: "Error",
            message: "Internal Server Error",
            status: 500,
            requestId: t.event.id,
          },
        },
      },
    ]);
    expect(t.errors).toEqual([error]);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it("[RPC-STREAM-S05] consumer backpressure requests no item beyond the current bounded frame", async () => {
    const t = harness();
    const called = deferred<void>();
    const next = vi.fn(async () => {
      called.resolve();
      return { done: false as const, value: 1 };
    });
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition(() => ({
        [Symbol.asyncIterator]: () => ({ next, return: returned }),
      })),
      undefined,
      LIMITS,
    );
    const reader = readerOf(response);
    expect(next).toHaveBeenCalledTimes(0);
    const reading = reader.read();
    await called.promise;
    expect(frames(new TextDecoder().decode((await reading).value))).toHaveLength(1);
    await Promise.resolve();
    expect(next).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(returned).toHaveBeenCalledTimes(1);
    expect(t.errors).toEqual([]);
  });

  it.each(["request", "consumer"] as const)(
    "[RPC-STREAM-S06] %s cancellation aborts pending next and returns exactly once",
    async (kind) => {
      const abort = new AbortController();
      const t = harness({ signal: abort.signal });
      const started = deferred<void>();
      const held = deferred<IteratorResult<unknown>>();
      const cleaned = deferred<void>();
      let signal: AbortSignal | undefined;
      const next = vi.fn(() => {
        started.resolve();
        return held.promise;
      });
      const returned = vi.fn(async () => {
        cleaned.resolve();
        return { done: true as const, value: undefined };
      });
      const response = await rpcStreamResponse(
        t.runtime,
        t.event,
        definition((_input, event) => {
          signal = event.signal;
          return { [Symbol.asyncIterator]: () => ({ next, return: returned }) };
        }),
        undefined,
        LIMITS,
      );
      const reader = readerOf(response);
      const reading = reader.read();
      await started.promise;
      const reason = new Error("consumer gone");
      if (kind === "request") abort.abort(reason);
      else await reader.cancel(reason);
      await cleaned.promise;
      expect(signal?.aborted).toBe(true);
      if (kind === "request") expect(signal?.reason).toBe(reason);
      expect(await reading).toMatchObject({ done: true });
      held.resolve({ done: false, value: "late" });
      await Promise.resolve();
      expect(next).toHaveBeenCalledTimes(1);
      expect(returned).toHaveBeenCalledTimes(1);
      expect(t.errors).toEqual([]);
    },
  );

  it("[RPC-STREAM-S07] an exact item bound can complete and an overflow cannot emit its extra item", async () => {
    for (const length of [2, 3]) {
      const t = harness();
      const response = await rpcStreamResponse(
        t.runtime,
        t.event,
        definition(async function* () {
          for (let index = 0; index < length; index += 1) yield index;
        }),
        undefined,
        { ...LIMITS, maxItems: 2 },
      );
      const result = frames(await response.text());
      expect(result.filter((frame) => frame.event === "item")).toEqual([
        { event: "item", payload: { value: 0 } },
        { event: "item", payload: { value: 1 } },
      ]);
      expect(result.at(-1)?.event).toBe(length === 2 ? "done" : "error");
      expect(t.errors).toHaveLength(length === 2 ? 0 : 1);
    }
  });

  it("[RPC-STREAM-S08] a frame beyond 64 KiB is refused before any item byte is emitted", async () => {
    const t = harness();
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition(async function* () {
        yield "x".repeat(70 * 1024);
      }),
      undefined,
      LIMITS,
    );
    const result = frames(await response.text());
    expect(result.map((frame) => frame.event)).toEqual(["error"]);
    expect(t.errors).toHaveLength(1);
  });

  it("[RPC-STREAM-S09] the deadline wakes a pending iterator and emits a safe terminal error", async () => {
    vi.useFakeTimers();
    const t = harness();
    const started = deferred<void>();
    const held = deferred<IteratorResult<unknown>>();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    let signal: AbortSignal | undefined;
    try {
      const response = await rpcStreamResponse(
        t.runtime,
        t.event,
        definition((_input, event) => {
          signal = event.signal;
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                started.resolve();
                return held.promise;
              },
              return: returned,
            }),
          };
        }),
        undefined,
        { ...LIMITS, maxDurationMs: 10 },
      );
      const text = response.text();
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(frames(await text)).toEqual([
        {
          event: "error",
          payload: {
            error: {
              name: "HttpError",
              message: "Gateway Timeout",
              status: 504,
              requestId: t.event.id,
            },
          },
        },
      ]);
      expect(signal?.aborted).toBe(true);
      expect(returned).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      held.resolve({ done: true, value: undefined });
      vi.useRealTimers();
    }
  });

  it("[RPC-STREAM-S10] iterator acquisition and steps retain request context and original EventState accessors", async () => {
    const t = harness();
    const key = createKey<string>("stream-identity");
    t.event.set(key, "owner");
    t.event.route = { kind: "rpc", id: "feed", params: { key: "value" } };
    const seen: RequestEvent[] = [];
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition((_input, event) => {
        seen.push(getRequestEvent());
        expect(event.isNavigationCheck).toBe(false);
        expect(event.get(key)).toBe("owner");
        expect(event.params).toEqual({ key: "value" });
        return {
          [Symbol.asyncIterator]() {
            seen.push(getRequestEvent());
            return {
              async next() {
                await Promise.resolve();
                seen.push(getRequestEvent());
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      }),
      undefined,
      LIMITS,
    );
    expect(frames(await response.text()).map((frame) => frame.event)).toEqual(["done"]);
    expect(seen).toHaveLength(3);
    expect(seen.every((event) => event === seen[0])).toBe(true);
    expect(seen[0]?.signal).not.toBe(t.event.signal);
  });

  it("[RPC-STREAM-S11] handler callbacks do not subscribe their caller while caller tracking resumes", async () => {
    const t = harness();
    let runs = 0;
    let response: Promise<Response> | undefined;
    const state = createRoot((dispose) => {
      const [secret, setSecret] = useSignal(0);
      const [visible, setVisible] = useSignal(0);
      const computation = useMemo(() => {
        runs += 1;
        response = rpcStreamResponse(
          t.runtime,
          t.event,
          definition(() => {
            secret();
            return {
              [Symbol.asyncIterator]: () => ({
                next: async () => ({ done: true as const, value: undefined }),
              }),
            };
          }),
          undefined,
          LIMITS,
        );
        return visible();
      });
      return { dispose, computation, setSecret, setVisible };
    });
    try {
      state.computation();
      if (response === undefined) throw new Error("missing response");
      await (await response).text();
      state.setSecret(1);
      state.computation();
      expect(runs).toBe(1);
      state.setVisible(1);
      state.computation();
      expect(runs).toBe(2);
      await (await response).text();
    } finally {
      state.dispose();
    }
  });

  it("[RPC-STREAM-S12] cancellation cleanup failures are reported without an unhandled rejection", async () => {
    const t = harness();
    const started = deferred<void>();
    const cleaned = deferred<void>();
    const error = new Error("cleanup failure");
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            started.resolve();
            return new Promise<IteratorResult<unknown>>(() => undefined);
          },
          return: async () => {
            cleaned.resolve();
            throw error;
          },
        }),
      })),
      undefined,
      LIMITS,
    );
    const reader = readerOf(response);
    const reading = reader.read();
    await started.promise;
    await reader.cancel();
    await reading;
    await cleaned.promise;
    await Promise.resolve();
    expect(t.errors).toEqual([error]);
  });

  it("[RPC-STREAM-S13] cancellation before the producer microtask returns its iterator and clears all timers", async () => {
    vi.useFakeTimers();
    const t = harness();
    const next = vi.fn(async () => ({ done: false as const, value: 1 }));
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    let signal: AbortSignal | undefined;
    try {
      const response = await rpcStreamResponse(
        t.runtime,
        t.event,
        definition((_input, event) => {
          signal = event.signal;
          return { [Symbol.asyncIterator]: () => ({ next, return: returned }) };
        }),
        undefined,
        LIMITS,
      );
      const reason = new Error("canceled immediately");
      await response.body?.cancel(reason);
      expect(signal?.reason).toBe(reason);
      expect(returned).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(t.errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[RPC-STREAM-S14] a deadline frees an idle consumer and leaves only one bounded terminal frame", async () => {
    vi.useFakeTimers();
    const t = harness();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    try {
      const response = await rpcStreamResponse(
        t.runtime,
        t.event,
        definition(() => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false as const, value: 1 }),
            return: returned,
          }),
        })),
        undefined,
        { ...LIMITS, maxDurationMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(vi.getTimerCount()).toBe(0);
      expect(returned).toHaveBeenCalledTimes(1);
      expect(frames(await response.text()).map((frame) => frame.event)).toEqual(["error"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[RPC-STREAM-S15] cancellation while middleware awaits cannot invoke the handler later", async () => {
    const abort = new AbortController();
    const t = harness({ signal: abort.signal });
    const started = deferred<void>();
    const release = deferred<void>();
    const completed = deferred<void>();
    const handler = vi.fn(async function* () {
      yield 1;
    });
    const pending = rpcStreamResponse(
      t.runtime,
      t.event,
      {
        ...definition(handler),
        middleware: [
          async (_context, next) => {
            started.resolve();
            await release.promise;
            try {
              return await next();
            } finally {
              completed.resolve();
            }
          },
        ],
      },
      undefined,
      LIMITS,
    );
    await started.promise;
    const reason = new Error("gone before invocation");
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    release.resolve();
    await completed.promise;
    expect(handler).not.toHaveBeenCalled();
    expect(t.errors).toEqual([]);
  });

  it("[RPC-STREAM-S16] custom iterator-result accessors retain the linked request context", async () => {
    const t = harness();
    let expected: RequestEvent | undefined;
    let step = 0;
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition((_input, event) => {
        expected = event;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({
              get done() {
                expect(getRequestEvent()).toBe(expected);
                return step++ > 0;
              },
              get value() {
                expect(getRequestEvent()).toBe(expected);
                return "value";
              },
            }),
          }),
        };
      }),
      undefined,
      LIMITS,
    );
    expect(frames(await response.text())).toEqual([
      { event: "item", payload: { value: "value" } },
      { event: "done", payload: {} },
    ]);
    expect(t.errors).toEqual([]);
  });

  it("[RPC-STREAM-S17] iterator return executes in the linked request context with an aborted signal", async () => {
    const t = harness();
    let expected: RequestEvent | undefined;
    const returned = vi.fn(async () => {
      expect(getRequestEvent()).toBe(expected);
      expect(getRequestEvent().signal.aborted).toBe(true);
      return { done: true as const, value: undefined };
    });
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition((_input, event) => {
        expected = event;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false as const, value: 1 }),
            return: returned,
          }),
        };
      }),
      undefined,
      LIMITS,
    );
    await response.body?.cancel();
    expect(returned).toHaveBeenCalledTimes(1);
    expect(t.errors).toEqual([]);
  });

  it("[RPC-STREAM-S18] oversized app error data becomes a safe bounded terminal refusal", async () => {
    const t = harness();
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      definition(() => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new HttpError(400, "bad input", { data: "x".repeat(70 * 1024) });
          },
        }),
      })),
      undefined,
      LIMITS,
    );
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(64 * 1024);
    expect(frames(text)).toEqual([
      {
        event: "error",
        payload: {
          error: {
            name: "Error",
            message: "Internal Server Error",
            status: 500,
            requestId: t.event.id,
          },
        },
      },
    ]);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]).toBeInstanceOf(RangeError);
  });

  it("[RPC-STREAM-S19] schema inference-only types are never read and validation preserves its receiver", async () => {
    const t = harness();
    let metadataReads = 0;
    let validations = 0;
    const properties = {
      version: 1 as const,
      vendor: "receiver-schema",
      get types(): never {
        metadataReads += 1;
        throw new Error("inference-only schema metadata was read");
      },
      validate(value: unknown) {
        validations += 1;
        expect(this).toBe(properties);
        return { value };
      },
    };
    const response = await rpcStreamResponse(
      t.runtime,
      t.event,
      {
        ...definition(async function* (input) {
          yield input;
        }),
        input: { "~standard": properties },
      },
      "input",
      LIMITS,
    );
    expect(frames(await response.text())).toEqual([
      { event: "item", payload: { value: "input" } },
      { event: "done", payload: {} },
    ]);
    expect(metadataReads).toBe(0);
    expect(validations).toBe(1);
    expect(t.errors).toEqual([]);
  });

  it("[RPC-STREAM-S20] guard refusal reads no user schema metadata or validator", async () => {
    const t = harness();
    let schemaReads = 0;
    const validate = vi.fn((value: unknown) => ({ value }));
    const handler = vi.fn(async function* () {
      yield 1;
    });
    await expect(
      rpcStreamResponse(
        t.runtime,
        t.event,
        {
          ...definition(handler),
          guard: [() => false],
          input: {
            get "~standard"() {
              schemaReads += 1;
              return { version: 1 as const, vendor: "lazy-schema", validate };
            },
          },
        },
        undefined,
        LIMITS,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(schemaReads).toBe(0);
    expect(validate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(t.errors).toEqual([]);
  });
});
