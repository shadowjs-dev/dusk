import { describe, expect, it } from "vitest";
import {
  apiHandler,
  apiRoute,
  createHandler,
  type DuskHandler,
  type HandlerOptions,
  json,
  readFormLimited,
  readJson,
  readTextLimited,
} from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

const MIB = 1024 * 1024;
/** The UTF-8 bytes of a text, as the `BodyInit` type takes them. */
const encode = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(new TextEncoder().encode(value));

/** The bytes of the given values, as the `BodyInit` type takes them. */
const bytesOf = (...values: number[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values);

type Routes = Record<string, ReturnType<typeof apiRoute>>;

/** A handler over the shared app plus the given API routes, with a recording error sink. */
async function boot(
  routes: Routes = {},
  options: Partial<HandlerOptions> = {},
): Promise<{ handler: DuskHandler; client: TestClient }> {
  const app = await loadApp();
  const handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app, {
      apiRoutes: Object.entries(routes).map(([path, module]) => ({
        id: path,
        path,
        load: async () => module,
      })),
    }),
    dev: true,
    onError: errorLog().onError,
    ...options,
  });
  return { handler, client: createTestClient(handler, { origin: "https://app.test" }) };
}

/** Compresses bytes with the Web Streams codec of `format`. */
async function compress(
  bytes: Uint8Array<ArrayBuffer>,
  format: "gzip" | "deflate",
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A multipart body built by the platform `Request`, with the boundary the header names. */
async function multipart(
  build: (form: FormData) => void,
): Promise<{ headers: Record<string, string>; body: Uint8Array<ArrayBuffer> }> {
  const form = new FormData();
  build(form);
  const request = new Request("https://app.test/", { method: "POST", body: form });
  return {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
    body: new Uint8Array(await request.arrayBuffer()),
  };
}

/** The `error` object of a JSON error answer. */
async function jsonError(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("error" in body)) {
    throw new TypeError("expected a JSON error body");
  }
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null) throw new TypeError("expected an error object");
  return { ...error };
}

/** A Standard Schema that accepts any JSON value, for `apiHandler({ body })`. */
const acceptAny = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const echoBytes = apiRoute({
  POST: async (event) =>
    new Response(await event.rawBody(), {
      headers: { "content-type": "application/octet-stream" },
    }),
});

