import { hashKey } from "@shadow-js/query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CacheStore, createMemoryCacheStore } from "../../src/server/cache-store";
import { EventState } from "../../src/server/event";
import {
  type CacheOptions,
  type CachePolicy,
  createIsr,
  keyOf,
  resolveCache,
} from "../../src/server/isr";

/**
 * ISR at scale: the page cache is driven through `createIsr` with a scripted renderer, a fake clock and real events, so
 * the fan-in is exact (`Promise.all` of N requests, one render) and time is the test's.
 */

afterEach(() => {
  vi.useRealTimers();
});

function eventFor(path: string, options: { signal?: AbortSignal; platform?: unknown } = {}) {
  const url = new URL(`https://example.com${path}`);
  return new EventState({
    request: new Request(url),
    url,
    signal: options.signal ?? new AbortController().signal,
    id: "test",
    nonce: undefined,
    signer: undefined,
    secureCookies: true,
    env: {},
    platform: options.platform,
    clientAddress: undefined,
    dev: false,
    lang: "en",
  });
}

function policy(fresh: number | false = 60, stale = 60, cookies: string[] = []): CachePolicy {
  return { fresh, stale, cookies, searchParams: undefined };
}

interface Script {
  /** The `Vary` header the scripted page sends; the page then reads the headers it names. */
  vary: string | undefined;
  count: number;
  signals: AbortSignal[];
  hold: Promise<void> | undefined;
  fail: Error | undefined;
  status: number;
}

function setup(
  options: CacheOptions = {},
  store: CacheStore = createMemoryCacheStore({ maxEntries: 50 }),
) {
  const clock = { now: 1_000_000 };
  const script: Script = {
    vary: undefined,
    count: 0,
    signals: [],
    hold: undefined,
    fail: undefined,
    status: 200,
  };
  const reports: unknown[] = [];
  const config = {
    ...resolveCache({ now: () => clock.now, store, ...options }),
    base: "",
    caseSensitive: false,
  };
  const isr = createIsr(config, {
    render: async (input) => {
      script.count += 1;
      const number = script.count;
      if (input.signal !== undefined) script.signals.push(input.signal);
      if (script.hold !== undefined) await script.hold;
      if (script.fail !== undefined) throw script.fail;
      return {
        response: new Response(`<p>render ${number}</p>`, {
          status: script.status,
          headers:
            script.vary === undefined
              ? { "content-type": "text/html" }
              : { "content-type": "text/html", vary: script.vary },
        }),
        event: eventFor(input.url.pathname),
        read: new Set<string>(script.vary === undefined ? [] : [script.vary]),
      };
    },
    renderOwn: async () => new Response("own"),
    report: (error) => void reports.push(error),
  });
  return { clock, script, reports, isr, store };
}

