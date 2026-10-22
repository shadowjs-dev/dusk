import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import {
  buildIdOf,
  buildServiceWorker,
  createPrecacheManifest,
  createWorkerConfig,
  offlinePage,
  pwa,
  resolvePwaOptions,
  serviceWorkerEntrySource,
} from "../../src/vite/pwa";
import {
  cacheNames,
  decideRequest,
  excessKeys,
  isCacheableResponse,
  isFresh,
  matchRule,
  pathBelowBase,
  planPrecache,
  staleCaches,
  type WorkerConfig,
  type WorkerRule,
} from "../../src/vite/pwa-core";
import { SKIP_WAITING_MESSAGE } from "../../src/vite/pwa-worker";

const ORIGIN = "https://app.test";

const API_RULE: WorkerRule = {
  patterns: ["/api/**"],
  strategy: "network-first",
  cache: "api",
  maxEntries: 10,
  maxAgeSeconds: 60,
  networkTimeoutSeconds: 3,
};
const IMAGE_RULE: WorkerRule = {
  patterns: ["/images/*.{png,jpg}"],
  strategy: "cache-first",
  cache: "images",
  maxEntries: 0,
  maxAgeSeconds: 0,
  networkTimeoutSeconds: 0,
};

const CONFIG: WorkerConfig = {
  prefix: "dusk",
  buildId: "b1",
  base: "/",
  precache: [{ url: "/assets/app-1.js", revision: "r1" }],
  rules: [API_RULE, IMAGE_RULE],
  exclude: ["/_dusk/**"],
  appShell: undefined,
  offline: "/offline.html",
};

const PRECACHED = new Set([`${ORIGIN}/assets/app-1.js`]);

function decide(
  url: string,
  extra: Partial<{ method: string; mode: string; authorized: boolean; ranged: boolean }> = {},
  config: WorkerConfig = CONFIG,
) {
  return decideRequest(
    { method: "GET", mode: "cors", authorized: false, ranged: false, url, ...extra },
    config,
    ORIGIN,
    PRECACHED,
  );
}

function response(
  headers: Record<string, string>,
  status = 200,
  type = "basic",
): Parameters<typeof isCacheableResponse>[0] {
  return { status, type, headers: new Headers(headers) };
}

describe("pwa: request decisions", () => {
  it("[PWA-01] only same-origin GET requests inside the base are handled", () => {
    expect(decide(`${ORIGIN}/api/items`, { method: "POST" }).kind).toBe("bypass");
    expect(decide(`${ORIGIN}/api/items`, { method: "PUT" }).kind).toBe("bypass");
    expect(decide("https://other.test/api/items").kind).toBe("bypass");
    expect(decide("not a url").kind).toBe("bypass");
    expect(decide(`${ORIGIN}/api/items`).kind).toBe("rule");
    const mounted = { ...CONFIG, base: "/app/" };
    expect(decide(`${ORIGIN}/api/items`, {}, mounted).kind).toBe("bypass");
    expect(decide(`${ORIGIN}/app/api/items`, {}, mounted).kind).toBe("rule");
  });

  it("[PWA-02] a precached file is answered from the precache, with a query it is not", () => {
    expect(decide(`${ORIGIN}/assets/app-1.js`)).toEqual({
      kind: "precache",
      key: `${ORIGIN}/assets/app-1.js`,
    });
    expect(decide(`${ORIGIN}/assets/app-1.js?v=2`).kind).toBe("bypass");
  });

  it("[PWA-03] server function calls and everything under an excluded pattern go to the network", () => {
    expect(decide(`${ORIGIN}/_dusk/rpc/abc`).kind).toBe("bypass");
    expect(decide(`${ORIGIN}/_dusk/image?url=%2Fa.png&w=640&q=75`, { mode: "no-cors" }).kind).toBe(
      "bypass",
    );
    expect(decide(`${ORIGIN}/_dusk/nav`, { mode: "navigate" }).kind).toBe("bypass");
  });

  it("[PWA-04] a request with credentials or a byte range is never answered from a cache", () => {
    expect(decide(`${ORIGIN}/api/items`, { authorized: true }).kind).toBe("bypass");
    expect(decide(`${ORIGIN}/images/a.png`, { ranged: true }).kind).toBe("bypass");
  });

  it("[PWA-05] a navigation no rule claims gets the network with the offline fallback", () => {
    expect(decide(`${ORIGIN}/about`, { mode: "navigate" })).toEqual({ kind: "navigation" });
    expect(decide(`${ORIGIN}/about`).kind).toBe("bypass");
    const claimed = decide(`${ORIGIN}/api/page`, { mode: "navigate" });
    expect(claimed).toEqual({ kind: "rule", rule: API_RULE, navigation: true });
  });

  it("[PWA-06] the first matching rule wins and patterns are globs of the path below the base", () => {
    expect(matchRule(CONFIG.rules, "/images/a.png")?.cache).toBe("images");
    expect(matchRule(CONFIG.rules, "/images/a.gif")).toBeUndefined();
    expect(matchRule(CONFIG.rules, "/api/a/b/c")?.cache).toBe("api");
    expect(pathBelowBase("/app/x", "/app/")).toBe("/x");
    expect(pathBelowBase("/app", "/app/")).toBe("/");
    expect(pathBelowBase("/application/x", "/app/")).toBeUndefined();
    expect(pathBelowBase("/x", "/")).toBe("/x");
  });
});

