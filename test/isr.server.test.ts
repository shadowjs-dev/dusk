import { describe, expect, it, vi } from "vitest";
import { createKeyValueCacheStore, createMemoryCacheStore } from "../src/server/cache-store";
import { createHandler, type DuskRuntimeManifest, type HandlerOptions } from "../src/server/index";
import { createFakeKeyValue } from "../src/testing/key-value";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * ISR fixture: pages with `revalidate`, `cache` options, counted loaders, a purge page and a page whose
 * head carries a CSP nonce. Compiled with the real compiler, so the loaders and renders are the real ones.
 */
const SOURCE = `
import { defineRoute, Outlet, useLoaderData, notFound } from "@shadow-js/router";
import { getRequestEvent, cacheTags, revalidatePath, revalidateTag } from "@start/server";


export const counts = { news: 0, forever: 0, personal: 0, sets: 0, missing: 0, flaky: 0, locale: 0, big: 0, tagged: 0 };
export const state = { fail: false };

function Text(props) { return <p class={props.cls}>{props.text}</p>; }

const news = defineRoute("/news", {
  id: "news",
  revalidate: 60,
  loader: () => { counts.news += 1; cacheTags("list"); return { n: counts.news }; },
  component: () => { const data = useLoaderData(); return <Text cls="news" text={"news " + (data()?.n ?? 0)} />; },
});
const forever = defineRoute("/forever", {
  id: "forever",
  revalidate: false,
  loader: () => { counts.forever += 1; return { n: counts.forever }; },
  component: () => { const data = useLoaderData(); return <Text cls="forever" text={"forever " + data()?.n} />; },
});
const personal = defineRoute("/personal", {
  id: "personal",
  revalidate: 60,
  loader: () => { counts.personal += 1; return { who: getRequestEvent().cookies.get("session") ?? "anon" }; },
  component: () => { const data = useLoaderData(); return <Text cls="personal" text={"hello " + data()?.who} />; },
});
const sets = defineRoute("/sets-cookie", {
  id: "sets-cookie",
  revalidate: 60,
  loader: () => { counts.sets += 1; getRequestEvent().cookies.set("seen", "1"); return 1; },
  component: () => <Text cls="sets" text="sets" />,
});
const missing = defineRoute("/missing", {
  id: "missing",
  revalidate: 60,
  loader: () => { counts.missing += 1; throw notFound(); },
  component: () => <Text cls="missing" text="never" />,
});
const flaky = defineRoute("/flaky", {
  id: "flaky",
  revalidate: 1,
  cache: { staleSeconds: 60 },
  loader: () => { counts.flaky += 1; if (state.fail) throw new Error("database is down"); return { n: counts.flaky }; },
  component: () => { const data = useLoaderData(); return <Text cls="flaky" text={"flaky " + data()?.n} />; },
});
const locale = defineRoute("/locale", {
  id: "locale",
  revalidate: 60,
  cache: { cookies: ["locale"] },
  loader: () => { counts.locale += 1; return { lang: getRequestEvent().cookies.get("locale") ?? "en" }; },
  component: () => { const data = useLoaderData(); return <Text cls="locale" text={"lang " + data()?.lang} />; },
});
const big = defineRoute("/big", {
  id: "big",
  revalidate: 60,
  loader: () => { counts.big += 1; return 1; },
  component: () => <Text cls="big" text={"x".repeat(4000)} />,
});
const tagged = defineRoute("/tagged", {
  id: "tagged",
  revalidate: false,
  loader: () => { counts.tagged += 1; cacheTags("post:7"); return 1; },
  component: () => <Text cls="tagged" text="tagged" />,
});
const purge = defineRoute("/purge", {
  id: "purge",
  loader: async () => {
    const url = getRequestEvent().url;
    const path = url.searchParams.get("path");
    const tag = url.searchParams.get("tag");
    if (path !== null) await revalidatePath(path);
    if (tag !== null) await revalidateTag(tag);
    return 1;
  },
  component: () => <Text cls="purge" text="purged" />,
});
const nonce = defineRoute("/nonce", {
  id: "nonce",
  revalidate: 60,
  component: () => <Text cls="nonce" text="nonce page" />,
});

export const routes = [news, forever, personal, sets, missing, flaky, locale, big, tagged, purge, nonce];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly counts: Record<string, number>;
  readonly state: { fail: boolean };
}

async function fixture(): Promise<Fixture> {
  return load<Fixture>(SOURCE);
}

function manifestOf(app: Fixture): DuskRuntimeManifest {
  return {
    routes: app.routes,
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: app.App,
  };
}

interface Booted {
  readonly app: Fixture;
  readonly get: (path: string, init?: RequestInit) => Promise<Response>;
  readonly body: (response: Response) => Promise<string>;
  readonly clock: { now: number };
  readonly errors: unknown[];
  readonly handler: ReturnType<typeof createHandler>;
}

async function boot(
  options: Partial<HandlerOptions> & { readonly clockStart?: number } = {},
): Promise<Booted> {
  const app = await fixture();
  const clock = { now: options.clockStart ?? 1_000_000 };
  const errors: unknown[] = [];
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    security: { allowedHosts: ["example.com"] },
    onError: (error) => void errors.push(error),
    onWarning: () => undefined,
    ...options,
    cache: { now: () => clock.now, ...(options.cache ?? {}) },
  });
  return {
    app,
    clock,
    errors,
    handler,
    get: (path, init) => handler.fetch(new Request(`https://example.com${path}`, init)),
    body: (response) => response.text(),
  };
}

