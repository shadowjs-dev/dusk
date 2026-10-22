import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { createDataCache } from "../src/server/data-cache";
import {
  apiRoute,
  createHandler,
  createMemoryKVStore,
  type DuskRuntimeManifest,
  defineLocals,
  getRequestEvent,
  json,
  type Middleware,
} from "../src/server/index";
import { type CachePolicy, cacheableRequest, keyOf, variantKeyOf } from "../src/server/isr";
import { createTestClient } from "../src/testing/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";
import { get, handmade } from "./support/sec2-core";

/**
 * PASS 2, scope D (server core): the page cache and the data cache (SEC2-CORE-63 .. 74) and request locals
 * (SEC2-CORE-75 .. 78).
 *
 * The page cache keys a page by host, path, the query parameters the route names and the cookies it declares. Before the
 * fixes, a render was given more than the key: every query parameter, every request header, and the path as spelled.
 */

const SOURCE = `
import { defineRoute, useLoaderData } from "@shadow-js/router";
import { getRequestEvent, revalidatePath } from "@start/server";

export const counts = { q: 0, lang: 0, langv: 0, user: 0, about: 0, cookie: 0, plain: 0 };

function Text(props) { return <p class={props.cls}>{props.text}</p>; }

const q = defineRoute("/q", {
  id: "q",
  revalidate: 60,
  cache: { searchParams: ["page"] },
  loader: () => {
    counts.q += 1;
    const params = getRequestEvent().url.searchParams;
    return { page: params.get("page") ?? "", q: params.get("q") ?? "" };
  },
  component: () => { const d = useLoaderData(); return <Text cls="q" text={"page=" + d()?.page + " q=" + d()?.q} />; },
});
const lang = defineRoute("/lang", {
  id: "lang",
  revalidate: 60,
  loader: () => { counts.lang += 1; return { lang: getRequestEvent().request.headers.get("accept-language") ?? "none" }; },
  component: () => { const d = useLoaderData(); return <Text cls="lang" text={"lang=" + d()?.lang} />; },
});
const langv = defineRoute("/langv", {
  id: "langv",
  revalidate: 60,
  loader: () => {
    counts.langv += 1;
    getRequestEvent().responseHeaders.set("vary", "accept-language");
    return { lang: getRequestEvent().request.headers.get("accept-language") ?? "none" };
  },
  component: () => { const d = useLoaderData(); return <Text cls="langv" text={"langv=" + d()?.lang} />; },
});
const user = defineRoute("/user", {
  id: "user",
  revalidate: 60,
  loader: () => { counts.user += 1; return { who: getRequestEvent().request.headers.get("x-forwarded-user") ?? "anonymous" }; },
  component: () => { const d = useLoaderData(); return <Text cls="user" text={"who=" + d()?.who} />; },
});
const about = defineRoute("/about", {
  id: "about",
  revalidate: 60,
  loader: () => { counts.about += 1; return { n: counts.about }; },
  component: () => { const d = useLoaderData(); return <Text cls="about" text={"about " + d()?.n} />; },
});
const cookie = defineRoute("/cookie", {
  id: "cookie",
  revalidate: 60,
  loader: () => { counts.cookie += 1; getRequestEvent().cookies.set("seen", "1"); return 1; },
  component: () => <Text cls="cookie" text="cookie" />,
});
const plain = defineRoute("/plain", {
  id: "plain",
  revalidate: 60,
  loader: () => { counts.plain += 1; return { n: counts.plain }; },
  component: () => { const d = useLoaderData(); return <Text cls="plain" text={"plain " + d()?.n} />; },
});
const purge = defineRoute("/purge", {
  id: "purge",
  loader: async () => { await revalidatePath(getRequestEvent().url.searchParams.get("path") ?? "/"); return 1; },
  component: () => <Text cls="purge" text="purged" />,
});

export const routes = [q, lang, langv, user, about, cookie, plain, purge];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly counts: Record<string, number>;
}

async function boot() {
  const app = await load<Fixture>(SOURCE);
  const warnings: string[] = [];
  const handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
      App: app.App,
    },
    dev: true,
    security: { allowedHosts: ["example.com"] },
    onError: () => undefined,
    onWarning: (message) => void warnings.push(message),
  });
  const fetchPath = (path: string, headers: Record<string, string> = {}) =>
    handler.fetch(new Request(`https://example.com${path}`, { headers }));
  return { app, handler, warnings, fetchPath };
}

