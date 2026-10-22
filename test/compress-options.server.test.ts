import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { negotiateEncoding, type ServerHandle, serve } from "../src/node/index";
import type { Handler } from "../src/server/types";
import { deferred } from "./support/deferred";

const open: ServerHandle[] = [];
const dirs: string[] = [];

/** True when this Node has zstd in `node:zlib` (22.15 and later; the 22.12 floor does not). */
const hasZstd = typeof zlib.createZstdCompress === "function";

afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  fetch: Handler["fetch"],
  options: Parameters<typeof serve>[1] = {},
  extra: Partial<Handler> = {},
): Promise<ServerHandle> {
  const handle = await serve({ fetch, ...extra }, { port: 0, shutdownSignals: false, ...options });
  open.push(handle);
  return handle;
}

/** Fetches without automatic decoding, to see the wire. */
function wire(
  url: string,
  acceptEncoding: string | undefined,
): Promise<{ headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () =>
          resolve({ headers: res.headers as Record<string, string>, body: Buffer.concat(parts) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const big = JSON.stringify({
  items: Array.from({ length: 200 }, (_unused, n) => ({ n, text: "lorem ipsum" })),
});
const json = async (): Promise<Response> =>
  new Response(big, { headers: { "content-type": "application/json" } });

/** Deterministic prose with enough variety that gzip levels 1 and 9 produce different sizes. */
function prose(): string {
  const words = Array.from({ length: 60 }, (_unused, n) => `w${(n * 7919) % 1013}x`);
  let seed = 12_345;
  const out: string[] = [];
  for (let n = 0; n < 12_000; n += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    out.push(words[seed % words.length] ?? "");
  }
  return out.join(" ");
}

describe("compress filter", () => {
  it("[SCMP-01] filter(request, response) decides per response; false sends the body as is, true compresses", async () => {
    const seen: Array<{ path: string; type: string | null }> = [];
    const server = await start(
      async (request) =>
        new Response(big, {
          headers: {
            "content-type": "application/json",
            "x-secret": new URL(request.url).pathname.includes("account") ? "1" : "0",
          },
        }),
      {
        compress: {
          filter: (request, response) => {
            seen.push({
              path: new URL(request.url).pathname,
              type: response.headers.get("content-type"),
            });
            return response.headers.get("x-secret") !== "1";
          },
        },
      },
    );
    const open = await wire(`${server.url}/public`, "gzip");
    expect(open.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(open.body).toString()).toBe(big);
    const secret = await wire(`${server.url}/account`, "gzip, br");
    expect(secret.headers["content-encoding"]).toBeUndefined();
    expect(secret.body.toString()).toBe(big);
    // A response that is not compressed still varies on Accept-Encoding for a cache in front.
    expect(secret.headers["vary"]).toContain("Accept-Encoding");
    expect(seen).toEqual([
      { path: "/public", type: "application/json" },
      { path: "/account", type: "application/json" },
    ]);
  });

  it("[SCMP-02] a filter that throws, returns a promise or returns a non-true value fails closed: no compression, and a throw is reported", async () => {
    const reported: unknown[] = [];
    const server = await start(json, {
      onError: (error) => reported.push(error),
      compress: {
        filter: (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/throws") throw new Error("filter exploded");
          if (path === "/promise") return Promise.resolve(true) as unknown as boolean;
          if (path === "/undefined") return undefined as unknown as boolean;
          return true;
        },
      },
    });
    for (const path of ["throws", "promise", "undefined"]) {
      const answer = await wire(`${server.url}/${path}`, "gzip");
      expect(answer.headers["content-encoding"], path).toBeUndefined();
      expect(answer.body.toString(), path).toBe(big);
    }
    expect((await wire(`${server.url}/ok`, "gzip")).headers["content-encoding"]).toBe("gzip");
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("filter exploded");
  });

  it("[SCMP-03] the filter is not asked about a response that would not be compressed anyway", async () => {
    let asked = 0;
    const server = await start(
      async (request) =>
        new Response("tiny", {
          headers: {
            "content-type": request.url.endsWith("/image") ? "image/png" : "text/plain",
            "content-length": "4",
          },
        }),
      {
        compress: {
          filter: () => {
            asked += 1;
            return true;
          },
        },
      },
    );
    await wire(`${server.url}/small`, "gzip");
    await wire(`${server.url}/image`, "gzip");
    await wire(`${server.url}/small`, undefined);
    expect(asked).toBe(0);
  });

  it("[SCMP-04] a static answer from the handler's file gate goes through the filter too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-compress-gate-"));
    dirs.push(dir);
    writeFileSync(join(dir, "data.json"), big);
    const server = await start(
      json,
      {
        static: { dir },
        compress: { filter: (request) => !new URL(request.url).pathname.startsWith("/data") },
      },
      {
        gateAsset: async () => ({
          kind: "answer",
          response: new Response(big, { headers: { "content-type": "application/json" } }),
        }),
      },
    );
    const gated = await wire(`${server.url}/data.json`, "gzip");
    expect(gated.headers["content-encoding"]).toBeUndefined();
    expect(gated.body.toString()).toBe(big);
  });
});

