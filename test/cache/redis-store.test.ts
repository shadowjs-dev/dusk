import { describe, expect, it } from "vitest";
import type { CacheEntry } from "../../src/server/cache-store";
import { EventState } from "../../src/server/event";
import { type CachePolicy, createIsr, resolveCache } from "../../src/server/isr";
import { redisStore } from "../../src/server/stores/redis";
import { createFakeRedis } from "../support/fake-redis";

const AT = 1_700_000_000_000;

function entry(fields: Partial<CacheEntry> = {}): CacheEntry {
  return {
    status: 200,
    headers: [["content-type", "text/html"]],
    body: "<p>x</p>",
    nonce: undefined,
    etag: '"e"',
    storedAt: AT,
    freshUntil: AT + 60_000,
    staleUntil: AT + 120_000,
    tags: ["path:/x"],
    ...fields,
  };
}

describe("redisStore: what it writes", () => {
  it("[REDIS-01] one string per entry with a version tag and a PX expiry at the end of the stale window; one set per tag; the prefix is used", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { prefix: "app:isr:", now: () => AT });
    await store.set("k1", entry({ tags: ["path:/x", "posts"] }));
    expect(client.keys().sort()).toEqual(["app:isr:e:k1", "app:isr:t:path:/x", "app:isr:t:posts"]);
    const raw = JSON.parse(client.raw("app:isr:e:k1") ?? "null") as { v: number; e: CacheEntry };
    expect(raw.v).toBe(1);
    expect(raw.e.body).toBe("<p>x</p>");
    expect(client.ttlOf("app:isr:e:k1")).toBe(120_000);
    // The index sets carry no expiry unless tagTtlSeconds asks for one.
    expect(client.ttlOf("app:isr:t:posts")).toBeUndefined();
  });

  it("[REDIS-02] an entry that never goes stale is written without an expiry", async () => {
    const client = createFakeRedis({ now: () => AT });
    await redisStore(client, { now: () => AT }).set(
      "k",
      entry({ freshUntil: null, staleUntil: null }),
    );
    expect(client.ttlOf("dusk:isr:e:k")).toBeUndefined();
  });

  it("[REDIS-03] two stores with different prefixes on one client do not see each other", async () => {
    const client = createFakeRedis({ now: () => AT });
    const a = redisStore(client, { prefix: "a:", now: () => AT });
    const b = redisStore(client, { prefix: "b:", now: () => AT });
    await a.set("k", entry());
    expect(await b.get("k")).toBeUndefined();
    expect(await b.tags("path:/x")).toEqual([]);
    await b.purgeTag("path:/x");
    expect(await a.get("k")).toBeDefined();
  });

  it("[REDIS-04] only GET, SET, DEL, SADD, SREM, SMEMBERS and PEXPIRE are used: no SCAN or KEYS to find a tag", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT, tagTtlSeconds: 3600 });
    await store.set("a", entry({ tags: ["t", "u"] }));
    await store.set("b", entry({ tags: ["t"] }));
    await store.tags("t");
    await store.purgeTag("t");
    await store.delete("a");
    const names = new Set(client.commands.map((command) => command.split(" ")[0]));
    expect([...names].sort()).toEqual(["DEL", "GET", "PEXPIRE", "SADD", "SET", "SMEMBERS", "SREM"]);
  });

  it("[REDIS-05] an entry over maxEntryBytes is refused with a RangeError before any command is sent", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { maxEntryBytes: 1_000, now: () => AT });
    await expect(store.set("k", entry({ body: "x".repeat(2_000) }))).rejects.toThrow(RangeError);
    expect(client.commands).toEqual([]);
    await store.set("k", entry({ body: "x".repeat(300) }));
    // The cap counts bytes, not characters.
    await expect(store.set("k2", entry({ body: "世".repeat(400) }))).rejects.toThrow(RangeError);
  });

  it("[REDIS-06] the default cap is 1 MiB of serialized entry", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    await store.set("fits", entry({ body: "x".repeat(1024 * 1024 - 2_000) }));
    await expect(store.set("too-big", entry({ body: "x".repeat(1024 * 1024) }))).rejects.toThrow(
      RangeError,
    );
  });
});

describe("redisStore: what it reads", () => {
  it("[REDIS-07] a string that is not a version-1 entry is a miss, never an error", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    await client.set("dusk:isr:e:garbage", "not json at all");
    await client.set("dusk:isr:e:future", JSON.stringify({ v: 2, e: entry() }));
    await client.set("dusk:isr:e:bare", JSON.stringify(entry()));
    await client.set("dusk:isr:e:shape", JSON.stringify({ v: 1, e: { body: 3 } }));
    await client.set("dusk:isr:e:null", "null");
    for (const key of ["garbage", "future", "bare", "shape", "null"]) {
      expect(await store.get(key)).toBeUndefined();
    }
  });

  it("[REDIS-08] a purge or tags() never returns or deletes an entry written by a version it does not know", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    await client.sAdd("dusk:isr:t:posts", "foreign");
    await client.set("dusk:isr:e:foreign", JSON.stringify({ v: 2, e: entry({ tags: ["posts"] }) }));
    expect(await store.tags("posts")).toEqual([]);
    await store.purgeTag("posts");
    // The foreign entry is not ours to delete.
    expect(client.raw("dusk:isr:e:foreign")).toBeDefined();
  });

  it("[REDIS-09] a failing client rejects the call: the cache reports it and serves on", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    client.failNext(["GET"], new Error("ECONNRESET"));
    await expect(store.get("k")).rejects.toThrow("ECONNRESET");
    client.failNext(["SET"], new Error("READONLY"));
    await expect(store.set("k", entry())).rejects.toThrow("READONLY");
  });
});

