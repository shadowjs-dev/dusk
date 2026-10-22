import { beforeAll, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { type ErrorLog, errorLog } from "./support/app";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/**
 * One table of redirect targets drives every place a redirect can be thrown: a page `beforeLoad`,
 * a page loader, an API route, a server function and a classic form post. The target comes from the
 * request, so the same routes see every row.
 */
const SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { redirect, serverFn, apiRoute } from "@start/server";


const target = (context) => context.event.url.searchParams.get("to");
const before = defineRoute("/before", { id: "before", beforeLoad: ({ context }) => { throw redirect(target(context)); }, component: () => <p>never</p> });
const loaderRoute = defineRoute("/loader", { id: "loader", loader: ({ context }) => { throw redirect(target(context)); }, component: () => <p>never</p> });
export const routes = [before, loaderRoute];
export const App = (props) => <main>{props.children}</main>;
export const api = apiRoute({ GET: (event) => { throw redirect(event.url.searchParams.get("to")); } });
export const go = serverFn({}, (input) => { throw redirect(input); });
export const goForm = serverFn({ form: true }, (input) => { throw redirect(input.to); });
`;

interface Row {
  readonly name: string;
  readonly target: string;
  /** "blocked": 500 and no Location. "local": allowed, and the browser stays on this origin. */
  readonly expect: "blocked" | "local" | "trusted";
}

const ORIGIN = "https://app.test";

const TABLE: readonly Row[] = [
  { name: "protocol-relative", target: "//evil.example/x", expect: "blocked" },
  { name: "triple slash", target: "///evil.example", expect: "blocked" },
  { name: "slash backslash", target: "/\\evil.example", expect: "blocked" },
  { name: "double backslash", target: "\\\\evil.example", expect: "blocked" },
  { name: "single backslash", target: "\\evil.example", expect: "blocked" },
  { name: "tab inside", target: "/\t/evil.example", expect: "blocked" },
  { name: "header splitting", target: "/a\r\nSet-Cookie: x=y", expect: "blocked" },
  { name: "javascript scheme", target: "javascript:alert(1)", expect: "blocked" },
  { name: "mixed case scheme", target: "JaVaScRiPt:alert(1)", expect: "blocked" },
  { name: "data scheme", target: "data:text/html,x", expect: "blocked" },
  { name: "foreign origin", target: "https://evil.example/x", expect: "blocked" },
  { name: "scheme without slashes", target: "https:evil.example", expect: "blocked" },
  { name: "user info", target: "https://evil.example@app.test/", expect: "blocked" },
  { name: "encoded slash", target: "/%2F/evil.example", expect: "local" },
  { name: "encoded backslash", target: "/%5Cevil.example", expect: "local" },
  { name: "plain path", target: "/dashboard?tab=1", expect: "local" },
  { name: "own absolute URL", target: `${ORIGIN}/dashboard`, expect: "local" },
  { name: "trusted origin", target: "https://partner.example/x", expect: "trusted" },
];

interface App {
  readonly routes: never[];
  readonly App: never;
  readonly api: never;
  readonly go: never;
  readonly goForm: never;
}

let app: App;
let log: ErrorLog;
let handler: DuskHandler;
let client: TestClient;

function boot(trusted: boolean): void {
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: app.routes,
      apiRoutes: [{ id: "api", path: "/api", load: async () => app.api }],
      serverFns: {
        go: { load: async () => app.go },
        goForm: { load: async () => app.goForm },
      },
      assets: { entry: "/e.js", css: [], preloads: {}, base: "/" },
      App: app.App,
    },
    dev: false,
    security: { allowedHosts: ["app.test"] },
    ...(trusted ? { trustedOrigins: ["https://partner.example"] } : {}),
    onError: log.onError,
  });
  client = createTestClient(handler, { origin: ORIGIN });
}

/** True when a browser following `location` from the app stays on the app's origin. */
function staysOnOrigin(location: string): boolean {
  return URL.canParse(location, ORIGIN) && new URL(location, ORIGIN).origin === ORIGIN;
}

/** The location a server answered for `row` through `kind`, or undefined when it refused. */
type Outcome = { readonly status: number; readonly location: string | undefined };

const PATHS: ReadonlyArray<{
  readonly name: string;
  run(row: Row): Promise<Outcome>;
}> = [
  {
    name: "page beforeLoad",
    async run(row) {
      const response = await client.get(`/before?to=${encodeURIComponent(row.target)}`);
      return { status: response.status, location: response.headers.get("location") ?? undefined };
    },
  },
  {
    name: "page loader",
    async run(row) {
      const response = await client.get(`/loader?to=${encodeURIComponent(row.target)}`);
      return { status: response.status, location: response.headers.get("location") ?? undefined };
    },
  },
  {
    name: "API route",
    async run(row) {
      const response = await client.get(`/api?to=${encodeURIComponent(row.target)}`);
      return { status: response.status, location: response.headers.get("location") ?? undefined };
    },
  },
  {
    name: "server function",
    async run(row) {
      const result = await client.serverFn("go", row.target);
      return { status: result.status, location: result.redirect?.to };
    },
  },
  {
    name: "form post",
    async run(row) {
      const response = await client.post("/_dusk/fn/goForm", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ to: row.target }).toString(),
      });
      return { status: response.status, location: response.headers.get("location") ?? undefined };
    },
  },
];

beforeAll(async () => {
  app = await load<App>(SOURCE);
});

for (const path of PATHS) {
  describe(`redirect targets through a ${path.name}`, () => {
    it("[SRDT-10] every row of the table: blocked targets answer 500 with no Location, allowed ones stay on the origin", async () => {
      boot(true);
      for (const row of TABLE) {
        const outcome = await path.run(row);
        const label = `${path.name}: ${row.name} (${JSON.stringify(row.target)})`;
        if (row.expect === "blocked") {
          expect(outcome.status, label).toBe(500);
          expect(outcome.location, label).toBeUndefined();
        } else {
          expect(outcome.location, label).toBeDefined();
          expect(outcome.status, label).toBeLessThan(400);
          const location = outcome.location ?? "";
          expect(location.startsWith("//"), label).toBe(false);
          expect(location.includes("\\"), label).toBe(false);
          if (row.expect === "local") expect(staysOnOrigin(location), label).toBe(true);
          else expect(location, label).toBe(row.target);
        }
      }
    });

    it("[SRDT-11] a blocked target is reported once as REDIRECT_TARGET_BLOCKED and never reaches the body", async () => {
      boot(false);
      const outcome = await path.run({ name: "x", target: "//evil.example/x", expect: "blocked" });
      expect(outcome.status).toBe(500);
      const blocked = log.errors.filter((entry) =>
        String(entry.error).includes("REDIRECT_TARGET_BLOCKED"),
      );
      expect(blocked).toHaveLength(1);
    });

    it("[SRDT-12] without a trusted origin the partner origin is blocked as well", async () => {
      boot(false);
      const outcome = await path.run({
        name: "partner",
        target: "https://partner.example/x",
        expect: "blocked",
      });
      expect(outcome.status).toBe(500);
      expect(outcome.location).toBeUndefined();
    });
  });
}
