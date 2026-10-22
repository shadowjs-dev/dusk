import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import {
  createHandler,
  type DuskHandler,
  type DuskRuntimeManifest,
  type Middleware,
} from "../src/server/index";

/**
 * `runMiddlewareForStaticFiles`: with the option off (the default) a file in the static directory is answered before
 * the global middleware, as before. With it on, the middleware runs for a request that names a file: it can refuse the
 * file, and the headers and cookies it sets go out with the file.
 */

const App = (props: { children?: unknown }) => props.children;

const manifest: DuskRuntimeManifest = {
  routes: [],
  apiRoutes: [],
  serverFns: {},
  assets: { entry: "/assets/app.js", css: [], preloads: {}, base: "/" },
  App,
};

const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory with the given files. */
function staticDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "shadow-static-middleware-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

/** The middleware under test: records each path, refuses one file, and sets a header and a cookie on the rest. */
function recordingGate(seen: string[]): Middleware {
  return async (event, next) => {
    seen.push(event.url.pathname);
    if (event.url.pathname === "/private.txt") return new Response("Unauthorized", { status: 401 });
    if (event.url.pathname === "/boom.txt") throw new Error("the gate failed");
    const response = await next();
    event.responseHeaders.set("x-gate", "passed");
    event.cookies.set("seen", "1", { path: "/" });
    return response;
  };
}

async function boot(handler: DuskHandler, dir: string): Promise<ServerHandle> {
  const server = await serve(handler, {
    port: 0,
    host: "127.0.0.1",
    shutdownSignals: false,
    static: { dir },
  });
  servers.push(server);
  return server;
}

describe("static files and the global middleware", () => {
  it("[SMW-01] by default a file is served before the middleware: the middleware does not run for it", async () => {
    const seen: string[] = [];
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [recordingGate(seen)],
      onError: () => undefined,
    });
    const server = await boot(handler, staticDir({ "hello.txt": "hi there" }));
    const response = await fetch(`${server.url}/hello.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi there");
    expect(response.headers.get("x-gate")).toBeNull();
    expect(seen).toEqual([]);
    expect(handler.gateAsset).toBeUndefined();
  });

  it("[SMW-02] with runMiddlewareForStaticFiles the middleware runs for a file, and its headers and cookies go out with it", async () => {
    const seen: string[] = [];
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [recordingGate(seen)],
      runMiddlewareForStaticFiles: true,
      onError: () => undefined,
    });
    const server = await boot(handler, staticDir({ "hello.txt": "hi there" }));
    const response = await fetch(`${server.url}/hello.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hi there");
    expect(response.headers.get("x-gate")).toBe("passed");
    expect(response.headers.get("set-cookie")).toContain("seen=1");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(seen).toEqual(["/hello.txt"]);
    expect(handler.gateAsset).toBeDefined();
  });

  it("[SMW-03] a middleware that refuses a file answers the refusal, and the file is not sent", async () => {
    const seen: string[] = [];
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [recordingGate(seen)],
      runMiddlewareForStaticFiles: true,
      onError: () => undefined,
    });
    const server = await boot(handler, staticDir({ "private.txt": "secret" }));
    const response = await fetch(`${server.url}/private.txt`);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(seen).toEqual(["/private.txt"]);
  });

  it("[SMW-04] a path that names no file goes to the handler once, as any other request", async () => {
    const seen: string[] = [];
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [recordingGate(seen)],
      runMiddlewareForStaticFiles: true,
      onError: () => undefined,
    });
    const server = await boot(handler, staticDir({ "hello.txt": "hi" }));
    const response = await fetch(`${server.url}/nothing-here`);
    expect(response.status).toBe(404);
    expect(seen).toEqual(["/nothing-here"]);
  });

  it("[SMW-05] a HEAD request for a file runs the middleware and sends no body", async () => {
    const seen: string[] = [];
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [recordingGate(seen)],
      runMiddlewareForStaticFiles: true,
      onError: () => undefined,
    });
    const server = await boot(handler, staticDir({ "hello.txt": "hi there" }));
    const response = await fetch(`${server.url}/hello.txt`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-gate")).toBe("passed");
    expect(seen).toEqual(["/hello.txt"]);
  });

  it("[SMW-06] a middleware that throws answers 500 and the file is not sent", async () => {
    const seen: string[] = [];
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [recordingGate(seen)],
      runMiddlewareForStaticFiles: true,
      onError: () => undefined,
    });
    const server = await boot(handler, staticDir({ "boom.txt": "never sent" }));
    const response = await fetch(`${server.url}/boom.txt`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("never sent");
  });

  it("[SMW-07] a non-boolean runMiddlewareForStaticFiles is refused at creation", () => {
    expect(() =>
      createHandler({
        dev: true,
        manifest,
        runMiddlewareForStaticFiles: "yes" as unknown as boolean,
      }),
    ).toThrow(/runMiddlewareForStaticFiles must be true or false/);
  });
});
