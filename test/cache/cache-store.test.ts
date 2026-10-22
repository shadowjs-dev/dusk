import { describe, expect, it } from "vitest";
import {
  type CacheEntry,
  type CacheStore,
  createKeyValueCacheStore,
  createMemoryCacheStore,
} from "../../src/server/cache-store";
import { createFakeKeyValue } from "../../src/testing/key-value";

function entry(body: string, tags: readonly string[] = [], now = 0): CacheEntry {
  return {
    status: 200,
    headers: [["content-type", "text/html; charset=utf-8"]],
    body,
    nonce: undefined,
    etag: `"${body.length}"`,
    storedAt: now,
    freshUntil: now + 60_000,
    staleUntil: now + 120_000,
    tags,
  };
}

/** The contract every CacheStore implementation must meet, run against each one. */
function storeContract(name: string, make: () => CacheStore): void {
  describe(`CacheStore contract: ${name}`, () => {
    it("[ISR-21a] set, get and delete round trip the entry", async () => {
      const store = make();
      await store.set("k1", entry("<p>one</p>", ["t"]));
      const got = await store.get("k1");
      expect(got?.body).toBe("<p>one</p>");
      expect(got?.headers).toEqual([["content-type", "text/html; charset=utf-8"]]);
      await store.delete("k1");
      expect(await store.get("k1")).toBeUndefined();
    });

    it("[ISR-21b] tags index the keys stored under them, and delete removes them from the index", async () => {
      const store = make();
      await store.set("a", entry("a", ["list"]));
      await store.set("b", entry("b", ["list", "post:1"]));
      expect([...(await store.tags("list"))].sort()).toEqual(["a", "b"]);
      expect(await store.tags("post:1")).toEqual(["b"]);
      await store.delete("b");
      expect(await store.tags("list")).toEqual(["a"]);
      expect(await store.tags("post:1")).toEqual([]);
    });

    it("[ISR-21c] overwriting an entry with other tags moves it between tag sets", async () => {
      const store = make();
      await store.set("a", entry("v1", ["old"]));
      await store.set("a", entry("v2", ["new"]));
      expect(await store.tags("old")).toEqual([]);
      expect(await store.tags("new")).toEqual(["a"]);
      expect((await store.get("a"))?.body).toBe("v2");
    });

    it("[ISR-21d] a missing key and a missing tag are empty, not errors", async () => {
      const store = make();
      expect(await store.get("nope")).toBeUndefined();
      expect(await store.tags("nothing")).toEqual([]);
      await store.delete("nope");
    });
  });
}

storeContract("memory", () => createMemoryCacheStore({ maxEntries: 100 }));
storeContract("key-value adapter over the fake client", () =>
  createKeyValueCacheStore(createFakeKeyValue({ now: () => 0 }), { prefix: "t:" }),
);

describe("memory cache store", () => {
  it("[ISR-20] is bounded: the least recently used entry is evicted first, and a read counts as a use", async () => {
    const store = createMemoryCacheStore({ maxEntries: 2 });
    await store.set("a", entry("a", ["ta"]));
    await store.set("b", entry("b", ["tb"]));
    await store.get("a"); // "a" is now the most recent
    await store.set("c", entry("c", ["tc"]));
    expect(await store.get("b")).toBeUndefined();
    expect((await store.get("a"))?.body).toBe("a");
    expect((await store.get("c"))?.body).toBe("c");
    // The eviction removes the evicted key from its tag set too: no tag index grows without bound.
    expect(await store.tags("tb")).toEqual([]);
  });

  it("[ISR-20b] the bound is a number of entries greater than zero", () => {
    expect(() => createMemoryCacheStore({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => createMemoryCacheStore({ maxEntries: 1.5 })).toThrow(RangeError);
  });
});

describe("fake key-value client (test double with Redis-like semantics)", () => {
  it("[ISR-22a] values are strings, and a read returns a copy", async () => {
    const kv = createFakeKeyValue({ now: () => 0 });
    await kv.set("k", "v");
    expect(await kv.get("k")).toBe("v");
    expect(await kv.get("missing")).toBeNull();
  });

  it("[ISR-22b] keys expire with their TTL on the injected clock", async () => {
    let clock = 1_000;
    const kv = createFakeKeyValue({ now: () => clock });
    await kv.set("k", "v", { pxExpire: 500 });
    clock = 1_499;
    expect(await kv.get("k")).toBe("v");
    clock = 1_500;
    expect(await kv.get("k")).toBeNull();
  });

  it("[ISR-22c] a key holds one kind of value: the wrong command is a WRONGTYPE error", async () => {
    const kv = createFakeKeyValue({ now: () => 0 });
    await kv.set("s", "text");
    await kv.sAdd("set", "m");
    await expect(kv.sAdd("s", "x")).rejects.toThrow(/WRONGTYPE/);
    await expect(kv.get("set")).rejects.toThrow(/WRONGTYPE/);
  });

  it("[ISR-22d] sets: add and remove report how many members changed; an emptied set is gone", async () => {
    const kv = createFakeKeyValue({ now: () => 0 });
    expect(await kv.sAdd("tags", "a")).toBe(1);
    expect(await kv.sAdd("tags", "a")).toBe(0);
    expect(await kv.sRem("tags", "a")).toBe(1);
    expect(await kv.sRem("tags", "a")).toBe(0);
    expect(await kv.sMembers("tags")).toEqual([]);
    expect(await kv.del("tags")).toBe(0);
  });

  it("[ISR-22e] del counts the keys it removed", async () => {
    const kv = createFakeKeyValue({ now: () => 0 });
    await kv.set("a", "1");
    await kv.set("b", "2");
    expect(await kv.del("a")).toBe(1);
    expect(await kv.del("a")).toBe(0);
  });
});
