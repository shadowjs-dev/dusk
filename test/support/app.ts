import type { DuskRuntimeManifest, ErrorInfo, HandlerOptions } from "../../src/server/index";
import { load } from "./compile";

/**
 * One app for the server tests: a layout with links, pages with loaders, a redirect, a not-found,
 * a failing loader, a streaming page behind Suspense, an API route and two server functions. The
 * module is compiled with the real compiler; the router and renderer are the real ones.
 */
const APP_SOURCE = `
import { defineRoute, Outlet, A, useLoaderData, useParams, redirect as routerRedirect, notFound } from "@shadow-js/router";
import { Suspense } from "@shadow-js/web";
import { useResource } from "@shadow-js/core";
import { HttpError, redirect, getRequestEvent, serverFn, apiRoute, json, createKey } from "@start/server";

export const gates = {};
export const calls = { post: 0, home: 0, secret: 0, fn: 0, clientOnly: 0, dataOnly: 0, spa: 0 };
export const rendered = { clientOnly: 0, dataOnly: 0, spa: 0 };
export const seen = { eventIds: [], streamed: [] };
export const userKey = createKey("user");

function Home() {
  const data = useLoaderData();
  return <p class="home">{data()?.greeting}</p>;
}
const home = defineRoute("/", {
  id: "home",
  loader: () => { calls.home += 1; return { greeting: "hello" }; },
  head: ({ loaderData }) => [
    { tag: "title", children: "Home | " + loaderData?.greeting },
    { tag: "meta", props: { name: "description", content: "The <home> page" } },
  ],
  component: Home,
});
function Post() {
  const data = useLoaderData();
  const params = useParams();
  return <article class="post"><h1>{data()?.title}</h1><p>id={params.id}</p></article>;
}
const post = defineRoute("/posts/:id", {
  id: "post",
  loader: ({ params }) => { calls.post += 1; return { title: "Post " + params.id }; },
  head: ({ loaderData, params }) => ({ tag: "title", children: loaderData?.title ?? "post " + params.id }),
  component: Post,
});
const old = defineRoute("/old", { id: "old", beforeLoad: () => { throw redirect("/posts/1", { status: 301 }); }, component: () => <p>never</p> });
const plainRedirect = defineRoute("/plain-redirect", { id: "plain-redirect", beforeLoad: () => { throw routerRedirect("/"); }, component: () => <p>never</p> });
const external = defineRoute("/external", { id: "external", beforeLoad: () => { throw redirect("https://evil.example/steal"); }, component: () => <p>never</p> });
const protocolRelative = defineRoute("/proto-relative", { id: "proto-relative", beforeLoad: () => { throw redirect("//evil.example/x"); }, component: () => <p>never</p> });
const broken = defineRoute("/broken", {
  id: "broken",
  loader: () => { throw new Error("secret database password is hunter2"); },
  component: () => <p>never</p>,
  error: ({ error }) => <p class="broken">{error.message}</p>,
});
const forbidden = defineRoute("/forbidden", {
  id: "forbidden",
  loader: () => { throw new HttpError(403, "not for you"); },
  component: () => <p>never</p>,
  error: ({ error }) => <p class="forbidden">{error.message}</p>,
});
const guarded = defineRoute("/guarded", {
  id: "guarded",
  beforeLoad: () => { calls.secret += 1; throw new HttpError(401, "sign in"); },
  component: () => <p>never</p>,
});
const crash = defineRoute("/crash", {
  id: "crash",
  beforeLoad: () => { throw new Error("beforeLoad exploded with secret details"); },
  component: () => <p>never</p>,
});
const gone = defineRoute("/gone", { id: "gone", loader: () => { throw notFound(); }, component: () => <p>never</p>, notFound: () => <p class="gone">nothing here</p> });
const search = defineRoute("/search", {
  id: "search",
  validateSearch: (raw) => ({ q: String(raw.q ?? "") }),
  component: () => <p class="search">search page</p>,
});
const xss = defineRoute("/xss/:value", {
  id: "xss",
  head: ({ params }) => [{ tag: "title", children: params.value }, { tag: "meta", props: { name: "x", content: params.value } }, { tag: "link", props: { rel: "canonical", href: "javascript:alert(1)" } }],
  component: () => { const params = useParams(); return <p class="xss">{params.value}</p>; },
});
// This app exercises a boundary alongside the outlet. Route-owned resources are covered by
// page-concurrency.server.test.ts through the real compiler and streaming page pipeline.
function Slow(props) {
  const name = props.name;
  const data = useResource(() => gates[name].promise, { key: "slow-" + name });
  const value = data();
  if (value !== undefined) seen.streamed.push({ name, eventId: getRequestEvent().id });
  return <p class="slow">{value ?? "…"}</p>;
}
const streaming = defineRoute("/stream/:name", {
  id: "streaming",
  component: () => <h2>shell</h2>,
});
const eventPage = defineRoute("/event", {
  id: "event",
  component: () => { const event = getRequestEvent(); seen.eventIds.push(event.id); return <p class="event">{event.url.pathname}</p>; },
});
const nested = defineRoute("/nested", { id: "nested", component: () => <div class="nested"><Outlet /></div>, children: [
  defineRoute("/child", { id: "nested-child", component: () => <p class="child">child</p> }),
] });
const clientOnly = defineRoute("/client-only", {
  id: "client-only",
  ssr: false,
  loader: () => { calls.clientOnly += 1; return { value: "client" }; },
  head: () => [{ tag: "title", children: "Client only" }],
  component: () => { rendered.clientOnly += 1; return <p class="never-on-server">client only</p>; },
});
const dataOnly = defineRoute("/data-only", {
  id: "data-only",
  ssr: "data-only",
  loader: () => { calls.dataOnly += 1; return { value: "loaded on the server" }; },
  head: () => [{ tag: "title", children: "Data only" }],
  component: () => { rendered.dataOnly += 1; return <p class="never-on-server">data only</p>; },
});
const dataOnlyGone = defineRoute("/data-only-gone", {
  id: "data-only-gone",
  ssr: "data-only",
  loader: () => { throw notFound(); },
  component: () => <p class="never-on-server">gone</p>,
});
const dataOnlyMoved = defineRoute("/data-only-moved", {
  id: "data-only-moved",
  ssr: "data-only",
  beforeLoad: () => { throw routerRedirect("/"); },
  component: () => <p class="never-on-server">moved</p>,
});
const spa = defineRoute("/spa", {
  id: "spa",
  ssr: false,
  component: () => { rendered.spa += 1; return <section class="never-on-server"><Outlet /></section>; },
  children: [defineRoute("/inner", { id: "spa-inner", loader: () => { calls.spa += 1; return 1; }, component: () => <p class="never-on-server">inner</p> })],
});
const ghost = defineRoute("/ghost", { id: "ghost", loader: () => { throw notFound(); }, component: () => <p>never</p> });
const withNotFoundLayout = defineRoute("", { id: "layout", component: function Layout() {
  return <div class="layout"><nav><A to="/">home</A></nav><Outlet /></div>;
}, notFound: () => <p class="nf">page not found</p>, children: [home, post, clientOnly, dataOnly, dataOnlyGone, dataOnlyMoved, spa, ghost, old, plainRedirect, external, protocolRelative, broken, forbidden, guarded, crash, gone, search, xss, streaming, eventPage, nested] });

export const routes = [withNotFoundLayout];

export function App(props) {
  const path = getRequestEvent().url.pathname;
  const name = path.startsWith("/stream/") ? path.slice(8) : undefined;
  return (
    <main class="app">
      {props.children}
      {name === undefined ? null : <Suspense fallback={<p class="fallback">loading</p>}><Slow name={name} /></Suspense>}
    </main>
  );
}

// API route
export const items = apiRoute({
  GET: (event) => json({ id: event.params.id ?? null, method: event.method }),
  POST: async (event) => json({ echoed: await event.request.json() }, { status: 201 }),
  PUT: () => new Response(null, { status: 204 }),
});
export const webhook = apiRoute({ csrf: false, POST: () => json({ received: true }) });
export const throwing = apiRoute({ GET: () => { throw new Error("api exploded with secret details"); } });
export const teapot = apiRoute({ GET: () => { throw new HttpError(418, "short and stout", { headers: { "x-teapot": "yes" } }); } });
export const redirecting = apiRoute({ GET: () => { throw redirect("/posts/2", { status: 303 }); } });
export const plain = apiRoute({ GET: () => "plain text", POST: () => ({ nested: [1, 2, 3] }) });

// Server functions
const schema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      if (typeof value === "object" && value !== null && typeof value.title === "string" && value.title.length > 0) {
        return { value: { title: value.title } };
      }
      return { issues: [{ message: "title is required", path: ["title"] }, { message: "second issue", path: [{ key: "x" }, 0] }] };
    },
  },
};
export const addTodo = serverFn({ input: schema }, async (input, event) => { calls.fn += 1; return { id: 1, title: input.title, by: event.id.length > 0 }; });
export const echo = serverFn({}, (input) => input);
export const readOnly = serverFn({ method: "GET" }, (input) => ({ got: input }));
export const redirecting_fn = serverFn({}, () => { throw redirect("/posts/9", { status: 303 }); });
export const failing = serverFn({}, () => { throw new Error("db connection string postgres://user:pass@host"); });
export const denied = serverFn({}, () => { throw new HttpError(403, "no access", { data: { reason: "plan" } }); });
export const guardedFn = serverFn({ middleware: [async ({ event }, next) => { if (event.request.headers.get("x-token") !== "ok") throw new HttpError(401, "missing token"); return next(); }] }, () => "secret value");
export const unserializable = serverFn({}, () => ({ run() {} }));
export const formFn = serverFn({ form: true }, (input) => ({ saved: input }));
export const withEvent = serverFn({}, (_input, event) => ({ id: event.id, path: event.url.pathname }));
export const nextTwice = serverFn({ middleware: [async (_ctx, next) => { await next(); return next(); }] }, () => 1);
`;