describe("pwa: what may be kept", () => {
  it("[PWA-07] a plain 200 is kept", () => {
    expect(isCacheableResponse(response({ "cache-control": "public, max-age=60" }))).toBe(true);
    expect(isCacheableResponse(response({}))).toBe(true);
    expect(isCacheableResponse(response({ "cache-control": "no-cache" }))).toBe(true);
  });

  it("[PWA-08] no-store, private, cookies, a cookie vary and a nonce policy are never kept", () => {
    expect(isCacheableResponse(response({ "cache-control": "no-store" }))).toBe(false);
    expect(isCacheableResponse(response({ "cache-control": "private, no-store" }))).toBe(false);
    expect(isCacheableResponse(response({ "cache-control": "max-age=5, Private" }))).toBe(false);
    expect(isCacheableResponse(response({ "set-cookie": "sid=1; HttpOnly" }))).toBe(false);
    expect(isCacheableResponse(response({ vary: "Accept-Encoding, Cookie" }))).toBe(false);
    expect(isCacheableResponse(response({ vary: "*" }))).toBe(false);
    expect(
      isCacheableResponse(
        response({ "content-security-policy": "default-src 'self'; script-src 'nonce-abc123'" }),
      ),
    ).toBe(false);
    expect(isCacheableResponse(response({ "content-security-policy": "default-src 'self'" }))).toBe(
      true,
    );
  });

  it("[PWA-09] only a complete same-origin 200 is kept", () => {
    expect(isCacheableResponse(response({}, 206))).toBe(false);
    expect(isCacheableResponse(response({}, 404))).toBe(false);
    expect(isCacheableResponse(response({}, 500))).toBe(false);
    expect(isCacheableResponse(response({}, 200, "opaque"))).toBe(false);
    expect(isCacheableResponse(response({}, 200, "cors"))).toBe(false);
    expect(isCacheableResponse(response({}, 301))).toBe(false);
  });
});

