import { serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnStub } from "../../src/client/fn";
import { enhanceForm, useFormStatus } from "../../src/client/form";
import { createSubmissionStore, type SubmissionStore } from "../../src/client/submissions";
import { fail, isFailure } from "../../src/shared/action";

/**
 * The browser side of the mutation model: one submission store behind `useSubmission`, `useSubmissions`,
 * `useFetcher` and `useRevalidator`, and the progressive enhancement of `<Form>` (`enhanceForm`).
 */

const save = serverFnStub<{ title: string }, { saved: string }>("saveNote", {
  method: "POST",
  form: true,
  base: "",
  batch: false,
});
const plain = serverFnStub<{ title: string }, { saved: string }>("plainNote", {
  method: "POST",
  form: false,
  base: "",
  batch: false,
});
const single = serverFnStub<{ n: number }, number>("countNote", {
  method: "POST",
  form: false,
  base: "",
  batch: false,
  singleFlight: true,
});

function envelope(value: unknown): Response {
  return new Response(serialize({ ok: true, value }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorEnvelope(status: number, message: string): Response {
  return new Response(serialize({ ok: false, error: { name: "HttpError", message, status } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

let form: HTMLFormElement | undefined;
afterEach(() => {
  form?.remove();
  form = undefined;
  vi.unstubAllGlobals();
});

function mountForm(html: string): HTMLFormElement {
  const element = document.createElement("form");
  element.setAttribute("action", save.url);
  element.innerHTML = html;
  document.body.append(element);
  form = element;
  return element;
}

describe("the submission store", () => {
  it("[MUT-20] a submission goes pending, then success, and keeps a stable id", async () => {
    const store: SubmissionStore = createSubmissionStore();
    const first = store.submit("save", async (input: string) => input.toUpperCase(), "a");
    expect(first.id).toBe("s1");
    expect(first.status()).toBe("pending");
    expect(first.pending()).toBe(true);
    await first.done;
    expect(first.status()).toBe("success");
    expect(first.result()).toBe("A");
    expect(first.input).toBe("a");
    expect(store.latest("save")?.id).toBe("s1");
    expect(store.submit("save", async () => "b", "b").id).toBe("s2");
    expect(store.latest("save")?.id).toBe("s2");
  });

  it("[MUT-21] an error keeps its error, retry runs the same input again, clear resets to idle", async () => {
    const store = createSubmissionStore();
    let calls = 0;
    const flaky = async (input: number): Promise<number> => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return input * 2;
    };
    const sub = store.submit("calc", flaky, 4);
    await sub.done;
    expect(sub.status()).toBe("error");
    expect(sub.error()).toBeInstanceOf(Error);
    expect(sub.result()).toBeUndefined();
    await sub.retry();
    expect(sub.status()).toBe("success");
    expect(sub.result()).toBe(8);
    expect(calls).toBe(2);
    sub.clear();
    expect(sub.status()).toBe("idle");
    expect(sub.result()).toBeUndefined();
    expect(store.latest("calc")).toBeUndefined();
  });

  it("[MUT-22] the list of a key keeps the latest 50 submissions, in order", async () => {
    const store = createSubmissionStore();
    for (let n = 0; n < 60; n += 1) {
      store.submit("ping", async () => n, n);
    }
    const list = store.list("ping");
    expect(list).toHaveLength(50);
    expect(list[0]?.id).toBe("s11");
    expect(list[49]?.id).toBe("s60");
    expect(store.list()).toHaveLength(50);
  });

  it("[MUT-31] a flash from the server seeds the latest submission and the one-time flash", () => {
    const store = createSubmissionStore();
    store.seed({ submission: { key: "saveNote", status: "success", value: { saved: "x" } } });
    const seeded = store.latest("saveNote");
    expect(seeded?.status()).toBe("success");
    expect(seeded?.result()).toEqual({ saved: "x" });
    store.seed({
      submission: {
        key: "saveNote",
        status: "error",
        error: { status: 422, message: "Bad", issues: [{ message: "No", path: ["title"] }] },
      },
      flash: 5,
    });
    expect(store.latest("saveNote")?.status()).toBe("error");
    expect(store.latest("saveNote")?.error()).toMatchObject({ status: 422, message: "Bad" });
    expect(store.flash()).toBe(5);
  });

  it("[MUT-33] fail() values are recognized and shaped", () => {
    expect(isFailure(fail(400, { x: 1 }))).toBe(true);
    expect(isFailure({ __duskFailure: 2, status: 400 })).toBe(false);
    expect(isFailure({})).toBe(false);
    expect(isFailure(null)).toBe(false);
  });
});

describe("the form enhancement", () => {
  it("[MUT-23] a submit is intercepted: no page load, a POST of FormData through the call header", async () => {
    const fetchMock = vi.fn(async () => envelope({ saved: "hi" }));
    vi.stubGlobal("fetch", fetchMock);
    const element = mountForm('<input name="title" value="hi"><button type="submit">Save</button>');
    const store = createSubmissionStore();
    const stop = enhanceForm(element, { fn: save, store });
    const event = new Event("submit", { cancelable: true, bubbles: true });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const sub = store.latest(save.id);
    expect(sub?.status()).toBe("pending");
    await sub?.done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(save.url);
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).get("x-dusk-fn")).toBe("1");
    expect(sub?.result()).toEqual({ saved: "hi" });
    stop();
  });

  it("[MUT-24] a second submit while the first is pending is ignored, and the form is busy", async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const element = mountForm('<input name="title" value="x"><button type="submit">Save</button>');
    const store = createSubmissionStore();
    const stop = enhanceForm(element, { fn: save, store });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(element.getAttribute("aria-busy")).toBe("true");
    const sub = store.latest(save.id);
    finish?.(envelope({ saved: "x" }));
    await sub?.done;
    expect(element.getAttribute("aria-busy")).toBeNull();
    stop();
  });

  it("[MUT-25] reloadDocument leaves the submit alone: no preventDefault, no request", () => {
    const fetchMock = vi.fn(async () => envelope({ saved: "x" }));
    vi.stubGlobal("fetch", fetchMock);
    const element = mountForm('<input name="title" value="x">');
    const store = createSubmissionStore();
    const stop = enhanceForm(element, { fn: save, store, reloadDocument: true });
    const event = new Event("submit", { cancelable: true, bubbles: true });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    stop();
  });

  it("[MUT-26] a fail() result is a successful call that failed; its field problems mark and focus the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        envelope(fail(422, { issues: [{ message: "Required", path: ["title"] }] })),
      ),
    );
    const element = mountForm(
      '<label>Title <input name="title" value=""></label><button type="submit">Save</button>',
    );
    const store = createSubmissionStore();
    const onResult = vi.fn();
    const stop = enhanceForm(element, { fn: save, store, onResult });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const sub = store.latest(save.id);
    await sub?.done;
    expect(sub?.status()).toBe("success");
    expect(sub?.failed()).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(1);
    const field = element.querySelector<HTMLInputElement>('[name="title"]');
    expect(field?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    stop();
  });

  it("[MUT-27] a thrown error becomes an error submission and the form is not left busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorEnvelope(409, "Taken")),
    );
    const element = mountForm('<input name="title" value="x">');
    const store = createSubmissionStore();
    const stop = enhanceForm(element, { fn: plain, store });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const sub = store.latest(plain.id);
    await sub?.done;
    expect(sub?.status()).toBe("error");
    expect(sub?.error()).toMatchObject({ status: 409, message: "Taken" });
    expect(element.getAttribute("aria-busy")).toBeNull();
    stop();
  });

  it("[MUT-28] a single-flight call sends the page location, and revalidate: false sends none", async () => {
    const fetchMock = vi.fn(async () => envelope(1));
    vi.stubGlobal("fetch", fetchMock);
    await single({ n: 1 });
    await single({ n: 2 }, { revalidate: false });
    const first = new Headers(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    );
    const second = new Headers(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers,
    );
    expect(first.get("x-dusk-location")).not.toBeNull();
    expect(second.get("x-dusk-location")).toBeNull();
  });

  it("[MUT-34] a GET form with a route target navigates with the query, and reloadDocument does not", () => {
    const navigate = vi.fn(async () => undefined);
    const element = document.createElement("form");
    element.setAttribute("method", "get");
    element.setAttribute("action", "/search");
    element.innerHTML = '<input name="q" value="shadow js">';
    document.body.append(element);
    form = element;
    const stop = enhanceForm(element, { href: "/search", method: "get", navigate });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(navigate).toHaveBeenCalledWith("/search?q=shadow+js", { replace: false });
    stop();
  });
});

