import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeFetch } from "../src/adapter/native";
import { type ServerHandle, serve } from "../src/node/index";
import { ifRangeMatches, parseRange } from "../src/node/static-files";
import { file } from "../src/server/file";
import type { Handler } from "../src/server/types";

const BODY = "0123456789".repeat(100);
const OLD = new Date("2024-01-02T03:04:05Z");

let dir: string;
let server: ServerHandle;

const handler = { fetch: async () => new Response("handler", { status: 404 }) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dusk-r2-range-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "old.txt"), BODY);
  writeFileSync(join(dir, "fresh.txt"), BODY);
  utimesSync(join(dir, "old.txt"), OLD, OLD);
  server = await serve(handler, {
    port: 0,
    shutdownSignals: false,
    static: { dir },
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

type Fetcher = (path: string, headers: Record<string, string>) => Promise<Response>;

const viaNode: Fetcher = (path, headers) =>
  fetch(`${server.url}${path}`, { headers: { "accept-encoding": "identity", ...headers } });

const viaNative: Fetcher = (path, headers) => {
  const answer = createNativeFetch(handler as unknown as Handler, {
    static: dir,
    compress: false,
    onError: (error) => {
      throw error;
    },
  });
  return answer(new Request(`http://localhost${path}`, { headers }), undefined);
};

describe.each([
  ["node server", viaNode],
  ["native (Bun/Deno) layer", viaNative],
] as const)("Range on the %s", (_name, request) => {
  const range = (value: string, extra: Record<string, string> = {}, path = "/old.txt") =>
    request(path, { range: value, ...extra });

  it("[DUSK-R2-4] a range-spec whose last position is before its first is invalid and ignored (200 full)", async () => {
    for (const value of ["bytes=5-2", "bytes=0-3,5-2", "bytes=2000-1"]) {
      const response = await range(value);
      expect(response.status, value).toBe(200);
      expect((await response.text()).length, value).toBe(BODY.length);
    }
  });

  it("[DUSK-R2-4] a valid range that selects nothing is 416 with Content-Range */size", async () => {
    for (const value of [`bytes=${BODY.length}-`, "bytes=-0"]) {
      const response = await range(value);
      expect(response.status, value).toBe(416);
      expect(response.headers.get("content-range"), value).toBe(`bytes */${BODY.length}`);
    }
  });

  it("[DUSK-R2-4] a valid range is 206 with the slice, and the unit is case-insensitive", async () => {
    for (const value of ["bytes=10-19", "Bytes=10-19"]) {
      const response = await range(value);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes 10-19/${BODY.length}`);
      expect(response.headers.get("content-length")).toBe("10");
      expect(await response.text()).toBe(BODY.slice(10, 20));
    }
    expect((await request("/old.txt", {})).headers.get("accept-ranges")).toBe("bytes");
  });

  it("[DUSK-R2-4] If-Range with the exact Last-Modified date allows the range", async () => {
    const response = await range("bytes=0-3", { "if-range": OLD.toUTCString() });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("0123");
  });

  it("[DUSK-R2-4] If-Range with another date, a bad date or any weak entity tag returns the whole file", async () => {
    const etag = (await request("/old.txt", {})).headers.get("etag") ?? "";
    expect(etag.startsWith("W/")).toBe(true);
    for (const value of [
      new Date(OLD.getTime() + 1000).toUTCString(),
      "not a date",
      etag,
      'W/"stale"',
      '"strong-but-different"',
    ]) {
      const response = await range("bytes=0-3", { "if-range": value });
      expect(response.status, value).toBe(200);
      expect((await response.text()).length, value).toBe(BODY.length);
    }
  });

  it("[DUSK-R2-4] a Last-Modified less than a second old is a weak validator and never satisfies If-Range", async () => {
    const now = new Date();
    utimesSync(join(dir, "fresh.txt"), now, now);
    const modified = (await request("/fresh.txt", {})).headers.get("last-modified") ?? "";
    const response = await range("bytes=0-3", { "if-range": modified }, "/fresh.txt");
    expect(response.status).toBe(200);
  });

  it("[DUSK-R2-4] a HEAD range request has the status and headers of the slice and no body", async () => {
    if (request !== viaNative) return;
    const answer = createNativeFetch(handler as unknown as Handler, {
      static: dir,
      compress: false,
      onError: (error) => {
        throw error;
      },
    });
    const head = await answer(
      new Request("http://localhost/old.txt", { method: "HEAD", headers: { range: "bytes=0-3" } }),
      undefined,
    );
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-3/${BODY.length}`);
    expect(await head.text()).toBe("");
  });
});

describe("range helpers", () => {
  it("[DUSK-R2-4] parseRange tells an invalid range-spec (null) from an unsatisfiable one", () => {
    expect(parseRange("bytes=5-2", 100)).toBeNull();
    expect(parseRange("bytes=5-2", 3)).toBeNull();
    expect(parseRange("bytes=200-300", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
  });

  it("[DUSK-R2-4] ifRangeMatches uses the strong comparison for entity tags", () => {
    const old = Date.parse("2024-01-02T03:04:05Z");
    const now = old + 86_400_000;
    expect(ifRangeMatches('"abc"', '"abc"', old, now)).toBe(true);
    expect(ifRangeMatches('"abc"', '"abd"', old, now)).toBe(false);
    expect(ifRangeMatches('W/"abc"', 'W/"abc"', old, now)).toBe(false);
    expect(ifRangeMatches('W/"abc"', '"abc"', old, now)).toBe(false);
    expect(ifRangeMatches('"abc"', 'W/"abc"', old, now)).toBe(false);
  });
});

describe("file(): the same reading of Range and If-Range", () => {
  const body = new TextEncoder().encode("0123456789");
  const ask = (headers: Record<string, string>, options: Record<string, unknown> = {}) =>
    file(body, { request: new Request("http://x.test/f", { headers }), ...options });

  it("[DUSK-R2-4] bytes=5-2 is invalid and ignored: the whole file", async () => {
    const response = ask({ range: "bytes=5-2" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
  });

  it("[DUSK-R2-4] a strong entity tag in If-Range allows the range; a weak one never does", async () => {
    expect(ask({ range: "bytes=0-3", "if-range": '"v1"' }, { etag: '"v1"' }).status).toBe(206);
    expect(ask({ range: "bytes=0-3", "if-range": '"v2"' }, { etag: '"v1"' }).status).toBe(200);
    expect(ask({ range: "bytes=0-3", "if-range": 'W/"v1"' }, { etag: 'W/"v1"' }).status).toBe(200);
    expect(ask({ range: "bytes=0-3", "if-range": '"v1"' }, { etag: 'W/"v1"' }).status).toBe(200);
  });

  it("[DUSK-R2-4] a date in If-Range must equal an old enough Last-Modified, whatever the etag", () => {
    const old = new Date("2024-01-02T03:04:05Z");
    const asked = { range: "bytes=0-3", "if-range": old.toUTCString() };
    expect(ask(asked, { lastModified: old }).status).toBe(206);
    expect(ask(asked, { lastModified: old, etag: '"v1"' }).status).toBe(206);
    expect(ask(asked, { lastModified: new Date(old.getTime() + 1000) }).status).toBe(200);
    expect(ask(asked).status).toBe(200);
    const now = new Date();
    expect(
      ask({ range: "bytes=0-3", "if-range": now.toUTCString() }, { lastModified: now }).status,
    ).toBe(200);
  });
});
