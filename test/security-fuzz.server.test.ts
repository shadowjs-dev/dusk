import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServerHandle, serve } from "../src/node/index";
import type { DuskHandler } from "../src/server/index";
import { auditHandler, loadAuditApp } from "./support/audit";

/**
 * Fuzz-style tests: random malformed HTTP at the handler and at a real `serve()`. The generator is seeded, so a
 * failure replays. Invariants: every answer is a status from the allowed set; no body shows a stack trace, a
 * source path or a secret; every call settles (no hang); no unhandled rejection; memory stays bounded.
 */

const ALLOWED = new Set([
  200, 201, 204, 206, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 405, 409, 413, 414, 415,
  416, 426, 429, 431, 499, 500, 501, 503, 504,
]);
const LEAK = /\n\s+at |node_modules|\/Users\/|\.ts:\d+|SECRET-FUZZ|stack/i;
const SECRET = "SECRET-FUZZ-1";

/** Mulberry32: a small seeded generator, so every run sees the same sequence. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_PIECES = [
  "/",
  "/",
  "/",
  "..",
  ".",
  "%",
  "%2e",
  "%2f",
  "%5c",
  "%00",
  "%ff",
  "%E2%80%A8",
  "\\",
  "?",
  "#",
  ";",
  "a",
  "api",
  "items",
  "dashboard",
  "notes",
  "_dusk",
  "fn",
  "image",
  "nav",
  "_batch",
  "\u0000",
  " ",
  "é",
  "~",
  "*",
  "%252e",
  "1",
  "99999999999999999999",
];
const HEADER_NAMES = [
  "content-type",
  "content-length",
  "transfer-encoding",
  "origin",
  "referer",
  "sec-fetch-site",
  "cookie",
  "accept",
  "x-dusk-fn",
  "x-dusk-deployment",
  "x-dusk-location",
  "x-forwarded-for",
  "authorization",
  "if-none-match",
  "range",
  "x-custom",
];
const VALUES = [
  "",
  "1",
  "0",
  "-1",
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=x",
  "text/html",
  "chunked",
  "gzip, chunked",
  "null",
  "https://app.test",
  "https://evil.example",
  "same-origin",
  "cross-site",
  "none",
  "*/*",
  "1.2.3.4, 5.6.7.8",
  "[::1]",
  "::ffff:10.0.0.1",
  "x".repeat(300),
  "%00%ff",
  "A".repeat(9000),
  `shadow_session=${SECRET}`,
  "__dusk_flash=garbage",
  'W/"abc"',
  "bytes=0-",
  "bytes=5-2",
];

function randomPath(next: () => number): string {
  const count = 1 + Math.floor(next() * 8);
  let out = "";
  for (let index = 0; index < count; index += 1) {
    out += PATH_PIECES[Math.floor(next() * PATH_PIECES.length)] ?? "/";
  }
  return out.startsWith("/") ? out : `/${out}`;
}

const PREFIXES = [
  "",
  "/_dusk/fn/",
  "/_dusk/image",
  "/_dusk/nav",
  "/_dusk/fn/_batch",
  "/api/items",
  "/api/json",
  "/notes/",
];

/** One random request. Bodies are bounded so the test itself stays small. */
function randomRequest(next: () => number): Request {
  const methods = [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "TRACE",
    "get",
    "POST ",
  ];
  const method = methods[Math.floor(next() * methods.length)] ?? "GET";
  const prefix = PREFIXES[Math.floor(next() * PREFIXES.length)] ?? "";
  const path = `${prefix}${randomPath(next)}`;
  const headers = new Headers();
  const count = Math.floor(next() * 6);
  for (let index = 0; index < count; index += 1) {
    const name = HEADER_NAMES[Math.floor(next() * HEADER_NAMES.length)] ?? "x-custom";
    const value = VALUES[Math.floor(next() * VALUES.length)] ?? "";
    headers.append(name, value);
  }
  const bodies = [
    "",
    "{}",
    "[]",
    '[{"id":"echo","input":1}]',
    '{"__proto__":{}}',
    "x".repeat(2048),
    "\u0000\u0001",
  ];
  const body = next() < 0.5 ? undefined : bodies[Math.floor(next() * bodies.length)];
  const withBody =
    body !== undefined && method !== "GET" && method !== "HEAD" && method !== "TRACE";
  try {
    return new Request(`https://app.test${path}`, {
      method,
      headers,
      ...(withBody ? { body, duplex: "half" as const } : {}),
    } as RequestInit);
  } catch {
    // The Request constructor refuses some combinations: the generator simply asks again with a plain GET.
    return new Request("https://app.test/");
  }
}