describe("[G-D5] byte-exact raw body", () => {
  it("[G-D5] event.rawBody() returns the bytes the client sent, a UTF-8 BOM included", async () => {
    const { client } = await boot({ "/api/hook": echoBytes });
    const sent = bytesOf(0xef, 0xbb, 0xbf, ...encode('{"event":"ping"}'));
    const response = await client.post("/api/hook", {
      headers: { "content-type": "application/json" },
      body: sent,
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(sent);
  });

  it("[G-D5] event.rawBody() keeps invalid UTF-8 bytes exactly", async () => {
    const { client } = await boot({ "/api/hook": echoBytes });
    const sent = bytesOf(0xff, 0xfe, 0x80, 0x41, 0xc3);
    const response = await client.post("/api/hook", {
      headers: { "content-type": "application/octet-stream" },
      body: sent,
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(sent);
  });

  it("[G-D5] event.rawBody() honors the global body limit with 413", async () => {
    const { client } = await boot(
      { "/api/hook": echoBytes },
      { security: { limits: { maxBodyBytes: 16 } } },
    );
    const response = await client.post("/api/hook", { body: "x".repeat(100) });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[G-D5] rawBody and readJson read the body once: both see the same bytes", async () => {
    const { client } = await boot({
      "/api/hook": apiRoute({
        POST: async (event) => {
          const raw = await event.rawBody();
          const parsed = await readJson(event.request);
          return json({ bytes: raw.byteLength, value: parsed });
        },
      }),
    });
    const response = await client.post("/api/hook", {
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(await response.json()).toEqual({ bytes: 7, value: { a: 1 } });
  });
});

describe("[G-D6] request Content-Encoding", () => {
  const readJsonRoute = apiRoute({
    POST: async (event) => json({ got: await readJson(event.request) }),
  });

  it("[G-D6] gzipped JSON to an API route is decoded", async () => {
    const { client } = await boot({ "/api/json": readJsonRoute });
    const body = await compress(encode('{"n":42}'), "gzip");
    const response = await client.post("/api/json", {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ got: { n: 42 } });
  });

  it("[G-D6] deflate is decoded with the same rules", async () => {
    const { client } = await boot({ "/api/json": readJsonRoute });
    const body = await compress(encode('{"n":7}'), "deflate");
    const response = await client.post("/api/json", {
      headers: { "content-type": "application/json", "content-encoding": "deflate" },
      body,
    });
    expect(await response.json()).toEqual({ got: { n: 7 } });
  });

  it("[G-D6] a gzip bomb is cut off at the limit on the decoded size with 413", async () => {
    const { client } = await boot(
      { "/api/json": readJsonRoute },
      { security: { limits: { maxBodyBytes: 4096 } } },
    );
    const body = await compress(new Uint8Array(MIB), "gzip");
    expect(body.byteLength).toBeLessThan(4096);
    const response = await client.post("/api/json", {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body,
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[G-D6] br is refused with 415 and a JSON error on an API route", async () => {
    const { client } = await boot({ "/api/json": readJsonRoute });
    const response = await client.post("/api/json", {
      headers: { "content-type": "application/json", "content-encoding": "br" },
      body: "x",
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[G-D6] a corrupt gzip body is a 400, not a 500", async () => {
    const { client } = await boot({ "/api/json": readJsonRoute });
    const response = await client.post("/api/json", {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: encode("not gzip at all"),
    });
    expect(response.status).toBe(400);
  });
});

describe("[G-D4] framing rejections take the shape of the route", () => {
  const limits = { dev: true, security: { limits: { maxBodyBytes: 1000 } } } as const;

  it("[G-D4] an oversize Content-Length on an API route is a JSON 413", async () => {
    const { client } = await boot({ "/api/x": apiRoute({ POST: () => json({}) }) }, limits);
    const response = await client.post("/api/x", {
      headers: { "content-length": "5000" },
      body: "hello",
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await jsonError(response)).toMatchObject({ status: 413 });
  });

  it("[G-D4] a bad Content-Length on an API route is a JSON 400", async () => {
    const { client } = await boot({ "/api/x": apiRoute({ POST: () => json({}) }) }, limits);
    const response = await client.post("/api/x", {
      headers: { "content-length": "abc" },
      body: "hello",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[G-D4] an oversize Content-Length on a page is an HTML 413", async () => {
    const { client } = await boot({}, limits);
    const response = await client.post("/", {
      headers: { "content-length": "5000" },
      body: "hello",
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("[G-D4] an oversize Content-Length on a server function path is a JSON 413", async () => {
    const { client } = await boot({}, limits);
    const response = await client.post("/_dusk/fn/echo", {
      headers: { "content-length": "5000" },
      body: "hello",
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[G-D4] a bad Content-Length on a server function path is a JSON 400", async () => {
    const { client } = await boot({}, limits);
    const response = await client.post("/_dusk/fn/echo", {
      headers: { "content-length": "5, 5" },
      body: "hello",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("[G-D3] a route's maxBodyBytes is its own limit", () => {
  const upload = apiRoute({
    POST: apiHandler({ body: acceptAny, maxBodyBytes: 2 * MIB }, ({ event }) =>
      json({ ok: event.method }),
    ),
  });

  it("[G-D3] an API route with a 2 MiB route limit accepts a 1.5 MiB body the 1 MiB default rejects", async () => {
    const { client } = await boot({
      "/api/upload": upload,
      "/api/small": apiRoute({ POST: apiHandler({ body: acceptAny }, () => json({})) }),
    });
    const payload = JSON.stringify({ data: "x".repeat(Math.floor(1.5 * MIB)) });
    const accepted = await client.post("/api/upload", {
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(accepted.status).toBe(200);
    const rejected = await client.post("/api/small", {
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(rejected.status).toBe(413);
  });

  it("[G-D3] a route limit above security.limits.maxRouteBodyBytes is clamped to that ceiling", async () => {
    const { client } = await boot(
      { "/api/upload": upload },
      { security: { limits: { maxRouteBodyBytes: MIB + MIB / 4 } } },
    );
    const response = await client.post("/api/upload", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(Math.floor(1.5 * MIB)) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("[G-D1] form and multipart caps", () => {
  const form = apiRoute({
    POST: async (event) => {
      const fields = await readFormLimited(event.request, { maxFileBytes: 10 });
      return json({ keys: Object.keys(fields) });
    },
  });

  it("[G-D1] a multipart upload with a file over the cap is a 413 with a JSON code", async () => {
    const { client } = await boot({ "/api/form": form });
    const upload = await multipart((body) => {
      body.set("file", new File([new Uint8Array(100)], "big.bin"));
    });
    const response = await client.post("/api/form", { headers: upload.headers, body: upload.body });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await jsonError(response)).toMatchObject({ data: { code: "FORM_FILE_TOO_LARGE" } });
  });

  it("[G-D1] too many fields is a 413 with a code", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: async (event) =>
          json({ n: Object.keys(await readFormLimited(event.request, { maxFields: 2 })).length }),
      }),
    });
    const upload = await multipart((body) => {
      body.set("a", "1");
      body.set("b", "2");
      body.set("c", "3");
    });
    const response = await client.post("/api/form", { headers: upload.headers, body: upload.body });
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({ data: { code: "FORM_TOO_MANY_FIELDS" } });
  });

  it("[G-D1] too many files is a 413 with a code", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: async (event) =>
          json({
            n: Object.keys(await readFormLimited(event.request, { maxFileCount: 1 })).length,
          }),
      }),
    });
    const upload = await multipart((body) => {
      body.append("one", new File(["a"], "a.txt"));
      body.append("two", new File(["b"], "b.txt"));
    });
    const response = await client.post("/api/form", { headers: upload.headers, body: upload.body });
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({ data: { code: "FORM_TOO_MANY_FILES" } });
  });

  it("[G-D1] a text field over its byte cap is a 413 with a code", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: async (event) =>
          json({
            n: Object.keys(await readFormLimited(event.request, { maxFieldBytes: 8 })).length,
          }),
      }),
    });
    const upload = await multipart((body) => {
      body.set("notes", "x".repeat(20));
    });
    const response = await client.post("/api/form", { headers: upload.headers, body: upload.body });
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({ data: { code: "FORM_FIELD_TOO_LARGE" } });
  });

  it("[G-D1] a urlencoded form is capped by the same field count", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: async (event) =>
          json({ n: Object.keys(await readFormLimited(event.request, { maxFields: 2 })).length }),
      }),
    });
    const response = await client.post("/api/form", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=2&c=3",
    });
    expect(response.status).toBe(413);
  });

  it("[G-D1] the caps come from security.limits.form when the route gives none", async () => {
    const { client } = await boot(
      {
        "/api/form": apiRoute({
          POST: async (event) =>
            json({ n: Object.keys(await readFormLimited(event.request)).length }),
        }),
      },
      { security: { limits: { form: { maxFields: 2 } } } },
    );
    const response = await client.post("/api/form", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=2&c=3",
    });
    expect(response.status).toBe(413);
  });

  it("[G-D1] within the caps a multipart upload passes and the File arrives intact", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: async (event) => {
          const fields = await readFormLimited(event.request, { maxFileBytes: 64 });
          const file = fields["file"];
          if (!(file instanceof File)) return json({ ok: false });
          return json({ title: fields["title"], name: file.name, text: await file.text() });
        },
      }),
    });
    const upload = await multipart((body) => {
      body.set("title", "hello");
      body.set("file", new File(["payload é"], "a.txt", { type: "text/plain" }));
    });
    const response = await client.post("/api/form", { headers: upload.headers, body: upload.body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "hello", name: "a.txt", text: "payload é" });
  });
});

describe("[G-D7] text charset", () => {
  const text = apiRoute({
    POST: async (event) => json({ text: await readTextLimited(event.request, 1024) }),
  });

  const cases: ReadonlyArray<readonly [string, string, Uint8Array<ArrayBuffer>, string]> = [
    [
      "[G-D7] utf-8 is the default and decodes non-ASCII",
      "text/plain",
      bytesOf(0x68, 0xc3, 0xa9),
      "hé",
    ],
    ["[G-D7] utf-16le decodes", "text/plain; charset=utf-16le", bytesOf(0x68, 0, 0xe9, 0), "hé"],
    ["[G-D7] utf-16be decodes", "text/plain; charset=utf-16be", bytesOf(0, 0x68, 0, 0xe9), "hé"],
    ["[G-D7] iso-8859-1 decodes", "text/plain; charset=iso-8859-1", bytesOf(0x68, 0xe9), "hé"],
    ["[G-D7] latin1 decodes", "text/plain; charset=latin1", bytesOf(0x68, 0xe9), "hé"],
  ];
  for (const [name, contentType, bytes, expected] of cases) {
    it(name, async () => {
      const { client } = await boot({ "/api/text": text });
      const response = await client.post("/api/text", {
        headers: { "content-type": contentType },
        body: bytes,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: expected });
    });
  }

  it("[G-D7] an unknown charset is a 415 with a JSON error", async () => {
    const { client } = await boot({ "/api/text": text });
    const response = await client.post("/api/text", {
      headers: { "content-type": "text/plain; charset=shift_jis" },
      body: "abc",
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("[G-D8] a second read of a body", () => {
  it("[G-D8] a second read is a 500 that says the body was already read and names the two fixes", async () => {
    const { client } = await boot({
      "/api/twice": apiRoute({
        POST: async (event) => {
          await event.request.text();
          return json({ again: await event.request.text() });
        },
      }),
    });
    const response = await client.post("/api/twice", { body: "abc" });
    expect(response.status).toBe(500);
    const message = String((await jsonError(response))["message"]);
    expect(message).toContain("already consumed");
    expect(message).toContain("event.rawBody()");
    expect(message).toContain("request.clone()");
  });
});
