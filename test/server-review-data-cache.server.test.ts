import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithEvent } from "../src/server/context";
import { adoptDataCache, cachedFetch, createDataCache } from "../src/server/data-cache";
import type { EventState } from "../src/server/event";
import { createMemoryKVStore } from "../src/server/kv-store";
import { createTestEvent } from "../src/testing/index";

/** `cachedFetch` inside a request, in draft mode and out of it. */
function inRequest<T>(draft: boolean, callback: () => Promise<T>): Promise<T> {
  const event = createTestEvent() as EventState;
  event.draft = draft;
  adoptDataCache(event, createDataCache({ kv: createMemoryKVStore() }));
  return runWithEvent(event, callback);
}

describe("cachedFetch in draft mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[DUSK-SRV-REV-11] a text answer is returned as text in draft mode too, as it is out of draft mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("plain text", { headers: { "content-type": "text/plain" } })),
    );
    const outside = await inRequest(false, () =>
      cachedFetch("https://api.example/t", undefined, { revalidate: 60 }),
    );
    const inside = await inRequest(true, () =>
      cachedFetch("https://api.example/t", undefined, { revalidate: 60 }),
    );
    expect(outside).toBe("plain text");
    expect(inside).toBe("plain text");
  });

  it("[DUSK-SRV-REV-12] draft mode keeps the rules of cachedFetch: GET only, no credential headers, an error status is an error", async () => {
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const options = { revalidate: 60 } as const;
    await expect(
      inRequest(true, () => cachedFetch("https://api.example/t", { method: "POST" }, options)),
    ).rejects.toThrow(TypeError);
    await expect(
      inRequest(true, () =>
        cachedFetch("https://api.example/t", { headers: { Authorization: "Bearer x" } }, options),
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      inRequest(true, () => cachedFetch("https://api.example/t", undefined, options)),
    ).rejects.toThrow("answered 500");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("[DUSK-SRV-REV-13] draft mode fetches every time and stores nothing", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ n: 1 }), { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const event = createTestEvent() as EventState;
    event.draft = true;
    const kv = createMemoryKVStore();
    adoptDataCache(event, createDataCache({ kv }));
    await runWithEvent(event, async () => {
      await cachedFetch("https://api.example/j", undefined, { revalidate: 60 });
      await cachedFetch("https://api.example/j", undefined, { revalidate: 60 });
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await kv.list({ prefix: "" })).keys).toEqual([]);
  });
});