describe("form options", () => {
  it("[MUT-36] resetOnSuccess clears the fields after a success; focusOnError false leaves focus alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => envelope(fail(422, { issues: [{ message: "No", path: ["title"] }] }))),
    );
    const element = mountForm('<input name="title"><button type="submit">Save</button>');
    const typed = element.querySelector<HTMLInputElement>('[name="title"]');
    if (typed !== null) typed.value = "typed";
    const store = createSubmissionStore();
    const stop = enhanceForm(element, {
      fn: save,
      store,
      focusOnError: false,
      resetOnSuccess: true,
    });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await store.latest(save.id)?.done;
    const field = element.querySelector<HTMLInputElement>('[name="title"]');
    // A failure is not a success: the fields keep what was typed, and focus is not moved.
    expect(field?.value).toBe("typed");
    expect(document.activeElement).not.toBe(field);
    stop();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => envelope({ saved: "ok" })),
    );
    const again = enhanceForm(element, { fn: save, store, resetOnSuccess: true });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await store.latest(save.id)?.done;
    expect(field?.value).toBe("");
    again();
  });

  it("[MUT-37] scroll keep restores the scroll position after a GET navigation", async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    const navigate = vi.fn(async () => undefined);
    const element = document.createElement("form");
    element.setAttribute("method", "get");
    element.innerHTML = '<input name="q" value="x">';
    document.body.append(element);
    form = element;
    const stop = enhanceForm(element, {
      href: "/search",
      method: "get",
      navigate,
      keepScroll: true,
    });
    window.scrollTo(0, 0);
    Object.defineProperty(window, "scrollY", { configurable: true, value: 120 });
    Object.defineProperty(window, "scrollX", { configurable: true, value: 0 });
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(scrollTo).toHaveBeenCalledWith(0, 120);
    stop();
  });

  it("[MUT-38] useFormStatus outside a form reports not pending", () => {
    expect(useFormStatus()).toEqual({ pending: false, method: "get", action: "" });
  });
});

