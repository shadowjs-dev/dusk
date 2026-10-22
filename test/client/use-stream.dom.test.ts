import { createRoot, flushSync, useSignal } from "@shadow-js/core";
import { expect, it, vi } from "vitest";
import { useStream } from "../../src/client/stream";

async function microtasks(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
}

it("[RPC-STREAM-HOOK-06] terminal iterator values are not evaluated", async () => {
  const root = createRoot((stop) => ({
    stop,
    result: useStream<number>(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({
          done: true,
          get value(): never {
            throw new Error("terminal values are not yielded");
          },
        }),
      }),
    })),
  }));
  try {
    flushSync();
    await microtasks();
    expect(root.result.status()).toBe("complete");
    expect(root.result.error()).toBeUndefined();
  } finally {
    root.stop();
  }
});

it("[RPC-STREAM-HOOK-01] retains only the latest item and finishes", async () => {
  const root = createRoot((stop) => ({
    stop,
    result: useStream(async function* () {
      yield 1;
      yield 2;
    }),
  }));
  try {
    flushSync();
    await microtasks();
    expect(root.result.value()).toBe(2);
    expect(root.result.status()).toBe("complete");
    expect(root.result.error()).toBeUndefined();
  } finally {
    root.stop();
  }
});

it.each([false, true])(
  "[RPC-STREAM-HOOK-02] synchronous and asynchronous source failures become reactive errors (%s)",
  async (asyncFailure) => {
    const failure = new Error("source failed");
    const root = createRoot((stop) => ({
      stop,
      result: useStream<number>(() => {
        if (asyncFailure) return Promise.reject(failure);
        throw failure;
      }),
    }));
    try {
      flushSync();
      await microtasks();
      expect(root.result.error()).toBe(failure);
      expect(root.result.status()).toBe("error");
    } finally {
      root.stop();
    }
  },
);

it("[RPC-STREAM-HOOK-03] changing tracked input and reconnecting abort old invocations", async () => {
  const signals: AbortSignal[] = [];
  const [input, setInput] = useSignal(1);
  const root = createRoot((stop) => ({
    stop,
    result: useStream((signal) => {
      signals.push(signal);
      const value = input();
      return (async function* () {
        yield value;
      })();
    }),
  }));
  try {
    flushSync();
    await microtasks();
    setInput(2);
    flushSync();
    await microtasks();
    expect(signals[0]?.aborted).toBe(true);
    expect(root.result.value()).toBe(2);
    root.result.reconnect();
    flushSync();
    await microtasks();
    expect(signals[1]?.aborted).toBe(true);
    expect(signals).toHaveLength(3);
    expect(root.result.value()).toBe(2);
  } finally {
    root.stop();
  }
  expect(signals[2]?.aborted).toBe(true);
});

it("[RPC-STREAM-HOOK-04] disposing before source resolution returns the iterator without pulling it", async () => {
  const next = vi.fn(async () => ({ done: false as const, value: 1 }));
  const end = vi.fn(async () => ({ done: true as const, value: undefined }));
  let resolve: (stream: AsyncIterable<number>) => void = () => {
    throw new Error("missing resolver");
  };
  const pending = new Promise<AsyncIterable<number>>((done) => {
    resolve = done;
  });
  const root = createRoot((stop) => ({ stop, result: useStream(() => pending) }));
  flushSync();
  root.stop();
  resolve({ [Symbol.asyncIterator]: () => ({ next, return: end }) });
  await microtasks();
  expect(next).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalledTimes(1);
  expect(root.result.value()).toBeUndefined();
});

it("[RPC-STREAM-HOOK-05] disposing a pending iterator returns it once and ignores its late item", async () => {
  let resolve: (value: IteratorResult<number>) => void = () => {
    throw new Error("missing resolver");
  };
  const pending = new Promise<IteratorResult<number>>((done) => {
    resolve = done;
  });
  const end = vi.fn(async () => ({ done: true as const, value: undefined }));
  const root = createRoot((stop) => ({
    stop,
    result: useStream(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => pending, return: end }),
    })),
  }));
  flushSync();
  await microtasks();
  root.stop();
  expect(end).toHaveBeenCalledTimes(1);
  resolve({ done: false, value: 99 });
  await microtasks();
  expect(end).toHaveBeenCalledTimes(1);
  expect(root.result.value()).toBeUndefined();
});
