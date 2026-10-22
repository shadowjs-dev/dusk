import { serialize } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import {
  apiHandler,
  apiRoute,
  BodyTooLargeError,
  createHandler,
  type DuskHandler,
  type HandlerOptions,
  json,
  readFormLimited,
  readJsonLimited,
  serverFn,
} from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

/**
 * Over-limit bodies: the JSON error envelope on API routes, the 413 a helper or `apiHandler` raises, and the per-function
 * body limit of a server function (`serverFn({ maxBodyBytes })`). A declared length and a chunked body are both tested.
 */

/** A Standard Schema that accepts any JSON value (the body is then the parsed text). */
const acceptAnyBody = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

type ApiRoutes = Record<string, ReturnType<typeof apiRoute>>;

async function boot(
  routes: ApiRoutes = {},
  options: Partial<HandlerOptions> = {},
  fns: Record<string, ReturnType<typeof serverFn>> = {},
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
      serverFns: Object.fromEntries(
        Object.entries(fns).map(([id, definition]) => [id, { load: async () => definition }]),
      ),
    }),
    dev: true,
    onError: errorLog().onError,
    ...options,
  });
  return { handler, client: createTestClient(handler, { origin: "https://app.test" }) };
}

/** A body that is sent without a `Content-Length` (chunked), so the limit is hit while it is read. */
function chunked(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function jsonError(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("error" in body)) {
    throw new TypeError("expected a JSON error body");
  }
  const error: unknown = body.error;
  if (typeof error !== "object" || error === null) throw new TypeError("expected an error object");
  return { ...error };
}

const big = (bytes: number) => JSON.stringify({ text: "x".repeat(bytes) });

describe("[G-D4] over-limit bodies of API routes are JSON", () => {
  it("[BL-01] a chunked body over the route's own limit is a JSON 413 and the handler does not run", async () => {
    let ran = 0;
    const { client } = await boot({
      "/api/upload": apiRoute({
        POST: apiHandler({ body: acceptAnyBody, maxBodyBytes: 2000 }, () => {
          ran += 1;
          return json({ ok: true });
        }),
      }),
    });
    const response = await client.post("/api/upload", {
      headers: { "content-type": "application/json" },
      body: chunked(big(5000)),
      duplex: "half",
    } as never);
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({ status: 413 });
    expect(ran).toBe(0);
  });

  it("[BL-02] a chunked body over the route's own limit is a JSON 413 when the route reads it (readJsonLimited)", async () => {
    const { client } = await boot({
      "/api/read": apiRoute({
        POST: async (event) => json(await readJsonLimited(event.request, 2000)),
      }),
    });
    const response = await client.post("/api/read", {
      headers: { "content-type": "application/json" },
      body: chunked(big(5000)),
      duplex: "half",
    } as never);
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await jsonError(response)).toMatchObject({ status: 413 });
  });

  it("[BL-03] a declared Content-Length over the route's own limit is a JSON 413 before a byte is read", async () => {
    let read = 0;
    const { client } = await boot({
      "/api/read": apiRoute({
        POST: async (event) => {
          read += 1;
          return json(await readJsonLimited(event.request, 2000));
        },
      }),
    });
    const response = await client.post("/api/read", {
      headers: { "content-type": "application/json", "content-length": "5000" },
      body: big(5000),
    });
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({ status: 413 });
    expect(read).toBe(1);
  });

  it("[BL-04] a request that asks for JSON (Accept) is answered with the JSON 413 on a page route too", async () => {
    const { client } = await boot({}, { security: { limits: { maxBodyBytes: 1000 } } });
    const response = await client.post("/", {
      headers: { accept: "application/json", "content-length": "5000" },
      body: "hello",
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("[G-D4] apiHandler maps a body that is too large to 413 with a configured message", () => {
  it("[BL-05] apiHandler({ bodyTooLargeMessage }) names the message in the 413 JSON answer", async () => {
    const { client } = await boot({
      "/api/item": apiRoute({
        POST: apiHandler(
          {
            body: acceptAnyBody,
            maxBodyBytes: 2000,
            bodyTooLargeMessage: "Send at most 2 KB of JSON.",
          },
          ({ body }) => json({ got: body }),
        ),
      }),
    });
    const response = await client.post("/api/item", {
      headers: { "content-type": "application/json" },
      body: chunked(big(5000)),
      duplex: "half",
    } as never);
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({
      status: 413,
      message: "Send at most 2 KB of JSON.",
    });
  });

  it("[BL-06] without the option the 413 keeps the standard message", async () => {
    const { client } = await boot({
      "/api/item": apiRoute({
        POST: apiHandler({ body: acceptAnyBody, maxBodyBytes: 2000 }, ({ body }) =>
          json({ got: body }),
        ),
      }),
    });
    const response = await client.post("/api/item", {
      headers: { "content-type": "application/json" },
      body: chunked(big(5000)),
      duplex: "half",
    } as never);
    expect(await jsonError(response)).toMatchObject({ status: 413, message: "Payload Too Large" });
  });

  it("[BL-07] a BodyTooLargeError the handler itself lets through (readFormLimited) gets the configured 413 too", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: apiHandler(
          { maxBodyBytes: 2000, bodyTooLargeMessage: "The form is too large." },
          async ({ event }) => json(await readFormLimited(event.request)),
        ),
      }),
    });
    const form = new FormData();
    form.set("note", "y".repeat(5000));
    const raw = new Request("https://app.test/", { method: "POST", body: form });
    const response = await client.post("/api/form", {
      headers: { "content-type": raw.headers.get("content-type") ?? "" },
      body: new Uint8Array(await raw.arrayBuffer()),
    });
    expect(response.status).toBe(413);
    expect(await jsonError(response)).toMatchObject({
      status: 413,
      message: "The form is too large.",
    });
  });

  it("[BL-08] apiHandler refuses a bodyTooLargeMessage that is empty or not a string", () => {
    expect(() => apiHandler({ bodyTooLargeMessage: "" }, () => json({}))).toThrow(
      /bodyTooLargeMessage/,
    );
    expect(() =>
      apiHandler({ bodyTooLargeMessage: 5 as unknown as string }, () => json({})),
    ).toThrow(/bodyTooLargeMessage/);
  });
});

