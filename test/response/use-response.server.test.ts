import { describe, expect, it, vi } from "vitest";
import { createHandler, type DuskRuntimeManifest } from "../../src/server/index";
import { errorLog, manifestOf } from "../support/app";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";

/**
 * `useResponse()` on the server: a component, a loader, a middleware or a data-only page sets the status,
 * headers and cookies of its own response. A write after the first byte is a dev warning and changes nothing.
 * Outside a request (on the client, or in a test) the same calls do nothing and never throw.
 */
const SOURCE = `
import { defineRoute } from "@shadow-js/router";
import { Suspense } from "@shadow-js/web";
import { useResource } from "@shadow-js/core";
import { useResponse } from "@shadow-js/dusk";


export const gate = { promise: null, resolve: null };
export const checks = { outside: null };

function Status() {
  const response = useResponse();
  response.setStatus(201);
  response.setHeader("x-render", "sync");
  response.appendHeader("x-list", "one");
  response.appendHeader("x-list", "two");
  response.setCookie("theme", "dark", { path: "/" });
  response.deleteCookie("old", { path: "/" });
  let rangeError = "none";
  try { response.setStatus(99); } catch (error) { rangeError = error.name; }
  let headerError = "none";
  try { response.setHeader("set-cookie", "a=b"); } catch (error) { headerError = error.name; }
  response.setHeader("x-checks", rangeError + " " + headerError);
  return <p class="status">created</p>;
}
const status = defineRoute("/status", { id: "status", component: Status });

const loaderStatus = defineRoute("/loader-status", {
  id: "loader-status",
  loader: () => { useResponse().setStatus(202); return { ok: true }; },
  component: () => <p class="loader-status">accepted</p>,
});

const dataOnly = defineRoute("/data-only", {
  id: "data-only",
  ssr: "data-only",
  loader: () => { useResponse().setStatus(203); return { ok: true }; },
  component: () => <p class="never">data only</p>,
});

function Late() {
  const data = useResource(() => gate.promise, { key: "late" });
  const value = data();
  if (value !== undefined) useResponse().setStatus(418);
  return <p class="late">{value ?? "waiting"}</p>;
}

const late = defineRoute("/late", { id: "late", component: () => <p class="shell">shell</p> });

const headers = defineRoute("/headers-only", {
  id: "headers-only",
  component: () => { useResponse().setHeader("x-page", "yes"); return <p>headers</p>; },
});

export const routes = [status, loaderStatus, dataOnly, late, headers];

export const middleware = [
  (event, next) => {
    useResponse().setHeader("x-middleware", "yes");
    return next();
  },
];

export function App(props) {
  return (
    <main class="app">
      {props.children}
      <Suspense fallback={null}>{gate.promise === null ? null : <Late />}</Suspense>
    </main>
  );
}
`;

interface Compiled {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly middleware: readonly unknown[];
  readonly gate: { promise: Promise<string> | null; resolve: ((value: string) => void) | null };
}

const ORIGIN = "http://localhost";

async function boot(mode: "string" | "async" | "stream") {
  const compiled = await load<Compiled>(SOURCE);
  const log = errorLog();
  const manifest: DuskRuntimeManifest = manifestOf(
    { routes: compiled.routes, App: compiled.App } as never,
    { apiRoutes: [], serverFns: {} },
  );
  const handler = createHandler({
    features: allFeatures(),
    manifest,
    dev: true,
    onError: log.onError,
    mode,
    middleware: compiled.middleware as never,
  });
  return { compiled, handler, log };
}

function get(handler: { fetch(request: Request): Promise<Response> }, path: string) {
  return handler.fetch(new Request(`${ORIGIN}${path}`));
}

const MODES = ["string", "async", "stream"] as const;

describe("useResponse on the server", () => {
  it.each(MODES)(
    "[RSP-1] a component sets status, headers and cookies of its response (%s mode)",
    async (mode) => {
      const { handler } = await boot(mode);
      const response = await get(handler, "/status");
      expect(response.status).toBe(201);
      expect(response.headers.get("x-render")).toBe("sync");
      expect(response.headers.get("x-list")).toBe("one, two");
      const cookies = response.headers.getSetCookie();
      expect(
        cookies.some((cookie) => cookie.startsWith("theme=dark;") && cookie.includes("Path=/")),
      ).toBe(true);
      expect(
        cookies.some((cookie) => cookie.startsWith("old=;") && cookie.includes("Max-Age=0")),
      ).toBe(true);
      expect(await response.text()).toContain("created");
    },
  );

  it.each(MODES)(
    "[RSP-2] an invalid status and a reserved header are refused with a RangeError and a TypeError (%s mode)",
    async (mode) => {
      const { handler } = await boot(mode);
      const response = await get(handler, "/status");
      expect(response.headers.get("x-checks")).toBe("RangeError TypeError");
    },
  );

  it.each(MODES)("[RSP-3] a loader's status stands for the page (%s mode)", async (mode) => {
    const { handler } = await boot(mode);
    const response = await get(handler, "/loader-status");
    expect(response.status).toBe(202);
    expect(await response.text()).toContain("accepted");
  });

  it("[RSP-4] a data-only page keeps the status its loader set", async () => {
    const { handler } = await boot("string");
    const response = await get(handler, "/data-only");
    expect(response.status).toBe(203);
  });

  it.each(MODES)(
    "[RSP-5] a middleware sets a header that reaches the response (%s mode)",
    async (mode) => {
      const { handler } = await boot(mode);
      const response = await get(handler, "/headers-only");
      expect(response.headers.get("x-middleware")).toBe("yes");
      expect(response.headers.get("x-page")).toBe("yes");
    },
  );

  it("[RSP-6] a write after the shell is streamed is a dev warning and changes nothing", async () => {
    const { compiled, handler, log } = await boot("stream");
    let resolveLate: (value: string) => void = () => undefined;
    compiled.gate.promise = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const response = await get(handler, "/late");
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("shell");
    resolveLate("late value");
    let text = "";
    for (;;) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("late value");
    // The setup spies on console.warn: the message is read and cleared here, so the test asserts it.
    const warnings = vi.mocked(console.warn).mock.calls.map((args) => args.map(String).join(" "));
    vi.mocked(console.warn).mockClear();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("useResponse");
    expect(log.errors).toHaveLength(0);
  });

  it("[RSP-7] outside a request the calls do nothing and never throw", async () => {
    const { useResponse } = await import("../../src/shared/response");
    const response = useResponse();
    expect(response.inRequest).toBe(false);
    expect(() => {
      response.setStatus(500);
      response.setHeader("x-outside", "yes");
      response.appendHeader("x-outside", "yes");
      response.setCookie("a", "b");
      response.deleteCookie("a");
    }).not.toThrow();
  });
});
