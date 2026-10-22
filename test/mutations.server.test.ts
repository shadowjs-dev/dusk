import type { RouteDefinition } from "@shadow-js/router";
import { deserialize } from "@shadow-js/web/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler, fail } from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * The no-JS mutation protocol: `fail()` results, signed one-time flash cookies that carry a submission
 * result to the page the browser is sent back to, and the JS form path that answers with an envelope.
 */

const SECRET = "mutation-test-secret-0123456789abcdef";

const FIXTURE = `
import { defineRoute } from "@shadow-js/router";
import { useFlash, useSubmission } from "@shadow-js/dusk/client";
import { fail, HttpError, serverFn, setFlash } from "@start/server";


export const save = serverFn({ form: true }, (input) => {
  const title = String(input.title ?? "");
  if (title === "") return fail(400, { errors: { title: "Required" } });
  if (title === "boom") throw new HttpError(422, "Bad title", { data: { issues: [{ message: "No booms", path: ["title"] }] } });
  return { saved: title };
});
export const pick = serverFn({}, (input) => fail(409, { reason: input }));
export const notice = serverFn({ form: true }, async (_input, event) => { await setFlash(event, { notice: "Saved." }); return { ok: true }; });
export const bigNotice = serverFn({ form: true }, async (_input, event) => { await setFlash(event, { notice: "x".repeat(10000) }); return { ok: true }; });

function Notes() {
  const last = useSubmission();
  const flash = useFlash();
  return (
    <section>
      <p class="result">{last.status}:{last.failed ? "failed" : "ok"}:{JSON.stringify(last.result ?? null)}</p>
      <p class="error">{last.error === undefined ? "none" : String(last.error.message ?? last.error)}</p>
      <p class="issues">{JSON.stringify(last.error?.issues ?? null)}</p>
      <p class="flash">{flash() === undefined ? "none" : JSON.stringify(flash())}</p>
    </section>
  );
}
export const routes = [defineRoute("/notes", { id: "notes", component: Notes })];
`;

interface Fixture {
  readonly routes: readonly RouteDefinition[];
  readonly save: unknown;
  readonly pick: unknown;
  readonly notice: unknown;
  readonly bigNotice: unknown;
  readonly App: (props: { readonly children?: unknown }) => unknown;
}

let fixture: Fixture;

beforeAll(async () => {
  const mod = await load<Fixture & { App?: unknown }>(
    `${FIXTURE}\nexport function App(props) { return props.children; }`,
  );
  fixture = mod as unknown as Fixture;
});

function boot(options: { secrets?: boolean } = {}): { handler: DuskHandler; client: TestClient } {
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: fixture.routes,
      apiRoutes: [],
      serverFns: {
        save: { load: async () => fixture.save as never },
        pick: { load: async () => fixture.pick as never },
        notice: { load: async () => fixture.notice as never },
        bigNotice: { load: async () => fixture.bigNotice as never },
      },
      assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
      App: fixture.App as never,
    },
    dev: true,
    security: {
      allowedHosts: ["localhost"],
      ...(options.secrets === false ? {} : { cookieSecrets: [SECRET] }),
    },
  });
  return { handler, client: createTestClient(handler) };
}

/** The text of a page with the renderer's hydration markers removed and quotes unescaped. */
async function textOf(response: Response): Promise<string> {
  return (await response.text()).replace(/<!--[\s\S]*?-->/g, "").replaceAll("&quot;", '"');
}

const FORM = {
  "content-type": "application/x-www-form-urlencoded",
  referer: "http://localhost/notes",
};

