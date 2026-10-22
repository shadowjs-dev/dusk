import { describe, expect, it, vi } from "vitest";
import { checkBundle } from "../../src/adapter/checks";
import { acceptsGzip, gzipResponse } from "../../src/adapter/native";
import { checkOutDir, relativePath } from "../../src/adapter/paths";
import { assertAdapter } from "../../src/adapter/types";
import { bun } from "../../src/bun/index";
import { checkCloudflareOptions, wranglerToml } from "../../src/cloudflare/index";
import { checkNetlifyOptions, netlify } from "../../src/netlify/index";
import {
  createFetch,
  platformHost,
  runtimeEnvironment,
  waitUntil,
} from "../../src/server/platform";
import { checkVercelOptions, vercel } from "../../src/vercel/index";

/** The platform helpers every adapter entry uses, and the option checks of each adapter. */

describe("platformHost: bindings are environment, the platform hooks are not", () => {
  it("[PLAT-01] copies the bindings as enumerable keys and keeps clientAddress and waitUntil out of them", () => {
    const waitUntilHook = () => undefined;
    const host = platformHost(
      { API_KEY: "abc", COUNT: 3 },
      { clientAddress: "198.51.100.4", waitUntil: waitUntilHook },
    );
    expect(Object.keys(host).sort()).toEqual(["API_KEY", "COUNT"]);
    expect(Reflect.get(host, "clientAddress")).toBe("198.51.100.4");
    expect(Reflect.get(host, "waitUntil")).toBe(waitUntilHook);
    expect(Object.getPrototypeOf(host)).toBeNull();
  });

  it("[PLAT-02] an absent environment gives an empty host", () => {
    expect(Object.keys(platformHost(undefined))).toEqual([]);
  });
});

