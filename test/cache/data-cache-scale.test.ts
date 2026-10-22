import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataCache, type DataCacheOptions } from "../../src/server/data-cache";
import { EventState } from "../../src/server/event";
import { runWithEvent } from "../../src/server/index";
import { createMemoryKVStore } from "../../src/server/kv-store";

/**
 * The data cache at scale: `Promise.all` fan-in for one key, a fake clock for the lifetimes and the backoff, and a stubbed
 * `fetch` for `cachedFetch`.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function latch<T = void>() {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup(options: Partial<Omit<DataCacheOptions, "kv">> = {}) {
  const clock = { now: 1_000_000 };
  const reports: unknown[] = [];
  const kv = createMemoryKVStore({ now: () => clock.now });
  const cache = createDataCache({
    kv,
    now: () => clock.now,
    report: (error) => void reports.push(error),
    ...options,
  });
  return { clock, reports, kv, cache };
}

describe("data cache: single flight", () => {
  it("[DC-S1] 200 concurrent misses run the function once; every caller gets an equal value of its own", async () => {
    const { cache } = setup();
    const held = latch<{ list: number[] }>();
    let runs = 0;
    const fn = () => {
      runs += 1;
      return held.promise;
    };
    const callers = Array.from({ length: 200 }, () =>
      cache.cacheData(fn, { key: ["catalog"], revalidate: 60 }),
    );
    await vi.waitFor(() => expect(cache.inFlight).toBe(1));
    held.release({ list: [1, 2, 3] });
    const values = await Promise.all(callers);
    expect(runs).toBe(1);
    expect(values.every((value) => value.list.join() === "1,2,3")).toBe(true);
    expect(new Set(values).size).toBe(200);
    values[0]?.list.push(4);
    expect(values[1]?.list).toEqual([1, 2, 3]);
    expect(cache.inFlight).toBe(0);
    // And the stored value is untouched by what callers did to theirs.
    expect(
      await cache.cacheData(async () => ({ list: [] }), { key: ["catalog"], revalidate: 60 }),
    ).toEqual({
      list: [1, 2, 3],
    });
  });

  it("[DC-S2] a failure is shared by the callers that waited, then forgotten: the next call runs again", async () => {
    const { cache } = setup();
    const held = latch();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await held.promise;
      throw new Error("upstream 500");
    };
    const callers = Array.from({ length: 8 }, () =>
      cache.cacheData(fn, { key: ["k"], revalidate: 60 }).then(
        () => "ok",
        (error: unknown) => (error as Error).message,
      ),
    );
    held.release();
    expect(new Set(await Promise.all(callers))).toEqual(new Set(["upstream 500"]));
    expect(runs).toBe(1);
    expect(await cache.cacheData(async () => "fine", { key: ["k"], revalidate: 60 })).toBe("fine");
  });

  it("[DC-S3] maxWaiters: the caller past the cap runs the function on its own and still gets a value", async () => {
    const { cache } = setup({ maxWaiters: 2 });
    const held = latch<string>();
    let runs = 0;
    const fn = () => {
      runs += 1;
      return runs === 1 ? held.promise : Promise.resolve(`own ${runs}`);
    };
    const callers = Array.from({ length: 4 }, () =>
      cache.cacheData(fn, { key: ["k"], revalidate: 60 }),
    );
    await vi.waitFor(() => expect(runs).toBe(3));
    held.release("shared");
    expect(await Promise.all(callers)).toEqual(["shared", "shared", "own 2", "own 3"]);
  });

  it("[DC-S4] a caller whose signal aborts stops waiting; the run goes on for the others and its signal stays live", async () => {
    const { cache } = setup();
    const held = latch<string>();
    const signals: AbortSignal[] = [];
    const fn = (signal: AbortSignal) => {
      signals.push(signal);
      return held.promise;
    };
    const leaving = new AbortController();
    const stays = cache.cacheData(fn, { key: ["k"], revalidate: 60 });
    const left = cache.cacheData(fn, { key: ["k"], revalidate: 60, signal: leaving.signal });
    leaving.abort(new Error("client left"));
    await expect(left).rejects.toThrow("client left");
    expect(signals[0]?.aborted).toBe(false);
    held.release("value");
    expect(await stays).toBe("value");
  });

  it("[DC-S5] when every caller with a signal left, the run's signal aborts and the key is free", async () => {
    const { cache } = setup();
    const signals: AbortSignal[] = [];
    const fn = (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => undefined);
    };
    const one = new AbortController();
    const two = new AbortController();
    const first = cache.cacheData(fn, { key: ["k"], revalidate: 60, signal: one.signal });
    const second = cache.cacheData(fn, { key: ["k"], revalidate: 60, signal: two.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    one.abort();
    two.abort();
    await expect(first).rejects.toBeDefined();
    await expect(second).rejects.toBeDefined();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(cache.inFlight).toBe(0);
  });

  it("[DC-S6] a run that never finishes is abandoned after timeoutMs: callers fail with TimeoutError and the next call runs", async () => {
    vi.useFakeTimers();
    const { cache } = setup({ timeoutMs: 1_000 });
    const outcome = cache
      .cacheData(() => new Promise<string>(() => undefined), { key: ["k"], revalidate: 60 })
      .then(
        () => "value",
        (error: unknown) => (error as DOMException).name,
      );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toBe("TimeoutError");
    expect(cache.inFlight).toBe(0);
    expect(await cache.cacheData(async () => "next", { key: ["k"], revalidate: 60 })).toBe("next");
  });

  it("[DC-S7] a purge that began while the function ran keeps its value out of the store", async () => {
    const { cache, kv } = setup();
    const held = latch<string>();
    let started = false;
    const pending = cache.cacheData(
      () => {
        started = true;
        return held.promise;
      },
      { key: ["post", 7], revalidate: 60, tags: ["post:7"] },
    );
    await vi.waitFor(() => expect(started).toBe(true));
    await cache.purgeTag("post:7");
    held.release("before the edit");
    expect(await pending).toBe("before the edit");
    expect((await kv.list({ prefix: "dusk:data:" })).keys).toEqual([]);
    expect(
      await cache.cacheData(async () => "after the edit", {
        key: ["post", 7],
        revalidate: 60,
        tags: ["post:7"],
      }),
    ).toBe("after the edit");
  });
});

describe("data cache: cachedFetch", () => {
  it("[DC-S8] 100 concurrent callers for one URL make one request; each parses its own object", async () => {
    const { cache } = setup();
    const held = latch<void>();
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests += 1;
      await held.promise;
      return new Response(JSON.stringify({ rates: [1, 2] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const callers = Array.from({ length: 100 }, () =>
      cache.cachedFetch<{ rates: number[] }>("https://api.example/rates", undefined, {
        revalidate: 60,
      }),
    );
    held.release();
    const values = await Promise.all(callers);
    expect(requests).toBe(1);
    expect(new Set(values).size).toBe(100);
    values[0]?.rates.push(3);
    expect(values[1]?.rates).toEqual([1, 2]);
  });

  it("[DC-S9] aborting one caller's signal does not abort the request the others wait for; aborting all of them does", async () => {
    const { cache } = setup();
    const fetchSignals: AbortSignal[] = [];
    const held = latch<void>();
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.signal) fetchSignals.push(init.signal);
      await held.promise;
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    });
    const one = new AbortController();
    const two = new AbortController();
    const url = "https://api.example/slow";
    const first = cache.cachedFetch<string>(url, { signal: one.signal }, { revalidate: 60 });
    const second = cache.cachedFetch<string>(url, { signal: two.signal }, { revalidate: 60 });
    const patient = cache.cachedFetch<string>(url, undefined, { revalidate: 60 });
    await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
    one.abort(new Error("one left"));
    await expect(first).rejects.toThrow("one left");
    expect(fetchSignals[0]?.aborted).toBe(false);
    two.abort(new Error("two left"));
    await expect(second).rejects.toThrow("two left");
    // The patient caller (no signal) still wants the answer.
    expect(fetchSignals[0]?.aborted).toBe(false);
    held.release();
    expect(await patient).toBe("ok");
  });

  it("[DC-S10] when the only callers abort, the request is aborted", async () => {
    const { cache } = setup();
    const fetchSignals: AbortSignal[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      if (init?.signal) fetchSignals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    const only = new AbortController();
    const call = cache.cachedFetch<string>(
      "https://api.example/x",
      { signal: only.signal },
      { revalidate: 60 },
    );
    await vi.waitFor(() => expect(fetchSignals).toHaveLength(1));
    only.abort(new Error("gone"));
    await expect(call).rejects.toThrow("gone");
    expect(fetchSignals[0]?.aborted).toBe(true);
  });
});

describe("data cache: stale-while-revalidate", () => {
  it("[DC-S11] 100 concurrent stale callers all get the old value at once; one background run refreshes it", async () => {
    const { cache, clock } = setup();
    let runs = 0;
    const fn = async () => ({ n: ++runs });
    await cache.cacheData(fn, { key: ["k"], revalidate: 10 });
    clock.now += 11_000;
    const held = latch<{ n: number }>();
    let refreshes = 0;
    const slow = () => {
      refreshes += 1;
      return held.promise;
    };
    const values = await Promise.all(
      Array.from({ length: 100 }, () => cache.cacheData(slow, { key: ["k"], revalidate: 10 })),
    );
    expect(values.every((value) => value.n === 1)).toBe(true);
    expect(refreshes).toBe(1);
    held.release({ n: 2 });
    await vi.waitFor(async () => {
      expect(await cache.cacheData(fn, { key: ["k"], revalidate: 10 })).toEqual({ n: 2 });
    });
    expect(refreshes).toBe(1);
  });

  it("[DC-S12] a failing refresh keeps the stale value, reports each failure and backs off: 1 s, 2 s, 4 s", async () => {
    const { cache, clock, reports } = setup();
    await cache.cacheData(async () => "v1", { key: ["k"], revalidate: 10 });
    clock.now += 11_000;
    let attempts = 0;
    const failing = async (): Promise<string> => {
      attempts += 1;
      throw new Error(`down ${attempts}`);
    };
    const stale = async () => {
      expect(await cache.cacheData(failing, { key: ["k"], revalidate: 10 })).toBe("v1");
      await vi.waitFor(() => expect(cache.inFlight).toBe(0));
    };
    await stale();
    expect(attempts).toBe(1);
    expect(reports).toEqual([new Error("down 1")]);
    await stale();
    expect(attempts).toBe(1);
    clock.now += 1_000;
    await stale();
    expect(attempts).toBe(2);
    clock.now += 1_999;
    await stale();
    expect(attempts).toBe(2);
    clock.now += 1;
    await stale();
    expect(attempts).toBe(3);
    clock.now += 3_999;
    await stale();
    expect(attempts).toBe(3);
    expect(reports).toHaveLength(3);
  });

  it("[DC-S13] inside a request the refresh is handed to the platform's waitUntil", async () => {
    const { cache, clock } = setup();
    await cache.cacheData(async () => "v1", { key: ["k"], revalidate: 10 });
    clock.now += 11_000;
    const taken: Promise<unknown>[] = [];
    const url = new URL("https://example.com/");
    const event = new EventState({
      request: new Request(url),
      url,
      signal: new AbortController().signal,
      id: "t",
      nonce: undefined,
      signer: undefined,
      secureCookies: true,
      env: {},
      platform: { waitUntil: (work: Promise<unknown>) => void taken.push(work) },
      clientAddress: undefined,
      dev: false,
      lang: "en",
    });
    const stale = await runWithEvent(event, () =>
      cache.cacheData(async () => "v2", { key: ["k"], revalidate: 10 }),
    );
    expect(stale).toBe("v1");
    expect(taken).toHaveLength(1);
    await taken[0];
    expect(await cache.cacheData(async () => "v3", { key: ["k"], revalidate: 10 })).toBe("v2");
  });
});

describe("data cache: options", () => {
  it("[DC-S14] bounds that are not positive whole numbers are RangeErrors; the defaults are 10 000 keys, 1 000 callers, 30 s", () => {
    expect(() => setup({ maxWaiters: 0 })).toThrow(RangeError);
    expect(() => setup({ timeoutMs: -5 })).toThrow(RangeError);
    expect(() => setup({ backoffBaseMs: 0 })).toThrow(RangeError);
    expect(() => setup({ backoffBaseMs: 5_000, backoffMaxMs: 1_000 })).toThrow(RangeError);
    expect(() => setup({ maxInFlight: 0 })).toThrow(RangeError);
    expect(() => setup()).not.toThrow();
  });
});
