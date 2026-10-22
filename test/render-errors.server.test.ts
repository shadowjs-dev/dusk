import { describe, expect, it, vi } from "vitest";
import { createMemoryCacheStore } from "../src/server/cache-store";
import { createHandler, type DuskHandler, type DuskRuntimeManifest } from "../src/server/index";
import { errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * Pages whose components throw while rendering on the server, each with an error component (or none),
 * a loader that throws, and a streamed Suspense boundary whose content throws after the shell is sent.
 */
const APP = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { ErrorBoundary, Suspense } from "@shadow-js/web";
import { useResource } from "@shadow-js/core";
import { HttpError, getRequestEvent } from "@start/server";


export const gates = {};

const crash = defineRoute("/crash", {
  id: "crash",
  component: () => { throw new Error("render exploded: secret database detail"); },
  error: ({ error }) => <p class="crash">{error.message}</p>,
});
const forbidden = defineRoute("/forbidden", {
  id: "forbidden",
  component: () => { throw new HttpError(403, "not for you"); },
  error: ({ error }) => <p class="forbidden">{error.message}</p>,
});
const signin = defineRoute("/signin", {
  id: "signin",
  component: () => { throw new HttpError(401, "sign in again"); },
  error: ({ error }) => <p class="signin">{error.message}</p>,
});
const unavailable = defineRoute("/unavailable", {
  id: "unavailable",
  component: () => { throw new HttpError(503, "maintenance: db secret"); },
  error: ({ error }) => <p class="unavailable">{error.message}</p>,
});
const cached = defineRoute("/cached", {
  id: "cached",
  revalidate: 60,
  component: () => { throw new Error("cached render exploded"); },
  error: ({ error }) => <p class="cached">{error.message}</p>,
});
const bare = defineRoute("/bare", {
  id: "bare",
  component: () => { throw new Error("bare render exploded"); },
});
const loaderBoom = defineRoute("/loader-boom", {
  id: "loader-boom",
  loader: () => { throw new Error("loader exploded: db"); },
  component: () => <p>never</p>,
  error: ({ error }) => <p class="loader">{error.message}</p>,
});
const late = defineRoute("/late/:name", {
  id: "late",
  component: () => <p class="late-page">late page</p>,
});
const ok = defineRoute("/ok", { id: "ok", component: () => <p class="ok">fine</p> });

function Late(props) {
  const data = useResource(() => gates[props.name].promise, { key: "late-" + props.name });
  return ErrorBoundary({
    fallback: <p class="late-caught">failed</p>,
    get children() {
      if (data() !== undefined) throw new Error("late exploded: secret");
      return <p class="late-wait">waiting</p>;
    },
  });
}

export function App(props) {
  const path = getRequestEvent().url.pathname;
  const name = path.startsWith("/late/") ? path.slice(6) : undefined;
  return (
    <main class="app">
      {props.children}
      {name === undefined ? null : <Suspense fallback={<p class="fallback">loading</p>}><Late name={name} /></Suspense>}
    </main>
  );
}

const layout = defineRoute("", {
  id: "layout",
  component: function Layout() {
    return <div class="layout"><Outlet /></div>;
  },
  children: [crash, forbidden, signin, unavailable, cached, bare, loaderBoom, late, ok],
});
export const routes = [layout];
`;

interface RenderErrorApp {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly gates: Record<
    string,
    { promise: Promise<string>; resolve(value: string): void; reject(error: unknown): void }
  >;
}

const ORIGIN = "http://localhost";

/** Markup without hydration keys and region markers, which carry no meaning for these assertions. */
function plain(html: string): string {
  return html.replace(/ data-hk="[^"]*"/g, "").replace(/<!--\[-->|<!--\]-->/g, "");
}

function manifestOf(app: RenderErrorApp): DuskRuntimeManifest {
  return {
    routes: app.routes,
    apiRoutes: [],
    serverFns: {},
    assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
    App: app.App,
  };
}

/** A fresh app and handler. Production is `dev: false` with the localhost host allowed. */
async function boot(
  options: { dev?: boolean; mode?: "string" | "async" | "stream"; cache?: { store: unknown } } = {},
): Promise<{
  app: RenderErrorApp;
  handler: DuskHandler;
  log: ReturnType<typeof errorLog>;
}> {
  const app = await load<RenderErrorApp>(APP);
  const log = errorLog();
  const production = options.dev === false;
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: !production,
    ...(production ? { security: { allowedHosts: ["localhost"] } } : {}),
    onError: log.onError,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.cache === undefined ? {} : { cache: options.cache as never }),
  });
  return { app, handler, log };
}

function get(handler: DuskHandler, path: string, init: RequestInit = {}): Promise<Response> {
  return handler.fetch(new Request(`${ORIGIN}${path}`, init));
}

describe("render errors: the status of a page whose component throws", () => {
  it("[SRV-60] a render error is answered with the route's error UI, status 500, and reported once with the original error", async () => {
    const { handler, log } = await boot();
    const response = await get(handler, "/crash");
    expect(response.status).toBe(500);
    const html = plain(await response.text());
    expect(html).toContain('<p class="crash">render exploded: secret database detail</p>');
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.error)).toContain("render exploded: secret database detail");
    expect(log.errors[0]?.info.phase).toBe("render");
  });

  it("[SRV-61] in production the error UI shows the reason phrase, and neither the message nor the stack is sent", async () => {
    const { handler, log } = await boot({ dev: false });
    const response = await get(handler, "/crash");
    expect(response.status).toBe(500);
    const html = plain(await response.text());
    expect(html).toContain('<p class="crash">Internal Server Error</p>');
    expect(html).not.toContain("secret database detail");
    expect(html).not.toContain("render exploded");
    expect(html).not.toContain(" at ");
    // The sink still gets the original error.
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.error)).toContain("secret database detail");
  });

  it("[SRV-62] an HttpError thrown while rendering keeps its status (403, 401) and its message when it is a client error", async () => {
    const { handler, log } = await boot({ dev: false });
    const forbidden = await get(handler, "/forbidden");
    expect(forbidden.status).toBe(403);
    expect(plain(await forbidden.text())).toContain('<p class="forbidden">not for you</p>');
    const signin = await get(handler, "/signin");
    expect(signin.status).toBe(401);
    expect(plain(await signin.text())).toContain('<p class="signin">sign in again</p>');
    // A client error is an answer, not a fault: nothing is reported.
    expect(log.errors).toHaveLength(0);
  });

  it("[SRV-63] an HttpError 503 keeps its status in production, and its message stays on the server", async () => {
    const { handler, log } = await boot({ dev: false });
    const response = await get(handler, "/unavailable");
    expect(response.status).toBe(503);
    const html = plain(await response.text());
    expect(html).toContain('<p class="unavailable">Service Unavailable</p>');
    expect(html).not.toContain("db secret");
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.error)).toContain("db secret");
  });

  it("[SRV-64] the answer to a render error has the page's headers, and no cookie or cache header from the error", async () => {
    const { handler } = await boot();
    const response = await get(handler, "/crash");
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toMatch(/.+/);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("[SRV-65] an error in a streamed Suspense boundary after the shell does not change the status, and is reported once", async () => {
    const { app, handler, log } = await boot();
    let resolve: (value: string) => void = () => undefined;
    const promise = new Promise<string>((done) => {
      resolve = done;
    });
    app.gates["one"] = { promise, resolve, reject: () => undefined };
    const response = await get(handler, "/late/one");
    expect(response.status).toBe(200);
    // The shell carries the fallback; the boundary's error arrives after the status is fixed.
    resolve("ready");
    const html = plain(await response.text());
    expect(html).toContain('<p class="late-caught">failed</p>');
    expect(
      log.errors.filter((entry) => String(entry.error).includes("late exploded")),
    ).toHaveLength(1);
    expect(
      log.errors.find((entry) => String(entry.error).includes("late exploded"))?.info.phase,
    ).toBe("render");
  });

  it("[SRV-66] the string and async render modes answer a render error with status 500 and the error UI", async () => {
    for (const mode of ["string", "async"] as const) {
      const { handler, log } = await boot({ mode });
      const response = await get(handler, "/crash");
      expect(response.status, mode).toBe(500);
      expect(plain(await response.text()), mode).toContain(
        '<p class="crash">render exploded: secret database detail</p>',
      );
      expect(log.errors, mode).toHaveLength(1);
    }
  });

  it("[SRV-67] HEAD answers the status a GET answers, with no body", async () => {
    const { handler } = await boot();
    const response = await get(handler, "/crash", { method: "HEAD" });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });

  it("[SRV-68] a page that answers a render error is not stored by the ISR cache, and is rendered again", async () => {
    const store = createMemoryCacheStore();
    const set = vi.spyOn(store, "set");
    const { handler } = await boot({ cache: { store } });
    const first = await get(handler, "/cached");
    expect(first.status).toBe(500);
    expect(plain(await first.text())).toContain('<p class="cached">cached render exploded</p>');
    const second = await get(handler, "/cached");
    expect(second.status).toBe(500);
    expect(second.headers.get("x-dusk-cache")).not.toBe("HIT");
    expect(set).not.toHaveBeenCalled();
  });

  it("[SRV-69] a route without an error component still answers a render error with the built-in 500 page, reported once", async () => {
    const { handler, log } = await boot({ dev: false });
    const response = await get(handler, "/bare");
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Internal Server Error");
    expect(html).not.toContain("bare render exploded");
    expect(log.errors).toHaveLength(1);
  });

  it("[SRV-70] a loader error shown by its route's error UI is reported once, not again by the boundary that shows it", async () => {
    const { handler, log } = await boot();
    const response = await get(handler, "/loader-boom");
    expect(response.status).toBe(500);
    expect(plain(await response.text())).toContain('<p class="loader">loader exploded: db</p>');
    expect(log.errors).toHaveLength(1);
    expect(String(log.errors[0]?.error)).toContain("loader exploded: db");
  });

  it("[SRV-71] a page that renders fine keeps status 200 and reports nothing", async () => {
    const { handler, log } = await boot();
    const response = await get(handler, "/ok");
    expect(response.status).toBe(200);
    expect(plain(await response.text())).toContain('<p class="ok">fine</p>');
    expect(log.errors).toHaveLength(0);
  });
});
