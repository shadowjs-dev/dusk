import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostListSource, hostPatternSource } from "../src/adapter/host-routes";
import { createNativeFetch } from "../src/adapter/native";
import { workerSource } from "../src/cloudflare/index";
import { type ServerHandle, serve } from "../src/node/index";
import { hostCheckOf } from "../src/server/host-policy";
import { compileHostRules } from "../src/server/hosts";
import { createHandler } from "../src/server/index";
import type { DuskHandler } from "../src/server/types";
import { vercelRoutes } from "../src/vercel/index";
import { loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

/**
 * The static file layers (the Node server, the Bun and Deno layer) apply the handler's `security.allowedHosts` before any
 * file is read (R-16). A refused Host gets the handler's own 400 for every path: a prerendered page, a public file, a
 * hashed asset and a path with no file look alike, so the answer is no existence oracle. The platform routes of Vercel and
 * Cloudflare do the same for their own file answers. Ids: SHS-n (static layers), RE-n (the Host pattern parity), VR-n
 * (Vercel routes), CFW-n (the Cloudflare Worker).
 */

const HOSTS = ["app.test"];
const PAGE = "<h1>about</h1>";
const ROBOTS = "User-agent: *\n";
const HASHED = "console.log('hashed');";

let root: string;
const servers: ServerHandle[] = [];

/** A real handler over the shared test app, with the host list given (or none). */
async function handlerWith(hosts: readonly string[] | undefined): Promise<DuskHandler> {
  const app = await loadApp();
  return createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    // `dev: true` without a host list keeps the production note out of the way (no host list, no note).
    dev: hosts === undefined,
    ...(hosts === undefined ? {} : { security: { allowedHosts: hosts } }),
    onError: () => undefined,
  });
}

/** The client folder: a prerendered page, a public file, a hashed asset and a folder for the index. */
function clientFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "dusk-host-static-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<h1>home</h1>");
  writeFileSync(join(dir, "about.html"), PAGE);
  writeFileSync(join(dir, "robots.txt"), ROBOTS);
  writeFileSync(join(dir, "assets", "app-3f9a1c2e7b.js"), HASHED);
  return dir;
}

beforeAll(() => {
  root = clientFolder();
});

