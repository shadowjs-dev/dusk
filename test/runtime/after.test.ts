import { describe, expect, it } from "vitest";
import { AFTER_LIMIT, queueAfter, runAfterTasks, takeAfterTasks } from "../../src/server/after";

describe("after()", () => {
  it("[AFT-1] queued tasks run in order when run; a second take finds nothing", async () => {
    const event = {};
    const order: string[] = [];
    queueAfter(event, () => order.push("first"));
    queueAfter(event, async () => {
      await Promise.resolve();
      order.push("second");
    });
    const tasks = takeAfterTasks(event);
    expect(tasks).toHaveLength(2);
    expect(takeAfterTasks(event)).toEqual([]);
    await runAfterTasks(tasks, () => undefined);
    expect(order).toEqual(["first", "second"]);
  });

  it("[AFT-2] a failing task is reported and the next task still runs; nothing is thrown to the caller", async () => {
    const event = {};
    const reported: unknown[] = [];
    queueAfter(event, () => {
      throw new Error("analytics down");
    });
    let ran = false;
    queueAfter(event, () => {
      ran = true;
    });
    await expect(
      runAfterTasks(takeAfterTasks(event), (error) => reported.push(error)),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("analytics down");
  });

  it("[AFT-3] the queue of one request is bounded", () => {
    const event = {};
    for (let index = 0; index < AFTER_LIMIT; index += 1) queueAfter(event, () => undefined);
    expect(() => queueAfter(event, () => undefined)).toThrow(RangeError);
  });

  it("[AFT-4] a task that is not a function is a TypeError when queued", () => {
    expect(() => queueAfter({}, "nope" as unknown as () => void)).toThrow(TypeError);
  });

  it("[AFT-5] the tasks do not start before the work that queued them is done (they start when run)", async () => {
    const event = {};
    let started = false;
    queueAfter(event, () => {
      started = true;
    });
    expect(started).toBe(false);
    await runAfterTasks(takeAfterTasks(event), () => undefined);
    expect(started).toBe(true);
  });
});
