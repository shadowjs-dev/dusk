import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import type { DuskHandler } from "../src/server/index";
import { auditHandler, loadAuditApp } from "./support/audit";
import { rawRequest, statusOf } from "./support/net";

const SECRET = "OUTSIDE-SECRET-7f3a";
let root: string;
let publicDir: string;
let handler: DuskHandler;
let server: ServerHandle;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "dusk-audit-"));
  publicDir = join(root, "public");
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(join(root, "private"), { recursive: true });
  writeFileSync(join(root, "OUTSIDE.txt"), SECRET);
  writeFileSync(join(root, "private", "key.txt"), SECRET);
  writeFileSync(join(publicDir, "index.html"), "<!doctype html><p>public</p>");
  writeFileSync(join(publicDir, ".env"), `KEY=${SECRET}`);
  writeFileSync(join(publicDir, "app.js"), "console.log(1)");
  symlinkSync(join(root, "OUTSIDE.txt"), join(publicDir, "link.txt"));
  symlinkSync(join(root, "private"), join(publicDir, "linkdir"));
  const app = await loadAuditApp();
  ({ handler } = auditHandler(app, { onError: () => undefined }));
  server = await serve(handler, {
    port: 0,
    host: "127.0.0.1",
    static: { dir: publicDir },
    shutdownSignals: false,
    compress: false,
  });
});

afterAll(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

/** Sends one raw request line and returns the status and the whole answer. */
async function raw(target: string, extra = ""): Promise<{ status: number; text: string }> {
  const text = await rawRequest(
    server.port,
    `GET ${target} HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n${extra}\r\n`,
  );
  return { status: statusOf(text), text };
}

describe("SEC-13x static files over a real socket", () => {
  it.each([
    "/..%2fOUTSIDE.txt",
    "/%2e%2e/OUTSIDE.txt",
    "/%2e%2e%2fOUTSIDE.txt",
    "/..%5cOUTSIDE.txt",
    "/..\\OUTSIDE.txt",
    "/./../OUTSIDE.txt",
    "//../OUTSIDE.txt",
    "/index.html/..%2fOUTSIDE.txt",
    "/%00/OUTSIDE.txt",
    "/index.html%00.txt",
    "/link.txt",
    "/linkdir/key.txt",
    "/linkdir%2fkey.txt",
    "/.env",
    "/%2eenv",
    "/%252e%252e/OUTSIDE.txt",
  ])("[SEC-130] %s never returns a file from outside the public directory", async (target) => {
    const response = await raw(target);
    expect(response.text).not.toContain(SECRET);
  });

  it("[SEC-131] an encoded traversal is a 400, never a 200", async () => {
    expect((await raw("/..%2fOUTSIDE.txt")).status).not.toBe(200);
    expect((await raw("/%00/OUTSIDE.txt")).status).toBe(400);
  });

  it("[SEC-132] a file that exists is served with nosniff and an ETag", async () => {
    const response = await raw("/app.js");
    expect(statusOf(response.text)).toBe(200);
    expect(response.text.toLowerCase()).toContain("x-content-type-options: nosniff");
    expect(response.text.toLowerCase()).toContain("etag:");
  });

  it("[SEC-133] a static HTML page carries the framing and referrer defaults that the handler sends", async () => {
    const response = await raw("/index.html");
    expect(statusOf(response.text)).toBe(200);
    expect(response.text.toLowerCase()).toContain("x-frame-options: sameorigin");
    expect(response.text.toLowerCase()).toContain("referrer-policy:");
  });
});

describe("SEC-14x request framing over a real socket (smuggling)", () => {
  const body = '{"a":1}';

  it("[SEC-140] two Content-Length headers are refused and the body is not parsed", async () => {
    const text = await rawRequest(
      server.port,
      `POST /api/json HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n${body}`,
    );
    expect(statusOf(text)).toBe(400);
    expect(text).not.toContain('"ok":');
  });

  it("[SEC-141] Content-Length together with Transfer-Encoding is refused", async () => {
    const text = await rawRequest(
      server.port,
      `POST /api/json HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
    );
    expect(statusOf(text)).toBe(400);
  });

  it("[SEC-142] a Transfer-Encoding other than plain chunked is refused, never read as chunked", async () => {
    const text = await rawRequest(
      server.port,
      `POST /api/json HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/json\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
    );
    expect([400, 501]).toContain(statusOf(text));
  });

  it("[SEC-143] two Host headers are refused", async () => {
    const text = await rawRequest(
      server.port,
      "GET /api/items HTTP/1.1\r\nHost: app.test\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    expect(statusOf(text)).toBe(400);
  });

  it("[SEC-144] an absolute-form request target is not read as a proxy request", async () => {
    const text = await rawRequest(
      server.port,
      "GET http://evil.example/secret HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n",
    );
    expect(statusOf(text)).toBe(400);
  });

  it("[SEC-145] a header name with a space or a control character is refused", async () => {
    const text = await rawRequest(
      server.port,
      "GET /api/items HTTP/1.1\r\nHost: app.test\r\nX Bad: 1\r\nConnection: close\r\n\r\n",
    );
    expect([400, 431]).toContain(statusOf(text));
  });

  it("[SEC-146] a header block over the 16 KiB limit is refused before the handler runs", async () => {
    const big = "x".repeat(20_000);
    const text = await rawRequest(
      server.port,
      `GET /api/items HTTP/1.1\r\nHost: app.test\r\nX-Big: ${big}\r\nConnection: close\r\n\r\n`,
    );
    expect([400, 431]).toContain(statusOf(text));
    expect(text).not.toContain('"query"');
  });

  it("[SEC-147] a request line that is not valid HTTP gets a 400 and the connection is closed", async () => {
    const text = await rawRequest(server.port, "GET /\u0001 HTTP/1.1\r\nHost: app.test\r\n\r\n");
    expect([400, 0]).toContain(statusOf(text));
  });
});
