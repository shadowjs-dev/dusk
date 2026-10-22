import { createComponent as createServerComponent, renderToString } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateIslands, type IslandsHandle } from "../../src/client/islands";
import { load } from "../client/support/compile";
import { loadComponent } from "./support/compile";

/**
 * `<Island>`: the server writes the children inside the island's element; the browser's registry takes it over
 * (`client:load` at once, the other directives when their strategy fires). `client:only` has no server content.
 */
type Module = { Island: (props: Record<string, unknown>) => unknown };

let handle: IslandsHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
  document.body.innerHTML = "";
});

function markup(mod: Module, props: Record<string, unknown>): string {
  return renderToString(() => createServerComponent(mod.Island as never, props));
}

describe("<Island> markup", () => {
  it("[CISL-20] the server renders the children inside the island element, with its directive", async () => {
    const mod = await loadComponent<Module>("ssr", "island");
    const html = markup(mod, {
      id: "chart",
      "client:load": true,
      props: { title: "Sales" },
      children: "server chart",
    });
    expect(html).toContain('data-island="chart"');
    expect(html).toContain('data-client="load"');
    expect(html).toContain("server chart");
    expect(html).toContain("data-props=");
    const visible = markup(mod, { id: "map", children: "map" });
    expect(visible).toContain('data-client="visible"');
    const media = markup(mod, { id: "nav", "client:media": "(min-width: 800px)", children: "nav" });
    expect(media).toContain('data-media="(min-width: 800px)"');
    expect(media).toContain('data-client="media"');
  });

  it("[CISL-21] client:only renders the fallback on the server, never the children", async () => {
    const mod = await loadComponent<Module>("ssr", "island");
    const html = markup(mod, {
      id: "editor",
      "client:only": true,
      fallback: "loading editor",
      children: "never",
    });
    expect(html).toContain("loading editor");
    expect(html).not.toContain("never");
    expect(html).toContain('data-client="only"');
  });

  it("[CISL-22] two directives, a media directive with no query, and props that are not plain data are refused", async () => {
    const mod = await loadComponent<Module>("ssr", "island");
    expect(() => markup(mod, { id: "x", "client:load": true, "client:idle": true })).toThrow(
      /set together/,
    );
    expect(() => markup(mod, { id: "x", "client:media": "  " })).toThrow(/needs a media query/);
    expect(() => markup(mod, { id: "x", props: { onClick: () => 1 } })).toThrow(/only plain data/);
  });
});

describe("<Island> in the browser", () => {
  it("[CISL-23] a client:load island is hydrated in place: the server's element is the one that stays", async () => {
    const serverMod = await loadComponent<Module>("ssr", "island");
    const html = markup(serverMod, {
      id: "greeting",
      "client:load": true,
      props: { name: "Ada" },
      children: "server text",
    });
    document.body.innerHTML = html;
    // The server wrote a hydration marker before the text; the text node is the element that must survive.
    const textOf = (): ChildNode | undefined =>
      [...(document.querySelector('[data-island="greeting"]')?.childNodes ?? [])].find(
        (node) => node.nodeType === Node.TEXT_NODE,
      );
    const serverText = textOf();
    expect(serverText?.textContent).toBe("server text");

    // The component returns the text the server wrote, so hydration claims that text node instead of replacing it.
    const component = await load<{ Greeting: (props: Record<string, unknown>) => unknown }>(
      `export function Greeting(props) { return "server text"; }`,
      "dom",
    );
    const loads = vi.fn(async () => ({ default: component.Greeting }));
    handle = hydrateIslands({ registry: { greeting: loads } });
    await vi.waitFor(() => expect(handle?.hydrated).toBe(1));
    expect(loads).toHaveBeenCalledTimes(1);
    expect(textOf()).toBe(serverText);
  });

  it("[CISL-24] client:only mounts the component in the browser, replacing the fallback", async () => {
    const serverMod = await loadComponent<Module>("ssr", "island");
    document.body.innerHTML = markup(serverMod, {
      id: "editor",
      "client:only": true,
      fallback: "loading",
    });
    const component = (): unknown => {
      const host = document.createElement("p");
      host.textContent = "editor ready";
      return host;
    };
    handle = hydrateIslands({ registry: { editor: async () => ({ default: component }) } });
    await vi.waitFor(() => expect(document.body.textContent).toContain("editor ready"));
    expect(document.body.textContent).not.toContain("loading");
  });
});