describe("ISR: when a page is served from the cache", () => {
  it("[ISR-01] the first GET renders (MISS), the next one is served from the cache (HIT) without the loader", async () => {
    const t = await boot();
    const first = await t.get("/news");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await t.body(first)).toContain("news 1");
    const second = await t.get("/news");
    expect(second.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await t.body(second)).toContain("news 1");
    expect(t.app.counts["news"]).toBe(1);
  });

  it("[ISR-02] a cached answer says how long it is fresh and carries an ETag; If-None-Match gives 304", async () => {
    const t = await boot();
    await t.get("/news");
    const hit = await t.get("/news");
    expect(hit.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=60",
    );
    const etag = hit.headers.get("etag");
    expect(etag).toMatch(/^"[^"]+"$/);
    const conditional = await t.get("/news", { headers: { "if-none-match": etag ?? "" } });
    expect(conditional.status).toBe(304);
    expect(t.app.counts["news"]).toBe(1);
  });

  it("[ISR-03] after the fresh period a stale answer is served at once; one background render refreshes the entry", async () => {
    const t = await boot();
    await t.get("/news");
    t.clock.now += 61_000;
    const stale = await t.get("/news");
    expect(stale.headers.get("x-dusk-cache")).toBe("STALE");
    expect(await t.body(stale)).toContain("news 1");
    // The refreshed entry is stored after its render: wait for the store, not for the loader.
    await vi.waitFor(async () => {
      const next = await t.get("/news");
      expect(next.headers.get("x-dusk-cache")).toBe("HIT");
      expect(await t.body(next)).toContain("news 2");
    });
    expect(t.app.counts["news"]).toBe(2);
  });

  it("[ISR-04] beyond the stale window the request waits for a fresh render (MISS)", async () => {
    const t = await boot();
    await t.get("/news");
    t.clock.now += 61_000 + 60_000 + 1;
    const fresh = await t.get("/news");
    expect(fresh.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await t.body(fresh)).toContain("news 2");
  });

  it("[ISR-05] concurrent misses for one key share one render", async () => {
    const t = await boot();
    const answers = await Promise.all(Array.from({ length: 5 }, () => t.get("/news")));
    const bodies = await Promise.all(answers.map((answer) => t.body(answer)));
    expect(t.app.counts["news"]).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
  });

  it("[ISR-06] a request with a cookie the page does not declare is never served from or stored in the cache", async () => {
    const t = await boot();
    const one = await t.get("/personal", { headers: { cookie: "session=alice" } });
    const two = await t.get("/personal", { headers: { cookie: "session=bob" } });
    expect(one.headers.get("x-dusk-cache")).toBe("BYPASS");
    expect(await t.body(one)).toContain("hello alice");
    expect(await t.body(two)).toContain("hello bob");
    expect(one.headers.get("cache-control")).toBe("private, no-store");
    const anon = await t.get("/personal");
    expect(await t.body(anon)).toContain("hello anon");
    expect(t.app.counts["personal"]).toBe(3);
  });

  it("[ISR-07] an Authorization header bypasses the cache", async () => {
    const t = await boot();
    await t.get("/news");
    const signedIn = await t.get("/news", { headers: { authorization: "Bearer x" } });
    expect(signedIn.headers.get("x-dusk-cache")).toBe("BYPASS");
    expect(t.app.counts["news"]).toBe(2);
  });

  it("[ISR-08] an answer that sets a cookie is not stored", async () => {
    const t = await boot();
    const one = await t.get("/sets-cookie");
    expect(one.headers.get("set-cookie")).toContain("seen=1");
    await t.get("/sets-cookie");
    expect(t.app.counts["sets"]).toBe(2);
  });

  it("[ISR-09] errors and non-200 answers are never stored: the next request renders again", async () => {
    const t = await boot();
    const gone = await t.get("/missing");
    expect(gone.status).toBe(404);
    await t.get("/missing");
    expect(t.app.counts["missing"]).toBe(2);
    t.app.state.fail = true;
    const broken = await t.get("/flaky");
    expect(broken.status).toBe(500);
    t.app.state.fail = false;
    const recovered = await t.get("/flaky");
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-dusk-cache")).toBe("MISS");
  });

  it("[ISR-10] a failed background render keeps serving the stale entry and reports the error", async () => {
    const t = await boot();
    await t.get("/flaky");
    t.clock.now += 2_000;
    t.app.state.fail = true;
    const stale = await t.get("/flaky");
    expect(stale.headers.get("x-dusk-cache")).toBe("STALE");
    expect(await t.body(stale)).toContain("flaky 1");
    await vi.waitFor(() => expect(t.errors.length).toBeGreaterThan(0));
    t.app.state.fail = false;
    const again = await t.get("/flaky");
    expect(again.headers.get("x-dusk-cache")).toBe("STALE");
    expect(await t.body(again)).toContain("flaky 1");
  });

  it("[ISR-11] revalidate: false keeps a page until it is purged", async () => {
    const t = await boot();
    await t.get("/forever");
    t.clock.now += 10 * 365 * 24 * 3600 * 1000;
    const kept = await t.get("/forever");
    expect(kept.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await t.body(kept)).toContain("forever 1");
    expect(t.app.counts["forever"]).toBe(1);
  });

  it("[ISR-12] revalidatePath purges the cached pages of that path, and only them", async () => {
    const t = await boot();
    await t.get("/news");
    await t.get("/forever");
    await t.get("/purge?path=/news");
    const news = await t.get("/news");
    expect(news.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await t.body(news)).toContain("news 2");
    expect((await t.get("/forever")).headers.get("x-dusk-cache")).toBe("HIT");
  });

  it("[ISR-13] revalidateTag purges the pages indexed under the tag (cacheTags in a loader)", async () => {
    const t = await boot();
    await t.get("/tagged");
    expect((await t.get("/tagged")).headers.get("x-dusk-cache")).toBe("HIT");
    await t.get("/purge?tag=post:7");
    expect((await t.get("/tagged")).headers.get("x-dusk-cache")).toBe("MISS");
    expect(t.app.counts["tagged"]).toBe(2);
  });

  it("[ISR-14] cookies named in cache.cookies are part of the key and of Vary", async () => {
    const t = await boot();
    const fr = await t.get("/locale", { headers: { cookie: "locale=fr" } });
    expect(await t.body(fr)).toContain("lang fr");
    expect(fr.headers.get("vary")).toMatch(/cookie/i);
    const de = await t.get("/locale", { headers: { cookie: "locale=de" } });
    expect(de.headers.get("x-dusk-cache")).toBe("MISS");
    expect(await t.body(de)).toContain("lang de");
    const frAgain = await t.get("/locale", { headers: { cookie: "locale=fr" } });
    expect(frAgain.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await t.body(frAgain)).toContain("lang fr");
    expect(t.app.counts["locale"]).toBe(2);
  });

  it("[ISR-15] a cached page's CSP nonce is rewritten to the nonce of the response that serves it", async () => {
    const t = await boot({
      security: { allowedHosts: ["example.com"], csp: {} },
      document: { head: (event) => `<script nonce="${event.nonce ?? ""}">window.x = 1;</script>` },
    });
    const first = await t.get("/nonce");
    const firstNonce = /nonce-([A-Za-z0-9+/=_-]+)/.exec(
      first.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(firstNonce).toBeDefined();
    const second = await t.get("/nonce");
    expect(second.headers.get("x-dusk-cache")).toBe("HIT");
    const secondNonce = /nonce-([A-Za-z0-9+/=_-]+)/.exec(
      second.headers.get("content-security-policy") ?? "",
    )?.[1];
    expect(secondNonce).toBeDefined();
    expect(secondNonce).not.toBe(firstNonce);
    const body = await t.body(second);
    expect(body).toContain(`nonce="${secondNonce}"`);
    expect(body).not.toContain(`nonce="${firstNonce}"`);
  });

  it("[ISR-16] a body larger than maxEntryBytes is answered but not stored", async () => {
    const t = await boot({ cache: { maxEntryBytes: 1000 } });
    expect((await t.get("/big")).headers.get("x-dusk-cache")).toBe("MISS");
    expect((await t.get("/big")).headers.get("x-dusk-cache")).toBe("MISS");
    expect(t.app.counts["big"]).toBe(2);
  });

  it("[ISR-17] HEAD is answered from the cache without a body", async () => {
    const t = await boot();
    await t.get("/news");
    const head = await t.get("/news", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await head.text()).toBe("");
    expect(t.app.counts["news"]).toBe(1);
  });

  it("[ISR-18] middleware wraps cached answers: its headers are on the HIT too", async () => {
    const t = await boot({
      middleware: [
        async (_event, next) => {
          const response = await next();
          response.headers.set("x-mw", "yes");
          return response;
        },
      ],
    });
    await t.get("/news");
    const hit = await t.get("/news");
    expect(hit.headers.get("x-dusk-cache")).toBe("HIT");
    expect(hit.headers.get("x-mw")).toBe("yes");
  });

  it("[ISR-19] a revalidate that is not false or a positive number fails at startup", async () => {
    const app = await fixture();
    const bad = {
      ...manifestOf(app),
      routes: [
        {
          ...app.routes[0],
          spec: { ...app.routes[0]?.spec, revalidate: 0 },
        },
      ] as unknown as DuskRuntimeManifest["routes"],
    };
    expect(() =>
      createHandler({
        features: allFeatures(),
        manifest: bad,
        dev: true,
        onWarning: () => undefined,
      }),
    ).toThrow(TypeError);
  });

  it("[ISR-23] the key-value adapter over a fake shared store serves, purges and tags like the memory store", async () => {
    const kv = createFakeKeyValue({ now: () => 1_000_000 });
    const store = createKeyValueCacheStore(kv, { now: () => 1_000_000, prefix: "app:" });
    const t = await boot({ cache: { store } });
    await t.get("/news");
    expect((await t.get("/news")).headers.get("x-dusk-cache")).toBe("HIT");
    await t.get("/purge?path=/news");
    expect((await t.get("/news")).headers.get("x-dusk-cache")).toBe("MISS");
    expect(t.app.counts["news"]).toBe(2);
  });

  it("[ISR-24] with a bound on in-flight renders, distinct keys still render correctly", async () => {
    const t = await boot({
      cache: { maxInFlight: 1, store: createMemoryCacheStore({ maxEntries: 10 }) },
    });
    const [a, b] = await Promise.all([t.get("/news"), t.get("/forever")]);
    expect(await t.body(a)).toContain("news 1");
    expect(await t.body(b)).toContain("forever 1");
  });
});