describe("compress types", () => {
  it("[SCMP-10] types replaces the default list: strings (exact and family) and regular expressions, parameters ignored", async () => {
    const server = await start(
      async (request) =>
        new Response(big, {
          headers: { "content-type": new URL(request.url).searchParams.get("t") ?? "" },
        }),
      { compress: { types: ["application/x-custom", "image/*", /^text\/csv$/i] } },
    );
    const encodingOf = async (type: string): Promise<string | undefined> =>
      (await wire(`${server.url}/?t=${encodeURIComponent(type)}`, "gzip")).headers[
        "content-encoding"
      ];
    expect(await encodingOf("application/x-custom; charset=utf-8")).toBe("gzip");
    expect(await encodingOf("Application/X-Custom")).toBe("gzip");
    expect(await encodingOf("image/png")).toBe("gzip");
    expect(await encodingOf("text/csv; charset=utf-8")).toBe("gzip");
    // The defaults no longer apply.
    expect(await encodingOf("application/json")).toBeUndefined();
    expect(await encodingOf("text/html")).toBeUndefined();
    expect(await encodingOf("application/x-customer")).toBeUndefined();
  });

  it("[SCMP-11] a global or sticky regular expression keeps no state between responses", async () => {
    const server = await start(json, { compress: { types: [/^application\/json/g, /^text\//y] } });
    for (let round = 0; round < 4; round += 1) {
      expect((await wire(`${server.url}/`, "gzip")).headers["content-encoding"]).toBe("gzip");
    }
  });

  it("[SCMP-12] Vary follows the list: a type outside it is not marked as varying", async () => {
    const server = await start(
      async () => new Response(big, { headers: { "content-type": "text/plain" } }),
      { compress: { types: ["application/json"] } },
    );
    const answer = await wire(`${server.url}/`, "gzip");
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.headers["vary"]).toBeUndefined();
  });

  it("[SCMP-13] static files use the same list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-compress-types-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.txt"), big);
    writeFileSync(join(dir, "b.json"), big);
    const server = await start(json, {
      static: { dir },
      compress: { types: ["application/json"] },
    });
    expect((await wire(`${server.url}/a.txt`, "gzip")).headers["content-encoding"]).toBeUndefined();
    expect((await wire(`${server.url}/b.json`, "gzip")).headers["content-encoding"]).toBe("gzip");
  });
});

