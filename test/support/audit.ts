import { createHandler, type DuskHandler, type HandlerOptions } from "../../src/server/index";
import { createTestClient, type TestClient } from "../../src/testing/index";
import { errorLog, manifestOf } from "./app";
import { load } from "./compile";
import { allFeatures } from "./features";

/**
 * A small application for the security audit. Only plain routes (no loader, head or error options), so
 * it renders on the router without the feature modules. Every interesting response is a server function
 * or an API route that reflects what it was given, so a test can see exactly what the handler let through.
 */
const AUDIT_SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { HttpError, redirect, serverFn, apiRoute, json, readJson, getRequestEvent } from "@start/server";


export const App = (props) => <main>{props.children}</main>;

const home = defineRoute("/", { id: "home", component: () => <p class="home">home</p> });
const dashboard = defineRoute("/dashboard", { id: "dashboard", component: () => <p class="dashboard">secret dashboard</p> });
const notes = defineRoute("/notes/:id", { id: "notes", component: () => <p class="notes">note</p> });
export const routes = [home, dashboard, notes];

export const goForm = serverFn({ form: true }, (input) => { throw redirect(input.to); });
export const go = serverFn({}, (input) => { throw redirect(input); });
export const echo = serverFn({}, (input) => ({ got: input }));
export const saveForm = serverFn({ form: true }, (input) => ({ saved: input }));
export const pathOf = serverFn({}, () => ({ path: getRequestEvent().url.pathname, id: getRequestEvent().id }));
export const failing = serverFn({}, () => { throw new Error("db password is hunter2 at /srv/private/key.pem"); });
export const denied = serverFn({}, () => { throw new HttpError(403, "no access", { data: { reason: "plan" } }); });
export const readOnly = serverFn({ method: "GET" }, (input) => ({ got: input }));
export const api = apiRoute({
  GET: (event) => json({ query: Object.fromEntries(event.url.searchParams), path: event.url.pathname }),
  POST: async (event) => json({ echoed: await event.request.text() }),
});
export const openApi = apiRoute({ csrf: false, POST: () => json({ ok: true }) });
export const jsonBody = apiRoute({ POST: async (event) => json({ ok: await readJson(event.request) }) });
export const boom = apiRoute({ GET: () => { throw new Error("internal details /srv/x secret=abc"); } });
`;

/** The compiled audit application. */
export interface AuditApp {
  readonly routes: unknown[];
  readonly App: unknown;
  readonly goForm: unknown;
  readonly go: unknown;
  readonly echo: unknown;
  readonly saveForm: unknown;
  readonly pathOf: unknown;
  readonly failing: unknown;
  readonly denied: unknown;
  readonly readOnly: unknown;
  readonly api: unknown;
  readonly openApi: unknown;
  readonly jsonBody: unknown;
  readonly boom: unknown;
}

/** Compiles the audit application with the real compiler. */
export async function loadAuditApp(): Promise<AuditApp> {
  return load<AuditApp>(AUDIT_SOURCE);
}

/** Builds a handler over the audit application. */
export function auditHandler(
  app: AuditApp,
  options: Partial<HandlerOptions> = {},
): { handler: DuskHandler; log: ReturnType<typeof errorLog> } {
  const log = errorLog();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app as never, {
      routes: app.routes as never,
      apiRoutes: [
        { id: "api", path: "/api/items", load: async () => app.api as never },
        { id: "open-api", path: "/api/open", load: async () => app.openApi as never },
        { id: "json-body", path: "/api/json", load: async () => app.jsonBody as never },
        { id: "boom", path: "/api/boom", load: async () => app.boom as never },
      ],
      serverFns: {
        goForm: { load: async () => app.goForm as never },
        go: { load: async () => app.go as never },
        echo: { load: async () => app.echo as never },
        saveForm: { load: async () => app.saveForm as never },
        pathOf: { load: async () => app.pathOf as never },
        failing: { load: async () => app.failing as never },
        denied: { load: async () => app.denied as never },
        readOnly: { load: async () => app.readOnly as never },
      },
    }),
    dev: false,
    security: { allowedHosts: ["app.test"] },
    onError: log.onError,
    ...options,
  });
  return { handler, log };
}

/** A test client for the audit handler, on the app's own origin. */
export function auditClient(handler: DuskHandler): TestClient {
  return createTestClient(handler, { origin: "https://app.test" });
}
