import { describe, expect, it, vi } from "vitest";
import { createDataCache } from "../../src/server/data-cache";
import { createMemoryKVStore, type KVStore } from "../../src/server/kv-store";

/** A store that fails the operations named, as a store outage does. */
function failing(fails: ReadonlyArray<"get" | "set" | "delete">): KVStore {
  const inner = createMemoryKVStore();
  const outage = new Error("store is down");
  return {
    ...inner,
    get: async (key) => {
      if (fails.includes("get")) throw outage;
      return inner.get(key);
    },
    set: async (key, value, options) => {
      if (fails.includes("set")) throw outage;
      return inner.set(key, value, options);
    },
    delete: async (key) => {
      if (fails.includes("delete")) throw outage;
      return inner.delete(key);
    },
  };
}

describe("data cache: a store outage", () => {
  it("[DUSK-R2-8] a read that fails is reported and the function computes fresh data", async () => {
    const report = vi.fn();
    const cache = createDataCache({ kv: failing(["get"]), report });
    const fn = vi.fn(async () => ({ posts: 3 }));
    await expect(cache.cacheData(fn, { key: ["posts"], revalidate: 60 })).resolves.toEqual({
      posts: 3,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ message: "store is down" });
  });

  it("[DUSK-R2-8] a write that fails after the function ran is reported and the value is still returned", async () => {
    const report = vi.fn();
    const cache = createDataCache({ kv: failing(["set"]), report });
    await expect(
      cache.cacheData(async () => "fresh", { key: ["k"], revalidate: 60 }),
    ).resolves.toBe("fresh");
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("[DUSK-R2-8] an error of the function itself is not swallowed as an outage", async () => {
    const report = vi.fn();
    const cache = createDataCache({ kv: createMemoryKVStore(), report });
    await expect(
      cache.cacheData(
        async () => {
          throw new Error("loader failed");
        },
        { key: ["k"], revalidate: 60 },
      ),
    ).rejects.toThrow("loader failed");
    expect(report).not.toHaveBeenCalled();
  });
});