const text = (response: Response): Promise<string> => response.text();

describe("SEC2-CORE page cache: what a render may depend on", () => {
  it("[SEC2-CORE-63] a query parameter the route did not name is not part of the cached render", async () => {
    const t = await boot();
    const first = await text(await t.fetchPath("/q?page=1&q=PLANTED"));
    expect(first).toContain("page=1");
    expect(first).not.toContain("PLANTED");
    const second = await t.fetchPath("/q?page=1&q=other");
    expect(second.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await text(second)).not.toContain("PLANTED");
    const third = await t.fetchPath("/q?page=2");
    expect(await text(third)).toContain("page=2");
    expect(t.app.counts["q"]).toBe(2);
  });

  it("[SEC2-CORE-64] a page that reads a request header it did not list in Vary is rendered for that request and never stored", async () => {
    const t = await boot();
    const french = await text(await t.fetchPath("/lang", { "accept-language": "fr" }));
    expect(french).toContain("lang=fr");
    const german = await t.fetchPath("/lang", { "accept-language": "de" });
    expect(await text(german)).toContain("lang=de");
    expect(german.headers.get("x-dusk-cache")).not.toBe("HIT");
    expect(t.app.counts["lang"]).toBe(2);
    // A header an auth proxy sets works the same way: one user's page is not another user's.
    const alice = await text(await t.fetchPath("/user", { "x-forwarded-user": "alice" }));
    const bob = await text(await t.fetchPath("/user", { "x-forwarded-user": "bob" }));
    expect(alice).toContain("who=alice");
    expect(bob).toContain("who=bob");
    expect(t.warnings.some((message) => message.includes("accept-language"))).toBe(true);
  });

  it("[SEC2-CORE-65] a page that lists the header in Vary is stored once per value and still served from the cache", async () => {
    const t = await boot();
    const fr1 = await t.fetchPath("/langv", { "accept-language": "fr" });
    const de1 = await t.fetchPath("/langv", { "accept-language": "de" });
    const fr2 = await t.fetchPath("/langv", { "accept-language": "fr" });
    expect(await text(fr1)).toContain("langv=fr");
    expect(await text(de1)).toContain("langv=de");
    expect(fr2.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await text(fr2)).toContain("langv=fr");
    expect(t.app.counts["langv"]).toBe(2);
  });

  it("[SEC2-CORE-66] a page that does not read request headers is cached, whatever headers the visitor sends", async () => {
    const t = await boot();
    await t.fetchPath("/plain", {
      "accept-language": "fr",
      "user-agent": "a",
      "x-forwarded-user": "u",
      accept: "text/html",
    });
    const second = await t.fetchPath("/plain", { "accept-language": "de" });
    expect(second.headers.get("x-dusk-cache")).toBe("HIT");
    expect(t.app.counts["plain"]).toBe(1);
  });

  it("[SEC2-CORE-67] the spellings of one path share one entry, and revalidatePath removes it for every spelling", async () => {
    const t = await boot();
    for (const path of ["/about", "/ABOUT", "/%61bout", "/About"]) {
      const response = await t.fetchPath(path);
      expect(response.status, path).toBe(200);
    }
    expect(t.app.counts["about"], "one render for four spellings").toBe(1);
    expect((await t.fetchPath("/ABOUT")).headers.get("x-dusk-cache")).toBe("HIT");
    await t.fetchPath("/purge?path=/about");
    const after = await t.fetchPath("/ABOUT");
    expect(after.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await text(after)).toContain("about 2");
    // A purge by another spelling of the path reaches the same entry.
    await t.fetchPath("/purge?path=/ABOUT");
    expect((await t.fetchPath("/about")).headers.get("x-dusk-cache")).toBe("MISS");
  });

  it("[SEC2-CORE-68] an answer that sets a cookie is not stored, and a request with Authorization or an undeclared cookie is not served from the cache", async () => {
    const t = await boot();
    await t.fetchPath("/cookie");
    const again = await t.fetchPath("/cookie");
    expect(again.headers.get("x-dusk-cache")).not.toBe("HIT");
    expect(t.app.counts["cookie"]).toBe(2);
    await t.fetchPath("/plain");
    for (const headers of [{ authorization: "Bearer x" }, { cookie: "session=abc" }]) {
      const response = await t.fetchPath("/plain", headers);
      expect(response.headers.get("x-dusk-cache")).toBe("BYPASS");
    }
  });

  it("[SEC2-CORE-69] there is no HTTP endpoint that purges the cache: revalidation is server code only", async () => {
    const t = await boot();
    for (const path of [
      "/_dusk/revalidate",
      "/_dusk/cache/purge",
      "/api/revalidate",
      "/revalidate",
      "/_dusk/revalidate?tag=a&secret=x",
    ]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await t.handler.fetch(
          new Request(`https://example.com${path}`, {
            method,
            headers: { origin: "https://example.com" },
          }),
        );
        expect([404, 405], `${method} ${path}`).toContain(response.status);
      }
    }
  });

  it("[SEC2-CORE-70] keys cannot collide: the page key and the variant key are injective over paths, queries, cookies and header values", () => {
    const policy: CachePolicy = {
      fresh: 60,
      stale: 0,
      cookies: ["a", "b"],
      searchParams: undefined,
    };
    const unit = fc.string({ maxLength: 12 });
    fc.assert(
      fc.property(
        fc.tuple(unit, unit, unit, unit),
        fc.tuple(unit, unit, unit, unit),
        (left, right) => {
          const keyFor = ([path, query, a, b]: readonly [
            string,
            string,
            string,
            string,
          ]): string => {
            const url = new URL("https://example.com/");
            url.pathname = `/${path}`;
            url.searchParams.set("q", query);
            const request = new Request(url, {
              headers: { cookie: `a=${encodeURIComponent(a)}; b=${encodeURIComponent(b)}` },
            });
            return keyOf(url, request, policy);
          };
          const same = left.every((part, index) => part === right[index]);
          return same === (keyFor(left) === keyFor(right));
        },
      ),
      { seed: 20261010, numRuns: 300 },
    );
    const request = (value: string): Request =>
      new Request("https://example.com/", { headers: { "accept-language": value, "x-b": value } });
    const values = ["", "a", "a&b", "a#vary:x-b=", "%26", "a=b", "x-b=1&accept-language=2"];
    const seen = new Set<string>();
    for (const value of values)
      seen.add(variantKeyOf("base", request(value), ["accept-language", "x-b"]));
    expect(seen.size).toBe(values.length);
    expect(
      cacheableRequest(
        new Request("https://example.com/", { headers: { authorization: "x" } }),
        policy,
      ),
    ).toBe(false);
  });
});