let unhandled = 0;
const onUnhandled = (): void => {
  unhandled += 1;
};

describe("SEC-30x fuzz: random requests at the handler", () => {
  let handler: DuskHandler;
  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    const app = await loadAuditApp();
    ({ handler } = auditHandler(app, { onError: () => undefined }));
  });
  afterAll(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  it("[SEC-300] 400 seeded malformed requests: allowed status, no leaks, every call settles, no unhandled rejection", async () => {
    const next = rng(0x5eed1);
    const heapBefore = process.memoryUsage().heapUsed;
    const failures: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      const request = randomRequest(next);
      const settled = await Promise.race([
        handler.fetch(request, { clientAddress: "203.0.113.7" }).then(async (response) => ({
          response,
          text: request.method === "HEAD" ? "" : await response.text(),
        })),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5000)),
      ]);
      if (settled === "hung") {
        failures.push(`hung: ${request.method} ${request.url}`);
        continue;
      }
      if (!ALLOWED.has(settled.response.status)) {
        failures.push(`status ${settled.response.status}: ${request.method} ${request.url}`);
      }
      if (LEAK.test(settled.text)) failures.push(`leak in body: ${request.method} ${request.url}`);
      if (settled.text.includes(SECRET))
        failures.push(`secret echoed: ${request.method} ${request.url}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(failures).toEqual([]);
    expect(unhandled).toBe(0);
    const growth = process.memoryUsage().heapUsed - heapBefore;
    expect(growth).toBeLessThan(200 * 1024 * 1024);
  });

  it("[SEC-301] a body far beyond the limit, read in pieces, is cut off with 413 and the process stays up", async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
    const response = await handler.fetch(
      new Request("https://app.test/api/json", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.test",
          "sec-fetch-site": "same-origin",
        },
        body: big,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });
});

describe("SEC-31x fuzz: random bytes at a real serve()", () => {
  let server: ServerHandle;
  beforeAll(async () => {
    const app = await loadAuditApp();
    const { handler } = auditHandler(app, { onError: () => undefined });
    server = await serve(handler, {
      port: 0,
      host: "127.0.0.1",
      shutdownSignals: false,
      compress: false,
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it("[SEC-310] 60 seeded byte streams: every connection ends (a status line or a close), none hangs, no stack in the answer", async () => {
    const next = rng(0xbeef);
    const problems: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const length = 1 + Math.floor(next() * 400);
      const bytes = new Uint8Array(length);
      for (let at = 0; at < length; at += 1) bytes[at] = Math.floor(next() * 256);
      if (next() < 0.5) {
        const head = Buffer.from("GET /api/items HTTP/1.1\r\nHost: app.test\r\n");
        const merged = new Uint8Array(head.byteLength + bytes.byteLength);
        merged.set(head, 0);
        merged.set(bytes, head.byteLength);
        bytes.set(merged.subarray(0, length));
      }
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect(server.port, "127.0.0.1");
        const parts: Buffer[] = [];
        const timer = setTimeout(() => {
          socket.destroy();
          resolve("hung");
        }, 3000);
        // Half-close after the bytes: a request cut short then gets EOF, so the server must answer or close.
        socket.on("connect", () => socket.end(bytes));
        socket.on("data", (chunk: Buffer) => parts.push(chunk));
        socket.on("error", () => undefined);
        socket.on("close", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(parts).toString("latin1"));
        });
      });
      if (outcome === "hung") problems.push(`hung on ${index}`);
      else {
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(outcome)?.[1] ?? 0);
        if (status !== 0 && !ALLOWED.has(status)) problems.push(`status ${status} on ${index}`);
        if (LEAK.test(outcome)) problems.push(`leak on ${index}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
