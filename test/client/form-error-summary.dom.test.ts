import { serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnStub } from "../../src/client/fn";
import { enhanceForm } from "../../src/client/form";
import { createSubmissionStore } from "../../src/client/submissions";
import { fail } from "../../src/shared/action";

/** Where focus goes after a failed enhanced submit: the form's error summary, else the first field with a problem. */

const save = serverFnStub<{ title: string }, { saved: string }>("saveSummary", {
  method: "POST",
  form: true,
  base: "",
  batch: false,
});

function answer(body: unknown, status = 200): Response {
  return new Response(serialize(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function failed(): Response {
  return answer({
    ok: true,
    value: fail(422, { issues: [{ message: "Required", path: ["title"] }] }),
  });
}

let form: HTMLFormElement | undefined;
afterEach(() => {
  form?.remove();
  form = undefined;
  vi.unstubAllGlobals();
});

function mount(html: string): HTMLFormElement {
  const element = document.createElement("form");
  element.setAttribute("action", save.url);
  element.innerHTML = html;
  document.body.append(element);
  form = element;
  return element;
}

/** Submits the form and waits for the call to settle. */
async function submit(
  element: HTMLFormElement,
  options: { readonly focusOnError?: boolean } = {},
): Promise<void> {
  const store = createSubmissionStore();
  const stop = enhanceForm(element, { fn: save, store, ...options });
  element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await store.latest(save.id)?.done;
  await Promise.resolve();
  stop();
}

describe("the error summary of a form", () => {
  it("[FORM-SUM-01] a failed result moves focus to [data-dusk-form-errors], not to the field, and still marks the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failed()),
    );
    const element = mount(
      '<div data-dusk-form-errors tabindex="-1">Fix the title</div><input name="title">',
    );
    await submit(element);
    expect(document.activeElement).toBe(element.querySelector("[data-dusk-form-errors]"));
    expect(element.querySelector('[name="title"]')?.getAttribute("aria-invalid")).toBe("true");
  });

  it("[FORM-SUM-02] a summary that cannot take focus by itself is made focusable (tabindex -1), and an author's tabindex is kept", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failed()),
    );
    const plain = mount('<div data-dusk-form-errors>Fix the title</div><input name="title">');
    await submit(plain);
    const summary = plain.querySelector("[data-dusk-form-errors]");
    // A browser ignores focus() on a div without tabindex: the attribute is what makes the move work.
    expect(summary?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(summary);
    plain.remove();
    const own = mount(
      '<div data-dusk-form-errors tabindex="0">Fix the title</div><input name="title">',
    );
    await submit(own);
    expect(own.querySelector("[data-dusk-form-errors]")?.getAttribute("tabindex")).toBe("0");
  });

  it("[FORM-SUM-03] a thrown error that carries issues also moves focus to the summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer(
          {
            ok: false,
            error: {
              name: "HttpError",
              message: "Invalid",
              status: 422,
              data: { issues: [{ message: "Required", path: ["title"] }] },
            },
          },
          422,
        ),
      ),
    );
    const element = mount(
      '<div data-dusk-form-errors tabindex="-1">Fix the title</div><input name="title">',
    );
    await submit(element);
    expect(document.activeElement).toBe(element.querySelector("[data-dusk-form-errors]"));
    expect(element.querySelector('[name="title"]')?.getAttribute("aria-invalid")).toBe("true");
  });

  it("[FORM-SUM-04] without a summary the first field with a problem takes focus", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failed()),
    );
    const element = mount('<input name="other"><input name="title">');
    await submit(element);
    expect(document.activeElement).toBe(element.querySelector('[name="title"]'));
  });

  it("[FORM-SUM-05] focusOnError: false leaves focus where it was, summary or not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failed()),
    );
    const element = mount(
      '<input name="other"><div data-dusk-form-errors tabindex="-1">Fix</div><input name="title">',
    );
    element.querySelector<HTMLInputElement>('[name="other"]')?.focus();
    await submit(element, { focusOnError: false });
    expect(document.activeElement).toBe(element.querySelector('[name="other"]'));
  });

  it("[FORM-SUM-06] a failure without issues leaves focus alone, and a later success clears the marks", async () => {
    const element = mount(
      '<input name="other"><div data-dusk-form-errors tabindex="-1">Fix</div><input name="title">',
    );
    const store = createSubmissionStore();
    const stop = enhanceForm(element, { fn: save, store });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => failed()),
    );
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await store.latest(save.id)?.done;
    await Promise.resolve();
    expect(element.querySelector('[name="title"]')?.getAttribute("aria-invalid")).toBe("true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ ok: true, value: { saved: "ok" } })),
    );
    element.querySelector<HTMLInputElement>('[name="other"]')?.focus();
    element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await store.latest(save.id)?.done;
    await Promise.resolve();
    expect(element.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(document.activeElement).toBe(element.querySelector('[name="other"]'));
    stop();
  });
});
