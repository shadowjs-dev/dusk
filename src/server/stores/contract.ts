/**
 * The contract of a page cache store ({@link CacheStore}), as scenarios any test runner can run. The memory store,
 * the key-value adapters and {@link redisStore} in this repository all pass it, and a store you write must too: a
 * passing run is the evidence it can back the page cache of several instances.
 *
 * It states what the cache relies on: entries round-trip exactly, a tag lists exactly the keys whose latest entry
 * carries it, a delete removes an entry from every tag, concurrent writers do not lose each other, a purge removes
 * exactly the entries of its tag and never leaves a live entry that no later purge could find. Expiry by time is
 * checked when the harness says the store has it and can move its clock.
 *
 * @example
 * import { runStoreContract } from "@shadow-js/dusk/stores/contract";
 * it("passes the store contract", () => runStoreContract(myStore));
 * @packageDocumentation
 */

import type { CacheEntry, CacheStore } from "../cache-store";

/**
 * What the scenarios need besides the store. @since 1.0.0
 */
export interface StoreHarness {
  /** The store under test. */
  readonly store: CacheStore;
  /** The clock the store reads for expiry, in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Moves the store's clock forward. Together with `expires` it enables the scenario that checks a store drops an
   * entry at the end of its stale window.
   */
  readonly advance?: (milliseconds: number) => void;
  /** Whether the store drops entries when their stale window ends (Redis does; the bounded memory store does not). */
  readonly expires?: boolean;
}

/** One scenario of the contract. @since 1.0.0 */
export interface StoreContractCase {
  /** Stable id, `SC1`... */
  readonly id: string;
  /** What the scenario shows. */
  readonly name: string;
  /** Runs the scenario; throws when the store breaks the contract. `space` is a prefix no other scenario uses. */
  run(harness: StoreHarness, space: string): Promise<void>;
}