describe("redisStore: tags and purges", () => {
  it("[REDIS-10] tags() drops members whose entry expired or lost the tag, and removes them from the index", async () => {
    const time = { now: AT };
    const client = createFakeRedis({ now: () => time.now });
    const store = redisStore(client, { now: () => time.now });
    await store.set("short", entry({ tags: ["t"], staleUntil: AT + 1_000 }));
    await store.set("long", entry({ tags: ["t"] }));
    await store.set("moved", entry({ tags: ["t"] }));
    await store.set("moved", entry({ tags: ["other"] }));
    time.now += 5_000;
    expect(await store.tags("t")).toEqual(["long"]);
    expect((await client.sMembers("dusk:isr:t:t")).sort()).toEqual(["long"]);
  });

  it("[REDIS-11] purgeTag removes the entries that carry the tag, keeps the others, and empties the index", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    for (let index = 0; index < 100; index += 1) {
      await store.set(
        `k${index}`,
        entry({ tags: index % 2 === 0 ? ["even", "all"] : ["odd", "all"] }),
      );
    }
    await store.purgeTag("even");
    expect(await store.tags("even")).toEqual([]);
    expect((await store.tags("odd")).length).toBe(50);
    expect((await store.tags("all")).length).toBe(50);
    expect(client.keys().includes("dusk:isr:t:even")).toBe(false);
  });

  it("[REDIS-12] a purge reads one set and touches each member a fixed number of times (no scan)", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    for (let index = 0; index < 20; index += 1)
      await store.set(`k${index}`, entry({ tags: ["t"] }));
    client.commands.length = 0;
    await store.purgeTag("t");
    const count = (name: string) => client.commands.filter((c) => c.startsWith(`${name} `)).length;
    expect(count("SMEMBERS")).toBe(1);
    expect(count("DEL")).toBe(20);
    expect(count("SREM")).toBe(20);
    // One read to check the entry, one to see that no new entry took its place after the index member was removed.
    expect(count("GET")).toBe(40);
  });

  it("[REDIS-13] a purge racing with writes of the same tag: whatever is stored afterward is found by the next purge (200 seeds)", async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const client = createFakeRedis({ now: () => AT, seed });
      const store = redisStore(client, { now: () => AT });
      const keys = Array.from({ length: 8 }, (_unused, index) => `k${index}`);
      for (const key of keys.slice(0, 4)) await store.set(key, entry({ tags: ["t"] }));
      await Promise.all([
        store.purgeTag("t"),
        ...keys.slice(4).map((key) => store.set(key, entry({ tags: ["t"] }))),
        ...keys.slice(0, 2).map((key) => store.set(key, entry({ tags: ["t"], body: "again" }))),
      ]);
      const listed = new Set(await store.tags("t"));
      for (const key of keys) {
        if ((await store.get(key)) !== undefined) {
          expect(listed.has(key), `seed ${seed}: ${key}`).toBe(true);
        }
      }
      await store.purgeTag("t");
      for (const key of keys) expect(await store.get(key), `seed ${seed}: ${key}`).toBeUndefined();
    }
  });

  it("[REDIS-14] delete removes the entry from every tag it was indexed under", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT });
    await store.set("k", entry({ tags: ["a", "b", "c"] }));
    await store.delete("k");
    for (const tag of ["a", "b", "c"]) {
      expect(await client.sMembers(`dusk:isr:t:${tag}`)).toEqual([]);
    }
    expect(client.keys()).toEqual([]);
  });
});