describe("[G-D4] the helpers throw BodyTooLargeError", () => {
  it("[BL-09] readJsonLimited throws BodyTooLargeError (413, the limit) for a body over its bound", async () => {
    const request = new Request("https://app.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big(500),
    });
    const error = await readJsonLimited(request, 100).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BodyTooLargeError);
    expect(error).toMatchObject({ status: 413, limit: 100 });
  });

  it("[BL-10] a form under the app's limit is read by readFormLimited (the caps do not reject it)", async () => {
    const { client } = await boot({
      "/api/form": apiRoute({
        POST: async (event) => json(await readFormLimited(event.request)),
      }),
    });
    const form = new FormData();
    form.set("note", "y".repeat(5000));
    const raw = new Request("https://app.test/", { method: "POST", body: form });
    const response = await client.post("/api/form", {
      headers: { "content-type": raw.headers.get("content-type") ?? "" },
      body: new Uint8Array(await raw.arrayBuffer()),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ note: "y".repeat(5000) });
  });
});

describe("[G-D2] a server function's own body limit", () => {
  const echo = serverFn({ maxBodyBytes: 1024 }, (input: unknown) => ({
    size: JSON.stringify(input).length,
  }));
  const roomy = serverFn({ maxBodyBytes: 4 * 1024 * 1024 }, (input: unknown) => ({
    size: JSON.stringify(input).length,
  }));
  const fns = { echo1234567890: echo, roomy1234567890: roomy };

  it("[BL-11] a call body over the function's limit is a 413 envelope, and the function does not run", async () => {
    let ran = 0;
    const counted = serverFn({ maxBodyBytes: 1024 }, () => {
      ran += 1;
      return "ran";
    });
    const { client } = await boot({}, {}, { counted1234567890: counted });
    const result = await client.serverFn("counted1234567890", { text: "x".repeat(4000) });
    expect(result.status).toBe(413);
    expect(result.ok).toBe(false);
    expect(ran).toBe(0);
  });

  it("[BL-12] a declared Content-Length over the function's limit is refused before the body is read", async () => {
    const { client } = await boot({}, {}, fns);
    const response = await client.post("/_dusk/fn/echo1234567890", {
      headers: { "x-dusk-fn": "1", "content-type": "application/json", "content-length": "4000" },
      body: "x".repeat(4000),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[BL-13] a chunked call body over the function's limit is a 413 envelope too", async () => {
    const { client } = await boot({}, {}, fns);
    const response = await client.post("/_dusk/fn/echo1234567890", {
      headers: { "x-dusk-fn": "1", "content-type": "application/json" },
      body: chunked(`[{"text":"${"x".repeat(4000)}"}]`),
      duplex: "half",
    } as never);
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("[BL-14] a function's limit above the app's raises it for that function only (2 MiB body, app limit 1 MiB)", async () => {
    const { client } = await boot({}, {}, fns);
    const big2 = await client.serverFn("roomy1234567890", { text: "x".repeat(2 * 1024 * 1024) });
    expect(big2.status).toBe(200);
    const small = await client.serverFn("echo1234567890", { text: "x".repeat(2 * 1024 * 1024) });
    expect(small.status).toBe(413);
  });

  it("[BL-15] a function's limit must be a positive whole number of bytes (refused when defined)", () => {
    const noop = () => "ok";
    expect(() => serverFn({ maxBodyBytes: 0 }, noop)).toThrow(/maxBodyBytes/);
    expect(() => serverFn({ maxBodyBytes: -1 }, noop)).toThrow(/maxBodyBytes/);
    expect(() => serverFn({ maxBodyBytes: Number.NaN }, noop)).toThrow(/maxBodyBytes/);
    expect(() => serverFn({ maxBodyBytes: 1.5 }, noop)).toThrow(/maxBodyBytes/);
    expect(() => serverFn({ maxBodyBytes: "10" as unknown as number }, noop)).toThrow(
      /maxBodyBytes/,
    );
  });

  it("[BL-16] a batch is bounded by the app's limit: a call's own larger limit does not raise the batch", async () => {
    const { client } = await boot({}, {}, fns);
    const payload = [{ id: "roomy1234567890", input: { text: "x".repeat(2 * 1024 * 1024) } }];
    const response = await client.post("/_dusk/fn/_batch", {
      headers: { "x-dusk-fn": "1", "content-type": "application/json" },
      body: serialize(payload),
    });
    expect(response.status).toBe(413);
  });
});
