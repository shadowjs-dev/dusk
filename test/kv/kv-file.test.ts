import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileKVStore } from "../../src/node/kv-file";
import { KV_CONFORMANCE } from "../../src/testing/kv-conformance";

let directory: string;
let clock: { now: number };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dusk-kv-"));
  clock = { now: 1_000_000 };
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const make = () => createFileKVStore({ directory: join(directory, "kv"), now: () => clock.now });

describe("KVStore: the file implementation", () => {
  for (const scenario of KV_CONFORMANCE) {
    it(`[KV-C-${scenario.id}] conformance (file): ${scenario.name}`, async () => {
      await scenario.run({
        store: make(),
        advance: (milliseconds) => {
          clock.now += milliseconds;
        },
      });
    });
  }

  it("[KV-F1] a key of any length fits a file name (the file is named by the key's hash)", async () => {
    const store = make();
    const key = `long:${"k".repeat(500)}`;
    await store.set(key, "ok");
    expect(await store.get(key)).toBe("ok");
  });

  it("[KV-F2] a write leaves no temporary file behind", async () => {
    const store = make();
    await store.set("a", 1);
    await store.increment("b", 2);
    const names = readdirSync(join(directory, "kv"));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names).toHaveLength(2);
  });

  it("[KV-F3] a damaged file is no entry: it reads as missing, and the store keeps working", async () => {
    const store = make();
    await store.set("broken", 1);
    const file = readdirSync(join(directory, "kv")).find((name) => name.endsWith(".json"));
    if (file === undefined) throw new Error("no file was written");
    writeFileSync(join(directory, "kv", file), "{not json");
    expect(await store.get("broken")).toBeUndefined();
    await store.set("broken", 2);
    expect(await store.get("broken")).toBe(2);
  });

  it("[KV-F4] concurrent increments of one key are not lost (writes on a key are serialized)", async () => {
    const store = make();
    await Promise.all(Array.from({ length: 20 }, () => store.increment("hits")));
    expect(await store.get("hits")).toBe(20);
  });

  it("[KV-F5] the value bound applies to the file store too", async () => {
    const store = createFileKVStore({ directory: join(directory, "kv"), maxValueBytes: 8 });
    await expect(store.set("k", "x".repeat(40))).rejects.toThrow(RangeError);
  });

  it("[KV-F6] a store that was never written lists nothing (the folder does not exist yet)", async () => {
    expect(await make().list({ prefix: "" })).toEqual({ keys: [], cursor: undefined });
  });
});
