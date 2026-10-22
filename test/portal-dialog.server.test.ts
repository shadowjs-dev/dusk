import { describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { type AppModule, errorLog, manifestOf } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * A deep link to a task whose sheet is open at render time. The sheet is a `Portal` with a dialog
 * role, as the primitives' dialog is built: its markup is emitted at the end of the body, after the root,
 * and the board stays in the root.
 */
const SOURCE = `
import { Portal, Show } from "@shadow-js/web";
import { defineRoute, Outlet, useParams } from "@shadow-js/router";


function Sheet(props) {
  return (
    <Show when={props.open}>
      <Portal>
        <div class="sheet" role="dialog" aria-modal="true">
          <h2>{props.title}</h2>
          <p>{props.body}</p>
        </div>
      </Portal>
    </Show>
  );
}
function Board() {
  return <section class="board"><h1>Board</h1><Outlet /></section>;
}
function Task() {
  const params = useParams();
  return <Sheet open title={"Task " + params.task} body="Opened from a deep link" />;
}
function Home() {
  return <p class="home">home</p>;
}
const task = defineRoute("/t/:task", { id: "task", component: Task });
const home = defineRoute("/", { id: "home", component: Home });
const board = defineRoute("", { id: "board", component: Board, children: [home, task] });
export const routes = [board];
export function App(props) {
  return <main class="app">{props.children}</main>;
}
`;

/** Markup without hydration keys and region markers, which carry no meaning for these assertions. */
function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

async function handlerFor(mode: "stream" | "string"): Promise<{
  handler: DuskHandler;
  errors: ReturnType<typeof errorLog>;
}> {
  const app: AppModule = await load<AppModule>(SOURCE);
  const errors = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    mode,
    onError: errors.onError,
  });
  return { handler, errors };
}

describe("pages: a dialog open at render time", () => {
  for (const mode of ["stream", "string"] as const) {
    it(`[SRV-50 ${mode}] a deep link to an open dialog answers 200 with the dialog at the end of the body, not in the root`, async () => {
      const { handler, errors } = await handlerFor(mode);
      const response = await handler.fetch(new Request("http://localhost/t/17"));
      expect(response.status).toBe(200);
      const html = plain(await response.text());
      const root = /<div id="app">([\s\S]*?)<\/div><!--portal:/.exec(html)?.[1];
      expect(root).toContain('<section class="board"><h1>Board</h1>');
      expect(root).not.toContain('role="dialog"');
      expect(html).toMatch(
        /<!--portal:[^>]*--><div class="sheet" role="dialog" aria-modal="true"><h2>Task 17<\/h2><p>Opened from a deep link<\/p><\/div><!--\/portal:[^>]*--><\/body><\/html>$/,
      );
      expect(errors.errors).toHaveLength(0);
    });
  }

  it("[SRV-51] a page with no open dialog has no portal markup in its document", async () => {
    const { handler } = await handlerFor("string");
    const html = plain(await (await handler.fetch(new Request("http://localhost/"))).text());
    expect(html).not.toContain("portal:");
    expect(html.endsWith('<p class="home">home</p></section></main></div></body></html>')).toBe(
      true,
    );
  });
});
