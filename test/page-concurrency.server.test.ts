import { loaderCache } from "@shadow-js/router/loaders";
import { expect, it } from "vitest";
import { pages } from "../src/features/pages";
import { createHandler, type DuskRuntimeManifest } from "../src/server/index";
import { load } from "./support/compile";
import { type Deferred, deferred } from "./support/deferred";

const source = `
import { onCleanup, useResource } from "@shadow-js/core";
import { defineRoute, useLoaderData } from "@shadow-js/router";
import { Suspense } from "@shadow-js/web";
import { getRequestEvent } from "@start/server";
export const gates = new Map();
export const events = { mounted: 0, disposed: 0, late: 0 };
function Late(props) {
  const value = useResource(() => gates.get(props.id).promise, { key: "data-" + props.id });
  const resolved = value();
  if (resolved === undefined) return <span />;
  events.late += 1;
  const event = getRequestEvent();
  return <p class="late" data-request={event.id}>{resolved}|{event.cookies.get("identity")}|{event.request.headers.get("x-identity")}|{event.locals.identity}</p>;
}
function Page() {
  events.mounted += 1;
  onCleanup(() => { events.disposed += 1; });
  const data = useLoaderData();
  return <section><h1>{data().identity}</h1><Suspense fallback={<p class="waiting">waiting</p>}><Late id={data().identity} /></Suspense></section>;
}
export const routes = [defineRoute("/stress/:id", {
  id: "stress",
  loader: async ({ params }) => {
    await Promise.resolve();
    const event = getRequestEvent();
    event.cookies.set("result", params.id, { path: "/" });
    event.responseHeaders.set("x-identity", params.id);
    return { identity: params.id };
  },
  component: Page,
})];
export function App(props) { return props.children; }
`;
interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly gates: Map<string, Deferred<string>>;
  readonly events: { mounted: number; disposed: number; late: number };
}

function handlerFor(app: Fixture, errors: unknown[]): ReturnType<typeof createHandler> {
  return createHandler({
    features: [pages({ routerFeatures: [loaderCache()] })],
    manifest: {
      routes: app.routes,
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: app.App,
    },
    security: { allowedHosts: ["localhost"] },
    middleware: [
      (event, next) => {
        Reflect.set(event.locals, "identity", event.url.pathname.split("/").at(-1));
        return next();
      },
    ],
    onError: (error) => {
      errors.push(error);
    },
  });
}

it("[SSR-CONCURRENCY-01] 10,000 streamed pages isolate loader state, late request context, cookies, headers, locals and cleanup", async () => {
  const app = await load<Fixture>(source);
  const errors: unknown[] = [];
  const handler = handlerFor(app, errors);
  const total = 10_000;
  const batchSize = 100;
  const requestIds = new Set<string>();
  for (let offset = 0; offset < total; offset += batchSize) {
    const names = Array.from({ length: batchSize }, (_, index) => String(offset + index));
    for (const name of names) app.gates.set(name, deferred<string>());
    const responses = await Promise.all(
      names.map((identity) =>
        handler.fetch(
          new Request(`http://localhost/stress/${identity}`, {
            headers: { cookie: `identity=${identity}`, "x-identity": identity },
          }),
        ),
      ),
    );
    const readers = responses.map((response) => {
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Missing response body");
      return reader;
    });
    try {
      const shells = await Promise.all(readers.map((reader) => reader.read()));
      for (const [index, shell] of shells.entries()) {
        const html = new TextDecoder().decode(shell.value);
        expect(html.replace(/<!--\[-->|<!--\]-->/g, "")).toContain(`>${names[index]}</h1>`);
        expect(html).toContain('class="waiting"');
        expect(html).not.toContain('class="late"');
      }
      const bodies = readers.map(async (reader) => {
        let html = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return html;
          html += new TextDecoder().decode(chunk.value);
        }
      });
      for (const name of names.toReversed()) app.gates.get(name)?.resolve(`late-${name}`);
      const completed = await Promise.all(bodies);
      for (const [index, html] of completed.entries()) {
        const identity = names[index];
        const response = responses[index];
        if (identity === undefined || response === undefined) throw new Error("Missing request");
        const requestId = response.headers.get("x-request-id");
        if (requestId === null) throw new Error("Missing request id");
        expect(html).toContain(`data-request="${requestId}"`);
        expect(html.replace(/<!--\[-->|<!--\]-->/g, "")).toContain(
          `>late-${identity}|${identity}|${identity}|${identity}</p>`,
        );
        expect(response.headers.get("x-identity")).toBe(identity);
        expect(response.headers.get("set-cookie")).toContain(`result=${identity};`);
        expect(html).toContain('data-sh="0"');
        expect(requestIds.has(requestId)).toBe(false);
        requestIds.add(requestId);
      }
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
      for (const name of names) app.gates.delete(name);
    }
  }
  expect(errors).toEqual([]);
  expect(requestIds.size).toBe(total);
  expect(app.gates.size).toBe(0);
  expect(app.events).toEqual({ mounted: total, disposed: total, late: total });
}, 120_000);

it("[SSR-CONCURRENCY-02] request abort and consumer cancellation do not affect other streamed pages or rerender disposed pages", async () => {
  const app = await load<Fixture>(source);
  const errors: unknown[] = [];
  const handler = handlerFor(app, errors);
  const names = Array.from({ length: 100 }, (_, index) => String(index));
  const controls = names.map(() => new AbortController());
  for (const name of names) app.gates.set(name, deferred<string>());
  const responses = await Promise.all(
    names.map((identity, index) =>
      handler.fetch(
        new Request(`http://localhost/stress/${identity}`, {
          signal: controls[index]?.signal ?? null,
          headers: { cookie: `identity=${identity}`, "x-identity": identity },
        }),
      ),
    ),
  );
  const readers = responses.map((response) => {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing response body");
    return reader;
  });
  try {
    await Promise.all(readers.map((reader) => reader.read()));
    const finished = Promise.allSettled(
      readers.map(async (reader) => {
        let html = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return html;
          html += new TextDecoder().decode(chunk.value);
        }
      }),
    );
    for (const [index, reader] of readers.entries()) {
      if (index % 3 === 0) controls[index]?.abort(new Error(`closed-${index}`));
      else if (index % 3 === 1) await reader.cancel("consumer stopped");
    }
    for (const name of names.toReversed()) app.gates.get(name)?.resolve(`late-${name}`);
    const outcomes = await finished;
    for (const [index, outcome] of outcomes.entries()) {
      if (index % 3 === 0) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected")
          expect(outcome.reason).toBe(controls[index]?.signal.reason);
      } else {
        expect(outcome.status).toBe("fulfilled");
        if (outcome.status === "fulfilled") {
          if (index % 3 === 1) expect(outcome.value).not.toContain('class="late"');
          else
            expect(outcome.value.replace(/<!--\[-->|<!--\]-->/g, "")).toContain(
              `>late-${index}|${index}|${index}|${index}</p>`,
            );
        }
      }
    }
    expect(errors).toEqual([]);
    expect(app.events).toEqual({ mounted: 100, disposed: 100, late: 33 });
  } finally {
    const cleanups = await Promise.allSettled(readers.map((reader) => reader.cancel()));
    for (const [index, cleanup] of cleanups.entries()) {
      if (cleanup.status === "rejected")
        expect(cleanup.reason).toBe(controls[index]?.signal.reason);
    }
    app.gates.clear();
  }
});