function expectSame(actual: unknown, expected: unknown, label: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`);
}

function expectTrue(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

function entryOf(
  harness: StoreHarness,
  fields: Partial<CacheEntry> & { readonly tags: readonly string[] },
): CacheEntry {
  const at = (harness.now ?? Date.now)();
  return {
    status: 200,
    headers: [["content-type", "text/html; charset=utf-8"]],
    body: "<p>page</p>",
    nonce: undefined,
    etag: '"e"',
    storedAt: at,
    freshUntil: at + 60_000,
    staleUntil: at + 120_000,
    ...fields,
  };
}

/**
 * The scenarios, in order. Each uses its own keys and tags (under `space`), so they can share one store.
 * @since 1.0.0
 */
export const STORE_CONTRACT: readonly StoreContractCase[] = [
  {
    id: "SC1",
    name: "an entry round-trips exactly: unicode body, several headers, nonce, validators and lifetimes",
    async run(harness, space) {
      const { store } = harness;
      const entry = entryOf(harness, {
        tags: [`${space}a`],
        body: "<p>héllo — 世界 \u{1F600} \" ' \\ \n \u0000</p>",
        headers: [
          ["content-type", "text/html; charset=utf-8"],
          ["link", "</a.css>; rel=preload; as=style"],
          ["vary", "accept-language"],
        ],
        nonce: "n0nce",
        etag: '"abc"',
      });
      await store.set(`${space}k`, entry);
      expectSame(await store.get(`${space}k`), entry, "round trip");
    },
  },
  {
    id: "SC2",
    name: "a missing key reads undefined; an entry without a nonce comes back without one",
    async run(harness, space) {
      const { store } = harness;
      expectSame(await store.get(`${space}missing`), undefined, "missing");
      await store.set(`${space}k`, entryOf(harness, { tags: [] }));
      const found = await store.get(`${space}k`);
      expectTrue(found !== undefined && found.nonce === undefined, "an absent nonce stays absent");
    },
  },
  {
    id: "SC3",
    name: "an entry that never goes stale (null lifetimes) is kept as it is",
    async run(harness, space) {
      const { store } = harness;
      const entry = entryOf(harness, { tags: [`${space}a`], freshUntil: null, staleUntil: null });
      await store.set(`${space}k`, entry);
      expectSame(await store.get(`${space}k`), entry, "eternal entry");
      expectSame(await store.tags(`${space}a`), [`${space}k`], "its tag");
    },
  },
  {
    id: "SC4",
    name: "set replaces the entry under a key",
    async run(harness, space) {
      const { store } = harness;
      await store.set(`${space}k`, entryOf(harness, { tags: [], body: "one" }));
      await store.set(`${space}k`, entryOf(harness, { tags: [], body: "two" }));
      expectSame((await store.get(`${space}k`))?.body, "two", "replaced");
    },
  },
  {
    id: "SC5",
    name: "tags(tag) lists the keys whose entry carries the tag; an unknown tag lists nothing",
    async run(harness, space) {
      const { store } = harness;
      await store.set(`${space}a`, entryOf(harness, { tags: [`${space}x`, `${space}y`] }));
      await store.set(`${space}b`, entryOf(harness, { tags: [`${space}x`] }));
      expectSame(sorted(await store.tags(`${space}x`)), [`${space}a`, `${space}b`], "tag x");
      expectSame(await store.tags(`${space}y`), [`${space}a`], "tag y");
      expectSame(await store.tags(`${space}unknown`), [], "unknown tag");
    },
  },
  {
    id: "SC6",
    name: "set with other tags re-indexes: the key leaves the tags its new entry does not carry",
    async run(harness, space) {
      const { store } = harness;
      await store.set(`${space}k`, entryOf(harness, { tags: [`${space}old`, `${space}kept`] }));
      await store.set(`${space}k`, entryOf(harness, { tags: [`${space}kept`, `${space}new`] }));
      expectSame(await store.tags(`${space}old`), [], "old tag");
      expectSame(await store.tags(`${space}kept`), [`${space}k`], "kept tag");
      expectSame(await store.tags(`${space}new`), [`${space}k`], "new tag");
    },
  },
  {
    id: "SC7",
    name: "delete removes the entry and its place in every tag; deleting a missing key is not an error",
    async run(harness, space) {
      const { store } = harness;
      await store.set(`${space}k`, entryOf(harness, { tags: [`${space}a`, `${space}b`] }));
      await store.set(`${space}other`, entryOf(harness, { tags: [`${space}a`] }));
      await store.delete(`${space}k`);
      expectSame(await store.get(`${space}k`), undefined, "deleted entry");
      expectSame(await store.tags(`${space}a`), [`${space}other`], "tag a");
      expectSame(await store.tags(`${space}b`), [], "tag b");
      await store.delete(`${space}k`);
      await store.delete(`${space}never-existed`);
    },
  },
  {
    id: "SC8",
    name: "fifty keys under one tag are all listed; deleting half leaves the other half",
    async run(harness, space) {
      const { store } = harness;
      const keys = Array.from({ length: 50 }, (_unused, index) => `${space}key-${index}`);
      for (const key of keys) await store.set(key, entryOf(harness, { tags: [`${space}many`] }));
      expectSame(sorted(await store.tags(`${space}many`)), sorted(keys), "all listed");
      const gone = keys.filter((_key, index) => index % 2 === 0);
      for (const key of gone) await store.delete(key);
      expectSame(
        sorted(await store.tags(`${space}many`)),
        sorted(keys.filter((_key, index) => index % 2 === 1)),
        "half left",
      );
    },
  },
  {
    id: "SC9",
    name: "keys and tags with spaces, quotes, colons, pipes, unicode and 400 characters work",
    async run(harness, space) {
      const { store } = harness;
      const keys = [
        `${space}host/path?a=1&b=2|c=d`,
        `${space}[s"x";,{"k":F}]#vary:accept-language=ar`,
        `${space}كلمة/页面 with space`,
        `${space}${"k".repeat(400)}`,
      ];
      for (const key of keys) {
        const tag = `${space}tag:${key.slice(space.length, space.length + 20)}`;
        await store.set(key, entryOf(harness, { tags: [tag], body: key }));
        expectSame((await store.get(key))?.body, key, "round trip");
        expectSame(await store.tags(tag), [key], "tag lists the key");
        await store.delete(key);
        expectSame(await store.get(key), undefined, "deleted");
      }
    },
  },
  {
    id: "SC10",
    name: "a 600 KB body round-trips",
    async run(harness, space) {
      const { store } = harness;
      const body = "0123456789abcdef".repeat(600 * 64);
      await store.set(`${space}big`, entryOf(harness, { tags: [], body }));
      expectSame((await store.get(`${space}big`))?.body === body, true, "big body");
    },
  },
  {
    id: "SC11",
    name: "forty concurrent sets of different keys under one tag all land and are all listed",
    async run(harness, space) {
      const { store } = harness;
      const keys = Array.from({ length: 40 }, (_unused, index) => `${space}c-${index}`);
      await Promise.all(
        keys.map((key) =>
          store.set(key, entryOf(harness, { tags: [`${space}shared`], body: key })),
        ),
      );
      expectSame(sorted(await store.tags(`${space}shared`)), sorted(keys), "all listed");
      const bodies = await Promise.all(keys.map(async (key) => (await store.get(key))?.body));
      expectSame(bodies, keys, "all stored");
    },
  },
  {
    id: "SC12",
    name: "concurrent sets of one key leave exactly one of the written entries, listed once",
    async run(harness, space) {
      const { store } = harness;
      const bodies = Array.from({ length: 20 }, (_unused, index) => `write-${index}`);
      await Promise.all(
        bodies.map((body) =>
          store.set(`${space}k`, entryOf(harness, { tags: [`${space}t`], body })),
        ),
      );
      const found = await store.get(`${space}k`);
      expectTrue(found !== undefined && bodies.includes(found.body), "one of the writes is stored");
      expectSame(await store.tags(`${space}t`), [`${space}k`], "listed once");
    },
  },
  {
    id: "SC13",
    name: "concurrent sets and deletes on different keys keep the tag index equal to the stored entries",
    async run(harness, space) {
      const { store } = harness;
      const keys = Array.from({ length: 30 }, (_unused, index) => `${space}m-${index}`);
      await Promise.all(
        keys.map((key) => store.set(key, entryOf(harness, { tags: [`${space}mix`] }))),
      );
      await Promise.all(
        keys.map((key, index) =>
          index % 3 === 0
            ? store.delete(key)
            : store.set(key, entryOf(harness, { tags: [`${space}mix`], body: `again ${index}` })),
        ),
      );
      const expected = keys.filter((_key, index) => index % 3 !== 0);
      expectSame(sorted(await store.tags(`${space}mix`)), sorted(expected), "index");
      for (const key of keys) {
        expectSame((await store.get(key)) !== undefined, expected.includes(key), `entry ${key}`);
      }
    },
  },
  {
    id: "SC14",
    name: "a store that has purgeTag removes exactly the entries that carry the tag, and its index",
    async run(harness, space) {
      const { store } = harness;
      if (store.purgeTag === undefined) return;
      await store.set(`${space}a`, entryOf(harness, { tags: [`${space}posts`, `${space}home`] }));
      await store.set(`${space}b`, entryOf(harness, { tags: [`${space}posts`] }));
      await store.set(`${space}c`, entryOf(harness, { tags: [`${space}home`] }));
      // `d` carried the tag once and does not any more: a purge of the tag must leave it.
      await store.set(`${space}d`, entryOf(harness, { tags: [`${space}posts`] }));
      await store.set(`${space}d`, entryOf(harness, { tags: [`${space}home`] }));
      await store.purgeTag(`${space}posts`);
      expectSame(await store.get(`${space}a`), undefined, "a");
      expectSame(await store.get(`${space}b`), undefined, "b");
      expectTrue((await store.get(`${space}c`)) !== undefined, "c stays");
      expectTrue((await store.get(`${space}d`)) !== undefined, "d stays");
      expectSame(await store.tags(`${space}posts`), [], "index emptied");
      expectSame(sorted(await store.tags(`${space}home`)), [`${space}c`, `${space}d`], "other tag");
      await store.purgeTag(`${space}posts`);
      await store.purgeTag(`${space}never-used`);
    },
  },
  {
    id: "SC15",
    name: "a purge that overlaps writes never leaves a live entry that tags() cannot find",
    async run(harness, space) {
      const { store } = harness;
      const keys = Array.from({ length: 24 }, (_unused, index) => `${space}p-${index}`);
      for (const key of keys.slice(0, 12)) {
        await store.set(key, entryOf(harness, { tags: [`${space}hot`] }));
      }
      const purge =
        store.purgeTag === undefined
          ? (async () => {
              for (const key of await store.tags(`${space}hot`)) await store.delete(key);
            })()
          : store.purgeTag(`${space}hot`);
      await Promise.all([
        purge,
        ...keys.slice(12).map((key) => store.set(key, entryOf(harness, { tags: [`${space}hot`] }))),
      ]);
      const listed = new Set(await store.tags(`${space}hot`));
      for (const key of keys) {
        if ((await store.get(key)) !== undefined) {
          expectTrue(listed.has(key), `${key} is stored but not listed under its tag`);
        }
      }
    },
  },
  {
    id: "SC16",
    name: "a store that expires entries drops one when its stale window ends, and its place in the tag",
    async run(harness, space) {
      const { store, advance, expires } = harness;
      if (expires !== true || advance === undefined) return;
      const at = (harness.now ?? Date.now)();
      await store.set(
        `${space}short`,
        entryOf(harness, { tags: [`${space}t`], freshUntil: at + 500, staleUntil: at + 1_000 }),
      );
      await store.set(`${space}long`, entryOf(harness, { tags: [`${space}t`] }));
      expectTrue((await store.get(`${space}short`)) !== undefined, "alive before its window ends");
      advance(2_000);
      expectSame(await store.get(`${space}short`), undefined, "gone after its window");
      expectTrue((await store.get(`${space}long`)) !== undefined, "the long one stays");
      expectSame(await store.tags(`${space}t`), [`${space}long`], "tag lists only what lives");
    },
  },
];

/**
 * Runs every scenario of the contract against a store.
 *
 * @param subject The store, or a harness with the store and its clock (give `advance` and `expires: true` when the store
 *   drops entries at the end of their stale window, to check that too).
 * @returns A promise that resolves when every scenario passed.
 * @throws Error naming every scenario that failed, with the reason of each.
 * @example
 * import { createMemoryCacheStore } from "@shadow-js/dusk/server";
 * await runStoreContract(createMemoryCacheStore());
 * @since 1.0.0
 */
export async function runStoreContract(subject: CacheStore | StoreHarness): Promise<void> {
  const harness: StoreHarness = "store" in subject ? subject : { store: subject };
  const run = crypto.randomUUID().slice(0, 8);
  const failures: string[] = [];
  for (const scenario of STORE_CONTRACT) {
    try {
      await scenario.run(harness, `contract:${run}:${scenario.id}:`);
    } catch (error) {
      failures.push(
        `${scenario.id} ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `The store breaks ${failures.length} scenario(s) of the contract:\n${failures.join("\n")}`,
    );
  }
}
