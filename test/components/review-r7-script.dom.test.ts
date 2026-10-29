import { flushSync } from "@shadow-js/core";
import { createComponent, render } from "@shadow-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { inlineScriptKey } from "../../src/shared/script";
import { loadComponent } from "./support/compile";

type Module = { Script: (props: Record<string, unknown>) => unknown };

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

/** The head as the server wrote it (see the server test for the markup), type="text/plain" so it does not run here. */
function serverScript(text: string): void {
  const element = document.createElement("script");
  element.type = "text/plain";
  element.setAttribute("data-dusk-script", inlineScriptKey(text));
  element.textContent = text;
  document.head.append(element);
}

async function mount(...scripts: readonly Record<string, unknown>[]): Promise<void> {
  const client = await loadComponent<Module>("dom", "script");
  const host = document.createElement("div");
  document.body.append(host);
  render(() => scripts.map((props) => createComponent(client.Script as never, props)), host);
  flushSync();
}

describe("<Script> inline code after hydration", () => {
  it("[DUSK-R7-8] an inline script with no id is adopted, not written a second time", async () => {
    serverScript("window.ran = (window.ran || 0) + 1");
    await mount({ children: "window.ran = (window.ran || 0) + 1" });
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it("[DUSK-R7-8] a script the server did not write is still run, and marked so a second mount adopts it", async () => {
    serverScript("window.a = 1");
    await mount({ children: "window.a = 1" }, { children: "window.b = 2" });
    expect(document.head.querySelectorAll("script")).toHaveLength(2);
    await mount({ children: "window.b = 2" });
    expect(document.head.querySelectorAll("script")).toHaveLength(2);
  });

  it("[DUSK-R7-8] a script with the same key but another text is not taken for the server's", async () => {
    const other = document.createElement("script");
    other.type = "text/plain";
    other.textContent = "window.a = 1";
    other.setAttribute("data-dusk-script", inlineScriptKey("window.c = 3"));
    document.head.append(other);
    await mount({ children: "window.c = 3" });
    expect(document.head.querySelectorAll("script")).toHaveLength(2);
  });

  it("[DUSK-R7-8] with an id the script is still found by its id", async () => {
    const existing = document.createElement("script");
    existing.id = "boot";
    existing.type = "text/plain";
    document.head.append(existing);
    await mount({ id: "boot", children: "window.ran = 1" });
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });
});
