import { serializeHydrationData } from "@shadow-js/router";
import { serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnStub } from "../../src/client/fn";
import { createSubmissionStore } from "../../src/client/submissions";
import { ROUTER_PAYLOAD_ID } from "../../src/shared/wire";

/** `fetcher.load(url)`: the page's loader data without a navigation, with its own loading state and error. */

const save = serverFnStub<{ title: string }, { saved: string }>("saveLoad", {
  method: "POST",
  form: true,
  base: "",
  batch: false,
});

function match(id: string, value: unknown) {
  return { id, params: {}, deps: null, updatedAt: 1, value, failed: false } as const;
}

/** A page that carries router data with one loader result. */
function page(value: unknown): Response {
  const data = serializeHydrationData({ version: 1, matches: [match("inbox", value)] });
  return new Response(
    `<!doctype html><html><body><script type="application/json" id="${ROUTER_PAYLOAD_ID}">${data}</script></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** A response the test settles by hand, so two loads can be in flight at once. */
function gate(): { readonly promise: Promise<Response>; resolve(response: Response): void } {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetcher.load", () => {
  it("[LOAD-01] goes loading, then idle, and keeps the loader data of the page without navigating", async () => {
    const fetchMock = vi.fn(async () => page({ count: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const fetcher = createSubmissionStore().fetcher("inbox");
    expect(fetcher.state()).toBe("idle");
    const done = fetcher.load("/inbox?page=2");
    expect(fetcher.state()).toBe("loading");
    await done;
    expect(fetcher.state()).toBe("idle");
    expect(fetcher.error()).toBeUndefined();
    expect(fetcher.data()).toEqual([match("inbox", { count: 3 })]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/inbox?page=2");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("accept")).toBe("text/html");
  });

  it("[LOAD-02] a page that answers with an error status sets the error and goes idle, and the earlier data stays", async () => {
    const store = createSubmissionStore();
    const fetcher = store.fetcher("inbox");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => page("first")),
    );
    await fetcher.load("/inbox");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    await fetcher.load("/inbox");
    expect(fetcher.state()).toBe("idle");
    expect((fetcher.error() as Error).message).toBe("fetcher.load(): the page answered 503");
    expect(fetcher.data()).toEqual([match("inbox", "first")]);
  });

  it("[LOAD-03] a network failure is the error as thrown, and a new load clears it at once", async () => {
    const fetcher = createSubmissionStore().fetcher("inbox");
    const offline = new TypeError("Failed to fetch");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw offline;
      }),
    );
    await fetcher.load("/inbox");
    expect(fetcher.error()).toBe(offline);
    expect(fetcher.state()).toBe("idle");
    const pending = gate();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending.promise),
    );
    const next = fetcher.load("/inbox");
    expect(fetcher.error()).toBeUndefined();
    expect(fetcher.state()).toBe("loading");
    pending.resolve(page(1));
    await next;
    expect(fetcher.error()).toBeUndefined();
  });

  it("[LOAD-04] a page without router data, and router data that is not valid, are not a crash", async () => {
    const fetcher = createSubmissionStore().fetcher("inbox");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html><body>no payload</body></html>", { status: 200 })),
    );
    await fetcher.load("/plain");
    expect(fetcher.data()).toBeUndefined();
    expect(fetcher.error()).toBeUndefined();
    expect(fetcher.state()).toBe("idle");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `<script type="application/json" id="${ROUTER_PAYLOAD_ID}">{"version":2}</script>`,
            { status: 200 },
          ),
      ),
    );
    await fetcher.load("/bad");
    expect(fetcher.error()).toBeInstanceOf(TypeError);
    expect(fetcher.state()).toBe("idle");
  });

  it("[LOAD-05] a second load supersedes the first: the first answer, arriving last, changes nothing", async () => {
    const fetcher = createSubmissionStore().fetcher("inbox");
    const first = gate();
    const second = gate();
    const queue = [first, second];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => queue.shift()?.promise),
    );
    const one = fetcher.load("/a");
    const two = fetcher.load("/b");
    second.resolve(page("second"));
    await two;
    expect(fetcher.data()).toEqual([match("inbox", "second")]);
    expect(fetcher.state()).toBe("idle");
    first.resolve(page("first"));
    await one;
    expect(fetcher.data()).toEqual([match("inbox", "second")]);
    expect(fetcher.state()).toBe("idle");
  });

  it("[LOAD-06] the first answer arriving before the second leaves the fetcher loading, without data", async () => {
    const fetcher = createSubmissionStore().fetcher("inbox");
    const first = gate();
    const second = gate();
    const queue = [first, second];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => queue.shift()?.promise),
    );
    const one = fetcher.load("/a");
    const two = fetcher.load("/b");
    first.resolve(page("first"));
    await one;
    expect(fetcher.state()).toBe("loading");
    expect(fetcher.data()).toBeUndefined();
    second.resolve(page("second"));
    await two;
    expect(fetcher.state()).toBe("idle");
    expect(fetcher.data()).toEqual([match("inbox", "second")]);
  });

  it("[LOAD-07] a superseded load that fails does not set an error on the newer one", async () => {
    const fetcher = createSubmissionStore().fetcher("inbox");
    const first = gate();
    const second = gate();
    const queue = [first, second];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => queue.shift()?.promise),
    );
    const one = fetcher.load("/a");
    const two = fetcher.load("/b");
    first.resolve(new Response("down", { status: 500 }));
    await one;
    expect(fetcher.error()).toBeUndefined();
    second.resolve(page("ok"));
    await two;
    expect(fetcher.error()).toBeUndefined();
    expect(fetcher.data()).toEqual([match("inbox", "ok")]);
  });

  it("[LOAD-08] a submit supersedes a load in flight: the load answer is dropped and the state is the submit's", async () => {
    const fetcher = createSubmissionStore().fetcher("inbox");
    const loading = gate();
    const saving = gate();
    const queue = [loading, saving];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => queue.shift()?.promise),
    );
    const load = fetcher.load("/a");
    const data = new FormData();
    data.set("title", "x");
    const submit = fetcher.submit(save, data);
    expect(fetcher.state()).toBe("submitting");
    loading.resolve(page("stale"));
    await load;
    expect(fetcher.data()).toBeUndefined();
    expect(fetcher.state()).toBe("submitting");
    saving.resolve(
      new Response(serialize({ ok: true, value: { saved: "x" } }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    await submit;
    expect(fetcher.data()).toEqual({ saved: "x" });
    expect(fetcher.state()).toBe("idle");
  });

  it("[LOAD-09] a fetcher evicted while a load is in flight settles on its own object, and the key starts again empty", async () => {
    const store = createSubmissionStore();
    const old = store.fetcher("k0");
    const pending = gate();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending.promise),
    );
    const load = old.load("/a");
    for (let n = 1; n <= 100; n += 1) store.fetcher(`k${n}`);
    const fresh = store.fetcher("k0");
    expect(fresh).not.toBe(old);
    pending.resolve(page("late"));
    await expect(load).resolves.toBeUndefined();
    expect(old.state()).toBe("idle");
    expect(old.data()).toEqual([match("inbox", "late")]);
    expect(fresh.state()).toBe("idle");
    expect(fresh.data()).toBeUndefined();
  });

  it("[LOAD-10] fetchers of different keys load independently", async () => {
    const store = createSubmissionStore();
    const a = gate();
    const b = gate();
    const queue = [a, b];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => queue.shift()?.promise),
    );
    const one = store.fetcher("a").load("/a");
    const two = store.fetcher("b").load("/b");
    b.resolve(page("b"));
    await two;
    expect(store.fetcher("b").data()).toEqual([match("inbox", "b")]);
    expect(store.fetcher("a").state()).toBe("loading");
    a.resolve(page("a"));
    await one;
    expect(store.fetcher("a").data()).toEqual([match("inbox", "a")]);
  });
});
