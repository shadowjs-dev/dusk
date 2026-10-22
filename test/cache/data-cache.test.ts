import { hashKey } from "@shadow-js/query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DuskError } from "../../src/server/context";
import { cacheData, createDataCache } from "../../src/server/data-cache";
import { createMemoryKVStore, type KVStore } from "../../src/server/kv-store";

function setup(options: { maxInFlight?: number; maxValueBytes?: number } = {}) {
  const clock = { now: 1_000_000 };
  const kv: KVStore & { readonly size: number } = createMemoryKVStore({ now: () => clock.now });
  const cache = createDataCache({
    kv,
    now: () => clock.now,
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
    ...(options.maxValueBytes === undefined ? {} : { maxValueBytes: options.maxValueBytes }),
  });
  return { clock, kv, cache };
}

/** A function that counts its calls and returns a new value each time. */
function counted<T>(make: (call: number) => T) {
  let calls = 0;
  const fn = async (): Promise<T> => {
    calls += 1;
    return make(calls);
  };
  return { fn, calls: () => calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data cache: cacheData", () => {
  it("[DC-1] a key and a lifetime are required: no key, no lifetime, or two lifetimes are TypeErrors", async () => {
    const { cache } = setup();
    const value = async () => 1;
    await expect(
      cache.cacheData(value, { key: undefined as unknown as string[], revalidate: 10 }),
    ).rejects.toThrow(TypeError);
    await expect(cache.cacheData(value, { key: ["k"] })).rejects.toThrow(/revalidate or cacheLife/);
    await expect(
      cache.cacheData(value, { key: ["k"], revalidate: 10, cacheLife: "hours" }),
    ).rejects.toThrow(/either/);
  });

  it("[DC-2] the key is the query key format: equal data (any property order) shares one entry, stored under hashKey", async () => {
    const { cache, kv } = setup();
    const first = counted(() => "one");
    await cache.cacheData(first.fn, { key: ["posts", { page: 1, sort: "new" }], revalidate: 60 });
    const second = counted(() => "two");
    expect(
      await cache.cacheData(second.fn, {
        key: ["posts", { sort: "new", page: 1 }],
        revalidate: 60,
      }),
    ).toBe("one");
    expect(second.calls()).toBe(0);
    const stored = await kv.list({ prefix: "dusk:data:" });
    expect(stored.keys).toEqual([`dusk:data:${hashKey(["posts", { page: 1, sort: "new" }])}`]);
  });

  it("[DC-3] a key that is not plain data is a TypeError (the query key rule)", async () => {
    const { cache } = setup();
    await expect(
      cache.cacheData(async () => 1, { key: ["when", new Date(0)] as unknown[], revalidate: 5 }),
    ).rejects.toThrow(TypeError);
  });

  it("[DC-4] a fresh value is served without running the function again", async () => {
    const { cache, clock } = setup();
    const work = counted((call) => `v${call}`);
    expect(await cache.cacheData(work.fn, { key: ["a"], revalidate: 60 })).toBe("v1");
    clock.now += 59_000;
    expect(await cache.cacheData(work.fn, { key: ["a"], revalidate: 60 })).toBe("v1");
    expect(work.calls()).toBe(1);
  });

  it("[DC-5] stale-while-revalidate: past `revalidate` the old value is served at once and one background refresh runs", async () => {
    const { cache, clock } = setup();
    const work = counted((call) => `v${call}`);
    await cache.cacheData(work.fn, { key: ["s"], revalidate: 60 });
    clock.now += 61_000;
    expect(await cache.cacheData(work.fn, { key: ["s"], revalidate: 60 })).toBe("v1");
    await vi.waitFor(() => expect(work.calls()).toBe(2));
    expect(await cache.cacheData(work.fn, { key: ["s"], revalidate: 60 })).toBe("v2");
  });

  it("[DC-6] past the expiry (2 x revalidate for a plain `revalidate`) the function runs and its value is returned", async () => {
    const { cache, clock } = setup();
    const work = counted((call) => `v${call}`);
    await cache.cacheData(work.fn, { key: ["e"], revalidate: 60 });
    clock.now += 121_000;
    expect(await cache.cacheData(work.fn, { key: ["e"], revalidate: 60 })).toBe("v2");
    expect(work.calls()).toBe(2);
  });

  it("[DC-7] concurrent misses for one key share one run of the function (request coalescing)", async () => {
    const { cache } = setup();
    const work = counted((call) => ({ call }));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.cacheData(work.fn, { key: ["c"], revalidate: 60 })),
    );
    expect(work.calls()).toBe(1);
    expect(new Set(results.map((result) => JSON.stringify(result)))).toEqual(
      new Set(['{"call":1}']),
    );
  });

  it("[DC-8] an error is not cached: the next call runs the function again", async () => {
    const { cache } = setup();
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("upstream down");
      return "ok";
    };
    await expect(cache.cacheData(flaky, { key: ["err"], revalidate: 60 })).rejects.toThrow(
      "upstream down",
    );
    expect(await cache.cacheData(flaky, { key: ["err"], revalidate: 60 })).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("[DC-9] cacheLife names the presets (seconds ... max); an unknown name is a TypeError listing the known profiles", async () => {
    const clock = { now: 0 };
    const kv = createMemoryKVStore({ now: () => clock.now });
    const cache = createDataCache({
      kv,
      now: () => clock.now,
      profiles: { quick: { stale: 0, revalidate: 2, expire: 4 } },
    });
    const work = counted((call) => call);
    await cache.cacheData(work.fn, { key: ["h"], cacheLife: "hours" });
    clock.now += 3_601_000;
    expect(await cache.cacheData(work.fn, { key: ["h"], cacheLife: "hours" })).toBe(1);
    await vi.waitFor(() => expect(work.calls()).toBe(2));
    await cache.cacheData(work.fn, { key: ["q"], cacheLife: "quick" });
    await expect(cache.cacheData(work.fn, { key: ["q"], cacheLife: "fortnight" })).rejects.toThrow(
      /known: .*hours/,
    );
  });

  it("[DC-10] tags: purgeTag removes exactly the entries tagged with it; the next call runs the function", async () => {
    const { cache } = setup();
    const posts = counted((call) => `posts${call}`);
    const users = counted((call) => `users${call}`);
    await cache.cacheData(posts.fn, { key: ["p", 1], revalidate: 600, tags: ["posts"] });
    await cache.cacheData(users.fn, { key: ["u", 1], revalidate: 600, tags: ["users"] });
    await cache.purgeTag("posts");
    expect(
      await cache.cacheData(posts.fn, { key: ["p", 1], revalidate: 600, tags: ["posts"] }),
    ).toBe("posts2");
    expect(
      await cache.cacheData(users.fn, { key: ["u", 1], revalidate: 600, tags: ["users"] }),
    ).toBe("users1");
  });

  it("[DC-11] a value that is not JSON is refused with a TypeError (the function's result is the caller's error)", async () => {
    const { cache } = setup();
    await expect(
      cache.cacheData(async () => undefined, { key: ["j"], revalidate: 60 }),
    ).rejects.toThrow(TypeError);
  });

  it("[DC-12] a value over maxValueBytes is returned but not stored", async () => {
    const { cache, kv } = setup({ maxValueBytes: 16 });
    const work = counted(() => "x".repeat(64));
    await cache.cacheData(work.fn, { key: ["big"], revalidate: 60 });
    await cache.cacheData(work.fn, { key: ["big"], revalidate: 60 });
    expect(work.calls()).toBe(2);
    expect(await kv.list({ prefix: "dusk:data:" })).toEqual({ keys: [], cursor: undefined });
  });

  it("[DC-13] bypass runs the function every time and stores nothing (draft mode uses it)", async () => {
    const { cache, kv } = setup();
    const work = counted((call) => call);
    expect(await cache.cacheData(work.fn, { key: ["b"], revalidate: 60, bypass: true })).toBe(1);
    expect(await cache.cacheData(work.fn, { key: ["b"], revalidate: 60, bypass: true })).toBe(2);
    expect(await kv.list({ prefix: "" })).toEqual({ keys: [], cursor: undefined });
  });

  it("[DC-14] the in-flight bound: past maxInFlight a call runs on its own (no sharing, no waiting)", async () => {
    const { cache } = setup({ maxInFlight: 1 });
    const gate = { open: () => undefined as void };
    const slow = () =>
      new Promise<string>((resolve) => {
        gate.open = () => resolve("slow");
      });
    const first = cache.cacheData(slow, { key: ["slow-1"], revalidate: 60 });
    const second = await cache.cacheData(async () => "fast", { key: ["slow-2"], revalidate: 60 });
    expect(second).toBe("fast");
    expect(cache.inFlight).toBe(1);
    gate.open();
    expect(await first).toBe("slow");
    expect(cache.inFlight).toBe(0);
  });

  it("[DC-15] the request-bound cacheData outside a request is a DuskError (DATA_CACHE_NO_STORE)", async () => {
    await expect(cacheData(async () => 1, { key: ["x"], revalidate: 5 })).rejects.toThrow(
      DuskError,
    );
  });
});

