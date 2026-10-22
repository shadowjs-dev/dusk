import { describe, expect, it, vi } from "vitest";
import { createHandler, type DuskRuntimeManifest, platformHost } from "../../src/server/index";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";

/**
 * The page cache at scale through a whole handler: real pages compiled with the real compiler, real requests with
 * their own abort signals, and the platform's `waitUntil` as an adapter passes it.
 */
const SOURCE = `
import { defineRoute, useLoaderData } from "@shadow-js/router";
import { getRequestEvent } from "@start/server";

export const counts = { slow: 0 };
export const control = { hold: null, fail: false, signals: [] };

function Text(props) { return <p class="t">{props.text}</p>; }

const slow = defineRoute("/slow", {
  id: "slow",
  revalidate: 60,
  cache: { staleSeconds: 120 },
  loader: async () => {
    counts.slow += 1;
    control.signals.push(getRequestEvent().signal);
    if (control.hold !== null) await control.hold;
    if (control.fail) throw new Error("upstream is down");
    return { n: counts.slow };
  },
  component: () => { const data = useLoaderData(); return <Text text={"slow " + (data()?.n ?? 0)} />; },
});

export const routes = [slow];
export function App(props) { return <main class="app">{props.children}</main>; }
`;

interface Fixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly counts: { slow: number };
  readonly control: { hold: Promise<void> | null; fail: boolean; signals: AbortSignal[] };
}

async function boot() {
  const app = await load<Fixture>(SOURCE);
  const clock = { now: 1_000_000 };
  const errors: unknown[] = [];
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
    onError: (error) => void errors.push(error),
    onWarning: () => undefined,
    cache: { now: () => clock.now },
  });
  const get = (path: string, init?: RequestInit, platform?: unknown) =>
    handler.fetch(new Request(`https://example.com${path}`, init), platform);
  return { app, clock, errors, get };
}

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ISR at scale through the handler", () => {
  it("[SCALE-ISR-H1] 60 concurrent first requests run the loader once; every response is 200 with its own complete body", async () => {
    const t = await boot();
    const held = latch();
    t.app.control.hold = held.promise;
    const pending = Array.from({ length: 60 }, () => t.get("/slow"));
    await vi.waitFor(() => expect(t.app.counts.slow).toBe(1));
    held.release();
    const responses = await Promise.all(pending);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(t.app.counts.slow).toBe(1);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(bodies.every((body) => body.includes("slow 1"))).toBe(true);
    expect(new Set(responses.map((response) => response.headers.get("x-dusk-cache")))).toEqual(
      new Set(["MISS"]),
    );
  });

  it("[SCALE-ISR-H2] one client hanging up does not cancel the render the others wait for; the page is cached for later", async () => {
    const t = await boot();
    const held = latch();
    t.app.control.hold = held.promise;
    const leaving = new AbortController();
    const stays = t.get("/slow");
    const left = t.get("/slow", { signal: leaving.signal });
    await vi.waitFor(() => expect(t.app.counts.slow).toBe(1));
    leaving.abort();
    expect((await left).status).toBe(499);
    expect(t.app.control.signals[0]?.aborted).toBe(false);
    held.release();
    expect((await stays).status).toBe(200);
    t.app.control.hold = null;
    const later = await t.get("/slow");
    expect(later.headers.get("x-dusk-cache")).toBe("HIT");
    expect(t.app.counts.slow).toBe(1);
  });

  it("[SCALE-ISR-H3] a stale page is served at once and its refresh goes to the platform's waitUntil; Age and s-maxage describe it", async () => {
    const t = await boot();
    await t.get("/slow");
    t.clock.now += 70_000;
    const taken: Promise<unknown>[] = [];
    const platform = platformHost({}, { waitUntil: (work) => void taken.push(work) });
    const stale = await t.get("/slow", undefined, platform);
    expect(stale.headers.get("x-dusk-cache")).toBe("STALE");
    expect(stale.headers.get("age")).toBe("70");
    expect(stale.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
    );
    expect(await stale.text()).toContain("slow 1");
    expect(taken).toHaveLength(1);
    await taken[0];
    const fresh = await t.get("/slow");
    expect(fresh.headers.get("x-dusk-cache")).toBe("HIT");
    expect(await fresh.text()).toContain("slow 2");
  });

  it("[SCALE-ISR-H4] a refresh that fails keeps the stale page and reports the error once to onError, then backs off", async () => {
    const t = await boot();
    await t.get("/slow");
    t.clock.now += 70_000;
    t.app.control.fail = true;
    const first = await t.get("/slow");
    expect(first.headers.get("x-dusk-cache")).toBe("STALE");
    await vi.waitFor(() => expect(t.app.counts.slow).toBe(2));
    await vi.waitFor(() => expect(t.errors.length).toBeGreaterThan(0));
    const reported = t.errors.length;
    const second = await t.get("/slow");
    expect(second.headers.get("x-dusk-cache")).toBe("STALE");
    expect(await second.text()).toContain("slow 1");
    expect(t.app.counts.slow).toBe(2);
    expect(t.errors.length).toBe(reported);
  });
});