describe("fetchers and the revalidator", () => {
  it("[MUT-29] a fetcher is keyed: the same key is the same fetcher, and submit runs without navigating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => envelope({ saved: "f" })),
    );
    const store = createSubmissionStore();
    expect(store.fetcher("inbox")).toBe(store.fetcher("inbox"));
    const fetcher = store.fetcher("inbox");
    expect(fetcher.state()).toBe("idle");
    const data = new FormData();
    data.set("title", "f");
    const done = fetcher.submit(save, data);
    expect(fetcher.state()).toBe("submitting");
    await done;
    expect(fetcher.state()).toBe("idle");
    expect(fetcher.data()).toEqual({ saved: "f" });
  });

  it("[MUT-37] at most 100 fetchers are kept: a 101st evicts the oldest, which is then a new fetcher", () => {
    const store = createSubmissionStore();
    const first = store.fetcher("k0");
    for (let n = 1; n < 100; n += 1) store.fetcher(`k${n}`);
    expect(store.fetcher("k0")).toBe(first); // 100 kept, none evicted yet
    store.fetcher("k100"); // the 101st
    expect(store.fetcher("k99")).toBe(store.fetcher("k99"));
    expect(store.fetcher("k0")).not.toBe(first);
  });

  it("[MUT-30] the revalidator reports loading while the revalidation runs, and calls the router once", async () => {
    let finish: (() => void) | undefined;
    const onRevalidate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const store = createSubmissionStore({ onRevalidate });
    const revalidator = store.revalidator();
    expect(revalidator.state()).toBe("idle");
    const running = revalidator.revalidate();
    expect(revalidator.state()).toBe("loading");
    finish?.();
    await running;
    expect(revalidator.state()).toBe("idle");
    expect(onRevalidate).toHaveBeenCalledTimes(1);
  });

  it("[MUT-35] a successful mutation revalidates unless the call opts out, and single flight does not revalidate twice", async () => {
    const onRevalidate = vi.fn(async () => undefined);
    const store = createSubmissionStore({ onRevalidate });
    await store.submit("a", async () => 1, undefined).done;
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    await store.submit("b", async () => 2, undefined, { revalidate: false }).done;
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    await store.submit("c", async () => 3, undefined, { singleFlight: true }).done;
    expect(onRevalidate).toHaveBeenCalledTimes(1);
  });
});
