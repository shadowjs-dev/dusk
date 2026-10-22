import { describe, expect, it } from "vitest";
import type { CacheEntry } from "../../src/server/cache-store";
import {
  createKvCacheStore,
  createKvRateLimitStore,
  createKvSessionStore,
} from "../../src/server/kv-adapters";
import { createMemoryKVStore } from "../../src/server/kv-store";
import { createRateLimiter } from "../../src/server/rate-limit";
import { KV_CONFORMANCE, type KvHarness } from "../../src/testing/kv-conformance";

function clockHarness(): { harness: KvHarness; clock: { now: number } } {
  const clock = { now: 1_000_000 };
  const store = createMemoryKVStore({ now: () => clock.now });
  return {
    clock,
    harness: {
      store,
      advance: (milliseconds: number) => {
        clock.now += milliseconds;
      },
    },
  };
}

describe("KVStore: the memory implementation", () => {
  it("[KV-1] get returns what set stored (JSON data); a missing key is undefined; set replaces", async () => {
    const { harness } = clockHarness();
    const store = harness.store;
    await store.set("a", { n: 1, list: [true, null, "x"] });
    expect(await store.get("a")).toEqual({ n: 1, list: [true, null, "x"] });
    expect(await store.get("missing")).toBeUndefined();
    await store.set("a", "again");
    expect(await store.get("a")).toBe("again");
  });

  it("[KV-2] a value must be JSON: undefined, functions, bigint, cycles and non-finite numbers are TypeErrors", async () => {
    const { harness } = clockHarness();
    const store = harness.store;
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    await expect(store.set("k", undefined)).rejects.toThrow(TypeError);
    await expect(store.set("k", () => 1)).rejects.toThrow(TypeError);
    await expect(store.set("k", 10n)).rejects.toThrow(TypeError);
    await expect(store.set("k", cycle)).rejects.toThrow(TypeError);
    await expect(store.set("k", Number.NaN)).rejects.toThrow(TypeError);
    await expect(store.set("k", { a: Number.POSITIVE_INFINITY })).rejects.toThrow(TypeError);
  });

  it("[KV-3] a value is copied in: changing the object afterward does not change the store", async () => {
    const { harness } = clockHarness();
    const value = { list: [1] };
    await harness.store.set("k", value);
    value.list.push(2);
    expect(await harness.store.get("k")).toEqual({ list: [1] });
    const read = (await harness.store.get("k")) as { list: number[] };
    read.list.push(9);
    expect(await harness.store.get("k")).toEqual({ list: [1] });
  });

  it("[KV-4] a TTL expires the entry: it is gone from get and from list once the clock reaches it", async () => {
    const { harness, clock } = clockHarness();
    await harness.store.set("short", 1, { ttlSeconds: 10 });
    await harness.store.set("long", 2);
    expect(await harness.store.get("short")).toBe(1);
    clock.now += 10_000;
    expect(await harness.store.get("short")).toBeUndefined();
    expect(await harness.store.get("long")).toBe(2);
    expect((await harness.store.list({ prefix: "" })).keys).toEqual(["long"]);
  });

  it("[KV-5] increment adds to a number (created at `by`, default 1); a non-number is a TypeError; the TTL is set when the key is created", async () => {
    const { harness, clock } = clockHarness();
    expect(await harness.store.increment("hits")).toBe(1);
    expect(await harness.store.increment("hits", 4)).toBe(5);
    await harness.store.set("name", "ada");
    await expect(harness.store.increment("name")).rejects.toThrow(TypeError);
    expect(await harness.store.increment("window", 1, { ttlSeconds: 5 })).toBe(1);
    expect(await harness.store.increment("window", 1, { ttlSeconds: 500 })).toBe(2);
    clock.now += 5_000;
    expect(await harness.store.get("window")).toBeUndefined();
  });

  it("[KV-6] delete removes a key; deleting a missing key is not an error", async () => {
    const { harness } = clockHarness();
    await harness.store.set("gone", true);
    await harness.store.delete("gone");
    await harness.store.delete("gone");
    expect(await harness.store.get("gone")).toBeUndefined();
  });

  it("[KV-7] list pages through the keys with a prefix, sorted, each key once", async () => {
    const { harness } = clockHarness();
    for (const key of ["p:c", "p:a", "p:e", "p:b", "q:x", "p:d"]) await harness.store.set(key, key);
    const first = await harness.store.list({ prefix: "p:", limit: 2 });
    expect(first.keys).toEqual(["p:a", "p:b"]);
    expect(first.cursor).toBeDefined();
    const second = await harness.store.list({ prefix: "p:", limit: 2, cursor: first.cursor });
    expect(second.keys).toEqual(["p:c", "p:d"]);
    const third = await harness.store.list({ prefix: "p:", limit: 2, cursor: second.cursor });
    expect(third.keys).toEqual(["p:e"]);
    expect(third.cursor).toBeUndefined();
  });

  it("[KV-8] the store is bounded: the least recently used entry is evicted; a read counts as a use", async () => {
    const store = createMemoryKVStore({ maxEntries: 2 });
    await store.set("a", 1);
    await store.set("b", 2);
    await store.get("a");
    await store.set("c", 3);
    expect(await store.get("b")).toBeUndefined();
    expect(await store.get("a")).toBe(1);
    expect(await store.get("c")).toBe(3);
  });

  it("[KV-9] a value over maxValueBytes is a RangeError; a key must be 1 to 512 characters without NUL", async () => {
    const store = createMemoryKVStore({ maxValueBytes: 16 });
    await expect(store.set("k", "x".repeat(64))).rejects.toThrow(RangeError);
    await expect(store.set("", 1)).rejects.toThrow(RangeError);
    await expect(store.set("k".repeat(513), 1)).rejects.toThrow(RangeError);
    await expect(store.set("a\u0000b", 1)).rejects.toThrow(TypeError);
  });

  it("[KV-10] the bounds of the constructor are checked", () => {
    expect(() => createMemoryKVStore({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => createMemoryKVStore({ maxValueBytes: -1 })).toThrow(RangeError);
  });

  for (const scenario of KV_CONFORMANCE) {
    it(`[KV-C-${scenario.id}] conformance (memory): ${scenario.name}`, async () => {
      const { harness } = clockHarness();
      await scenario.run(harness);
    });
  }
});

describe("KVStore: the adapters", () => {
  it("[KV-11] the cache store over KV keeps entries and a tag index; deleting an entry removes it from its tags", async () => {
    const kv = createMemoryKVStore();
    const cache = createKvCacheStore(kv, { now: () => 0 });
    const entry = (body: string, tags: string[]): CacheEntry => ({
      status: 200,
      headers: [],
      body,
      nonce: undefined,
      etag: `"${body}"`,
      storedAt: 0,
      freshUntil: 1000,
      staleUntil: 2000,
      tags,
    });
    await cache.set("k1", entry("one", ["path:/a", "post:1"]));
    await cache.set("k2", entry("two", ["post:1"]));
    expect([...(await cache.tags("post:1"))].sort()).toEqual(["k1", "k2"]);
    expect(await cache.get("k1")).toMatchObject({ body: "one" });
    await cache.delete("k1");
    expect(await cache.get("k1")).toBeUndefined();
    expect(await cache.tags("post:1")).toEqual(["k2"]);
    expect(await cache.tags("path:/a")).toEqual([]);
  });

  it("[KV-12] the tag index is bounded: past maxKeysPerTag the oldest key leaves the index (its entry expires on its own)", async () => {
    const kv = createMemoryKVStore();
    const cache = createKvCacheStore(kv, { maxKeysPerTag: 2, now: () => 0 });
    const make = (tags: string[]): CacheEntry => ({
      status: 200,
      headers: [],
      body: "b",
      nonce: undefined,
      etag: '"e"',
      storedAt: 0,
      freshUntil: 1,
      staleUntil: 2,
      tags,
    });
    await cache.set("a", make(["t"]));
    await cache.set("b", make(["t"]));
    await cache.set("c", make(["t"]));
    expect([...(await cache.tags("t"))].sort()).toEqual(["b", "c"]);
  });

  it("[KV-13] the session store over KV: a record round-trips and expires with its TTL; delete ends it", async () => {
    const clock = { now: 0 };
    const kv = createMemoryKVStore({ now: () => clock.now });
    const sessions = createKvSessionStore(kv);
    await sessions.set(
      "s1",
      { data: { user: "ada" }, createdAt: 1, rotatedAt: 1, lastSeenAt: 1 },
      30,
    );
    expect(await sessions.get("s1")).toEqual({
      data: { user: "ada" },
      createdAt: 1,
      rotatedAt: 1,
      lastSeenAt: 1,
    });
    clock.now += 30_000;
    expect(await sessions.get("s1")).toBeUndefined();
    await sessions.set("s2", { data: {}, createdAt: 1, rotatedAt: 1, lastSeenAt: 1 }, 30);
    await sessions.delete("s2");
    expect(await sessions.get("s2")).toBeUndefined();
  });

  it("[KV-15] the rate-limit store over KV makes the same decisions as the memory store", async () => {
    const clock = { now: 0 };
    const spec = { capacity: 3, refillPerSecond: 1 };
    const memory = createRateLimiter({ ...spec, now: () => clock.now });
    const kvBacked = createRateLimiter({
      ...spec,
      now: () => clock.now,
      store: createKvRateLimitStore(createMemoryKVStore({ now: () => clock.now })),
    });
    const sequence = [0, 0, 0, 0, 500, 500, 1200, 1200, 1200, 1200];
    for (const at of sequence) {
      clock.now = at;
      expect((await kvBacked.check("ip")).allowed).toBe((await memory.check("ip")).allowed);
    }
  });

  it("[KV-16] concurrent takes on one key cannot overdraw the bucket (the adapter serializes them)", async () => {
    const clock = { now: 0 };
    const kvBacked = createRateLimiter({
      capacity: 5,
      refillPerSecond: 0.000001,
      now: () => clock.now,
      store: createKvRateLimitStore(createMemoryKVStore({ now: () => clock.now })),
    });
    const decisions = await Promise.all(Array.from({ length: 12 }, () => kvBacked.check("same")));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  });
});
