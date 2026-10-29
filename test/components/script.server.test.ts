import { createComponent, renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../../src/server/index";
import { inlineScriptKey } from "../../src/shared/script";
import { errorLog, manifestOf } from "../support/app";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";
import { compiledComponents, loadComponent } from "./support/compile";

type Module = { Script: (props: Record<string, unknown>) => unknown };

function markup(mod: Module, props: Record<string, unknown>): string {
  return renderToString(() => createComponent(mod.Script as never, props));
}

describe("<Script> validation", () => {
  it("[CSCR-4] a script needs exactly one of src or children, a path or URL source, and a token nonce", async () => {
    const mod = await loadComponent<Module>("ssr", "script");
    expect(() => markup(mod, {})).toThrow(/exactly one of src/);
    expect(() => markup(mod, { src: "/a.js", children: "x" })).toThrow(/exactly one of src/);
    expect(() => markup(mod, { src: "javascript:alert(1)" })).toThrow(/must be a path/);
    expect(() => markup(mod, { src: "/a.js", nonce: "bad nonce" })).toThrow(
      /nonce must be a token/,
    );
  });
});

describe("<Script> markup on the server", () => {
  it("[CSCR-1] an afterInteractive script is async; a beforeInteractive one blocks parsing; both carry the nonce", async () => {
    const mod = await loadComponent<Module>("ssr", "script");
    const after = markup(mod, { src: "/analytics.js", nonce: "n0nce" });
    expect(after).toMatch(/<script[^>]* src="\/analytics\.js"/);
    expect(after).toMatch(/ async[ >=]/);
    expect(after).toContain('nonce="n0nce"');
    const before = markup(mod, { src: "/polyfill.js", strategy: "beforeInteractive" });
    expect(before).toContain('src="/polyfill.js"');
    expect(before).not.toContain("async");
  });

  it("[CSCR-2] a lazyOnload script is not in the server markup: the browser loads it after the load event", async () => {
    const mod = await loadComponent<Module>("ssr", "script");
    expect(markup(mod, { src: "/chat.js", strategy: "lazyOnload" })).toBe("");
  });

  it("[CSCR-3] inline code is written as a script; code that could end the element is refused", async () => {
    const mod = await loadComponent<Module>("ssr", "script");
    const html = markup(mod, { children: "window.ready = true;", id: "boot", nonce: "abc" });
    expect(html).toContain('id="boot"');
    expect(html).toContain("window.ready = true;");
    expect(html).toContain('nonce="abc"');
    expect(() => markup(mod, { children: "x</script><script>alert(1)" })).toThrow(
      /must not contain/,
    );
  });
});

/**
 * A script is written once per response: two `<Script>` components with one key produce one element. This
 * needs a request (the de-duplication is per response), so the handler renders the page.
 */
const SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { Script } from "${compiledComponents("ssr")}/index";


export const routes = [
  defineRoute("/", {
    id: "home",
    component: () => (
      <main>
        <Script src="/shared.js" />
        <Script src="/shared.js" />
        <Script id="widget" src="/widget-a.js" />
        <Script id="widget" src="/widget-b.js" />
        <p>page</p>
      </main>
    ),
  }),
];
export function App(props) { return <div class="app">{props.children}</div>; }
`;

describe("<Script> de-duplication on a page", () => {
  it("[CSCR-7] one script per key in a response: the same src, or the same id, is written once", async () => {
    const compiled = await load<{
      routes: DuskRuntimeManifest["routes"];
      App: DuskRuntimeManifest["App"];
    }>(SOURCE);
    const manifest = manifestOf({ routes: compiled.routes, App: compiled.App } as never, {
      apiRoutes: [],
      serverFns: {},
    });
    const log = errorLog();
    const handler = createHandler({
      features: allFeatures(),
      manifest,
      dev: true,
      onError: log.onError,
    });
    const html = await (await handler.fetch(new Request("http://localhost/"))).text();
    expect(html.match(/src="\/shared\.js"/g)).toHaveLength(1);
    expect(html.match(/src="\/widget-a\.js"/g)).toHaveLength(1);
    expect(html).not.toContain("/widget-b.js");
    expect(log.errors).toHaveLength(0);
  });
});

describe("<Script> inline code is marked for the browser", () => {
  it("[DUSK-R7-8] an inline script with no id carries the key of its text; one with an id carries its id only", async () => {
    const mod = await loadComponent<Module>("ssr", "script");
    const text = "window.ready = true;";
    const anonymous = markup(mod, { children: text });
    expect(anonymous).toContain(`data-dusk-script="${inlineScriptKey(text)}"`);
    expect(anonymous).toContain(text);
    expect(markup(mod, { children: text, id: "boot" })).not.toContain("data-dusk-script");
    expect(markup(mod, { src: "/a.js" })).not.toContain("data-dusk-script");
  });
});