/** A promise that stays pending until `release` is called. */
function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ISR coalescing", () => {
  it("[SCALE-ISR-01] 300 concurrent requests for an uncached key run one render; each response has its own readable body", async () => {
    const t = setup();
    const held = latch();
    t.script.hold = held.promise;
    const pending = Array.from({ length: 300 }, () => t.isr.serve(eventFor("/news"), policy()));
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    held.release();
    const responses = await Promise.all(pending);
    expect(t.script.count).toBe(1);
    expect(new Set(responses)).toHaveProperty("size", 300);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(new Set(bodies)).toEqual(new Set(["<p>render 1</p>"]));
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("x-dusk-cache")).toBe("MISS");
    }
    expect(t.isr.inFlight).toBe(0);
  });

  it("[SCALE-ISR-02] an answer that cannot be stored (a 404) is shared by the waiting requests: each reads its own body", async () => {
    const t = setup();
    const held = latch();
    t.script.hold = held.promise;
    t.script.status = 404;
    const pending = Array.from({ length: 20 }, () => t.isr.serve(eventFor("/gone"), policy()));
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    held.release();
    const responses = await Promise.all(pending);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(t.script.count).toBe(1);
    expect(bodies.every((body) => body === "<p>render 1</p>")).toBe(true);
    expect(responses.every((response) => response.status === 404)).toBe(true);
    // Nothing was stored: the next request renders again.
    t.script.hold = undefined;
    const next = await t.isr.serve(eventFor("/gone"), policy());
    expect(await next.text()).toBe("<p>render 2</p>");
  });

  it("[SCALE-ISR-03] a failed render is shared by the requests that waited for it and is not cached", async () => {
    const t = setup();
    const held = latch();
    t.script.hold = held.promise;
    t.script.fail = new Error("database is down");
    const pending = Array.from({ length: 10 }, () =>
      t.isr.serve(eventFor("/news"), policy()).then(
        () => "ok",
        (error: unknown) => (error as Error).message,
      ),
    );
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    held.release();
    expect(new Set(await Promise.all(pending))).toEqual(new Set(["database is down"]));
    expect(t.script.count).toBe(1);
    t.script.fail = undefined;
    t.script.hold = undefined;
    const recovered = await t.isr.serve(eventFor("/news"), policy());
    expect(await recovered.text()).toBe("<p>render 2</p>");
  });

  it("[SCALE-ISR-04] maxWaiters: the request past the cap renders on its own and is still answered", async () => {
    const t = setup({ maxWaiters: 3 });
    const held = latch();
    t.script.hold = held.promise;
    const pending = Array.from({ length: 5 }, () => t.isr.serve(eventFor("/news"), policy()));
    await vi.waitFor(() => expect(t.script.count).toBe(3));
    held.release();
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    // One shared render for three requests, two renders on their own.
    expect(t.script.count).toBe(3);
  });

  it("[SCALE-ISR-05] maxInFlight: past the cap a new key renders on its own; the key in flight still coalesces", async () => {
    const t = setup({ maxInFlight: 1 });
    const held = latch();
    t.script.hold = held.promise;
    const first = [t.isr.serve(eventFor("/a"), policy()), t.isr.serve(eventFor("/a"), policy())];
    const other = t.isr.serve(eventFor("/b"), policy());
    await vi.waitFor(() => expect(t.script.count).toBe(2));
    held.release();
    const all = await Promise.all([...first, other]);
    expect(all.every((response) => response.status === 200)).toBe(true);
    expect(t.script.count).toBe(2);
  });

  it("[SCALE-ISR-06] defaults: a thousand requests share one render, and the table holds ten thousand keys", () => {
    const config = resolveCache(undefined);
    expect(config.maxWaiters).toBe(1_000);
    expect(config.maxInFlight).toBe(10_000);
    expect(config.renderTimeoutMs).toBe(30_000);
    expect(config.backoffBaseMs).toBe(1_000);
    expect(config.backoffMaxMs).toBe(60_000);
    expect(() => resolveCache({ maxWaiters: 0 })).toThrow(RangeError);
    expect(() => resolveCache({ renderTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => resolveCache({ backoffBaseMs: 5_000, backoffMaxMs: 1_000 })).toThrow(RangeError);
  });

  it("[SCALE-ISR-07] a request whose client left gets 499 and stops waiting; the render goes on for the others", async () => {
    const t = setup();
    const held = latch();
    t.script.hold = held.promise;
    const leaving = new AbortController();
    const stays = t.isr.serve(eventFor("/news"), policy());
    const left = t.isr.serve(eventFor("/news", { signal: leaving.signal }), policy());
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    leaving.abort();
    expect((await left).status).toBe(499);
    expect(t.script.signals[0]?.aborted).toBe(false);
    held.release();
    expect((await stays).status).toBe(200);
    expect(t.script.count).toBe(1);
  });

  it("[SCALE-ISR-08] when every waiting client left, the render's signal aborts and the key is free", async () => {
    const t = setup();
    t.script.hold = latch().promise;
    const one = new AbortController();
    const two = new AbortController();
    const first = t.isr.serve(eventFor("/news", { signal: one.signal }), policy());
    const second = t.isr.serve(eventFor("/news", { signal: two.signal }), policy());
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    one.abort();
    expect((await first).status).toBe(499);
    expect(t.script.signals[0]?.aborted).toBe(false);
    two.abort();
    expect((await second).status).toBe(499);
    expect(t.script.signals[0]?.aborted).toBe(true);
    expect(t.isr.inFlight).toBe(0);
  });

  it("[SCALE-ISR-09] a render that never finishes is abandoned after renderTimeoutMs: the waiting requests fail and the key is free", async () => {
    vi.useFakeTimers();
    const t = setup({ renderTimeoutMs: 2_000 });
    t.script.hold = new Promise<void>(() => undefined);
    const outcome = t.isr.serve(eventFor("/news"), policy()).then(
      () => "answered",
      (error: unknown) => (error as DOMException).name,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBe("TimeoutError");
    expect(t.script.signals[0]?.aborted).toBe(true);
    expect(t.isr.inFlight).toBe(0);
    t.script.hold = undefined;
    expect(await (await t.isr.serve(eventFor("/news"), policy())).text()).toBe("<p>render 2</p>");
  });

  it("[SCALE-ISR-10] a purge that began while a page rendered keeps that page out of the store (the waiters still get it)", async () => {
    const t = setup();
    const held = latch();
    t.script.hold = held.promise;
    const waiting = t.isr.serve(eventFor("/news"), policy());
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    await t.isr.purgePath("/news");
    held.release();
    const answered = await waiting;
    expect(await answered.text()).toBe("<p>render 1</p>");
    t.script.hold = undefined;
    const next = await t.isr.serve(eventFor("/news"), policy());
    expect(next.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await next.text()).toBe("<p>render 2</p>");
    // A render that began after the purge is stored as usual.
    expect((await t.isr.serve(eventFor("/news"), policy())).headers.get("x-dusk-cache")).toBe(
      "HIT",
    );
  });

  it("[SCALE-ISR-11] a store with its own purgeTag is purged through it, in one call", async () => {
    const calls: string[] = [];
    const inner = createMemoryCacheStore();
    const store: CacheStore = {
      get: (key) => inner.get(key),
      set: (key, entry) => inner.set(key, entry),
      delete: (key) => inner.delete(key),
      tags: (tag) => inner.tags(tag),
      async purgeTag(tag) {
        calls.push(tag);
        for (const key of await inner.tags(tag)) await inner.delete(key);
      },
    };
    const t = setup({}, store);
    await t.isr.serve(eventFor("/news"), policy());
    expect((await t.isr.serve(eventFor("/news"), policy())).headers.get("x-dusk-cache")).toBe(
      "HIT",
    );
    await t.isr.purgePath("/news");
    expect(calls).toEqual(["path:/news"]);
    expect((await t.isr.serve(eventFor("/news"), policy())).headers.get("x-dusk-cache")).toBe(
      "MISS",
    );
  });
});

describe("ISR pages that vary", () => {
  it("[SCALE-ISR-22] the index of a page that varies lives as long as its variants, so a store that expires entries drops both together", async () => {
    const t = setup();
    t.script.vary = "accept-language";
    const url = new URL("https://example.com/news");
    await t.isr.serve(eventFor("/news"), policy(60, 60));
    const base = keyOf(url, new Request(url), policy(60, 60));
    const index = await t.store.get(base);
    expect(index?.headers).toEqual([["x-dusk-vary-index", "1"]]);
    expect(index?.freshUntil).toBe(t.clock.now + 60_000);
    expect(index?.staleUntil).toBe(t.clock.now + 120_000);
    // A page that never goes stale keeps its index too.
    await t.isr.serve(eventFor("/forever"), policy(false, 0));
    const foreverUrl = new URL("https://example.com/forever");
    const foreverIndex = await t.store.get(
      keyOf(foreverUrl, new Request(foreverUrl), policy(false, 0)),
    );
    expect(foreverIndex?.staleUntil).toBeNull();
  });
});

describe("ISR stale-while-revalidate", () => {
  it("[SCALE-ISR-12] 100 concurrent stale requests are all answered with the stale page at once; one background render refreshes it", async () => {
    const t = setup();
    await t.isr.serve(eventFor("/news"), policy());
    t.clock.now += 61_000;
    const held = latch();
    t.script.hold = held.promise;
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => t.isr.serve(eventFor("/news"), policy())),
    );
    expect(responses.every((r) => r.headers.get("x-dusk-cache") === "STALE")).toBe(true);
    expect(
      (await Promise.all(responses.map((r) => r.text()))).every((b) => b === "<p>render 1</p>"),
    ).toBe(true);
    expect(t.script.count).toBe(2);
    held.release();
    await vi.waitFor(async () => {
      const next = await t.isr.serve(eventFor("/news"), policy());
      expect(next.headers.get("x-dusk-cache")).toBe("HIT");
      expect(await next.text()).toBe("<p>render 2</p>");
    });
    expect(t.script.count).toBe(2);
  });

  it("[SCALE-ISR-13] the refresh is handed to the platform's waitUntil, which sees it settle with the entry stored", async () => {
    const t = setup();
    await t.isr.serve(eventFor("/news"), policy());
    t.clock.now += 61_000;
    const taken: Promise<unknown>[] = [];
    const platform = { waitUntil: (work: Promise<unknown>) => void taken.push(work) };
    const stale = await t.isr.serve(eventFor("/news", { platform }), policy());
    expect(stale.headers.get("x-dusk-cache")).toBe("STALE");
    expect(taken).toHaveLength(1);
    await taken[0];
    const next = await t.isr.serve(eventFor("/news"), policy());
    expect(next.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await next.text()).toBe("<p>render 2</p>");
    // Only the request that started a refresh hands one over: the others find it running.
    expect(taken).toHaveLength(1);
  });

  it("[SCALE-ISR-14] without a waitUntil the refresh still runs in the process; a waitUntil that throws is reported and the stale page is served", async () => {
    const t = setup();
    await t.isr.serve(eventFor("/news"), policy());
    t.clock.now += 61_000;
    const platform = {
      waitUntil() {
        throw new Error("called after the response was sent");
      },
    };
    const stale = await t.isr.serve(eventFor("/news", { platform }), policy());
    expect(stale.status).toBe(200);
    expect(t.reports).toEqual([new Error("called after the response was sent")]);
    await vi.waitFor(() => expect(t.script.count).toBe(2));
  });

  it("[SCALE-ISR-15] a failing refresh keeps serving the stale page, reports each failure, and backs off: 1 s, 2 s, 4 s", async () => {
    const t = setup({ backoffBaseMs: 1_000, backoffMaxMs: 60_000 }, createMemoryCacheStore());
    await t.isr.serve(eventFor("/news"), policy(60, 3_600));
    t.clock.now += 61_000;
    t.script.fail = new Error("upstream 503");
    const stale = async () => {
      const response = await t.isr.serve(eventFor("/news"), policy(60, 3_600));
      expect(response.headers.get("x-dusk-cache")).toBe("STALE");
      expect(await response.text()).toBe("<p>render 1</p>");
      // Let the background work settle before the next request.
      await vi.waitFor(() => expect(t.isr.inFlight).toBe(0));
    };
    await stale();
    expect(t.script.count).toBe(2);
    expect(t.reports).toHaveLength(1);
    // Inside the first wait (1 s): no new attempt, no new report.
    await stale();
    t.clock.now += 999;
    await stale();
    expect(t.script.count).toBe(2);
    t.clock.now += 1;
    await stale();
    expect(t.script.count).toBe(3);
    expect(t.reports).toHaveLength(2);
    // The second wait is 2 s.
    t.clock.now += 1_999;
    await stale();
    expect(t.script.count).toBe(3);
    t.clock.now += 1;
    await stale();
    expect(t.script.count).toBe(4);
    // The third wait is 4 s.
    t.clock.now += 3_999;
    await stale();
    expect(t.script.count).toBe(4);
    t.clock.now += 1;
    t.script.fail = undefined;
    await stale();
    expect(t.script.count).toBe(5);
    // The refresh worked: the page is fresh again and the backoff is forgotten.
    const fresh = await t.isr.serve(eventFor("/news"), policy(60, 3_600));
    expect(fresh.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await fresh.text()).toBe("<p>render 5</p>");
  });

  it("[SCALE-ISR-16] a refresh that renders an error page (not stored) backs off like a failure, without reporting an error", async () => {
    const t = setup();
    await t.isr.serve(eventFor("/news"), policy(60, 3_600));
    t.clock.now += 61_000;
    t.script.status = 500;
    const first = await t.isr.serve(eventFor("/news"), policy(60, 3_600));
    expect(first.headers.get("x-dusk-cache")).toBe("STALE");
    await vi.waitFor(() => expect(t.isr.inFlight).toBe(0));
    expect(t.script.count).toBe(2);
    await t.isr.serve(eventFor("/news"), policy(60, 3_600));
    expect(t.script.count).toBe(2);
    expect(t.reports).toEqual([]);
  });
});