describe("SEC2-CORE data cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[SEC2-CORE-71] cachedFetch keys on the request headers too: two tenants with different API keys never share an entry", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("x-api-key") ?? "none";
        calls.push(key);
        return new Response(JSON.stringify({ tenant: key }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const cache = createDataCache({ kv: createMemoryKVStore() });
    const url = "https://api.example/data";
    const a = await cache.cachedFetch<{ tenant: string }>(
      url,
      { headers: { "x-api-key": "A" } },
      { revalidate: 60 },
    );
    const b = await cache.cachedFetch<{ tenant: string }>(
      url,
      { headers: { "x-api-key": "B" } },
      { revalidate: 60 },
    );
    const a2 = await cache.cachedFetch<{ tenant: string }>(
      url,
      { headers: { "X-API-KEY": "A" } },
      { revalidate: 60 },
    );
    const none = await cache.cachedFetch<{ tenant: string }>(url, undefined, { revalidate: 60 });
    expect(a.tenant).toBe("A");
    expect(b.tenant).toBe("B");
    expect(a2.tenant).toBe("A");
    expect(none.tenant).toBe("none");
    expect(calls).toEqual(["A", "B", "none"]);
  });

  it("[SEC2-CORE-72] a header value is never written into a store key (keys reach logs and Redis dumps)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { headers: { "content-type": "text/plain" } })),
    );
    const kv = createMemoryKVStore();
    const cache = createDataCache({ kv });
    await cache.cachedFetch(
      "https://api.example/x",
      { headers: { "x-api-key": "SUPER-SECRET-KEY" } },
      { revalidate: 60 },
    );
    const page = await kv.list({ prefix: "" });
    expect(page.keys.length).toBeGreaterThan(0);
    for (const key of page.keys) expect(key).not.toContain("SUPER-SECRET-KEY");
  });

  it("[SEC2-CORE-73] cachedFetch refuses a URL with credentials (they would sit in the store key) and a body or credential header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    const cache = createDataCache({ kv: createMemoryKVStore() });
    await expect(
      cache.cachedFetch("https://user:pass@api.example/x", undefined, { revalidate: 60 }),
    ).rejects.toThrow(TypeError);
    await expect(
      cache.cachedFetch(
        "https://api.example/x",
        { headers: { Authorization: "x" } },
        { revalidate: 60 },
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      cache.cachedFetch(
        "https://api.example/x",
        { headers: { "Proxy-Authorization": "x" } },
        { revalidate: 60 },
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      cache.cachedFetch("https://api.example/x", { method: "POST" }, { revalidate: 60 }),
    ).rejects.toThrow(TypeError);
  });

  it("[SEC2-CORE-74] a tag cannot reach an entry through the key namespace: purging tag x leaves the entry whose key text is tag:x", async () => {
    const cache = createDataCache({ kv: createMemoryKVStore() });
    let runs = 0;
    const run = async (): Promise<number> => ++runs;
    await cache.cacheData(run, { key: ["tag:x"], revalidate: 60 });
    await cache.cacheData(run, { key: ["other"], revalidate: 60, tags: ["x"] });
    await cache.purgeTag("x");
    expect(await cache.cacheData(run, { key: ["tag:x"], revalidate: 60 })).toBe(1);
    expect(await cache.cacheData(run, { key: ["other"], revalidate: 60, tags: ["x"] })).toBe(3);
  });
});

