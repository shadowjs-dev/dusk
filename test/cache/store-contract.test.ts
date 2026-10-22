import { describe, expect, it } from "vitest";
import {
  type CacheStore,
  createKeyValueCacheStore,
  createMemoryCacheStore,
} from "../../src/server/cache-store";
import { createKvCacheStore } from "../../src/server/kv-adapters";
import { createMemoryKVStore } from "../../src/server/kv-store";
import {
  runStoreContract,
  STORE_CONTRACT,
  type StoreHarness,
} from "../../src/server/stores/contract";
import { redisStore } from "../../src/server/stores/redis";
import { createFakeKeyValue } from "../../src/testing/key-value";
import { createFakeRedis } from "../support/fake-redis";

/** A store of each kind with a clock the test moves. */
function withClock(): { clock: { now: number }; now: () => number; advance: (ms: number) => void } {
  const clock = { now: 1_700_000_000_000 };
  return {
    clock,
    now: () => clock.now,
    advance: (ms) => {
      clock.now += ms;
    },
  };
}

describe("the store contract: every store of the repository passes it", () => {
  it("[STORE-C1] the bounded memory store", async () => {
    await runStoreContract(createMemoryCacheStore({ maxEntries: 500 }));
  });

  it("[STORE-C2] the key-value adapter over the memory KV store (entries expire with their stale window)", async () => {
    const time = withClock();
    const kv = createMemoryKVStore({ now: time.now });
    await runStoreContract({
      store: createKvCacheStore(kv, { now: time.now }),
      now: time.now,
      advance: time.advance,
      expires: true,
    });
  });

  it("[STORE-C3] the Redis-like adapter over the fake key-value client", async () => {
    const time = withClock();
    await runStoreContract({
      store: createKeyValueCacheStore(createFakeKeyValue({ now: time.now }), { now: time.now }),
      now: time.now,
      advance: time.advance,
      expires: true,
    });
  });

  it("[STORE-C4] redisStore over the fake Redis, commands settling in order", async () => {
    const time = withClock();
    const client = createFakeRedis({ now: time.now });
    await runStoreContract({
      store: redisStore(client, { now: time.now }),
      now: time.now,
      advance: time.advance,
      expires: true,
    });
  });

  it("[STORE-C5] redisStore over the fake Redis with commands interleaved at random (40 seeds)", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const time = withClock();
      const client = createFakeRedis({ now: time.now, seed });
      await runStoreContract({
        store: redisStore(client, { now: time.now, prefix: `seed${seed}:` }),
        now: time.now,
        advance: time.advance,
        expires: true,
      });
    }
  });

  it("[STORE-C6] redisStore with tagTtlSeconds passes all but the eternal-entry scenario, which it refuses by design", async () => {
    const time = withClock();
    const client = createFakeRedis({ now: time.now, seed: 7 });
    let message = "";
    try {
      await runStoreContract({
        store: redisStore(client, { now: time.now, tagTtlSeconds: 3_600 }),
        now: time.now,
        advance: time.advance,
        expires: true,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/breaks 1 scenario/);
    expect(message).toMatch(/SC3 .*outlives tagTtlSeconds/);
  });

  it("[STORE-C7] two runs against one store do not disturb each other (each run has its own space)", async () => {
    const store = createMemoryCacheStore();
    await Promise.all([runStoreContract(store), runStoreContract(store)]);
  });
});

describe("the store contract: it catches stores that break it", () => {
  /** A memory store with one defect. */
  function defective(defect: (inner: CacheStore) => Partial<CacheStore>): CacheStore {
    const inner = createMemoryCacheStore();
    return {
      get: inner.get,
      set: inner.set,
      delete: inner.delete,
      tags: inner.tags,
      ...defect(inner),
    };
  }

  async function failures(store: CacheStore | StoreHarness): Promise<string> {
    try {
      await runStoreContract(store);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  }

  it("[STORE-C8] a delete that leaves the key in its tags is reported (SC7)", async () => {
    const store = defective((inner) => ({
      async delete(key) {
        const entry = await inner.get(key);
        await inner.delete(key);
        if (entry !== undefined) await inner.set(`${key}#ghost`, entry);
      },
      tags: async (tag) => [...(await inner.tags(tag)), `ghost-of-${tag}`],
    }));
    const message = await failures(store);
    expect(message).toMatch(/SC7/);
    expect(message).toMatch(/breaks \d+ scenario/);
  });

  it("[STORE-C9] a set that does not re-index the tags of the entry it replaces is reported (SC6)", async () => {
    const inner = createMemoryCacheStore();
    const store: CacheStore = {
      get: inner.get,
      delete: inner.delete,
      tags: inner.tags,
      async set(key, entry) {
        // Keeps the previous entry's tags indexed by writing the new entry under a second key as well.
        await inner.set(`${key}#shadow`, { ...entry, tags: [] });
        const previous = await inner.get(key);
        await inner.set(
          key,
          previous === undefined
            ? entry
            : { ...entry, tags: [...new Set([...previous.tags, ...entry.tags])] },
        );
      },
    };
    expect(await failures(store)).toMatch(/SC6/);
  });

  it("[STORE-C10] a store that loses writes made at the same time is reported (SC11)", async () => {
    const inner = createMemoryCacheStore();
    let busy = false;
    const store: CacheStore = {
      get: inner.get,
      delete: inner.delete,
      tags: inner.tags,
      async set(key, entry) {
        if (busy) return;
        busy = true;
        await inner.set(key, entry);
        await Promise.resolve();
        busy = false;
      },
    };
    expect(await failures(store)).toMatch(/SC11/);
  });

  it("[STORE-C11] a purge that leaves a live entry unlisted is reported (SC15)", async () => {
    const inner = createMemoryCacheStore();
    const store: CacheStore = {
      get: inner.get,
      delete: inner.delete,
      async set(key, entry) {
        await inner.set(key, entry);
      },
      async tags(tag) {
        const keys = await inner.tags(tag);
        // Forgets the last key it was asked about while a purge is running.
        return keys.slice(0, Math.max(0, keys.length - 1));
      },
    };
    expect(await failures(store)).toMatch(/SC1[35]|SC5|SC8/);
  });

  it("[STORE-C12] every scenario has a unique id and a name", () => {
    expect(new Set(STORE_CONTRACT.map((scenario) => scenario.id)).size).toBe(STORE_CONTRACT.length);
    expect(STORE_CONTRACT.every((scenario) => scenario.name.length > 10)).toBe(true);
  });
});