/** The compiled module of the shared app. */
export interface AppModule {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly gates: Record<
    string,
    { promise: Promise<string>; resolve(value: string): void; reject(error: unknown): void }
  >;
  readonly calls: {
    post: number;
    home: number;
    secret: number;
    fn: number;
    clientOnly: number;
    dataOnly: number;
    spa: number;
  };
  readonly rendered: { clientOnly: number; dataOnly: number; spa: number };
  readonly seen: { eventIds: string[]; streamed: Array<{ name: string; eventId: string }> };
  readonly [name: string]: unknown;
}

/** Loads a fresh copy of the shared app. */
export async function loadApp(): Promise<AppModule> {
  return load<AppModule>(APP_SOURCE);
}

/** Errors the handler reported, for assertions. */
export interface ErrorLog {
  readonly errors: Array<{ readonly error: unknown; readonly info: ErrorInfo }>;
  readonly onError: NonNullable<HandlerOptions["onError"]>;
}

/** A sink that records instead of printing. */
export function errorLog(): ErrorLog {
  const errors: ErrorLog["errors"] = [];
  return { errors, onError: (error, info) => void errors.push({ error, info }) };
}

/** Builds the manifest of the shared app. */
export function manifestOf(
  app: AppModule,
  overrides: Partial<DuskRuntimeManifest> = {},
): DuskRuntimeManifest {
  const lazy = <T>(value: unknown) => ({ load: async () => value as T });
  return {
    routes: app.routes,
    apiRoutes: [
      { id: "items", path: "/api/items/:id", load: async () => app["items"] as never },
      { id: "items-index", path: "/api/items", load: async () => app["items"] as never },
      { id: "webhook", path: "/api/webhook", load: async () => app["webhook"] as never },
      { id: "throwing", path: "/api/throwing", load: async () => app["throwing"] as never },
      { id: "teapot", path: "/api/teapot", load: async () => app["teapot"] as never },
      {
        id: "redirecting",
        path: "/api/redirecting",
        load: async () => app["redirecting"] as never,
      },
      { id: "plain", path: "/api/plain", load: async () => app["plain"] as never },
    ],
    serverFns: {
      addTodo: lazy(app["addTodo"]),
      echo: lazy(app["echo"]),
      readOnly: lazy(app["readOnly"]),
      redirecting: lazy(app["redirecting_fn"]),
      failing: lazy(app["failing"]),
      denied: lazy(app["denied"]),
      guarded: lazy(app["guardedFn"]),
      unserializable: lazy(app["unserializable"]),
      formFn: lazy(app["formFn"]),
      withEvent: lazy(app["withEvent"]),
      nextTwice: lazy(app["nextTwice"]),
    },
    assets: {
      entry: "/assets/entry-abc123.js",
      css: ["/assets/app-def456.css"],
      preloads: {
        post: ["/assets/post-chunk-111.js"],
        home: ["/assets/home-chunk-222.js", "/assets/font-333.woff2"],
      },
      base: "/",
    },
    App: app.App,
    ...overrides,
  };
}
