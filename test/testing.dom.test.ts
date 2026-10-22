import { describe, expect, it } from "vitest";
import { serverFnStub } from "../src/client/fn";
import { HttpError } from "../src/internal/http-error";
import {
  apiRoute,
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  json,
  serverFn,
} from "../src/server/index";
import { createTestClient, createTestEvent } from "../src/testing/index";
import { allFeatures } from "./support/features";

/** A handler with one mutating API route and one server function, so CSRF decides every POST. */
function boot(): DuskHandler {
  const notes = apiRoute({
    GET: (event) => json({ cookie: event.cookies.get("seen") ?? null }),
    POST: async (event) => {
      event.cookies.set("seen", "1", { httpOnly: true });
      return json({ echoed: await event.request.json() }, { status: 201 });
    },
  });
  const add = serverFn({}, (input) => ({ added: input }));
  const refuse = serverFn({}, () => {
    throw new HttpError(409, "already there");
  });
  const manifest: DuskRuntimeManifest = {
    routes: [],
    apiRoutes: [{ id: "notes", path: "/api/notes", load: async () => notes }],
    serverFns: { add: { load: async () => add }, refuse: { load: async () => refuse } },
    assets: { entry: "/assets/e.js", css: [], preloads: {}, base: "/" },
    App: () => null,
  };
  return createHandler({
    features: allFeatures(),
    manifest,
    security: { allowedHosts: ["localhost"] },
    dev: false,
  });
}

describe("the test client under happy-dom", () => {
  it("[STC-DOM-01] this project really runs under happy-dom, whose Request drops Origin and Sec-Fetch-Site", () => {
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin", "x-kept": "1" },
    });
    expect(typeof document).toBe("object");
    expect(request.headers.get("origin")).toBeNull();
    expect(request.headers.get("x-kept")).toBe("1");
  });

  it("[STC-DOM-02] a same-origin POST and a server function call pass the real CSRF check without a custom fixture", async () => {
    const client = createTestClient(boot());
    const created = await client.postJson("/api/notes", { title: "a" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ echoed: { title: "a" } });
    const call = await client.serverFn("add", { n: 1 });
    expect(call.ok).toBe(true);
    expect(call.value).toEqual({ added: { n: 1 } });
  });

  it("[STC-DOM-03] the CSRF check is not weakened: a cross-site POST and a bare POST are still refused", async () => {
    const client = createTestClient(boot());
    const cross = await client.postJson("/api/notes", { title: "a" }, { crossSite: true });
    expect(cross.status).toBe(403);
    const bare = await client.postJson("/api/notes", { title: "a" }, { bare: true });
    expect(bare.status).toBe(403);
    const crossFn = await client.serverFn("add", 1, { crossSite: true });
    expect(crossFn.status).toBe(403);
  });

  it("[STC-DOM-04] cookies travel too (happy-dom also drops the Cookie header of a Request)", async () => {
    // Cookies are Secure by default, so the client talks to an https origin.
    const client = createTestClient(boot(), { origin: "https://localhost" });
    const set = await client.postJson("/api/notes", {});
    expect(set.headers.getSetCookie()).toHaveLength(1);
    const read = await client.get("/api/notes");
    expect(await read.json()).toEqual({ cookie: "1" });
  });

  it("[STC-DOM-05] createTestEvent keeps the cookies and the Origin it was given", () => {
    const event = createTestEvent({
      method: "POST",
      headers: { origin: "http://localhost" },
      cookies: { sid: "abc" },
    });
    expect(event.cookies.get("sid")).toBe("abc");
    expect(event.request.headers.get("origin")).toBe("http://localhost");
  });

  it("[STC-DOM-06] client.fetch lets a server function stub call POST functions through the handler, CSRF on", async () => {
    const client = createTestClient(boot());
    const add = serverFnStub<unknown, { added: unknown }>("add", {
      method: "POST",
      form: false,
      base: "",
    }).with({ fetch: client.fetch });
    expect(await add({ n: 2 })).toEqual({ added: { n: 2 } });
    const refuse = serverFnStub("refuse", { method: "POST", form: false, base: "" }).with({
      fetch: client.fetch,
    });
    await expect(refuse()).rejects.toMatchObject({ status: 409, message: "already there" });
  });

  it("[STC-DOM-07] client.fetch accepts a Request and an init, and keeps the cookie jar", async () => {
    const client = createTestClient(boot(), { origin: "https://localhost" });
    const created = await client.fetch(
      new Request("https://localhost/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(created.status).toBe(201);
    const read = await client.fetch("https://localhost/api/notes");
    expect(await read.json()).toEqual({ cookie: "1" });
    const crossSite = await client.fetch("https://localhost/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    // An explicit header wins over the default, so a test can still prove the check refuses it.
    expect(crossSite.status).toBe(403);
  });
});