describe("ISR headers", () => {
  it("[SCALE-ISR-17] Age counts from the render; s-maxage is the whole lifetime, so a shared cache counts down to the same moment", async () => {
    const t = setup();
    const miss = await t.isr.serve(eventFor("/news"), policy(60, 120));
    expect(miss.headers.get("age")).toBe("0");
    expect(miss.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
    );
    t.clock.now += 25_400;
    const hit = await t.isr.serve(eventFor("/news"), policy(60, 120));
    expect(hit.headers.get("x-dusk-cache")).toBe("HIT");
    expect(hit.headers.get("age")).toBe("25");
    expect(hit.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
    );
    t.clock.now += 70_000;
    const stale = await t.isr.serve(eventFor("/news"), policy(60, 120));
    expect(stale.headers.get("x-dusk-cache")).toBe("STALE");
    // Age 95 is past s-maxage 60 (the copy is stale) and inside 60 + 120 (it may still be served while it refreshes).
    expect(stale.headers.get("age")).toBe("95");
    expect(stale.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
    );
  });

  it("[SCALE-ISR-18] the Age of a page is measured from the start of its render, not from when it was stored", async () => {
    const t = setup();
    const held = latch();
    t.script.hold = held.promise;
    const pending = t.isr.serve(eventFor("/news"), policy());
    await vi.waitFor(() => expect(t.script.count).toBe(1));
    t.clock.now += 4_000;
    held.release();
    const miss = await pending;
    expect(miss.headers.get("age")).toBe("4");
    t.script.hold = undefined;
    // 56 s later the page is 60 s old, not 56: it is no longer fresh.
    t.clock.now += 56_000;
    const next = await t.isr.serve(eventFor("/news"), policy());
    expect(next.headers.get("x-dusk-cache")).toBe("STALE");
  });

  it("[SCALE-ISR-19] a page that never goes stale has a year-long s-maxage and an Age; a page keyed on cookies is private", async () => {
    const t = setup();
    await t.isr.serve(eventFor("/forever"), policy(false, 0));
    t.clock.now += 3_000;
    const forever = await t.isr.serve(eventFor("/forever"), policy(false, 0));
    expect(forever.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=31536000");
    expect(forever.headers.get("age")).toBe("3");
    await t.isr.serve(eventFor("/mine"), policy(60, 60, ["locale"]));
    const mine = await t.isr.serve(eventFor("/mine"), policy(60, 60, ["locale"]));
    expect(mine.headers.get("cache-control")).toBe("private, max-age=0");
  });
});

describe("ISR key (query key contract)", () => {
  const base = (cookies: string[] = [], searchParams?: string[]): CachePolicy => ({
    fresh: 60,
    stale: 60,
    cookies,
    searchParams,
  });

  it("[SCALE-ISR-20] the key is hashKey([host, path, sorted query pairs, declared cookie pairs])", () => {
    const url = new URL("https://example.com/Docs/Intro?b=2&a=1&a=0&skip=x");
    const request = new Request(url, { headers: { cookie: "locale=ar; other=1" } });
    expect(keyOf(url, request, base(["locale"], ["a", "b"]))).toBe(
      hashKey([
        "example.com",
        "/docs/intro",
        [
          ["a", "0"],
          ["a", "1"],
          ["b", "2"],
        ],
        [["locale", "ar"]],
      ]),
    );
  });

  it("[SCALE-ISR-21] equal requests share a key whatever the order of their query; different ones never do, even when a value looks like another parameter or cookie", () => {
    const key = (target: string, cookie = "") => {
      const url = new URL(target);
      return keyOf(
        url,
        new Request(url, cookie === "" ? {} : { headers: { cookie } }),
        base(["c"]),
      );
    };
    expect(key("https://example.com/p?a=1&b=2")).toBe(key("https://example.com/p?b=2&a=1"));
    expect(key("https://example.com/p?a=1&b=2")).not.toBe(key("https://example.com/p?a=1%26b%3D2"));
    expect(key("https://example.com/p?a=1")).not.toBe(key("https://example.org/p?a=1"));
    expect(key("https://example.com/p")).not.toBe(key("https://example.com/p", "c=1"));
    expect(key("https://example.com/p", "c=1")).not.toBe(key("https://example.com/p", "c=2"));
    expect(key("https://example.com/p?a=1")).not.toBe(key("https://example.com/p", "c=a%3D1"));
  });
});
