import type { RouteDefinition } from "@shadow-js/router";
import { beforeAll, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { load } from "./support/compile";
import { type Deferred, deferred } from "./support/deferred";
import { allFeatures } from "./support/features";

/**
 * `<Await>` over a streamed page: the fallback is in the first chunk, the value follows when the promise
 * settles, a rejection renders the error element. The page is rendered by the real handler in its default
 * (stream) mode.
 */

const FIXTURE = `
import { defineRoute } from "@shadow-js/router";
import { Await } from "@shadow-js/dusk/client";


export const gates = {};

function Comments() {
  return (
    <main>
      <Await resolve={gates.slow.promise} fallback={<p class="pending">loading comments</p>} errorElement={(error) => <p class="failed">{error.message}</p>}>
        {(value) => <p class="done">{value}</p>}
      </Await>
    </main>
  );
}
function Broken() {
  return (
    <main>
      <Await resolve={gates.broken.promise} fallback={<p class="pending">loading again</p>} errorElement={(error) => <p class="failed">{error.message}</p>}>
        {(value) => <p class="done">{value}</p>}
      </Await>
    </main>
  );
}
export const routes = [
  defineRoute("/comments", { id: "comments", component: Comments }),
  defineRoute("/broken", { id: "broken", component: Broken }),
];
export function App(props) {
  return props.children;
}
`;

interface Fixture {
  readonly routes: readonly RouteDefinition[];
  readonly App: (props: { readonly children?: unknown }) => unknown;
  readonly gates: Record<string, Deferred<string>>;
}

let fixture: Fixture;
let handler: DuskHandler;

beforeAll(async () => {
  fixture = await load<Fixture>(FIXTURE);
  handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: fixture.routes,
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
      App: fixture.App as never,
    },
    dev: true,
    security: { allowedHosts: ["localhost"] },
  });
});

/** Reads the next chunk of a body, decoded. */
async function next(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  return chunk.done ? "" : new TextDecoder().decode(chunk.value);
}

/** Reads a body to its end and returns everything after the chunks already read. */
async function rest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let out = "";
  for (;;) {
    const text = await next(reader);
    if (text === "") return out;
    out += text;
  }
}

describe("<Await> in a streamed page", () => {
  it("[MUT-40] the fallback is sent first; the value follows when the promise resolves", async () => {
    const slow = deferred<string>();
    fixture.gates["slow"] = slow;
    const response = await handler.fetch(new Request("http://localhost/comments"));
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new TypeError("the response has no body");
    const first = await next(reader);
    expect(first).toMatch(/class="pending"[^>]*>/);
    expect(first).toContain("loading comments");
    slow.resolve("ready");
    const tail = await rest(reader);
    expect(tail).toMatch(/class="done"[^>]*>(?:<!--\[-->)?ready/);
  });

  it("[MUT-41] a rejected promise renders the errorElement with the error", async () => {
    const broken = deferred<string>();
    fixture.gates["broken"] = broken;
    const response = await handler.fetch(new Request("http://localhost/broken"));
    const reader = response.body?.getReader();
    if (reader === undefined) throw new TypeError("the response has no body");
    const first = await next(reader);
    expect(first).toContain("loading again");
    broken.reject(new Error("comments are down"));
    const tail = await rest(reader);
    expect(tail).toMatch(/class="failed"[^>]*>(?:<!--\[-->)?comments are down/);
    expect(tail).not.toContain('class="done"');
  });
});
