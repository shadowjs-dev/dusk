import { deserialize, serialize } from "@shadow-js/web/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { draftMode as draftFeature } from "../src/features/draft-mode";
import { rpc } from "../src/features/rpc";
import { secretsEqual } from "../src/server/draft-mode";
import {
  after as afterResponse,
  apiRoute,
  createHandler,
  type DuskHandler,
  draftMode,
  json,
  serverFn,
} from "../src/server/index";
import { load } from "./support/compile";
import { get, handmade, post } from "./support/sec2-core";

/**
 * PASS 2, scope D (server core): server function ids and the batch endpoint (SEC2-CORE-20 .. 25), draft mode
 * (26 .. 33) and `after()` (34 .. 40).
 */

const SECRET = "d".repeat(40);
const OTHER_SECRET = "e".repeat(40);
const CALL = { "content-type": "application/json", "x-dusk-fn": "1" };

/** The text of an answer with its per-request id blanked, so two answers compare byte for byte. */
async function shape(response: Response): Promise<string> {
  return (await response.text()).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>");
}

function bootFns(loads: string[], extra: Record<string, unknown> = {}): DuskHandler {
  const known = { ping: serverFn({}, () => "pong"), ...extra };
  const manifest = handmade([], {});
  return createHandler({
    features: [rpc()],
    manifest: {
      ...manifest,
      serverFns: Object.fromEntries(
        Object.entries(known).map(([id, definition]) => [
          id,
          {
            load: async () => {
              loads.push(id);
              return definition as never;
            },
          },
        ]),
      ),
    },
    dev: false,
    security: { allowedHosts: ["localhost"] },
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

describe("SEC2-CORE server function ids and batches", () => {
  it("[SEC2-CORE-20] a foreign id, an unknown id and a malformed id answer alike, and none of them loads a module", async () => {
    const loads: string[] = [];
    const handler = bootFns(loads);
    const ids = [
      "nope",
      "prototype",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "ping%2F..",
      "a".repeat(129),
      "ping%20",
      "PING",
    ];
    const bodies: string[] = [];
    for (const id of ids) {
      const response = await handler.fetch(post(`/_dusk/fn/${id}`, serialize([null]), CALL));
      expect(response.status, id).toBe(404);
      bodies.push(await shape(response));
    }
    // The same bytes for every one of them.
    expect(new Set(bodies).size).toBe(1);
    // No lookup past the table reached application code: the loader is not asked, so the time cannot differ either.
    expect(loads).toEqual([]);
    const ok = await handler.fetch(post("/_dusk/fn/ping", serialize([null]), CALL));
    expect(ok.status).toBe(200);
    expect(loads).toEqual(["ping"]);
  });

  it("[SEC2-CORE-21] a known id with the wrong method answers 405 and an unknown one 404: ids are public identifiers, not secrets", async () => {
    const handler = bootFns([], { read: serverFn({ method: "GET" }, () => 1) });
    const wrong = await handler.fetch(post("/_dusk/fn/read", serialize([null]), CALL));
    expect(wrong.status).toBe(405);
    const unknown = await handler.fetch(post("/_dusk/fn/zzz", serialize([null]), CALL));
    expect(unknown.status).toBe(404);
  });

  it("[SEC2-CORE-22] a batch item that names the batch endpoint or climbs the path is a 404 envelope; the other items still run", async () => {
    const loads: string[] = [];
    const handler = bootFns(loads);
    const body = serialize([
      { id: "_batch", input: [{ id: "ping", input: null }] },
      { id: "ping", input: null },
      { id: "../_batch", input: null },
      { id: "ping/../ping", input: null },
      { id: "ping", input: null },
    ]);
    const response = await handler.fetch(post("/_dusk/fn/_batch", body, CALL));
    expect(response.status).toBe(200);
    const text = await response.text();
    const parsed = (await import("@shadow-js/web/server")).deserialize(text) as Array<{
      ok?: boolean;
      error?: { status: number };
    }>;
    expect(parsed.map((item) => item.ok === true)).toEqual([false, true, false, false, true]);
    expect(parsed[0]?.error?.status).toBe(404);
    // The nested batch did not run its inner call.
    expect(loads).toEqual(["ping", "ping"]);
  });

  it("[SEC2-CORE-23] an id of 900 000 characters in a batch costs one regular expression test, not a lookup: 404 at once", async () => {
    const loads: string[] = [];
    const handler = bootFns(loads);
    const body = serialize([
      { id: "x".repeat(900_000), input: null },
      { id: "ping", input: null },
    ]);
    const started = performance.now();
    const response = await handler.fetch(post("/_dusk/fn/_batch", body, CALL));
    expect(response.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(loads).toEqual(["ping"]);
  });

  it("[SEC2-CORE-24] a batch of unknown ids loads nothing and a batch over rpc.maxBatchSize is refused before any call", async () => {
    const loads: string[] = [];
    const handler = bootFns(loads);
    const unknown = serialize(
      Array.from({ length: 25 }, (_, index) => ({ id: `u${index}`, input: null })),
    );
    expect((await handler.fetch(post("/_dusk/fn/_batch", unknown, CALL))).status).toBe(200);
    const tooMany = serialize(Array.from({ length: 26 }, () => ({ id: "ping", input: null })));
    expect((await handler.fetch(post("/_dusk/fn/_batch", tooMany, CALL))).status).toBe(413);
    expect(loads).toEqual([]);
  });
});

/** A handler with draft mode and one route that reports whether draft mode is on. */
function bootDraft(): DuskHandler {
  return createHandler({
    features: [apiRoutes(), draftFeature()],
    manifest: handmade([
      {
        id: "state",
        path: "/state",
        module: apiRoute({ GET: () => json({ draft: draftMode().enabled }) }),
      },
    ]),
    dev: false,
    security: { allowedHosts: ["localhost"] },
    draft: {},
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

const HTTPS = (path: string): string => `https://localhost${path}`;

function enable(secret: string): Request {
  return new Request(HTTPS("/_dusk/draft/enable"), {
    method: "POST",
    headers: {
      origin: "https://localhost",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ secret }),
  });
}

async function cookieOf(handler: DuskHandler, platform: Record<string, string>): Promise<string> {
  const response = await handler.fetch(enable(SECRET), platform);
  expect(response.status).toBe(200);
  const header = response.headers.getSetCookie()[0];
  if (header === undefined) throw new Error("no draft cookie was set");
  return header;
}

async function stateOf(
  handler: DuskHandler,
  platform: Record<string, string>,
  cookie: string,
): Promise<boolean> {
  const name = cookie.split(";")[0] ?? "";
  const response = await handler.fetch(
    new Request(HTTPS("/state"), { headers: { cookie: name } }),
    platform,
  );
  return ((await response.json()) as { draft: boolean }).draft;
}

describe("SEC2-CORE draft mode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("[SEC2-CORE-26] the enable and disable endpoints refuse GET and HEAD and set no cookie", async () => {
    const handler = bootDraft();
    const platform = { DUSK_DRAFT_SECRET: SECRET };
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/_dusk/draft/enable", "/_dusk/draft/disable"]) {
        const response = await handler.fetch(
          new Request(HTTPS(`${path}?secret=${SECRET}`), { method }),
          platform,
        );
        expect(response.status, `${method} ${path}`).toBe(405);
        expect(response.headers.getSetCookie(), `${method} ${path}`).toEqual([]);
      }
    }
  });

  it("[SEC2-CORE-27] a wrong secret, a missing secret and a secret in the query string enable nothing", async () => {
    const handler = bootDraft();
    const platform = { DUSK_DRAFT_SECRET: SECRET };
    for (const secret of ["", "x", SECRET.slice(0, -1), `${SECRET}x`, OTHER_SECRET]) {
      const response = await handler.fetch(enable(secret), platform);
      expect(response.status, secret).toBe(401);
      expect(response.headers.getSetCookie(), secret).toEqual([]);
    }
    const query = await handler.fetch(
      new Request(HTTPS(`/_dusk/draft/enable?secret=${SECRET}`), {
        method: "POST",
        headers: { origin: "https://localhost", "content-type": "application/json" },
        body: "{}",
      }),
      platform,
    );
    expect(query.status).toBe(401);
  });

  it("[SEC2-CORE-28] the draft cookie is HttpOnly, Secure, SameSite=Lax, Path=/ and expires (Max-Age)", async () => {
    const handler = bootDraft();
    const header = await cookieOf(handler, { DUSK_DRAFT_SECRET: SECRET });
    expect(header).toMatch(/^__dusk_draft=/);
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain=");
    const maxAge = /Max-Age=(\d+)/.exec(header);
    expect(maxAge, "a draft cookie without Max-Age lives as long as the browser").not.toBeNull();
    expect(Number(maxAge?.[1])).toBeGreaterThan(0);
    expect(Number(maxAge?.[1])).toBeLessThanOrEqual(24 * 3600);
  });

  it("[SEC2-CORE-29] the signed value expires on the server too: a stolen cookie stops working after its lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    const handler = bootDraft();
    const platform = { DUSK_DRAFT_SECRET: SECRET };
    const header = await cookieOf(handler, platform);
    const seconds = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
    expect(await stateOf(handler, platform, header)).toBe(true);
    vi.setSystemTime(Date.now() + (seconds - 5) * 1000);
    expect(await stateOf(handler, platform, header)).toBe(true);
    vi.setSystemTime(Date.now() + 10 * 1000);
    expect(await stateOf(handler, platform, header)).toBe(false);
  });

  it("[SEC2-CORE-30] rotating the secret ends every draft cookie at once (no old secret is kept)", async () => {
    const handler = bootDraft();
    const header = await cookieOf(handler, { DUSK_DRAFT_SECRET: SECRET });
    expect(await stateOf(handler, { DUSK_DRAFT_SECRET: SECRET }, header)).toBe(true);
    expect(await stateOf(handler, { DUSK_DRAFT_SECRET: OTHER_SECRET }, header)).toBe(false);
  });

  it("[SEC2-CORE-31] a forged, unsigned, re-named or truncated draft cookie is not draft mode", async () => {
    const handler = bootDraft();
    const platform = { DUSK_DRAFT_SECRET: SECRET };
    const header = await cookieOf(handler, platform);
    const value = (header.split(";")[0] ?? "").slice("__dusk_draft=".length);
    for (const forged of [
      "__dusk_draft=1",
      "__dusk_draft=",
      `__dusk_draft=${value.slice(0, -2)}`,
      `__dusk_draft=${value}AA`,
      `__dusk_draft=9999999999999.${value.split(".").pop()}`,
    ]) {
      expect(await stateOf(handler, platform, forged), forged).toBe(false);
    }
    // The same signature under another cookie name does not carry over (the signature binds the name).
    const response = await handler.fetch(
      new Request(HTTPS("/state"), { headers: { cookie: `session=${value}` } }),
      platform,
    );
    expect(((await response.json()) as { draft: boolean }).draft).toBe(false);
  });

  it("[SEC2-CORE-32] without a usable secret in the environment the endpoints are 404 and no cookie works", async () => {
    const handler = bootDraft();
    const none = await handler.fetch(enable(SECRET), {});
    expect(none.status).toBe(404);
    const short = await handler.fetch(enable("short"), { DUSK_DRAFT_SECRET: "short" });
    expect(short.status).toBe(404);
  });

  it("[SEC2-CORE-33] the secret comparison answers by content only (any length, any position of the difference)", async () => {
    expect(await secretsEqual(SECRET, SECRET)).toBe(true);
    expect(await secretsEqual(SECRET, `${SECRET}d`)).toBe(false);
    expect(await secretsEqual(SECRET, SECRET.slice(1))).toBe(false);
    expect(await secretsEqual(SECRET, `x${SECRET.slice(1)}`)).toBe(false);
    expect(await secretsEqual(SECRET, `${SECRET.slice(0, -1)}x`)).toBe(false);
    expect(await secretsEqual(SECRET, "")).toBe(false);
    expect(await secretsEqual("", "")).toBe(true);
    expect(await secretsEqual("\u00e9", "e\u0301")).toBe(false);
  });
});

