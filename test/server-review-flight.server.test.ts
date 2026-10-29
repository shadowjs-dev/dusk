import { defineRoute } from "@shadow-js/router";
import { deserialize, serialize } from "@shadow-js/web/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  getRequestEvent,
  HttpError,
  type Middleware,
  type RouteMiddlewareManifest,
  redirect,
  serverFn,
} from "../src/server/index";
import { allFeatures } from "./support/features";

/**
 * Single-flight answers run the loaders of the page the browser is on. The page's server middleware (a `_middleware`
 * folder, a route's `middleware` export) decides who may see those loaders, so it runs here as it does for the page.
 */

const ORIGIN = "https://example.com";
let loaderRuns = 0;
let trace: string[] = [];

beforeEach(() => {
  loaderRuns = 0;
  trace = [];
});

/** Reads the locals of the running request as plain data. */
function localsOf(): Record<string, unknown> {
  return { ...getRequestEvent().locals } as Record<string, unknown>;
}

const requireSession: Middleware = (event, next) => {
  trace.push("page-middleware");
  if (event.cookies.get("sid") !== "ok") throw new HttpError(403, "sign in first");
  (event.locals as Record<string, unknown>)["role"] = "admin";
  return next();
};
const bounce: Middleware = () => {
  throw redirect("/login");
};

const secret = defineRoute("/secret", {
  id: "secret",
  loader: () => {
    loaderRuns += 1;
    return { secret: "TOP-SECRET", locals: localsOf() };
  },
});
const open = defineRoute("/open", {
  id: "open",
  loader: () => {
    loaderRuns += 1;
    return { locals: localsOf() };
  },
});
const moved = defineRoute("/moved", {
  id: "moved",
  loader: () => {
    loaderRuns += 1;
    return { moved: true };
  },
});

const middleware: RouteMiddlewareManifest = {
  routes: {},
  directories: {
    secret: { load: async () => [requireSession] },
    moved: { load: async () => [bounce] },
  },
  pages: { secret: ["secret"], moved: ["moved"] },
  apis: {},
};

const save = serverFn({ singleFlight: true }, () => "saved");

function boot(): DuskHandler {
  const manifest: DuskRuntimeManifest = {
    routes: [secret, open, moved],
    apiRoutes: [],
    serverFns: { save: { load: async () => save as never } },
    assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
    App: (props: { children?: unknown }) => props.children as never,
    middleware,
  };
  return createHandler({
    features: allFeatures(),
    manifest,
    dev: false,
    security: { allowedHosts: ["example.com"] },
    // The app-wide middleware: it identifies the visitor for every request, the mutation included.
    middleware: [
      (event, next) => {
        (event.locals as Record<string, unknown>)["who"] = "ada";
        return next();
      },
    ],
    onError: () => undefined,
    onWarning: () => undefined,
  });
}

interface Answer {
  readonly ok: boolean;
  readonly value: unknown;
  readonly revalidated?: {
    readonly matches: readonly { readonly id: string; readonly value: unknown }[];
  };
}

async function call(handler: DuskHandler, location: string, cookie?: string): Promise<Answer> {
  const response = await handler.fetch(
    new Request(`${ORIGIN}/_dusk/fn/save`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "x-dusk-fn": "1",
        "x-dusk-location": location,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: serialize([{}]),
    }),
  );
  return deserialize(await response.text()) as Answer;
}

describe("single flight and the middleware of the page", () => {
  it("[DUSK-SRV-REV-15] a page whose middleware refuses the visitor gets no loader data, and its loader does not run", async () => {
    const answer = await call(boot(), "/secret");
    expect(answer.ok).toBe(true);
    expect(answer.value).toBe("saved");
    expect(answer.revalidated).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("TOP-SECRET");
    expect(loaderRuns).toBe(0);
    expect(trace).toEqual(["page-middleware"]);
  });

  it("[DUSK-SRV-REV-16] a page whose middleware redirects gets no loader data either", async () => {
    const answer = await call(boot(), "/moved");
    expect(answer.revalidated).toBeUndefined();
    expect(loaderRuns).toBe(0);
  });

  it("[DUSK-SRV-REV-17] when the middleware lets the visitor in, the loader runs with the locals of the app-wide and the page middleware", async () => {
    const answer = await call(boot(), "/secret", "sid=ok");
    expect(loaderRuns).toBe(1);
    expect(answer.revalidated?.matches.map((match) => match.id)).toEqual(["secret"]);
    expect(answer.revalidated?.matches[0]?.value).toEqual({
      secret: "TOP-SECRET",
      locals: { who: "ada", role: "admin" },
    });
  });

  it("[DUSK-SRV-REV-18] a page with no middleware still sees the locals the app-wide middleware set", async () => {
    const answer = await call(boot(), "/open");
    expect(answer.revalidated?.matches[0]?.value).toEqual({ locals: { who: "ada" } });
  });
});