describe("SEC2-CORE request locals", () => {
  it("[SEC2-CORE-75] 60 concurrent requests each see only their own locals, event values and request id across awaits", async () => {
    const order: Middleware = async (event, next) => {
      const id = event.url.searchParams.get("id") ?? "";
      (event.locals as Record<string, unknown>)["user"] = id;
      // Interleave: the later the id, the sooner it resumes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (Number(id) % 2 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      return next();
    };
    const handler = createHandler({
      features: [apiRoutes()],
      manifest: handmade([
        {
          id: "who",
          path: "/who",
          module: apiRoute({
            GET: async (event) => {
              await new Promise<void>((resolve) => setImmediate(resolve));
              const current = getRequestEvent();
              return json({
                asked: event.url.searchParams.get("id"),
                local: (event.locals as Record<string, unknown>)["user"],
                viaContext: (current.locals as Record<string, unknown>)["user"],
                same: current === event,
              });
            },
          }),
        },
      ]),
      dev: true,
      middleware: [order],
      onWarning: () => undefined,
    });
    const client = createTestClient(handler);
    const answers = await Promise.all(
      Array.from({ length: 60 }, async (_, id) => (await client.get(`/who?id=${id}`)).json()),
    );
    answers.forEach((answer, id) => {
      expect(answer).toEqual({
        asked: String(id),
        local: String(id),
        viaContext: String(id),
        same: true,
      });
    });
  });

  it("[SEC2-CORE-76] a mutable default of defineLocals is copied for each request: one request's push is not seen by the next", async () => {
    const locals = defineLocals({
      cart: [] as string[],
      seen: new Set<string>(),
      user: undefined as string | undefined,
    });
    const a = { locals: Object.create(null) } as never;
    const b = { locals: Object.create(null) } as never;
    locals.of(a).cart.push("secret-item");
    locals.of(a).seen.add("secret");
    locals.of(a).user = "alice";
    expect(locals.of(b).cart).toEqual([]);
    expect(locals.of(b).seen.size).toBe(0);
    expect(locals.of(b).user).toBeUndefined();
    expect(locals.defaults.cart).toEqual([]);
    expect(locals.of(a).cart).toEqual(["secret-item"]);
    // A default that cannot be copied per request is refused when it is declared, not leaked later.
    expect(() => defineLocals({ handler: () => 1 })).not.toThrow();
    expect(() => defineLocals({ box: { fn: () => 1 } })).toThrow(TypeError);
  });

  it("[SEC2-CORE-77] the locals object has no prototype: a __proto__ key is data, and Object.prototype stays clean", async () => {
    const handler = createHandler({
      features: [apiRoutes()],
      manifest: handmade([
        {
          id: "p",
          path: "/p",
          module: apiRoute({
            GET: (event) => {
              Reflect.set(event.locals, "__proto__", { polluted: true });
              return json({ proto: Object.getPrototypeOf(event.locals) === null });
            },
          }),
        },
      ]),
      dev: true,
      onWarning: () => undefined,
    });
    const response = await handler.fetch(get("/p"));
    expect(await response.json()).toEqual({ proto: true });
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });
});