describe("data cache: cachedFetch", () => {
  it("[DC-16] cachedFetch parses a JSON answer and caches it: one request for two calls", async () => {
    const { cache } = setup();
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ rate: 1.5 }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    expect(
      await cache.cachedFetch("https://api.example/rates", undefined, { revalidate: 300 }),
    ).toEqual({ rate: 1.5 });
    expect(
      await cache.cachedFetch("https://api.example/rates", undefined, { revalidate: 300 }),
    ).toEqual({ rate: 1.5 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("[DC-17] a text answer comes back as text; a non-OK answer is an error and is not cached", async () => {
    const { cache } = setup();
    let status = 503;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(status === 503 ? "down" : "hello", { status })),
    );
    await expect(
      cache.cachedFetch("https://api.example/t", undefined, { revalidate: 60 }),
    ).rejects.toThrow(/503/);
    status = 200;
    expect(await cache.cachedFetch("https://api.example/t", undefined, { revalidate: 60 })).toBe(
      "hello",
    );
  });

  it("[DC-18] only GET (or no method) is cached; another method is a TypeError", async () => {
    const { cache } = setup();
    await expect(
      cache.cachedFetch("https://api.example/p", { method: "POST" }, { revalidate: 60 }),
    ).rejects.toThrow(/GET/);
  });
});
