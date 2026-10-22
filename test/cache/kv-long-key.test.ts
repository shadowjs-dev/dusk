import { describe, expect, it } from "vitest";
import type { CacheEntry } from "../../src/server/cache-store";
import { createKvCacheStore } from "../../src/server/kv-adapters";
import { createMemoryKVStore } from "../../src/server/kv-store";

const entry = (tags: string[]): CacheEntry => ({
  status: 200,
  headers: [],
  body: "page",
  nonce: undefined,
  etag: '"e"',
  storedAt: 0,
  freshUntil: null,
  staleUntil: null,
  tags,
});

describe("the KV page cache adapter and long page keys", () => {
  it("[STORE-K1] a page key or tag longer than a KV key may be is stored under its digest, and found, listed and deleted by the long name", async () => {
    const kv = createMemoryKVStore();
    const store = createKvCacheStore(kv);
    const key = `example.com/${"a".repeat(700)}`;
    const tag = `path:/${"b".repeat(700)}`;
    await store.set(key, entry([tag]));
    expect((await store.get(key))?.body).toBe("page");
    expect(await store.tags(tag)).toEqual([key]);
    // Every key written to the KV store is within its limit.
    for (const name of (await kv.list({ limit: 1000 })).keys)
      expect(name.length).toBeLessThanOrEqual(512);
    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.tags(tag)).toEqual([]);
  });

  it("[STORE-K2] two long keys that share a long prefix stay two entries", async () => {
    const store = createKvCacheStore(createMemoryKVStore());
    const prefix = "p".repeat(600);
    await store.set(`${prefix}1`, { ...entry([]), body: "one" });
    await store.set(`${prefix}2`, { ...entry([]), body: "two" });
    expect((await store.get(`${prefix}1`))?.body).toBe("one");
    expect((await store.get(`${prefix}2`))?.body).toBe("two");
  });
});
