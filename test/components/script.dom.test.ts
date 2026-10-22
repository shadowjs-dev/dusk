import { flushSync } from "@shadow-js/core";
import { createComponent, render } from "@shadow-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadComponent } from "./support/compile";

/**
 * `<Script>` callbacks in the browser. The server markup is checked in script.server.test.ts (the server path).
 */
type Module = { Script: (props: Record<string, unknown>) => unknown };

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("<Script> in the browser", () => {
  it("[CSCR-5] the callbacks run once the script is available: onLoad then onReady", async () => {
    // A script the page already has counts as loaded: the callbacks run without a network request.
    // type="text/plain" keeps happy-dom from fetching it; the component only looks for the src attribute.
    const existing = document.createElement("script");
    existing.src = "/already.js";
    existing.type = "text/plain";
    document.head.append(existing);
    const mod = await loadComponent<Module>("dom", "script");
    const onLoad = vi.fn();
    const onReady = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    render(
      () => createComponent(mod.Script as never, { src: "/already.js", onLoad, onReady }),
      host,
    );
    flushSync();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(document.head.querySelectorAll('script[src="/already.js"]')).toHaveLength(1);
  });

  it("[CSCR-6] an inline script the page already has is not written again; onReady still runs", async () => {
    const existing = document.createElement("script");
    existing.id = "boot";
    existing.type = "text/plain";
    existing.textContent = "window.ran = (window.ran || 0) + 1";
    document.head.append(existing);
    const mod = await loadComponent<Module>("dom", "script");
    const onReady = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    render(
      () =>
        createComponent(mod.Script as never, { id: "boot", children: "window.ran = 99", onReady }),
      host,
    );
    flushSync();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll("#boot")).toHaveLength(1);
  });
});
