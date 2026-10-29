import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The unlink of the store waits on a gate the test controls, so the interleaving below is deterministic.
const gate: { hold: Promise<void> | undefined; reached: (() => void) | undefined } = {
  hold: undefined,
  reached: undefined,
};
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      if (gate.hold !== undefined) {
        gate.reached?.();
        await gate.hold;
      }
      return actual.unlink(path);
    },
  };
});

const { createFileKVStore } = await import("../src/node/kv-file");

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dusk-kv-rest-"));
});
afterEach(() => {
  gate.hold = undefined;
  gate.reached = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("file KV store", () => {
  it("[DUSK-REST-REV-5] removing an expired entry on read never deletes a value written meanwhile", async () => {
    const clock = { now: 1_000_000 };
    const store = createFileKVStore({ directory, now: () => clock.now });
    await store.set("k", "old", { ttlSeconds: 1 });
    clock.now += 5000;
    let release: () => void = () => undefined;
    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      gate.reached = resolve;
    });
    const stale = store.get("k");
    await reached;
    const fresh = store.set("k", "new");
    // Let the write run as far as it can while the removal is parked (a write is about ten file system round
    // trips; forty is far more), then let the removal finish.
    for (let trip = 0; trip < 40; trip += 1) await stat(directory);
    release();
    await Promise.all([stale, fresh]);
    gate.hold = undefined;
    expect(await store.get("k")).toBe("new");
  });

  it("[DUSK-REST-REV-6] list skips a file that is not a stored entry, as get treats a damaged file as no entry", async () => {
    const store = createFileKVStore({ directory, now: () => 1 });
    await store.set("a", 1);
    writeFileSync(join(directory, "stray.json"), "{not json");
    writeFileSync(join(directory, "other.json"), '{"unrelated":true}');
    expect(await store.list()).toEqual({ keys: ["a"], cursor: undefined });
  });
});