describe("pwa: limits and cache versions", () => {
  it("[PWA-10] a kept response is fresh until its maximum age", () => {
    expect(isFresh(1_000, 60, 1_000 + 60_000)).toBe(true);
    expect(isFresh(1_000, 60, 1_000 + 60_001)).toBe(false);
    expect(isFresh(undefined, 60, 5)).toBe(false);
    expect(isFresh(undefined, 0, 5)).toBe(true);
    expect(isFresh(Number.NaN, 60, 5)).toBe(false);
  });

  it("[PWA-11] the oldest entries over the limit are the ones deleted", () => {
    expect(excessKeys(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
    expect(excessKeys(["a", "b"], 2)).toEqual([]);
    expect(excessKeys(["a", "b", "c"], 0)).toEqual([]);
  });

  it("[PWA-12] cache names carry the build id and only this app's other builds are stale", () => {
    const names = cacheNames(CONFIG);
    expect(names.precache).toBe("dusk-precache-b1");
    expect(names.runtime("api")).toBe("dusk-runtime-api-b1");
    const all = [
      "dusk-precache-b0",
      "dusk-precache-b1",
      "dusk-runtime-api-b0",
      "dusk-runtime-api-b1",
      "other-app-precache-b0",
      "workbox-precache-v2",
    ];
    expect(staleCaches(all, CONFIG)).toEqual(["dusk-precache-b0", "dusk-runtime-api-b0"]);
  });

  it("[PWA-13] install downloads only the files an older build does not hold with the same revision", () => {
    const entries = [
      { url: "/a.js", revision: "1" },
      { url: "/b.js", revision: "2" },
      { url: "/c.js", revision: "3" },
    ];
    const held = new Map([
      ["/a.js", "1"],
      ["/b.js", "old"],
    ]);
    const plan = planPrecache(entries, (url) => held.get(url));
    expect(plan.reuse.map((e) => e.url)).toEqual(["/a.js"]);
    expect(plan.fetch.map((e) => e.url)).toEqual(["/b.js", "/c.js"]);
  });

  it("[PWA-14] the page and the worker agree on the skip-waiting message", () => {
    expect(SKIP_WAITING_MESSAGE).toBe("dusk:skip-waiting");
  });
});

describe("pwa: generator", () => {
  it("[PWA-15] the precache lists each file with a content hash, sorted, with the base", () => {
    const a = createPrecacheManifest(
      [
        { path: "assets/b.js", bytes: new TextEncoder().encode("b") },
        { path: "assets/a b.css", bytes: new TextEncoder().encode("a") },
      ],
      "/app/",
    );
    expect(a.map((e) => e.url)).toEqual(["/app/assets/a%20b.css", "/app/assets/b.js"]);
    for (const entry of a) expect(entry.revision).toMatch(/^[0-9a-f]{12}$/);
    const same = createPrecacheManifest(
      [
        { path: "assets/a b.css", bytes: new TextEncoder().encode("a") },
        { path: "assets/b.js", bytes: new TextEncoder().encode("b") },
      ],
      "/app/",
    );
    expect(same).toEqual(a);
    const changed = createPrecacheManifest(
      [
        { path: "assets/a b.css", bytes: new TextEncoder().encode("a!") },
        { path: "assets/b.js", bytes: new TextEncoder().encode("b") },
      ],
      "/app/",
    );
    expect(changed[0]?.revision).not.toBe(a[0]?.revision);
    expect(changed[1]?.revision).toBe(a[1]?.revision);
    expect(buildIdOf(changed)).not.toBe(buildIdOf(a));
    expect(buildIdOf(same)).toBe(buildIdOf(a));
  });

  it("[PWA-16] options get their defaults and a bad value is refused with its name", () => {
    const resolved = resolvePwaOptions({});
    expect(resolved.serviceWorkerFile).toBe("sw.js");
    expect(resolved.manifestFile).toBe("manifest.webmanifest");
    expect(resolved.neverTouch).toEqual(["/_dusk/**"]);
    expect(resolved.offline?.file).toBe("offline.html");
    expect(resolvePwaOptions({ offline: false }).offline).toBeUndefined();
    const rule = resolvePwaOptions({
      runtime: [{ pattern: "/api/**", strategy: "stale-while-revalidate" }],
    }).rules[0];
    expect(rule).toMatchObject({ cache: "rule0", maxEntries: 50, maxAgeSeconds: 2_592_000 });
    expect(() => resolvePwaOptions({ cacheNamePrefix: "Bad Prefix" })).toThrow(/cacheNamePrefix/);
    expect(() => resolvePwaOptions({ serviceWorkerFile: "../sw.js" })).toThrow(/serviceWorkerFile/);
    expect(() => resolvePwaOptions({ appShell: "//evil.test/" })).toThrow(/appShell/);
    expect(() =>
      resolvePwaOptions({ runtime: [{ pattern: "api/**", strategy: "cache-first" }] }),
    ).toThrow(/runtime\[0\]\.pattern/);
    expect(() =>
      resolvePwaOptions({ runtime: [{ pattern: "/a/../b", strategy: "cache-first" }] }),
    ).toThrow(/\.\./);
    expect(() =>
      resolvePwaOptions({
        runtime: [{ pattern: "/a/**", strategy: "nope" as unknown as "cache-first" }],
      }),
    ).toThrow(/strategy/);
    expect(() =>
      resolvePwaOptions({
        runtime: [{ pattern: "/a/**", strategy: "cache-first", maxEntries: -1 }],
      }),
    ).toThrow(/maxEntries/);
    expect(() =>
      resolvePwaOptions({
        runtime: [
          { pattern: "/a/**", strategy: "cache-first", cacheName: "x" },
          { pattern: "/b/**", strategy: "cache-first", cacheName: "x" },
        ],
      }),
    ).toThrow(/two runtime rules/);
  });

  it("[PWA-17] the worker configuration is plain data with the app shell under the base", () => {
    const resolved = resolvePwaOptions({ appShell: "/shell", runtime: [] });
    const config = createWorkerConfig(
      resolved,
      [{ url: "/app/assets/a.js", revision: "1" }],
      "/app/",
      "/app/offline.html",
    );
    expect(config.appShell).toBe("/app/shell");
    expect(config.offline).toBe("/app/offline.html");
    expect(config.buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    expect(
      createWorkerConfig({ ...resolved, buildId: "release-7" }, [], "/", undefined).buildId,
    ).toBe("release-7");
  });

  it("[PWA-18] the entry source writes the configuration as one literal that cannot end the script", () => {
    const hostile = { ...CONFIG, prefix: "x", offline: "</script>  " };
    const source = serviceWorkerEntrySource(hostile, "./runtime");
    expect(source.startsWith('import { installServiceWorker } from "./runtime";')).toBe(true);
    expect(source).not.toContain(" ");
    expect(source).not.toContain(" ");
    const call = "installServiceWorker(";
    const literal = source.slice(source.indexOf(call) + call.length, source.lastIndexOf(");"));
    expect(JSON.parse(literal)).toEqual(hostile);
  });

  it("[PWA-19] the offline page escapes its text and has no script and no inline style", () => {
    const page = offlinePage(
      {
        title: "<b>T</b>",
        heading: 'H"&',
        message: "<script>alert(1)</script>",
        lang: 'en"><x',
        file: "offline.html",
      },
      "/offline.css",
    );
    expect(page.html).not.toContain("<script");
    expect(page.html).not.toContain("<style");
    expect(page.html).not.toContain("<b>");
    expect(page.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.html).toContain('lang="en&quot;&gt;&lt;x"');
    expect(page.html).toContain('href="/offline.css"');
    expect(page.css).toContain("color-scheme");
  });
});

describe("pwa: build", () => {
  it("[PWA-20] the compiled worker is one self-contained script that carries the configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "dusk-pwa-sw-"));
    try {
      const code = await buildServiceWorker(CONFIG, root);
      expect(code).toContain("-precache-");
      expect(code).toContain("/assets/app-1.js");
      expect(code).not.toMatch(/\bimport\s*\(|^\s*import\s/m);
      expect(() => new Script(code)).not.toThrow();
      expect(code.length).toBeLessThan(12_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[PWA-21] a client build writes the manifest, the offline page and a worker that precaches the hashed assets", async () => {
    const root = mkdtempSync(join(tmpdir(), "dusk-pwa-build-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "public"), { recursive: true });
      writeFileSync(
        join(root, "index.html"),
        '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>',
      );
      writeFileSync(join(root, "src", "main.js"), 'console.log("hello");\n');
      writeFileSync(join(root, "public", "robots.txt"), "User-agent: *\n");
      await build({
        root,
        configFile: false,
        logLevel: "silent",
        base: "/app/",
        plugins: [
          pwa({
            manifest: { name: "Test", short_name: "T", start_url: "/app/", display: "standalone" },
            runtime: [{ pattern: "/api/**", strategy: "network-first", maxEntries: 5 }],
          }),
        ],
      });
      const dist = (name: string): string => readFileSync(join(root, "dist", name), "utf8");
      const manifest = JSON.parse(dist("manifest.webmanifest")) as {
        name: string;
        display: string;
      };
      expect(manifest).toMatchObject({ name: "Test", display: "standalone" });
      expect(dist("offline.html")).toContain("<h1>Offline</h1>");
      const worker = dist("sw.js");
      expect(worker).toMatch(/\/app\/assets\/index-[\w-]+\.js/);
      expect(worker).toContain("/app/offline.html");
      expect(worker).toContain("/app/offline.css");
      expect(worker).not.toContain("robots.txt");
      expect(worker).not.toContain(".vite");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("[PWA-22] a generated file never replaces one from public/", async () => {
    const root = mkdtempSync(join(tmpdir(), "dusk-pwa-clash-"));
    try {
      mkdirSync(join(root, "public"), { recursive: true });
      writeFileSync(
        join(root, "index.html"),
        '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
      );
      writeFileSync(join(root, "main.js"), "export {};\n");
      writeFileSync(join(root, "public", "sw.js"), "// the app's own worker\n");
      await expect(
        build({ root, configFile: false, logLevel: "silent", plugins: [pwa()] }),
      ).rejects.toThrow(/sw\.js already exists/);
      expect(readFileSync(join(root, "dist", "sw.js"), "utf8")).toBe("// the app's own worker\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("[PWA-23] a base that is not a path is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "dusk-pwa-base-"));
    try {
      writeFileSync(
        join(root, "index.html"),
        '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>',
      );
      writeFileSync(join(root, "main.js"), "export {};\n");
      await expect(
        build({
          root,
          configFile: false,
          logLevel: "silent",
          base: "https://cdn.example/",
          plugins: [pwa()],
        }),
      ).rejects.toThrow(/Vite base must be a path/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
