import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { staticFilesMiddlewareWarning } from "../src/adapter/static-files";
import { bun } from "../src/bun/index";
import { cloudflare, workerSource, wranglerToml } from "../src/cloudflare/index";
import { deno } from "../src/deno/index";
import { netlify } from "../src/netlify/index";
import { createHandler, type DuskRuntimeManifest, type Middleware } from "../src/server/index";
import { createFetch } from "../src/server/platform";
import { staticSite } from "../src/static/adapter";
import { vercel } from "../src/vercel/index";

/**
 * The platforms and `runMiddlewareForStaticFiles`: a platform whose output answers files before any code runs warns at
 * build time, naming the option; the Cloudflare Worker runs the gate for each file the assets binding has.
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
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the build says which platforms cannot run the middleware for files", () => {
  it("[SMP-01] the warning is silent when the option is off or the platform runs the gate", () => {
    expect(staticFilesMiddlewareWarning("vercel", false, false)).toBeUndefined();
    expect(staticFilesMiddlewareWarning("cloudflare", true, true)).toBeUndefined();
  });

  it("[SMP-02] a platform without the gate warns, and the warning names the option and the adapter", () => {
    const text = staticFilesMiddlewareWarning("vercel", false, true);
    expect(text).toContain("runMiddlewareForStaticFiles");
    expect(text).toContain('"vercel"');
  });

  it("[SMP-03] Cloudflare, Bun and Deno declare the gate (their layers ask it); Vercel, Netlify and the static export warn", () => {
    expect(cloudflare().capabilities.middlewareForStaticFiles).toBe(true);
    expect(bun().capabilities.middlewareForStaticFiles).toBe(true);
    expect(deno().capabilities.middlewareForStaticFiles).toBe(true);
    for (const adapter of [vercel(), netlify(), staticSite()]) {
      expect(adapter.capabilities.middlewareForStaticFiles ?? false, adapter.name).toBe(false);
      expect(
        staticFilesMiddlewareWarning(
          adapter.name,
          adapter.capabilities.middlewareForStaticFiles === true,
          true,
        ),
        adapter.name,
      ).toContain("runMiddlewareForStaticFiles");
    }
  });
});

describe("the gate on the platform surface", () => {
  it("[SMP-04] createFetch gates a file with the handler's middleware and passes the platform the fetch passes", async () => {
    const seen: string[] = [];
    const gate: Middleware = async (event, next) => {
      seen.push(event.url.pathname);
      if (event.url.pathname === "/private.txt")
        return new Response("Unauthorized", { status: 401 });
      const response = await next();
      event.responseHeaders.set("x-gate", "passed");
      return response;
    };
    const handler = createHandler({
      dev: true,
      manifest,
      middleware: [gate],
      runMiddlewareForStaticFiles: true,
      onError: () => undefined,
    });
    const module = createFetch(handler, { clientAddressHeader: "cf-connecting-ip" });
    expect(module.gateAsset).toBeDefined();
    const served = await module.gateAsset?.(new Request("https://app.test/hello.txt"), {});
    expect(served?.kind).toBe("serve");
    expect(served?.kind === "serve" ? served.headers.get("x-gate") : undefined).toBe("passed");
    const refused = await module.gateAsset?.(new Request("https://app.test/private.txt"), {});
    expect(refused?.kind).toBe("answer");
    expect(refused?.kind === "answer" ? refused.response.status : undefined).toBe(401);
    expect(seen).toEqual(["/hello.txt", "/private.txt"]);
  });

  it("[SMP-05] without the option the module has no gateAsset", () => {
    const handler = createHandler({ dev: true, manifest });
    expect(createFetch(handler).gateAsset).toBeUndefined();
  });
});

describe("the Cloudflare Worker with the file gate", () => {
  const ROBOTS = "User-agent: *";

  /** Writes a Worker whose server bundle stubs the handler's gate, and loads it. */
  async function loadGatedWorker(hosts: readonly string[] | undefined, tag: string) {
    const dir = mkdtempSync(join(tmpdir(), `dusk-cf-gate-${tag}-`));
    dirs.push(dir);
    mkdirSync(join(dir, "server"), { recursive: true });
    // The stub gate refuses /private.txt and passes every other file with a header; it records what it was asked.
    writeFileSync(
      join(dir, "server", "entry.js"),
      [
        "export const handler = { fetch: async (request) => new Response('handler:' + new URL(request.url).pathname) };",
        "export function workerFetch(h) {",
        "  return {",
        "    fetch: (request, env, ctx) => h.fetch(request, env, ctx),",
        "    gateAsset: async (request) => {",
        "      const path = new URL(request.url).pathname;",
        "      (globalThis.__duskGated ??= []).push(path);",
        "      if (path === '/private.txt') return { kind: 'answer', response: new Response('Unauthorized', { status: 401 }) };",
        "      const headers = new Headers({ 'x-gate': 'passed' });",
        "      headers.append('set-cookie', 'seen=1; Path=/');",
        "      return { kind: 'serve', headers };",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "worker.mjs"),
      workerSource({
        serverFile: "./server/entry.js",
        ...(hosts === undefined ? {} : { allowedHosts: hosts }),
        handlerPages: [],
        gateFiles: true,
      }),
    );
    const loaded = (await import(`${pathToFileURL(join(dir, "worker.mjs")).href}?t=${tag}`)) as {
      default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
    };
    const asked: string[] = [];
    const assets = {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        asked.push(path);
        if (path === "/robots.txt" || path === "/private.txt") {
          return new Response(path === "/robots.txt" ? ROBOTS : "secret", { status: 200 });
        }
        return new Response("missing", { status: 404 });
      },
    };
    const gated: string[] = [];
    (globalThis as { __duskGated?: string[] }).__duskGated = gated;
    return {
      worker: {
        fetch: (request: Request) => loaded.default.fetch(request, { ASSETS: assets }, {}),
      },
      asked,
      gated,
    };
  }

  it("[SMP-06] a file the binding has is sent with the gate's headers and cookies", async () => {
    const { worker, asked, gated } = await loadGatedWorker(undefined, "pass");
    const answer = await worker.fetch(new Request("https://app.test/robots.txt"));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(ROBOTS);
    expect(answer.headers.get("x-gate")).toBe("passed");
    expect(answer.headers.get("set-cookie")).toContain("seen=1");
    expect(asked).toEqual(["/robots.txt"]);
    expect(gated).toEqual(["/robots.txt"]);
  });

  it("[SMP-07] a refusal of the gate is the answer: the file is not sent", async () => {
    const { worker } = await loadGatedWorker(undefined, "refuse");
    const answer = await worker.fetch(new Request("https://app.test/private.txt"));
    expect(answer.status).toBe(401);
    expect(await answer.text()).toBe("Unauthorized");
  });

  it("[SMP-08] a path the binding does not have goes to the handler, not to the gate", async () => {
    const { worker, gated } = await loadGatedWorker(undefined, "missing");
    const answer = await worker.fetch(new Request("https://app.test/no-such.txt"));
    expect(await answer.text()).toBe("handler:/no-such.txt");
    expect(gated).toEqual([]);
  });

  it("[SMP-09] a refused Host never reaches the binding or the gate, and a POST is never gated", async () => {
    const { worker, asked, gated } = await loadGatedWorker(["app.test"], "host");
    const refused = await worker.fetch(new Request("https://evil.test/robots.txt"));
    expect(await refused.text()).toBe("handler:/robots.txt");
    const post = await worker.fetch(new Request("https://app.test/robots.txt", { method: "POST" }));
    expect(await post.text()).toBe("handler:/robots.txt");
    expect(asked).toEqual([]);
    expect(gated).toEqual([]);
  });

  it("[SMP-10] the gated Worker runs for every request (run_worker_first), and the plain one does not change", () => {
    const toml = wranglerToml({
      name: "app",
      compatibilityDate: "2025-09-01",
      compatibilityFlags: [],
      assetsDirectory: "client",
      allRequests: true,
    });
    expect(toml).toContain("run_worker_first = true");
    expect(workerSource({ serverFile: "./server/entry.js", handlerPages: [] })).toBe(
      '// Generated by @shadow-js/dusk (adapter: cloudflare).\nimport { handler, workerFetch } from "./server/entry.js";\n\nconst app = workerFetch(handler);\n\nexport default app;\n',
    );
  });
});
