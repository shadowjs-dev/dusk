import { describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { type AppModule, errorLog, manifestOf } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * A layout with its own loader data (the viewer) above a child whose loader throws `notFound()`.
 * The layout must keep its data on the server, so its notFound component (or the layout itself)
 * renders with the data, and the answer is 404 and not a render error.
 */
const SOURCE = `
import { defineRoute, Outlet, useLoaderData, notFound } from "@shadow-js/router";


export function Shell() {
  const data = useLoaderData();
  return <div class="shell"><header class="viewer">{data()?.viewer}</header><Outlet /></div>;
}
const task = defineRoute("/t/:task", {
  id: "task",
  loader: ({ params }) => {
    if (params.task === "nope") throw notFound();
    return { number: params.task };
  },
  component: function Task() {
    const data = useLoaderData();
    return <p class="task">{data()?.number}</p>;
  },
});
const board = defineRoute("/w/:workspace/p/:project", {
  id: "board",
  loader: ({ params }) => {
    if (params.project === "nope") throw notFound();
    return { name: params.project };
  },
  component: function Board() {
    const data = useLoaderData();
    return <section class="board"><h2 class="board-name">{data()?.name}</h2><Outlet /></section>;
  },
  notFound: () => <p class="board-nf">board not found</p>,
  children: [task],
});
const layout = defineRoute("", {
  id: "shell",
  loader: () => ({ viewer: "ada" }),
  component: Shell,
  notFound: () => <p class="shell-nf">shell not found</p>,
  children: [board],
});
const bare = defineRoute("", {
  id: "bare-shell",
  loader: () => ({ viewer: "grace" }),
  component: Shell,
  children: [
    defineRoute("/bare/:id", {
      id: "bare-project",
      loader: () => { throw notFound(); },
      component: () => <p class="never">never</p>,
    }),
  ],
});
export const routes = [layout, bare];
export function App(props) {
  return <main class="app">{props.children}</main>;
}
`;

const ORIGIN = "http://localhost";

function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

async function handlerFor(): Promise<{
  handler: DuskHandler;
  errors: ReturnType<typeof errorLog>;
}> {
  const app: AppModule = await load<AppModule>(SOURCE);
  const errors = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    onError: errors.onError,
  });
  return { handler, errors };
}

describe("pages: a notFound under a layout that has loader data", () => {
  it("[SRV-40] a child loader's notFound answers 404 and keeps the loaded board, with its notFound in its outlet", async () => {
    const { handler, errors } = await handlerFor();
    const response = await handler.fetch(new Request(`${ORIGIN}/w/atlas/p/ok/t/nope`));
    expect(response.status).toBe(404);
    const html = plain(await response.text());
    expect(html).toContain('<div class="shell"><header class="viewer">ada</header>');
    expect(html).toContain(
      '<section class="board"><h2 class="board-name">ok</h2><p class="board-nf">board not found</p></section></div>',
    );
    expect(html).not.toContain('class="task"');
    expect(errors.errors).toHaveLength(0);
  });

  it("[SRV-41] the loaded layouts' data reaches the dehydrated payload for a notFound answer", async () => {
    const { handler } = await handlerFor();
    const html = await (await handler.fetch(new Request(`${ORIGIN}/w/atlas/p/ok/t/nope`))).text();
    const payload = /id="__shadow_router">([^<]*)<\/script>/.exec(html)?.[1];
    expect(payload).toBeDefined();
    const data = JSON.parse(payload ?? "") as { matches: Array<{ id: string; value: unknown }> };
    expect(data.matches.find((match) => match.id === "shell")?.value).toEqual({ viewer: "ada" });
    expect(data.matches.find((match) => match.id === "board")?.value).toEqual({ name: "ok" });
  });

  it("[SRV-43] a layout whose own loader throws notFound is replaced by its notFound inside the outer layout", async () => {
    const { handler, errors } = await handlerFor();
    const response = await handler.fetch(new Request(`${ORIGIN}/w/atlas/p/nope/t/1`));
    expect(response.status).toBe(404);
    const html = plain(await response.text());
    expect(html).toContain(
      '<div class="shell"><header class="viewer">ada</header><p class="board-nf">board not found</p></div>',
    );
    expect(html).not.toContain('class="board"');
    expect(errors.errors).toHaveLength(0);
  });

  it("[SRV-42] with no notFound on the chain, the answer is the built-in 404 document", async () => {
    const { handler, errors } = await handlerFor();
    const response = await handler.fetch(new Request(`${ORIGIN}/bare/x`));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("404");
    expect(errors.errors).toHaveLength(0);
  });
});
