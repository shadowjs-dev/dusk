import { deserialize, serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnStub } from "../src/client/fn";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serverFnStub batching: unserializable input", () => {
  it("[DUSK-REST-REV-1] a call whose input cannot be serialized rejects alone; the calls batched with it still resolve", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit): Promise<Response> => {
      const calls = deserialize(String(init?.body)) as { id: string; input: unknown }[];
      bodies.push(calls);
      return new Response(serialize(calls.map((entry) => ({ ok: true, value: entry.input }))), {
        status: 200,
      });
    });
    const echo = serverFnStub<unknown, unknown>("echo", { method: "POST", form: false, base: "" });
    const settled = Promise.allSettled([echo("a"), echo({ fn: () => 1 }), echo("c")]);
    const [first, second, third] = await settled;
    expect(first).toEqual({ status: "fulfilled", value: "a" });
    expect(second?.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(TypeError);
    expect(third).toEqual({ status: "fulfilled", value: "c" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual([
      { id: "echo", input: "a" },
      { id: "echo", input: "c" },
    ]);
  });
});

describe("submission store revalidator", () => {
  it("[DUSK-REST-REV-2] the revalidator stays loading until every overlapping revalidation has finished", async () => {
    const { createSubmissionStore } = await import("../src/client/submissions");
    const gates: Array<() => void> = [];
    const store = createSubmissionStore({
      onRevalidate: () => new Promise<void>((resolve) => gates.push(resolve)),
    });
    const revalidator = store.revalidator();
    const first = revalidator.revalidate();
    const second = revalidator.revalidate();
    expect(revalidator.state()).toBe("loading");
    gates[0]?.();
    await first;
    expect(revalidator.state()).toBe("loading");
    gates[1]?.();
    await second;
    expect(revalidator.state()).toBe("idle");
  });
});
