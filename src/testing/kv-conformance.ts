/**
 * The conformance suite of the {@link KVStore} contract (see `kv-store.ts`). Every implementation runs
 * these scenarios: the memory store and the file store in this repository, and any store an app or an
 * adapter writes. A scenario throws when the store breaks the contract; a passing run is the evidence the
 * store can back the page cache, the data cache, sessions and rate limits.
 *
 * @example
 * import { KV_CONFORMANCE } from "@shadow-js/dusk/testing";
 * for (const scenario of KV_CONFORMANCE) it(scenario.name, () => scenario.run({ store, advance }));
 * @packageDocumentation
 */

import type { KVStore } from "../server/kv-store";

/** What a scenario gets: the store, and a way to move its clock forward. @since 1.0.0 */
export interface KvHarness {
  readonly store: KVStore;
  /** Moves the store's clock forward by `milliseconds` (the store must read the same clock). */
  advance(milliseconds: number): void;
}

/** One scenario of the suite. @since 1.0.0 */
export interface KvConformanceCase {
  readonly id: string;
  readonly name: string;
  run(harness: KvHarness): Promise<void>;
}

function same(actual: unknown, expected: unknown, label: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`);
}

async function refuses(work: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
  throw new Error(`${label}: the call should have been refused`);
}

/**
 * The scenarios of the contract, in order. Each one uses its own keys, so they can share one store.
 * @since 1.0.0
 */
export const KV_CONFORMANCE: readonly KvConformanceCase[] = [
  {
    id: "C1",
    name: "set and get round-trip JSON; a missing key reads undefined; set replaces",
    async run({ store }) {
      await store.set("c1:a", { n: 1, list: [true, null, "x"] });
      same(await store.get("c1:a"), { n: 1, list: [true, null, "x"] }, "round-trip");
      same(await store.get("c1:missing"), undefined, "missing");
      await store.set("c1:a", "again");
      same(await store.get("c1:a"), "again", "replace");
    },
  },
  {
    id: "C2",
    name: "a value that has no JSON form is refused",
    async run({ store }) {
      await refuses(() => store.set("c2:k", undefined), "undefined");
      await refuses(() => store.set("c2:k", () => 1), "function");
      await refuses(() => store.set("c2:k", Number.NaN), "NaN");
    },
  },
  {
    id: "C3",
    name: "a TTL expires the entry; an expired entry is absent from get and from list",
    async run({ store, advance }) {
      await store.set("c3:short", 1, { ttlSeconds: 10 });
      await store.set("c3:long", 2);
      same(await store.get("c3:short"), 1, "before expiry");
      advance(10_000);
      same(await store.get("c3:short"), undefined, "after expiry");
      same(await store.get("c3:long"), 2, "no TTL keeps the value");
      same((await store.list({ prefix: "c3:" })).keys, ["c3:long"], "list skips the expired entry");
    },
  },
  {
    id: "C4",
    name: "increment adds (a missing key starts at 0); a non-number is refused; the TTL applies when the key is created",
    async run({ store, advance }) {
      same(await store.increment("c4:n"), 1, "default step");
      same(await store.increment("c4:n", 4), 5, "explicit step");
      await store.set("c4:text", "ada");
      await refuses(() => store.increment("c4:text"), "increment of text");
      same(await store.increment("c4:w", 1, { ttlSeconds: 5 }), 1, "window created");
      same(await store.increment("c4:w", 1, { ttlSeconds: 500 }), 2, "window counted");
      advance(5_000);
      same(await store.get("c4:w"), undefined, "the window expired at the creation TTL");
    },
  },
  {
    id: "C5",
    name: "delete removes a key and a second delete is not an error",
    async run({ store }) {
      await store.set("c5:gone", true);
      await store.delete("c5:gone");
      await store.delete("c5:gone");
      same(await store.get("c5:gone"), undefined, "deleted");
    },
  },
  {
    id: "C6",
    name: "list returns the keys with a prefix in order, one page at a time, each key once",
    async run({ store }) {
      for (const key of ["c6:c", "c6:a", "c6:e", "c6:b", "c6x:z", "c6:d"])
        await store.set(key, key);
      const first = await store.list({ prefix: "c6:", limit: 2 });
      same(first.keys, ["c6:a", "c6:b"], "first page");
      const second = await store.list({ prefix: "c6:", limit: 2, cursor: first.cursor });
      same(second.keys, ["c6:c", "c6:d"], "second page");
      const third = await store.list({ prefix: "c6:", limit: 2, cursor: second.cursor });
      same(third.keys, ["c6:e"], "last page");
      same(third.cursor, undefined, "no cursor after the last page");
    },
  },
  {
    id: "C7",
    name: "a key must be 1 to 512 characters without NUL",
    async run({ store }) {
      await refuses(() => store.set("", 1), "empty key");
      await refuses(() => store.set("x".repeat(513), 1), "long key");
      await refuses(() => store.set("a\u0000b", 1), "NUL in key");
    },
  },
  {
    id: "C8",
    name: "a stored value is a copy: changing the object afterward does not change the store",
    async run({ store }) {
      const value = { list: [1] };
      await store.set("c8:v", value);
      value.list.push(2);
      same(await store.get("c8:v"), { list: [1] }, "after change");
    },
  },
];
