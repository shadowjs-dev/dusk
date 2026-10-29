import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateIslands } from "../src/client/islands";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("islands: the idle strategy", () => {
  it("[DUSK-REST-REV-3] dispose cancels an idle callback with cancelIdleCallback, never clearTimeout (a different id space)", () => {
    document.body.innerHTML = `<div data-island="a" data-client="idle">a</div>`;
    const request = vi.fn((_callback: () => void) => 41);
    const cancel = vi.fn();
    const clear = vi.fn();
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", cancel);
    vi.stubGlobal("clearTimeout", clear);
    const handle = hydrateIslands({
      registry: { a: async () => () => document.createTextNode("a") },
    });
    handle.dispose();
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(41);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("form enhancement: the submit button", () => {
  it("[DUSK-REST-REV-4] the button that submitted the form contributes its name and value, as in a plain browser submit", async () => {
    const { enhanceForm } = await import("../src/client/form");
    const { createSubmissionStore } = await import("../src/client/submissions");
    const { serialize } = await import("@shadow-js/web/server");
    const fetchMock = vi.fn(
      async () => new Response(serialize({ ok: true, value: 1 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    document.body.innerHTML = `<form><input name="id" value="7"><button type="submit" name="intent" value="delete">Delete</button></form>`;
    const form = document.querySelector("form") as HTMLFormElement;
    const button = form.querySelector("button") as HTMLButtonElement;
    const save = {
      id: "save",
      url: "/_dusk/fn/save",
    };
    const { serverFnStub } = await import("../src/client/fn");
    const stub = serverFnStub("save", { method: "POST", form: true, base: "", batch: false });
    const store = createSubmissionStore();
    const stop = enhanceForm(form, { fn: stub, store });
    form.dispatchEvent(
      new SubmitEvent("submit", { cancelable: true, bubbles: true, submitter: button }),
    );
    await store.latest(save.id)?.done;
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = init.body as FormData;
    expect(body.get("id")).toBe("7");
    expect(body.get("intent")).toBe("delete");
    stop();
  });
});
