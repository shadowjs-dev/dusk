import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";

let dir: string;
let server: ServerHandle;

const handler = { fetch: async () => new Response("handler", { status: 404 }) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dusk-r7-etag-"));
  writeFileSync(join(dir, "big.txt"), "0123456789".repeat(400));
  writeFileSync(join(dir, "small.txt"), "tiny");
  server = await serve(handler, { port: 0, shutdownSignals: false, static: { dir } });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string>): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers });

describe("a compressed static file revalidates", () => {
  it("[DUSK-R7-6] the ETag of a file compressed on the fly gets a 304 when the client sends it back", async () => {
    const first = await get("/big.txt", { "accept-encoding": "gzip" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-encoding")).toBe("gzip");
    const etag = first.headers.get("etag") ?? "";
    expect(etag).toMatch(/-gzip"$/);
    await first.arrayBuffer();
    const again = await get("/big.txt", { "accept-encoding": "gzip", "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    // The identity copy has its own tag, and a tag the file never had does not match.
    const identity = await get("/big.txt", { "accept-encoding": "identity" });
    const plain = identity.headers.get("etag") ?? "";
    expect(plain).not.toBe(etag);
    await identity.arrayBuffer();
    expect(
      (await get("/big.txt", { "accept-encoding": "identity", "if-none-match": plain })).status,
    ).toBe(304);
    expect(
      (await get("/big.txt", { "accept-encoding": "gzip", "if-none-match": '"other"' })).status,
    ).toBe(200);
  });

  it("[DUSK-R7-6] a file too small to compress keeps the identity tag and still gets its 304", async () => {
    const first = await get("/small.txt", { "accept-encoding": "gzip" });
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();
    expect(etag).not.toMatch(/-gzip"$/);
    expect(
      (await get("/small.txt", { "accept-encoding": "gzip", "if-none-match": etag })).status,
    ).toBe(304);
  });
});