describe("compress levels and options", () => {
  it("[SCMP-20] level sets the gzip level; gzipLevel overrides it", async () => {
    const text = prose();
    const body = async (): Promise<Response> =>
      new Response(text, { headers: { "content-type": "text/plain" } });
    const sizeWith = async (compress: object): Promise<number> => {
      const server = await start(body, { compress });
      const answer = await wire(server.url, "gzip");
      expect(zlib.gunzipSync(answer.body).toString()).toBe(text);
      return answer.body.length;
    };
    const fast = await sizeWith({ level: 1 });
    const best = await sizeWith({ level: 9 });
    expect(best).toBeLessThan(fast);
    expect(await sizeWith({ level: 1, gzipLevel: 9 })).toBe(best);
    expect(await sizeWith({ level: 9, gzipLevel: 1 })).toBe(fast);
  });

  it("[SCMP-21] minBytes still applies and the defaults are unchanged (br and gzip, 1024 bytes)", async () => {
    const server = await start(
      async () =>
        new Response("x".repeat(2000), {
          headers: { "content-type": "text/plain", "content-length": "2000" },
        }),
      { compress: { minBytes: 4000 } },
    );
    expect((await wire(server.url, "br")).headers["content-encoding"]).toBeUndefined();
    const plain = await start(json);
    expect((await wire(plain.url, "br, gzip")).headers["content-encoding"]).toBe("br");
    expect((await wire(plain.url, "gzip")).headers["content-encoding"]).toBe("gzip");
  });
});

describe("compress option validation", () => {
  const boot = (compress: object): Promise<ServerHandle> => start(json, { compress });

  it("[SCMP-30] an unknown option is rejected with the closest known name", async () => {
    await expect(boot({ minByte: 10 })).rejects.toThrow(
      /serve: compress: unknown option "minByte".*Did you mean "minBytes"/s,
    );
    await expect(boot({ filters: () => true })).rejects.toThrow(/Did you mean "filter"/);
  });

  it("[SCMP-31] numbers must be integers in range; the message names the option and the range", async () => {
    await expect(boot({ minBytes: -1 })).rejects.toThrow(/minBytes.*0 or more/);
    await expect(boot({ minBytes: 1.5 })).rejects.toThrow(/minBytes/);
    await expect(boot({ level: 0 })).rejects.toThrow(/level.*1 to 9/);
    await expect(boot({ level: 10 })).rejects.toThrow(/level.*1 to 9/);
    await expect(boot({ level: 2.5 })).rejects.toThrow(/level/);
    await expect(boot({ gzipLevel: 12 })).rejects.toThrow(/gzipLevel.*1 to 9/);
    await expect(boot({ brotliQuality: 6 })).rejects.toThrow(/brotliQuality.*0 to 5/);
    await expect(boot({ maxConcurrent: 0 })).rejects.toThrow(/maxConcurrent/);
    await expect(boot({ level: "6" })).rejects.toThrow(/level/);
  });

  it("[SCMP-32] types must be an array of strings and regular expressions; filter must be a function", async () => {
    await expect(boot({ types: "text/html" })).rejects.toThrow(/types.*array/);
    await expect(boot({ types: [42] })).rejects.toThrow(/types\[0\].*string or a RegExp/);
    await expect(boot({ types: [""] })).rejects.toThrow(/types\[0\]/);
    await expect(boot({ types: ["text/html", {}] })).rejects.toThrow(/types\[1\]/);
    await expect(boot({ filter: true })).rejects.toThrow(/filter.*function/);
  });

  it("[SCMP-33] compress: false and compress: {} stay valid", async () => {
    expect((await start(json, { compress: false })).port).toBeGreaterThan(0);
    expect((await start(json, { compress: {} })).port).toBeGreaterThan(0);
  });
});