describe("redisStore: bounded tag indexes (tagTtlSeconds)", () => {
  it("[REDIS-15] every write renews the index expiry; an idle index disappears", async () => {
    const time = { now: AT };
    const client = createFakeRedis({ now: () => time.now });
    const store = redisStore(client, { now: () => time.now, tagTtlSeconds: 600 });
    await store.set("k", entry({ tags: ["t"], staleUntil: AT + 120_000 }));
    expect(client.ttlOf("dusk:isr:t:t")).toBe(600_000);
    time.now += 400_000;
    await store.set("k2", entry({ tags: ["t"], staleUntil: time.now + 120_000 }));
    expect(client.ttlOf("dusk:isr:t:t")).toBe(600_000);
    time.now += 601_000;
    expect(client.keys()).toEqual([]);
  });

  it("[REDIS-16] an entry that would outlive its index (including one that never goes stale) is refused, and nothing is written", async () => {
    const client = createFakeRedis({ now: () => AT });
    const store = redisStore(client, { now: () => AT, tagTtlSeconds: 60 });
    await expect(store.set("long", entry({ staleUntil: AT + 120_000 }))).rejects.toThrow(
      RangeError,
    );
    await expect(store.set("forever", entry({ staleUntil: null }))).rejects.toThrow(/outlives/);
    expect(client.commands).toEqual([]);
    await store.set("short", entry({ staleUntil: AT + 30_000 }));
  });

  it("[REDIS-17] option errors: tagTtlSeconds needs pExpire; sizes and lifetimes must be positive integers", () => {
    const bare = createFakeRedis({ withPExpire: false });
    expect(() => redisStore(bare, { tagTtlSeconds: 60 })).toThrow(TypeError);
    expect(() => redisStore(createFakeRedis(), { tagTtlSeconds: 0 })).toThrow(RangeError);
    expect(() => redisStore(createFakeRedis(), { tagTtlSeconds: 1.5 })).toThrow(RangeError);
    expect(() => redisStore(createFakeRedis(), { maxEntryBytes: 0 })).toThrow(RangeError);
    expect(() => redisStore(bare)).not.toThrow();
  });
});

/** The page cache of one "instance" over a shared Redis, with a clock of its own. */
function instance(client: ReturnType<typeof createFakeRedis>, clock: { now: number }, tag: string) {
  const store = redisStore(client, { now: () => clock.now });
  let renders = 0;
  const isr = createIsr(
    {
      ...resolveCache({ now: () => clock.now, store }),
      base: "",
      caseSensitive: false,
    },
    {
      render: async (input) => {
        renders += 1;
        const url = input.url;
        const event = new EventState({
          request: new Request(url),
          url,
          signal: new AbortController().signal,
          id: tag,
          nonce: undefined,
          signer: undefined,
          secureCookies: true,
          env: {},
          platform: undefined,
          clientAddress: undefined,
          dev: false,
          lang: "en",
        });
        return {
          response: new Response(`<p>${tag} render ${renders}</p>`, {
            headers: { "content-type": "text/html" },
          }),
          event,
          read: new Set<string>(),
        };
      },
      renderOwn: async () => new Response("own"),
      report: () => undefined,
    },
  );
  const serve = (path: string) => {
    const url = new URL(`https://example.com${path}`);
    const event = new EventState({
      request: new Request(url),
      url,
      signal: new AbortController().signal,
      id: tag,
      nonce: undefined,
      signer: undefined,
      secureCookies: true,
      env: {},
      platform: undefined,
      clientAddress: undefined,
      dev: false,
      lang: "en",
    });
    const policy: CachePolicy = { fresh: 60, stale: 60, cookies: [], searchParams: undefined };
    return isr.serve(event, policy);
  };
  return { isr, serve, renders: () => renders };
}

describe("redisStore behind the page cache: several instances", () => {
  it("[REDIS-18] a page rendered by one instance is a HIT on another; a purge on either reaches both", async () => {
    const client = createFakeRedis({ now: () => AT });
    const clock = { now: AT };
    const a = instance(client, clock, "A");
    const b = instance(client, clock, "B");
    expect((await a.serve("/news")).headers.get("x-dusk-cache")).toBe("MISS");
    const hit = await b.serve("/news");
    expect(hit.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await hit.text()).toContain("A render 1");
    expect(b.renders()).toBe(0);
    await b.isr.purgePath("/news");
    const after = await a.serve("/news");
    expect(after.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await after.text()).toContain("A render 2");
    expect((await b.serve("/news")).headers.get("x-dusk-cache")).toBe("HIT");
  });

  it("[REDIS-19] clock skew moves the fresh/stale boundary an instance sees by the skew", async () => {
    const client = createFakeRedis({ now: () => AT });
    const clockA = { now: AT };
    const clockB = { now: AT + 40_000 };
    const a = instance(client, clockA, "A");
    const b = instance(client, clockB, "B");
    await a.serve("/news");
    // B is 40 s ahead: 25 s after the render the page is 25 s old for A and 65 s old for B (past its 60 s).
    clockA.now += 25_000;
    clockB.now += 25_000;
    expect((await a.serve("/news")).headers.get("x-dusk-cache")).toBe("HIT");
    expect((await b.serve("/news")).headers.get("x-dusk-cache")).toBe("STALE");
  });

  it("[REDIS-20] concurrent first requests on two instances may each render once, never more; both answers are complete pages", async () => {
    const client = createFakeRedis({ now: () => AT, seed: 3 });
    const clock = { now: AT };
    const a = instance(client, clock, "A");
    const b = instance(client, clock, "B");
    const responses = await Promise.all([
      ...Array.from({ length: 50 }, () => a.serve("/hot")),
      ...Array.from({ length: 50 }, () => b.serve("/hot")),
    ]);
    expect(a.renders()).toBe(1);
    expect(b.renders()).toBeLessThanOrEqual(1);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies.every((body) => /^<p>[AB] render 1<\/p>$/.test(body))).toBe(true);
  });
});