describe("the mutation protocol: fail() and the no-JS result", () => {
  it("[MUT-01] fail() answers a JS call with the failure as its value (status 200 envelope)", async () => {
    const { client } = boot();
    const result = await client.serverFn("pick", "taken");
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ __duskFailure: 1, status: 409, data: { reason: "taken" } });
  });

  it("[MUT-02] fail() rejects a status that is not a client or server error", () => {
    expect(() => fail(200, {})).toThrow(RangeError);
    expect(() => fail(399, {})).toThrow(RangeError);
    expect(() => fail(600, {})).toThrow(RangeError);
    expect(() => fail(Number.NaN, {})).toThrow(RangeError);
    expect(fail(400, { x: 1 })).toEqual({ __duskFailure: 1, status: 400, data: { x: 1 } });
  });

  it("[MUT-03] a classic form post with cookie secrets answers 303 to the referer and sets one signed flash cookie", async () => {
    const { client } = boot();
    const response = await client.post("/_dusk/fn/save", {
      headers: FORM,
      body: new URLSearchParams({ title: "" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/notes");
    const cookies = response.headers
      .getSetCookie()
      .filter((value) => value.startsWith("__dusk_flash="));
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/HttpOnly/);
  });

  it("[MUT-04] the page the browser is sent back to renders the result, and the flash is cleared", async () => {
    const { client } = boot();
    await client.post("/_dusk/fn/save", {
      headers: FORM,
      body: new URLSearchParams({ title: "" }),
    });
    const page = await client.get("/notes");
    expect(page.status).toBe(200);
    const html = await textOf(page);
    expect(html).toMatch(/<p class="result">success:failed:[^<]*__duskFailure[^<]*400/);
    expect(html).toContain('id="__shadow_flash"');
    const cleared = page.headers.getSetCookie().find((value) => value.startsWith("__dusk_flash="));
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it("[MUT-05] a flash is one-time: the next page render has no result", async () => {
    const { client } = boot();
    await client.post("/_dusk/fn/save", {
      headers: FORM,
      body: new URLSearchParams({ title: "" }),
    });
    await client.get("/notes");
    const again = await textOf(await client.get("/notes"));
    expect(again).toContain('<p class="result">idle:ok:null</p>');
    expect(again).toContain('<p class="flash">none</p>');
  });

  it("[MUT-06] a thrown error with issues is carried to the page as an error result, with its status", async () => {
    const { client } = boot();
    const response = await client.post("/_dusk/fn/save", {
      headers: FORM,
      body: new URLSearchParams({ title: "boom" }),
    });
    expect(response.status).toBe(303);
    const html = await textOf(await client.get("/notes"));
    expect(html).toContain('<p class="result">error:ok:null</p>');
    expect(html).toContain('<p class="error">Bad title</p>');
    expect(html).toContain("No booms");
  });

  it("[MUT-07] a forged or tampered flash cookie is ignored", async () => {
    const { client } = boot();
    client.cookies.set(
      new URL("http://localhost"),
      "__dusk_flash",
      "eyJzdWJtaXNzaW9uIjp7fX0.forged",
    );
    const html = await textOf(await client.get("/notes"));
    expect(html).toContain('<p class="result">idle:ok:null</p>');
    expect(html).toContain('<p class="flash">none</p>');
  });

  it("[MUT-08] a JS form post (multipart with the call header) answers a JSON envelope, not a redirect", async () => {
    const { client } = boot();
    const form = new FormData();
    form.set("title", "");
    const response = await client.post("/_dusk/fn/save", {
      headers: { "x-dusk-fn": "1" },
      body: form,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("location")).toBeNull();
    const body: unknown = deserialize(await response.text());
    expect(body).toEqual({
      ok: true,
      value: { __duskFailure: 1, status: 400, data: { errors: { title: "Required" } } },
    });
  });

  it("[MUT-09] a form post without the call header is still a classic post (303)", async () => {
    const { client } = boot();
    const body = new FormData();
    body.set("title", "x");
    const response = await client.post("/_dusk/fn/save", {
      headers: { referer: "http://localhost/notes" },
      body,
    });
    expect(response.status).toBe(303);
  });

  it("[MUT-10] without cookie secrets a classic post keeps the plain 303 and no flash cookie", async () => {
    const { client } = boot({ secrets: false });
    const response = await client.post("/_dusk/fn/save", {
      headers: FORM,
      body: new URLSearchParams({ title: "" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie().some((value) => value.startsWith("__dusk_flash="))).toBe(
      false,
    );
  });

  it("[MUT-11] setFlash() from a form function is read once by the page through useFlash()", async () => {
    const { client } = boot();
    await client.post("/_dusk/fn/notice", { headers: FORM, body: new URLSearchParams({}) });
    const first = await textOf(await client.get("/notes"));
    expect(first).toMatch(/<p class="flash">[^<]*Saved\.[^<]*<\/p>/);
    const second = await textOf(await client.get("/notes"));
    expect(second).toContain('<p class="flash">none</p>');
  });

  it("[MUT-36] a flash over 3000 characters is dropped to its status: the cookie stays small and the page does not get the text", async () => {
    const { client } = boot();
    const response = await client.post("/_dusk/fn/bigNotice", {
      headers: FORM,
      body: new URLSearchParams({}),
    });
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__dusk_flash="));
    expect(cookie).toBeDefined();
    expect((cookie as string).length).toBeLessThan(600);
    expect(await textOf(await client.get("/notes"))).not.toContain("xxxxxxxx");
  });
});
