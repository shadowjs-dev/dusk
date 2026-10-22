import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateIslands, type IslandRegistry, type IslandsHandle } from "../../src/client/islands";

/**
 * Islands in the browser: the server's markup is the page until a strategy fires; then the island's own
 * module is loaded (one chunk per island) and mounted in place. A nested island belongs to its outer island.
 */

let handle: IslandsHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  document.body.innerHTML = "";
});

/** Markup as the server writes it: the static content, plus the island attributes. */
function page(html: string): void {
  document.body.innerHTML = html;
}

async function settle(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 2000, interval: 2 });
}

describe("islands in the browser", () => {
  it("[ISL-10] an interaction island mounts its component on the first interaction, loading its module once", async () => {
    page(
      `<div id="chart" data-island="chart" data-client="interaction" data-props='{"title":"Sales"}'>server chart</div>`,
    );
    const loads = vi.fn(async () => ({
      default: (props: Readonly<Record<string, unknown>>) =>
        document.createTextNode(`client ${String(props["title"])}`),
    }));
    handle = hydrateIslands({ registry: { chart: loads } });
    const element = document.getElementById("chart");
    expect(element?.textContent).toBe("server chart");
    element?.dispatchEvent(new Event("pointerdown"));
    element?.dispatchEvent(new Event("pointerdown"));
    await settle(() => expect(element?.textContent).toBe("client Sales"));
    expect(loads).toHaveBeenCalledTimes(1);
    expect(handle.hydrated).toBe(1);
  });

  it("[ISL-11] an island inside another island is left to its outer island: its loader is not called", async () => {
    page(
      `<section data-island="outer" data-client="idle"><div data-island="inner" data-client="idle">inner server</div></section>`,
    );
    const inner = vi.fn(async () => () => document.createTextNode("inner client"));
    const outer = vi.fn(async () => () => document.createTextNode("outer client"));
    handle = hydrateIslands({ registry: { outer, inner } });
    await settle(() => expect(handle?.hydrated).toBe(1));
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it("[ISL-12] an id that is not in the registry is reported, and the server's markup stays as it is", async () => {
    page(`<div id="ghost" data-island="ghost" data-client="idle">still here</div>`);
    const errors: unknown[] = [];
    handle = hydrateIslands({ registry: {}, onError: (error) => void errors.push(error) });
    await settle(() => expect(errors).toHaveLength(1));
    expect(String((errors[0] as Error).message)).toContain('island "ghost" is not in the registry');
    expect(document.getElementById("ghost")?.textContent).toBe("still here");
    expect(handle.hydrated).toBe(0);
  });

  it("[ISL-13] props that are not a JSON object are reported and that island does not mount; the others do", async () => {
    page(
      `<div id="broken" data-island="a" data-client="idle" data-props="{not json"></div><div id="fine" data-island="b" data-client="idle">b</div>`,
    );
    const errors: unknown[] = [];
    const b = vi.fn(async () => () => document.createTextNode("b client"));
    handle = hydrateIslands({
      registry: { a: async () => () => document.createTextNode("a"), b },
      onError: (error) => void errors.push(error),
    });
    await settle(() => expect(document.getElementById("fine")?.textContent).toBe("b client"));
    expect(
      errors.some(
        (error) => error instanceof Error && error.message.includes("props of an island"),
      ),
    ).toBe(true);
    expect(document.getElementById("broken")?.textContent).toBe("");
  });

  it("[ISL-14] dispose stops the islands that have not started: a later interaction loads nothing", async () => {
    page(`<div id="late" data-island="late" data-client="interaction">server</div>`);
    const load = vi.fn(async () => () => document.createTextNode("late client"));
    handle = hydrateIslands({ registry: { late: load } });
    handle.dispose();
    document.getElementById("late")?.dispatchEvent(new Event("pointerdown"));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(load).not.toHaveBeenCalled();
    expect(document.getElementById("late")?.textContent).toBe("server");
  });

  it("[ISL-15] a module without a component is reported; the server markup is kept", async () => {
    page(`<div id="empty" data-island="empty" data-client="idle">server</div>`);
    const errors: unknown[] = [];
    const registry: IslandRegistry = { empty: async () => ({ default: undefined as never }) };
    handle = hydrateIslands({ registry, onError: (error) => void errors.push(error) });
    await settle(() => expect(errors).toHaveLength(1));
    expect(document.getElementById("empty")?.textContent).toBe("server");
  });
});
