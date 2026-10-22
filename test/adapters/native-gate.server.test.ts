import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeFetch } from "../../src/adapter/native";
import { bun } from "../../src/bun/index";
import { deno } from "../../src/deno/index";
import type { AssetDecision, Handler } from "../../src/server/types";

/**
 * The Bun and Deno layers (`adapter/native.ts`) answer a file the server would send from the client folder. With
 * `runMiddlewareForStaticFiles` the handler's `gateAsset` decides that file first, as the Node layer and the
 * Cloudflare Worker do (`NGATE-*`). These tests use the shared fetch function with a fake handler: the runtime
 * servers are run for real in the bun-runtime test and the Bun smoke.
 */

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A client folder with a file that the gate decides on, and a file it never sees. */
function clientFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "shadow-native-gate-"));
  dirs.push(dir);
  writeFileSync(join(dir, "hello.txt"), "hello from the file\n");
  writeFileSync(join(dir, "private.txt"), "TOP SECRET\n");
  writeFileSync(join(dir, "boom.txt"), "boom\n");
  return dir;
}

/** A handler that answers every path with "handler" and records what its gate was asked. */
function fakeHandler(decide: (request: Request) => Promise<AssetDecision>): {
  handler: Handler;
  asked: string[];
  platforms: unknown[];
} {
  const asked: string[] = [];
  const platforms: unknown[] = [];
  const handler: Handler = {
    fetch: () =>
      Promise.resolve(new Response("handler", { headers: { "content-type": "text/plain" } })),
    gateAsset: (request, platform) => {
      asked.push(new URL(request.url).pathname);
      platforms.push(platform);
      return decide(request);
    },
  };
  return { handler, asked, platforms };
}

/** The shared fetch function over a folder, compression off, for one request. */
function fetchOver(handler: Handler, dir: string) {
  return createNativeFetch(handler, { static: dir, compress: false, onError: () => undefined });
}

describe("the native layers ask the gate about a file (NGATE)", () => {
  it("[NGATE-01] a file the middleware lets through is sent with the headers and cookies it set, and the file's own framing", async () => {
    const dir = clientFolder();
    const { handler, asked } = fakeHandler(() =>
      Promise.resolve({
        kind: "serve",
        headers: new Headers({ "x-gate": "passed", "set-cookie": "seen=1; Path=/" }),
      }),
    );
    const response = await fetchOver(handler, dir)(
      new Request("http://app.test/hello.txt"),
      "10.0.0.7",
    );
    expect(asked).toEqual(["/hello.txt"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-gate")).toBe("passed");
    expect(response.headers.get("set-cookie")).toContain("seen=1");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("hello from the file\n");
  });

  it("[NGATE-02] a refusal of the middleware is the answer: the file is not read into the response", async () => {
    const dir = clientFolder();
    const { handler, asked } = fakeHandler(() =>
      Promise.resolve({ kind: "answer", response: new Response("Unauthorized", { status: 401 }) }),
    );
    const response = await fetchOver(handler, dir)(
      new Request("http://app.test/private.txt"),
      undefined,
    );
    expect(asked).toEqual(["/private.txt"]);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe("Unauthorized");
    expect(body).not.toContain("TOP SECRET");
  });

  it("[NGATE-03] a middleware that failed (its answer is a 500) sends that answer, and the file is not sent", async () => {
    const dir = clientFolder();
    const { handler } = fakeHandler(() =>
      Promise.resolve({
        kind: "answer",
        response: new Response("Internal Server Error", { status: 500 }),
      }),
    );
    const response = await fetchOver(handler, dir)(
      new Request("http://app.test/boom.txt"),
      undefined,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("boom");
  });

  it("[NGATE-04] the gate is asked with the client address the runtime reports, as the handler's platform", async () => {
    const dir = clientFolder();
    const { handler, platforms } = fakeHandler(() =>
      Promise.resolve({ kind: "serve", headers: new Headers() }),
    );
    await fetchOver(handler, dir)(new Request("http://app.test/hello.txt"), "203.0.113.9");
    const platform = platforms[0];
    expect(typeof platform).toBe("object");
    expect(Reflect.get(platform as object, "clientAddress")).toBe("203.0.113.9");
  });

  it("[NGATE-05] the gate is not asked for a path with no file (the handler answers it) or for a non-GET request", async () => {
    const dir = clientFolder();
    const { handler, asked } = fakeHandler(() =>
      Promise.resolve({ kind: "serve", headers: new Headers() }),
    );
    const fetch = fetchOver(handler, dir);
    expect(await (await fetch(new Request("http://app.test/missing.txt"), undefined)).text()).toBe(
      "handler",
    );
    const posted = await fetch(
      new Request("http://app.test/hello.txt", { method: "POST" }),
      undefined,
    );
    expect(await posted.text()).toBe("handler");
    expect(asked).toEqual([]);
  });

  it("[NGATE-06] a handler without gateAsset sends the file with no gate call (the option is off)", async () => {
    const dir = clientFolder();
    const handler: Handler = { fetch: () => Promise.resolve(new Response("handler")) };
    const response = await fetchOver(handler, dir)(
      new Request("http://app.test/hello.txt"),
      undefined,
    );
    expect(await response.text()).toBe("hello from the file\n");
  });

  it("[NGATE-07] the Bun and Deno adapters declare the gate, so their builds do not warn about runMiddlewareForStaticFiles", () => {
    expect(bun().capabilities.middlewareForStaticFiles).toBe(true);
    expect(deno().capabilities.middlewareForStaticFiles).toBe(true);
  });
});