describe("SEC2-CORE after() and instrumentation", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  function bootAfter(
    task: () => unknown,
    options: { onError?: (e: unknown) => void; hook?: () => void | Promise<void> } = {},
  ) {
    return createHandler({
      features: [apiRoutes()],
      manifest: handmade([
        {
          id: "a",
          path: "/a",
          module: apiRoute({
            GET: () => {
              afterResponse(task);
              return json({ ok: true });
            },
          }),
        },
      ]),
      dev: false,
      security: { allowedHosts: ["localhost"] },
      onError: options.onError ?? (() => undefined),
      onWarning: () => undefined,
      ...(options.hook === undefined ? {} : { instrumentation: { onRequestError: options.hook } }),
    });
  }

  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("[SEC2-CORE-34] a task that throws leaks nothing into the answer, is reported once, and the process sees no rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const errors: unknown[] = [];
    const handler = bootAfter(
      () => {
        throw new Error("SECRET-DB-PASSWORD hunter2 at /srv/app/after.ts:12");
      },
      { onError: (error) => void errors.push(error) },
    );
    const response = await handler.fetch(get("/a"));
    const text = await response.text();
    await turn();
    await turn();
    expect(response.status).toBe(200);
    expect(text).toBe('{"ok":true}');
    for (const [, value] of response.headers) expect(value).not.toContain("hunter2");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("hunter2");
    expect(unhandled).toEqual([]);
  });

  it("[SEC2-CORE-35] a task that rejects, a sink that throws and a hook that rejects together raise no unhandled rejection", async () => {
    process.on("unhandledRejection", onUnhandled);
    const handler = bootAfter(() => Promise.reject(new Error("late failure")), {
      onError: () => {
        throw new Error("the sink itself failed");
      },
      hook: () => Promise.reject(new Error("the hook failed")),
    });
    const response = await handler.fetch(get("/a"));
    await response.text();
    await turn();
    await turn();
    await turn();
    expect(response.status).toBe(200);
    expect(unhandled).toEqual([]);
    // Both failures went to the console as the last resort; the test setup wants that output asserted, then cleared.
    const logged = vi.mocked(console.error).mock.calls.map((args) => args.join(" "));
    expect(logged.some((line) => line.includes("the error sink threw"))).toBe(true);
    expect(logged.some((line) => line.includes("onRequestError failed"))).toBe(true);
    vi.mocked(console.error).mockClear();
  });

  it("[SEC2-CORE-36] a platform waitUntil that throws does not turn a finished answer into a 500, and the task still runs", async () => {
    let ran = false;
    const handler = bootAfter(() => {
      ran = true;
    });
    const response = await handler.fetch(get("/a"), {
      waitUntil: () => {
        throw new Error("waitUntil called after the response was sent");
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    await turn();
    expect(ran).toBe(true);
  });

  it("[SEC2-CORE-37] the work is handed to waitUntil as one promise, and a rejection inside it is reported, not thrown", async () => {
    const errors: unknown[] = [];
    let handed: Promise<unknown> | undefined;
    const handler = bootAfter(
      () => {
        throw new Error("inside waitUntil");
      },
      { onError: (error) => void errors.push(error) },
    );
    const response = await handler.fetch(get("/a"), {
      waitUntil: (promise: Promise<unknown>) => {
        handed = promise;
      },
    });
    expect(response.status).toBe(200);
    await expect(handed).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("[SEC2-CORE-38] without waitUntil the tasks start when the body has been read, not before the answer is sent", async () => {
    let ran = false;
    const handler = bootAfter(() => {
      ran = true;
    });
    const response = await handler.fetch(get("/a"));
    await turn();
    await turn();
    expect(ran, "the task ran while the body was still unread").toBe(false);
    await response.text();
    await turn();
    expect(ran).toBe(true);
  });

  it("[SEC2-CORE-39] a client that cancels the body does not lose the tasks", async () => {
    let ran = false;
    const handler = bootAfter(() => {
      ran = true;
    });
    const response = await handler.fetch(get("/a"));
    await response.body?.cancel();
    await turn();
    await turn();
    expect(ran).toBe(true);
  });

  it("[SEC2-CORE-40] an answer without a body starts its tasks too", async () => {
    let ran = false;
    const handler = createHandler({
      features: [apiRoutes()],
      manifest: handmade([
        {
          id: "n",
          path: "/n",
          module: apiRoute({
            GET: () => {
              afterResponse(() => {
                ran = true;
              });
              return new Response(null, { status: 204 });
            },
          }),
        },
      ]),
      dev: false,
      security: { allowedHosts: ["localhost"] },
      onError: () => undefined,
    });
    const response = await handler.fetch(get("/n"));
    expect(response.status).toBe(204);
    await turn();
    await turn();
    expect(ran).toBe(true);
  });
});

const FLIGHT_SOURCE = `
import { defineRoute, useLoaderData } from "@shadow-js/router";
import { serverFn, getRequestEvent } from "@start/server";

export const seen = [];
export const save = serverFn({ singleFlight: true }, () => "saved");
const news = defineRoute("/news", {
  id: "news",
  loader: () => { const host = getRequestEvent().url.host; seen.push(host); return { host }; },
  component: () => { const data = useLoaderData(); return <p>{data()?.host}</p>; },
});
export const routes = [news];
export function App(props) { return <main>{props.children}</main>; }
`;

describe("SEC2-CORE single flight", () => {
  it("[SEC2-CORE-93] (already safe) the page location of a single-flight call stays on this origin: /\\host runs no loader", async () => {
    const app = await load<{
      routes: never;
      App: never;
      save: unknown;
      seen: string[];
    }>(FLIGHT_SOURCE);
    const handler = createHandler({
      features: [
        rpc(),
        (await import("../src/features/pages")).pages({
          routerFeatures: [(await import("@shadow-js/router/loaders")).loaderCache({})],
        }),
      ],
      manifest: {
        ...handmade([], { save: app.save }),
        routes: app.routes,
        App: app.App,
      },
      dev: true,
      security: { allowedHosts: ["example.com"] },
      onError: () => undefined,
      onWarning: () => undefined,
    });
    const send = async (location: string): Promise<unknown> => {
      const response = await handler.fetch(
        new Request("https://example.com/_dusk/fn/save", {
          method: "POST",
          headers: { ...CALL, origin: "https://example.com", "x-dusk-location": location },
          body: serialize([null]),
        }),
      );
      return deserialize(await response.text());
    };
    expect(await send("/\\evil.example/news")).toEqual({ ok: true, value: "saved" });
    expect(await send("/ /evil.example/news")).toEqual({ ok: true, value: "saved" });
    expect(app.seen).toEqual([]);
    // The page's own location is revalidated, and it sees this host.
    const own = (await send("/news")) as { revalidated?: unknown };
    expect(own.revalidated).toBeDefined();
    expect(app.seen).toEqual(["example.com"]);
  });
});