afterAll(async () => {
  for (const server of servers.splice(0)) await server.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * The handler's error page carries the id of the request (`Request <uuid>`), which differs per request. The answers are
 * compared without it: everything else in the body is the handler's own.
 */
function withoutRequestId(text: string): string {
  return text.replace(/Request [0-9a-f-]{36}/g, "Request <id>");
}

/** A GET with a chosen Host header, through node:http (fetch cannot set Host). */
function getWithHost(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Starts a Node server over the client folder and the handler; the handle is closed after the suite. */
async function nodeServer(handler: DuskHandler): Promise<number> {
  const server = await serve(handler, {
    port: 0,
    host: "127.0.0.1",
    shutdownSignals: false,
    static: { dir: root, index: "index.html", extensions: [".html"], assetsDir: "assets" },
  });
  servers.push(server);
  return server.port;
}

const FILES = [
  ["/about", PAGE],
  ["/robots.txt", ROBOTS],
  ["/assets/app-3f9a1c2e7b.js", HASHED],
] as const;

describe("SHS: the Node static layer applies the host list before it reads a file", () => {
  it("[SHS-01] a listed Host gets the prerendered page, the public file and the hashed asset", async () => {
    const port = await nodeServer(await handlerWith(HOSTS));
    for (const [path, body] of FILES) {
      const answer = await getWithHost(port, path, "app.test");
      expect(answer.status, path).toBe(200);
      expect(answer.body, path).toBe(body);
    }
  });

  it("[SHS-02] a refused Host gets the handler's own 400 for the prerendered page, the public file and the hashed asset", async () => {
    const handler = await handlerWith(HOSTS);
    const port = await nodeServer(handler);
    for (const [path] of FILES) {
      const answer = await getWithHost(port, path, "evil.test");
      const direct = await handler.fetch(new Request(`http://evil.test${path}`));
      expect(answer.status, path).toBe(400);
      expect(withoutRequestId(answer.body), path).toBe(withoutRequestId(await direct.text()));
      expect(answer.type, path).toBe(direct.headers.get("content-type") ?? undefined);
    }
  });

  it("[SHS-03] no existence oracle: a refused Host answers a file and a missing path identically", async () => {
    const port = await nodeServer(await handlerWith(HOSTS));
    const present = await getWithHost(port, "/robots.txt", "evil.test");
    const absent = await getWithHost(port, "/no-such-file.txt", "evil.test");
    const unknownPage = await getWithHost(port, "/assets/app-0000000000.js", "evil.test");
    expect({ ...present, body: withoutRequestId(present.body) }).toEqual({
      ...absent,
      body: withoutRequestId(absent.body),
    });
    expect({ ...unknownPage, body: withoutRequestId(unknownPage.body) }).toEqual({
      ...absent,
      body: withoutRequestId(absent.body),
    });
  });

  it("[SHS-04] a listed Host matches without regard to case and with any port (the pattern has no port)", async () => {
    const port = await nodeServer(await handlerWith(HOSTS));
    expect((await getWithHost(port, "/about", "APP.Test")).status).toBe(200);
    expect((await getWithHost(port, "/about", "app.test:8443")).status).toBe(200);
  });

  it("[SHS-05] a wildcard pattern accepts its subdomains and refuses the apex", async () => {
    const port = await nodeServer(await handlerWith(["*.app.test"]));
    expect((await getWithHost(port, "/about", "sites.app.test")).status).toBe(200);
    expect((await getWithHost(port, "/about", "app.test")).status).toBe(400);
  });

  it("[SHS-06] a Host the bridge cannot read is refused the same way (the bridge's 400, no file)", async () => {
    const port = await nodeServer(await handlerWith(HOSTS));
    const answer = await getWithHost(port, "/about", "app test");
    expect(answer.status).toBe(400);
    expect(answer.body).not.toBe(PAGE);
  });

  it("[SHS-07] the Node layer takes the handler's host list only from the handler: none means no host work", async () => {
    expect(hostCheckOf(await handlerWith(undefined))).toBeUndefined();
    expect(hostCheckOf(await handlerWith(HOSTS))).toBeDefined();
    // `dusk start` wraps the handler in a proxy that only replaces `fetch` (cli/start.ts): the host list must still read.
    const handler = await handlerWith(HOSTS);
    const wrapped = new Proxy(handler, {
      get(target, property) {
        if (property === "fetch")
          return (request: Request, env?: unknown) => target.fetch(request, env);
        return Reflect.get(target, property, target);
      },
    });
    expect(hostCheckOf(wrapped)?.("app.test")).toBe(true);
    expect(hostCheckOf(wrapped)?.("evil.test")).toBe(false);
  });

  it("[SHS-08] without a host list the pure-file path serves a file for any Host (zero overhead, unchanged)", async () => {
    const port = await nodeServer(await handlerWith(undefined));
    for (const [path, body] of FILES) {
      const answer = await getWithHost(port, path, "any.host.example");
      expect(answer.status, path).toBe(200);
      expect(answer.body, path).toBe(body);
    }
  });
});

describe("SHS: the Bun and Deno layer applies the same host list", () => {
  it("[SHS-09] a listed Host gets the file; a refused Host gets the handler's 400 for a file and a missing path alike", async () => {
    const handler = await handlerWith(HOSTS);
    const fetch = createNativeFetch(handler, {
      static: root,
      compress: false,
      onError: () => undefined,
      assetsDir: "assets",
    });
    const ok = await fetch(new Request("http://app.test/about"), undefined);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(PAGE);
    const refusedFile = await fetch(new Request("http://evil.test/robots.txt"), undefined);
    const refusedMissing = await fetch(new Request("http://evil.test/no-such.txt"), undefined);
    const direct = await handler.fetch(new Request("http://evil.test/robots.txt"));
    const fileText = withoutRequestId(await refusedFile.text());
    const missingText = withoutRequestId(await refusedMissing.text());
    expect(refusedFile.status).toBe(400);
    expect(fileText).toBe(withoutRequestId(await direct.text()));
    expect(refusedMissing.status).toBe(400);
    expect(missingText).toBe(fileText);
  });

  it("[SHS-10] with no host list the native layer serves a file for any Host (zero overhead)", async () => {
    const fetch = createNativeFetch(await handlerWith(undefined), {
      static: root,
      compress: false,
      onError: () => undefined,
      assetsDir: "assets",
    });
    const answer = await fetch(new Request("http://any.example/robots.txt"), undefined);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(ROBOTS);
  });
});

/** Host values that exercise the case, port, wildcard and IPv6 rules of `compileHostRules`. */
const SAMPLE_HOSTS = [
  "app.test",
  "APP.test",
  "app.test:80",
  "app.test:443",
  "app.test:8443",
  "app.test:",
  "x.app.test",
  "X.APP.test:8443",
  "x.y.app.test",
  "app.test.evil",
  "evil.app.test.x",
  "a:b.app.test",
  "a.app.test:8443:1",
  "xapp.test",
  ".app.test",
  "sub.app.test:443",
  "[::1]",
  "[::1]:8080",
  "[::1]:9",
  "::1",
  "*.app.test",
];

const SAMPLE_PATTERNS = [
  "app.test",
  "app.test:8443",
  "app.test:",
  "*.app.test",
  "*.app.test:8443",
  "[::1]",
  "[::1]:8080",
  "x.app.test",
];

describe("RE: the platform Host expressions accept what the handler accepts", () => {
  it("[RE-01] each pattern's expression matches the same hosts as compileHostRules", () => {
    for (const pattern of SAMPLE_PATTERNS) {
      const handler = compileHostRules([pattern]);
      const expression = new RegExp(hostListSource([pattern]));
      for (const host of SAMPLE_HOSTS) {
        expect(expression.test(host), `${pattern} vs ${host}`).toBe(handler(host));
      }
    }
  });

  it("[RE-02] a list of patterns matches the union of the handler's rules", () => {
    const handler = compileHostRules(SAMPLE_PATTERNS);
    const expression = new RegExp(hostListSource(SAMPLE_PATTERNS));
    for (const host of SAMPLE_HOSTS) {
      expect(expression.test(host), host).toBe(handler(host));
    }
  });

  it("[RE-03] a bare wildcard, an empty pattern and a pattern with a path are refused, as the handler refuses them", () => {
    for (const pattern of ["*", "", "app.test/x", "user@app.test"]) {
      expect(() => hostPatternSource(pattern)).toThrow(TypeError);
      expect(() => compileHostRules([pattern])).toThrow(TypeError);
    }
  });
});

describe("VR: the Vercel routes send a refused Host to the function before the filesystem", () => {
  const PAGES = [
    { path: "/about", mode: "static", headers: [], httpsHeaders: [], reason: undefined },
  ] as const;

  it("[VR-01] with a host list, the first route sends a Host the list does not accept to the function", () => {
    const routes = vercelRoutes(PAGES, "render", [], HOSTS);
    expect(routes[0]).toEqual({
      src: "^/(.*)$",
      missing: [{ type: "host", value: { re: hostListSource(HOSTS) } }],
      dest: "/render",
    });
    const filesystem = routes.findIndex((route) => route["handle"] === "filesystem");
    expect(0).toBeLessThan(filesystem);
  });

  it("[VR-02] the route's expression refuses exactly what the handler refuses", () => {
    const routes = vercelRoutes(PAGES, "render", [], SAMPLE_PATTERNS);
    const first = routes[0] as { missing: Array<{ value: { re: string } }> };
    const expression = new RegExp(first.missing[0]?.value.re ?? "");
    const handler = compileHostRules(SAMPLE_PATTERNS);
    for (const host of SAMPLE_HOSTS) {
      // `missing` fires when the condition is absent: a host the list refuses is the one the route sends to the function.
      expect(!expression.test(host), host).toBe(!handler(host));
    }
  });

  it("[VR-03] without a host list the routes are unchanged (no host condition, zero function overhead)", () => {
    const routes = vercelRoutes(PAGES, "render", []);
    expect(routes.some((route) => route["missing"] !== undefined)).toBe(false);
    expect(routes[0]).not.toEqual({ src: "/(.*)", dest: "/render" });
    const empty = vercelRoutes(PAGES, "render", [], []);
    expect(empty).toEqual(routes);
  });
});

/** Writes the generated Worker next to a fake server bundle, so the module can run in this process. */
async function loadWorker(
  hosts: readonly string[] | undefined,
  handlerPages: readonly string[],
  tag: string,
): Promise<{
  readonly worker: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
  readonly seen: string[];
}> {
  const dir = mkdtempSync(join(tmpdir(), `dusk-cf-worker-${tag}-`));
  mkdirSync(join(dir, "server"), { recursive: true });
  // The server bundle's handler answers "handler:<path>" and records the path it was asked for.
  writeFileSync(
    join(dir, "server", "entry.js"),
    [
      "export const handler = { fetch: async (request) => new Response('handler:' + new URL(request.url).pathname) };",
      "export function workerFetch(h) { return { fetch: (request, env, ctx) => h.fetch(request, env, ctx) }; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "worker.mjs"),
    workerSource({
      serverFile: "./server/entry.js",
      ...(hosts === undefined ? {} : { allowedHosts: hosts }),
      handlerPages,
    }),
  );
  const loaded = (await import(`${pathToFileURL(join(dir, "worker.mjs")).href}?t=${tag}`)) as {
    default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
  };
  const seen: string[] = [];
  const assets = {
    fetch: async (request: Request): Promise<Response> => {
      seen.push(new URL(request.url).pathname);
      const path = new URL(request.url).pathname;
      return path === "/robots.txt"
        ? new Response(ROBOTS, { status: 200 })
        : new Response("missing", { status: 404 });
    },
  };
  return {
    worker: {
      fetch: (request, env, ctx) =>
        loaded.default.fetch(request, { ASSETS: assets, ...(env as object) }, ctx),
    },
    seen,
  };
}

describe("CFW: the Cloudflare Worker enforces the host list before the assets binding", () => {
  it("[CFW-01] a refused Host goes to the handler and the assets binding is not asked", async () => {
    const { worker, seen } = await loadWorker(HOSTS, ["/about"], "refused");
    const answer = await worker.fetch(new Request("https://evil.test/robots.txt"), {}, {});
    expect(await answer.text()).toBe("handler:/robots.txt");
    expect(seen).toEqual([]);
  });

  it("[CFW-02] a listed Host gets a public file from the assets binding", async () => {
    const { worker, seen } = await loadWorker(HOSTS, ["/about"], "file");
    const answer = await worker.fetch(new Request("https://app.test/robots.txt"), {}, {});
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(ROBOTS);
    expect(seen).toEqual(["/robots.txt"]);
  });

  it("[CFW-03] a prerendered page a rule applies to is answered by the handler, never by its file (with or without a slash, or .html)", async () => {
    const { worker, seen } = await loadWorker(HOSTS, ["/about"], "page");
    for (const path of ["/about", "/about/", "/about.html", "/about/index.html"]) {
      const answer = await worker.fetch(new Request(`https://app.test${path}`), {}, {});
      expect(await answer.text(), path).toBe(`handler:${path}`);
    }
    expect(seen).toEqual([]);
  });

  it("[CFW-04] a missing file falls through to the handler after the assets binding's 404", async () => {
    const { worker, seen } = await loadWorker(HOSTS, [], "missing");
    const answer = await worker.fetch(new Request("https://app.test/no-such.txt"), {}, {});
    expect(await answer.text()).toBe("handler:/no-such.txt");
    expect(seen).toEqual(["/no-such.txt"]);
  });

  it("[CFW-05] a method other than GET or HEAD, and a malformed escape, never reach the assets binding", async () => {
    const { worker, seen } = await loadWorker(HOSTS, [], "method");
    await worker.fetch(new Request("https://app.test/robots.txt", { method: "POST" }), {}, {});
    await worker.fetch(new Request("https://app.test/%E0%A4%A"), {}, {});
    expect(seen).toEqual([]);
  });

  it("[CFW-06] without a host list the Worker is the plain handler: no assets lookup at all", async () => {
    const { worker, seen } = await loadWorker(undefined, [], "plain");
    const answer = await worker.fetch(new Request("https://evil.test/robots.txt"), {}, {});
    expect(await answer.text()).toBe("handler:/robots.txt");
    expect(seen).toEqual([]);
  });
});