describe("zstd", () => {
  it("[SCMP-40] negotiateEncoding prefers br, then zstd, then gzip, by q-value first", () => {
    expect(negotiateEncoding("gzip, br")).toBe("br");
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("br, zstd, gzip")).toBe("br");
    expect(negotiateEncoding("zstd, gzip")).toBe(hasZstd ? "zstd" : "gzip");
    expect(negotiateEncoding("zstd;q=0.5, gzip")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.5, zstd;q=0.8")).toBe(hasZstd ? "zstd" : "gzip");
    expect(negotiateEncoding("br;q=0.4, zstd, gzip;q=0.9")).toBe(hasZstd ? "zstd" : "gzip");
    expect(negotiateEncoding("zstd")).toBe(hasZstd ? "zstd" : undefined);
    expect(negotiateEncoding("zstd;q=0")).toBeUndefined();
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("br;q=0, *")).toBe(hasZstd ? "zstd" : "gzip");
  });

  it("[SCMP-41] a runtime whose node:zlib has no zstd never negotiates it", async () => {
    vi.resetModules();
    vi.doMock("node:zlib", async (importOriginal) => {
      const original = await importOriginal<typeof zlib>();
      return { ...original, createZstdCompress: undefined, zstdCompressSync: undefined };
    });
    try {
      const fresh = await import("../src/node/compress");
      expect(fresh.negotiateEncoding("zstd")).toBeUndefined();
      expect(fresh.negotiateEncoding("zstd, gzip")).toBe("gzip");
      expect(fresh.negotiateEncoding("br, zstd")).toBe("br");
      const gzip = fresh.createCompressor().open("gzip");
      expect(gzip).toBeDefined();
      gzip?.stream.destroy();
      gzip?.release();
    } finally {
      vi.doUnmock("node:zlib");
      vi.resetModules();
    }
  });

  /** Registers a zstd scenario. On a Node.js without zstd, the scenario is the fallback: a client that accepts zstd is answered with gzip. */
  function zstdIt(title: string, body: () => Promise<void>): void {
    it(title, async () => {
      if (hasZstd) {
        await body();
        return;
      }
      const server = await start(json);
      const answer = await wire(server.url, "zstd, gzip");
      expect(answer.headers["content-encoding"]).toBe("gzip");
    });
  }

  zstdIt("[SCMP-42] a dynamic response is sent as zstd and decodes to the original", async () => {
    const server = await start(json);
    const answer = await wire(server.url, "zstd, gzip");
    expect(answer.headers["content-encoding"]).toBe("zstd");
    expect(answer.headers["vary"]).toContain("Accept-Encoding");
    expect(zlib.zstdDecompressSync(answer.body).toString()).toBe(big);
    expect((await wire(server.url, "br, zstd, gzip")).headers["content-encoding"]).toBe("br");
  });

  zstdIt("[SCMP-43] a streamed zstd response flushes per chunk", async () => {
    const release = deferred<void>();
    const server = await start(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(`<p>${"a".repeat(2000)}</p>`));
              await release.promise;
              controller.enqueue(new TextEncoder().encode("<p>end</p>"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
    );
    const received = deferred<void>();
    const done = new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        `${server.url}/`,
        { headers: { "accept-encoding": "zstd" } },
        (res) => {
          expect(res.headers["content-encoding"]).toBe("zstd");
          const parts: Buffer[] = [];
          res.on("data", (part: Buffer) => {
            parts.push(part);
            received.resolve();
          });
          res.on("end", () => resolve(zlib.zstdDecompressSync(Buffer.concat(parts)).toString()));
        },
      );
      req.on("error", reject);
      req.end();
    });
    await received.promise;
    release.resolve();
    expect(await done).toContain("<p>end</p>");
  });

  zstdIt(
    "[SCMP-44] a static file is compressed as zstd on the fly, with its own ETag; a .zst sibling is served as is",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dusk-zstd-"));
      dirs.push(dir);
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "live.json"), big);
      writeFileSync(join(dir, "pre.json"), big);
      writeFileSync(join(dir, "pre.json.zst"), zlib.zstdCompressSync(Buffer.from(big)));
      writeFileSync(join(dir, "pre.json.gz"), zlib.gzipSync(big));
      const server = await start(json, { static: { dir } });
      const live = await wire(`${server.url}/live.json`, "zstd");
      expect(live.headers["content-encoding"]).toBe("zstd");
      expect(zlib.zstdDecompressSync(live.body).toString()).toBe(big);
      const identity = await wire(`${server.url}/live.json`, undefined);
      expect(live.headers["etag"]).not.toBe(identity.headers["etag"]);
      const pre = await wire(`${server.url}/pre.json`, "zstd");
      expect(pre.headers["content-encoding"]).toBe("zstd");
      expect(pre.body.equals(zlib.zstdCompressSync(Buffer.from(big)))).toBe(true);
      // A client that does not take zstd still gets its gzip sibling, not the zstd one.
      const gz = await wire(`${server.url}/pre.json`, "gzip");
      expect(gz.headers["content-encoding"]).toBe("gzip");
      expect(zlib.gunzipSync(gz.body).toString()).toBe(big);
    },
  );
});