describe("createFetch: the Workers-style module over a handler", () => {
  const seen: Array<{ host: unknown; request: Request }> = [];
  const handler = {
    fetch(request: Request, host?: unknown): Promise<Response> {
      seen.push({ host, request });
      return Promise.resolve(new Response("ok"));
    },
  };

  it("[PLAT-03] the client address comes from the configured header and waitUntil from the context", async () => {
    const module = createFetch(handler, { clientAddressHeader: "cf-connecting-ip" });
    const calls: Promise<unknown>[] = [];
    const response = await module.fetch(
      new Request("http://localhost/", { headers: { "cf-connecting-ip": "203.0.113.8" } }),
      { TOKEN: "x" },
      { waitUntil: (promise) => void calls.push(promise) },
    );
    expect(await response.text()).toBe("ok");
    const host = seen.at(-1)?.host;
    expect(Reflect.get(host as object, "clientAddress")).toBe("203.0.113.8");
    expect(
      Reflect.apply(Reflect.get(host as object, "waitUntil") as () => void, host, [
        Promise.resolve(1),
      ]),
    ).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("[PLAT-04] a context without waitUntil (Vercel, Netlify) is accepted; no client address header means none", async () => {
    const module = createFetch(handler, { clientAddressHeader: "x-real-ip" });
    await module.fetch(new Request("http://localhost/"), undefined, {
      ip: "203.0.113.1",
    } as unknown as { waitUntil(p: Promise<unknown>): void });
    const host = seen.at(-1)?.host;
    expect(Reflect.get(host as object, "clientAddress")).toBeUndefined();
    expect(Reflect.get(host as object, "waitUntil")).toBeUndefined();
  });
});

describe("waitUntil outside a platform hook", () => {
  it("[PLAT-05] a failing background promise is logged, never dropped", async () => {
    const spy = vi.mocked(console.error);
    waitUntil(Promise.reject(new Error("audit write failed")));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("background work failed");
    spy.mockClear();
  });
});

describe("runtimeEnvironment", () => {
  it("[PLAT-06] reads the process environment as strings (Deno.env is used when present)", () => {
    const previous = process.env["PLAT_TEST_VALUE"];
    process.env["PLAT_TEST_VALUE"] = "present";
    try {
      expect(runtimeEnvironment()?.["PLAT_TEST_VALUE"]).toBe("present");
    } finally {
      if (previous === undefined) delete process.env["PLAT_TEST_VALUE"];
      else process.env["PLAT_TEST_VALUE"] = previous;
    }
  });

  it("[G-A7] a Deno global: Deno.env.toObject() is the environment, as strings, and process.env is not read", () => {
    vi.stubGlobal("Deno", { env: { toObject: () => ({ EDGE_REGION: "eu", EDGE_COUNT: "2" }) } });
    try {
      expect(runtimeEnvironment()).toEqual({ EDGE_REGION: "eu", EDGE_COUNT: "2" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("[G-A7] a Deno global without a usable env falls back to process.env", () => {
    const previous = process.env["PLAT_DENO_FALLBACK"];
    process.env["PLAT_DENO_FALLBACK"] = "from-process";
    try {
      vi.stubGlobal("Deno", {});
      expect(runtimeEnvironment()?.["PLAT_DENO_FALLBACK"]).toBe("from-process");
      vi.stubGlobal("Deno", { env: { toObject: () => "not an object" } });
      expect(runtimeEnvironment()?.["PLAT_DENO_FALLBACK"]).toBe("from-process");
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env["PLAT_DENO_FALLBACK"];
      else process.env["PLAT_DENO_FALLBACK"] = previous;
    }
  });

  it("[G-A7] the Netlify edge entry: runtimeEnvironment() and the Netlify context reach the handler's host", async () => {
    const seen: unknown[] = [];
    const handler = {
      fetch(_request: Request, host?: unknown): Promise<Response> {
        seen.push(host);
        return Promise.resolve(new Response("ok"));
      },
    };
    // The generated `edge-functions/render.mjs` is `createFetch(handler, { clientAddressHeader }).fetch(request, runtimeEnvironment(), context)`.
    const app = createFetch(handler, { clientAddressHeader: "x-nf-client-connection-ip" });
    const background: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => void background.push(promise) };
    vi.stubGlobal("Deno", { env: { toObject: () => ({ EDGE_SITE: "netlify-edge" }) } });
    try {
      const request = new Request("https://app.example/", {
        headers: { "x-nf-client-connection-ip": "203.0.113.9" },
      });
      await app.fetch(request, runtimeEnvironment(), context);
    } finally {
      vi.unstubAllGlobals();
    }
    const host = seen[0];
    expect(Reflect.get(host as object, "EDGE_SITE")).toBe("netlify-edge");
    expect(Reflect.get(host as object, "clientAddress")).toBe("203.0.113.9");
    const waitUntil: unknown = Reflect.get(host as object, "waitUntil");
    expect(typeof waitUntil).toBe("function");
    if (typeof waitUntil === "function")
      Reflect.apply(waitUntil, undefined, [Promise.resolve("done")]);
    expect(background).toHaveLength(1);
  });
});

describe("gzip for buffered responses", () => {
  it("[PLAT-07] accepts gzip unless q=0, and only for a client that says so", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1, gzip;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });

  it("[PLAT-08] compresses a buffered text response of 1 KiB or more, with Vary, and leaves the rest alone", () => {
    const big = "x".repeat(2048);
    const response = new Response(big, {
      headers: { "content-type": "text/html; charset=utf-8", "content-length": String(big.length) },
    });
    const zipped = gzipResponse(response, "gzip", "GET");
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("content-length")).toBeNull();
    expect(zipped.headers.get("vary")).toBe("Accept-Encoding");
    const small = new Response("tiny", {
      headers: { "content-type": "text/plain", "content-length": "4" },
    });
    expect(gzipResponse(small, "gzip", "GET")).toBe(small);
    const streamed = new Response(new ReadableStream({ start: (c) => c.close() }), {
      headers: { "content-type": "text/html" },
    });
    expect(gzipResponse(streamed, "gzip", "GET")).toBe(streamed);
    const sse = new Response("data: x\n\n", {
      headers: { "content-type": "text/event-stream", "content-length": "9999" },
    });
    expect(gzipResponse(sse, "gzip", "GET")).toBe(sse);
    const head = new Response("x".repeat(2048), {
      headers: { "content-type": "text/html", "content-length": "2048" },
    });
    expect(gzipResponse(head, "gzip", "HEAD")).toBe(head);
  });
});

describe("path arithmetic for emitted files", () => {
  it("[PLAT-09] relative specifiers between an output folder and a build folder", () => {
    expect(relativePath("/app/dist/bun", "/app/dist/client")).toBe("../client");
    expect(relativePath("/app/dist/bun", "/app/dist/server/entry.js")).toBe("../server/entry.js");
    expect(relativePath("/app/.vercel/output", "/app/dist/server")).toBe("../../dist/server");
    expect(relativePath("/app/dist/bun", "/app/dist/bun/server.mjs")).toBe("./server.mjs");
    expect(relativePath("/app/dist/client", "/app/dist/client/")).toBe("./");
  });

  it("[PLAT-10] an outDir must be a folder inside the project", () => {
    expect(checkOutDir("bun()", "dist/bun/")).toBe("dist/bun");
    expect(() => checkOutDir("bun()", "/etc")).toThrow(
      /outDir must be a folder inside the project/,
    );
    expect(() => checkOutDir("bun()", "../elsewhere")).toThrow(/outDir/);
    expect(() => checkOutDir("bun()", "dist/../../x")).toThrow(/outDir/);
    expect(() => checkOutDir("bun()", "")).toThrow(/outDir/);
  });
});

describe("bundle checks", () => {
  it("[PLAT-11] an edge bundle may not name a node: module; a self-contained bundle may not name a package", () => {
    const files = [
      {
        file: "dist/server/entry.js",
        code: 'import { readFileSync } from "node:fs";\nimport x from "zod";\nimport "./chunk.js";',
      },
    ];
    const edge = checkBundle({ name: "edge", edge: true, bundling: "dependencies" }, files);
    expect(edge.map((problem) => problem.specifier)).toEqual(["node:fs"]);
    const all = checkBundle({ name: "all", bundling: "all" }, files);
    expect(all.map((problem) => problem.specifier)).toEqual(["zod"]);
    expect(checkBundle({ name: "plain", bundling: "dependencies" }, files)).toEqual([]);
  });

  it("[PLAT-12] dynamic imports and require calls count too", () => {
    const code = 'const a = import("node:crypto");\nconst b = require("left-pad");';
    const problems = checkBundle({ name: "x", edge: true, bundling: "all" }, [
      { file: "f.js", code },
    ]);
    expect(problems.map((problem) => problem.specifier).sort()).toEqual([
      "left-pad",
      "node:crypto",
    ]);
  });
});

describe("adapter objects and their options", () => {
  it("[PLAT-13] dusk rejects an object that is not an adapter, with the field named", () => {
    expect(() => assertAdapter({})).toThrow(/needs a name/);
    expect(() =>
      assertAdapter({
        name: "x",
        outDir: "dist/x",
        build: () => undefined,
        env: "magic",
        bundling: "all",
        capabilities: {},
      }),
    ).toThrow(/env must be/);
    expect(() =>
      assertAdapter({
        name: "x",
        outDir: "../x",
        build: () => undefined,
        env: "process",
        bundling: "all",
        capabilities: {},
      }),
    ).toThrow(/must not leave the project/);
    expect(() => assertAdapter(null)).toThrow(/must be an adapter object/);
    expect(assertAdapter(bun()).name).toBe("bun");
  });

  it("[PLAT-14] Cloudflare options: worker name, date and flags are checked", () => {
    expect(() => checkCloudflareOptions({ name: "My App" })).toThrow(/is not a Worker name/);
    expect(() => checkCloudflareOptions({ name: "-bad" })).toThrow(/Worker name/);
    expect(() => checkCloudflareOptions({ compatibilityDate: "2025/09/01" })).toThrow(/YYYY-MM-DD/);
    expect(() => checkCloudflareOptions({ compatibilityFlags: ["Bad Flag"] })).toThrow(
      /compatibility flag/,
    );
    expect(checkCloudflareOptions({}).name).toBe("dusk-app");
  });

  it("[PLAT-15] Vercel options: runtime, node version, duration and function name", () => {
    expect(() => checkVercelOptions({ runtime: "deno" as "edge" })).toThrow(/runtime must be/);
    expect(() => checkVercelOptions({ nodeVersion: "node22" as "nodejs22.x" })).toThrow(
      /nodeVersion/,
    );
    expect(() => checkVercelOptions({ maxDuration: 0 })).toThrow(/maxDuration/);
    expect(() => checkVercelOptions({ maxDuration: 901 })).toThrow(/maxDuration/);
    expect(() => checkVercelOptions({ functionName: "Render" })).toThrow(/functionName/);
    expect(checkVercelOptions({}).outDir).toBe(".vercel/output");
    expect(vercel({ runtime: "edge" }).edge).toBe(true);
  });

  it("[PLAT-16] Netlify options: target, redirects and their status", () => {
    expect(() => checkNetlifyOptions({ target: "lambda" as "edge" })).toThrow(/target must be/);
    expect(() => checkNetlifyOptions({ redirects: [{ from: "old", to: "/new" }] })).toThrow(
      /must be a path starting with/,
    );
    expect(() =>
      checkNetlifyOptions({ redirects: [{ from: "/old", to: "javascript:alert(1)" }] }),
    ).toThrow(/redirect "to"/);
    expect(() =>
      checkNetlifyOptions({ redirects: [{ from: "/old", to: "/new", status: 200 as 301 }] }),
    ).toThrow(/status/);
    expect(
      checkNetlifyOptions({ redirects: [{ from: "/old", to: "https://example.com/x" }] }).redirects,
    ).toHaveLength(1);
    expect(netlify({ target: "edge" }).edge).toBe(true);
  });

  it("[PLAT-17] the wrangler.toml the Cloudflare adapter writes", () => {
    const toml = wranglerToml({
      name: "app",
      compatibilityDate: "2025-09-01",
      compatibilityFlags: ["nodejs_compat", "x"],
      assetsDirectory: "../client",
    });
    expect(toml).toContain('main = "worker.mjs"');
    expect(toml).toContain('compatibility_flags = ["nodejs_compat", "x"]');
    expect(toml).toContain('[assets]\ndirectory = "../client"\nbinding = "ASSETS"');
    expect(
      wranglerToml({
        name: "app",
        compatibilityDate: "2025-09-01",
        compatibilityFlags: [],
        assetsDirectory: "",
        withAssets: false,
      }),
    ).not.toContain("[assets]");
  });
});
