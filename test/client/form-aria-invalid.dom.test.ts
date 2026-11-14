import { serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFnStub } from "../../src/client/fn";
import { enhanceForm } from "../../src/client/form";
import { createSubmissionStore } from "../../src/client/submissions";
import { fail } from "../../src/shared/action";

/*
 * A form marks the fields of a `fail()` result with `aria-invalid="true"` and removes only what it marked: the attribute
 * an application sets on its own fields (a reactive binding of its own validation) is the application's.
 */

const save = serverFnStub<{ title: string }, { saved: string }>("saveInvalid", {
  method: "POST",
  form: true,
  base: "",
  batch: false,
});

function answer(body: unknown): Response {
  return new Response(serialize(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const failing =
  (...names: string[]) =>
  async () =>
    answer({
      ok: true,
      value: fail(422, { issues: names.map((name) => ({ message: "Required", path: [name] })) }),
    });
const succeeding = async () => answer({ ok: true, value: { saved: "ok" } });

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

function rig(element: HTMLFormElement) {
  const store = createSubmissionStore();
  const stop = enhanceForm(element, { fn: save, store, focusOnError: false });
  return {
    async submit(response: () => Promise<Response>): Promise<void> {
      vi.stubGlobal("fetch", vi.fn(response));
      element.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await store.latest(save.id)?.done;
      await Promise.resolve();
    },
    stop,
  };
}

const field = (element: HTMLFormElement, name: string): Element | null =>
  element.querySelector(`[name="${name}"]`);
const invalid = (element: HTMLFormElement, name: string): string | null =>
  field(element, name)?.getAttribute("aria-invalid") ?? null;

describe("the form's aria-invalid marks", () => {
  it("[FORM-AI-1] a successful submission leaves the aria-invalid the application set on a field", async () => {
    const element = mount('<input name="title"><input name="code" aria-invalid="true">');
    const { submit, stop } = rig(element);
    await submit(succeeding);
    expect(invalid(element, "code")).toBe("true");
    stop();
  });

  it("[FORM-AI-2] a later success removes the marks the form made and keeps the application's", async () => {
    const element = mount('<input name="title"><input name="code" aria-invalid="true">');
    const { submit, stop } = rig(element);
    await submit(failing("title"));
    expect(invalid(element, "title")).toBe("true");
    expect(invalid(element, "code")).toBe("true");
    await submit(succeeding);
    expect(invalid(element, "title")).toBeNull();
    expect(invalid(element, "code")).toBe("true");
    stop();
  });

  it("[FORM-AI-3] a field the application already marked stays marked after the form marks it and then clears", async () => {
    const element = mount('<input name="title" aria-invalid="true">');
    const { submit, stop } = rig(element);
    await submit(failing("title"));
    await submit(succeeding);
    expect(invalid(element, "title")).toBe("true");
    stop();
  });

  it('[FORM-AI-4] a field the application set to "false" gets it back when the form clears its mark', async () => {
    const element = mount('<input name="title" aria-invalid="false">');
    const { submit, stop } = rig(element);
    await submit(failing("title"));
    expect(invalid(element, "title")).toBe("true");
    await submit(succeeding);
    expect(invalid(element, "title")).toBe("false");
    stop();
  });

  it("[FORM-AI-5] a second failure moves the marks to the new fields and leaves the application's alone", async () => {
    const element = mount(
      '<input name="title"><input name="body"><input name="code" aria-invalid="true">',
    );
    const { submit, stop } = rig(element);
    await submit(failing("title"));
    await submit(failing("body"));
    expect(invalid(element, "title")).toBeNull();
    expect(invalid(element, "body")).toBe("true");
    expect(invalid(element, "code")).toBe("true");
    stop();
  });

  it("[FORM-AI-6] an attribute the application wrote after the form marked the field is not removed by a later success", async () => {
    const element = mount('<input name="title">');
    const { submit, stop } = rig(element);
    await submit(failing("title"));
    // The application's own binding took over the attribute and now says "false".
    field(element, "title")?.setAttribute("aria-invalid", "false");
    await submit(succeeding);
    expect(invalid(element, "title")).toBe("false");
    stop();
  });

  it("[FORM-AI-7] a field removed from the form after it was marked does not keep the form's bookkeeping alive", async () => {
    const element = mount('<input name="title"><input name="body">');
    const { submit, stop } = rig(element);
    await submit(failing("title"));
    field(element, "title")?.remove();
    await submit(succeeding);
    expect(element.querySelector('[aria-invalid="true"]')).toBeNull();
    stop();
  });
});
