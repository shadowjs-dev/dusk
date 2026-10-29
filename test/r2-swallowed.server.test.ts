import { describe, expect, it, vi } from "vitest";
import { isWorkerGone } from "../src/node/cluster";
import { headersFromRaw } from "../src/server/image-safe-fetch";
import { redisStore } from "../src/server/stores/redis";
import { createFakeRedis } from "./support/fake-redis";

describe("image fetch: headers the Fetch API refuses", () => {
  it("[DUSK-R2-9] a refused header is dropped, the rest kept, and the first refusal is reported once", () => {
    const report = vi.fn();
    const headers = headersFromRaw(
      ["content-type", "image/png", "bad name", "x", "x-a", "ok", "also bad", "y"],
      report,
    );
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("x-a")).toBe("ok");
    expect([...headers].length).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
  });

  it("[DUSK-R2-9] good headers report nothing", () => {
    const report = vi.fn();
    headersFromRaw(["content-type", "image/png"], report);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("redis store: a stored string that is not JSON", () => {
  it("[DUSK-R2-9] is a miss, and goes to report when the store has one; other formats are plain misses", async () => {
    const client = createFakeRedis({ now: () => 0 });
    const report = vi.fn();
    const store = redisStore(client, { now: () => 0, report });
    await client.set("dusk:isr:e:garbage", "not json at all");
    await client.set("dusk:isr:e:future", JSON.stringify({ v: 2, e: {} }));
    expect(await store.get("garbage")).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(SyntaxError);
    expect(await store.get("future")).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe("worker pool: calls to a worker that has left", () => {
  it("[DUSK-R2-9] ESRCH and a closed channel are the expected errors; anything else is not", () => {
    expect(isWorkerGone(Object.assign(new Error("x"), { code: "ESRCH" }))).toBe(true);
    expect(isWorkerGone(Object.assign(new Error("x"), { code: "ERR_IPC_DISCONNECTED" }))).toBe(
      true,
    );
    expect(isWorkerGone(Object.assign(new Error("x"), { code: "ERR_IPC_CHANNEL_CLOSED" }))).toBe(
      true,
    );
    expect(isWorkerGone(Object.assign(new Error("x"), { code: "EPERM" }))).toBe(false);
    expect(isWorkerGone(new TypeError("bad signal"))).toBe(false);
    expect(isWorkerGone("text")).toBe(false);
  });
});
