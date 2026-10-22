import { deserialize, serialize } from "@shadow-js/web/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { type AppModule, errorLog, loadApp, manifestOf } from "./support/app";
import { allFeatures } from "./support/features";

let app: AppModule;
let handler: DuskHandler;
let client: TestClient;
let log: ReturnType<typeof errorLog>;

async function boot(options: Partial<Parameters<typeof createHandler>[0]> = {}): Promise<void> {
  app = await loadApp();
  log = errorLog();
  handler = createHandler({
    features: allFeatures(),
    manifest: manifestOf(app),
    dev: true,
    onError: log.onError,
    ...options,
  });
  client = createTestClient(handler);
}

const JSON_HEADERS = { "content-type": "application/json", "x-dusk-fn": "1" };

describe("server functions: wire format and results", () => {
  beforeEach(async () => {
    await boot();
  });

  it("[SRPC-01] a call round trips: serialize([input]) in, { ok, value } out", async () => {
    const result = await client.serverFn("addTodo", { title: "write tests" });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ id: 1, title: "write tests", by: true });
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(app.calls.fn).toBe(1);
  });

  it("[SRPC-02] the codec carries Date, Map, Set, BigInt, undefined and NaN both ways", async () => {
    const input = {
      when: new Date(0),
      m: new Map([["k", 1n]]),
      s: new Set([1, 2]),
      u: undefined,
      n: Number.NaN,
    };
    const result = await client.serverFn("echo", input);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(input);
  });

  it("[SRPC-03] an unknown id, a malformed id and an id with a path are the same 404 answer", async () => {
    const bodies = await Promise.all(
      ["nope", "..%2f..%2fetc", "a".repeat(200), "x%00y"].map(async (id) => {
        const response = await client.request(`/_dusk/fn/${id}`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: serialize([1]),
        });
        return {
          status: response.status,
          body: (await response.text()).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "ID"),
        };
      }),
    );
    for (const entry of bodies) expect(entry).toEqual(bodies[0]);
    expect(bodies[0]?.status).toBe(404);
    expect(
      (
        await client.request("/_dusk/fn/echo/extra", {
          method: "POST",
          headers: JSON_HEADERS,
          body: "x",
        })
      ).status,
    ).toBe(404);
  });

  it("[SRPC-04] an id like __proto__ or constructor is not a function", async () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const response = await client.request(`/_dusk/fn/${id}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: serialize([1]),
      });
      expect(response.status).toBe(404);
    }
  });

  it("[SRPC-05] the wrong method is 405 with Allow, before the body is read", async () => {
    const get = await client.request("/_dusk/fn/addTodo", {
      method: "GET",
      headers: JSON_HEADERS,
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(
      (await client.request("/_dusk/fn/addTodo", { method: "HEAD", headers: JSON_HEADERS })).status,
    ).toBe(405);
    const options = await client.request("/_dusk/fn/addTodo", {
      method: "OPTIONS",
      headers: JSON_HEADERS,
    });
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    // A streamed body over the limit would give 413 if anything read it; the answer is 405.
    await boot({ security: { limits: { maxBodyBytes: 16 } } });
    const big = new TextEncoder().encode("x".repeat(500));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const postToGet = await client.request("/_dusk/fn/readOnly", {
      method: "POST",
      headers: JSON_HEADERS,
      body: stream,
      duplex: "half",
    });
    expect(postToGet.status).toBe(405);
    expect(postToGet.headers.get("allow")).toBe("GET");
  });

  it("[SRPC-06] a missing x-dusk-fn header or a non-JSON content type is rejected and the function does not run", async () => {
    const noHeader = await client.request("/_dusk/fn/addTodo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serialize([{ title: "x" }]),
    });
    expect(noHeader.status).toBe(400);
    const wrongType = await client.request("/_dusk/fn/addTodo", {
      method: "POST",
      headers: { "x-dusk-fn": "1", "content-type": "text/plain" },
      body: serialize([{ title: "x" }]),
    });
    expect(wrongType.status).toBe(415);
    const wrongValue = await client.request("/_dusk/fn/addTodo", {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-dusk-fn": "yes" },
      body: serialize([{ title: "x" }]),
    });
    expect(wrongValue.status).toBe(400);
    expect(app.calls.fn).toBe(0);
  });

  it("[SRPC-07] cross-site calls are rejected by the CSRF check before anything runs", async () => {
    const result = await client.serverFn("addTodo", { title: "x" }, { crossSite: true });
    expect(result.status).toBe(403);
    expect(app.calls.fn).toBe(0);
    const bare = await client.serverFn("addTodo", { title: "x" }, { bare: true });
    expect(bare.status).toBe(403);
  });

  it("[SRPC-08] invalid input is 400 with bounded, serializable issues, and the function does not run", async () => {
    const result = await client.serverFn("addTodo", { title: "" });
    expect(result.status).toBe(400);
    expect(result.ok).toBe(false);
    expect(result.error?.name).toBe("ValidationError");
    expect(result.error?.issues).toEqual([
      { message: "title is required", path: ["title"] },
      { message: "second issue", path: ["x", 0] },
    ]);
    expect(app.calls.fn).toBe(0);
  });

  it("[SRPC-09] malformed bodies are a generic 400: bad JSON, wrong shape, extra elements, trailing garbage", async () => {
    for (const body of [
      "{",
      "null",
      JSON.stringify({ r: 1, t: "no" }),
      serialize([1, 2]),
      `${serialize([1])} trailing`,
      serialize({ not: "an array" }),
    ]) {
      const response = await client.request("/_dusk/fn/echo", {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("SyntaxError");
    }
  });

  it("[SRPC-10] a body over the limit is 413 whether the length is declared or streamed", async () => {
    await boot({ security: { limits: { maxBodyBytes: 64 } } });
    const big = serialize(["x".repeat(500)]);
    const declared = await client.request("/_dusk/fn/echo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: big,
    });
    expect(declared.status).toBe(413);
    const chunk = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk.slice(0, 100));
        controller.enqueue(chunk.slice(100));
        controller.close();
      },
    });
    const streamed = await client.request("/_dusk/fn/echo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: stream,
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  it("[SRPC-11] a thrown redirect() becomes { redirect: { to, status } } with HTTP 200 (a 3xx would be followed by fetch)", async () => {
    const result = await client.serverFn("redirecting", undefined);
    expect(result.status).toBe(200);
    expect(result.redirect).toEqual({ to: "/posts/9", status: 303 });
    expect(result.ok).toBe(false);
    expect(result.response.headers.get("location")).toBeNull();
  });

  it("[SRPC-12] an HttpError keeps its status, public message and data", async () => {
    const result = await client.serverFn("denied", undefined);
    expect(result.status).toBe(403);
    expect(result.error).toMatchObject({
      name: "HttpError",
      message: "no access",
      status: 403,
      data: { reason: "plan" },
    });
  });

  it("[SRPC-13] an unexpected error is 500; production shows no message, development does; the id is returned", async () => {
    await boot({ dev: false, security: { allowedHosts: ["localhost"] } });
    const hidden = await client.serverFn("failing", undefined);
    expect(hidden.status).toBe(500);
    expect(hidden.error?.message).toBe("Internal Server Error");
    expect(JSON.stringify(hidden.body)).not.toContain("postgres");
    expect(hidden.error?.requestId).toBe(hidden.response.headers.get("x-request-id") ?? "");
    expect(log.errors).toHaveLength(1);
    await boot();
    const shown = await client.serverFn("failing", undefined);
    expect(shown.error?.message).toContain("postgres");
  });

  it("[SRPC-14] function middleware runs before the handler and can reject", async () => {
    const denied = await client.serverFn("guarded", undefined);
    expect(denied.status).toBe(401);
    expect(denied.error?.message).toBe("missing token");
    const allowed = await client.serverFn("guarded", undefined, { headers: { "x-token": "ok" } });
    expect(allowed.value).toBe("secret value");
  });

  it("[SRPC-15] a value that cannot be serialized is a 500, not a crash", async () => {
    const result = await client.serverFn("unserializable", undefined);
    expect(result.status).toBe(500);
    expect(log.errors).toHaveLength(1);
  });

  it("[SRPC-16] GET functions take their input from ?p=, and are rejected when the payload is too long or not base64url", async () => {
    const ok = await client.serverFn("readOnly", { q: "x" }, { method: "GET" });
    expect(ok.status).toBe(200);
    expect(ok.value).toEqual({ got: { q: "x" } });
    const long = await client.request(`/_dusk/fn/readOnly?p=${"A".repeat(5000)}`, {
      headers: { "x-dusk-fn": "1" },
    });
    expect(long.status).toBe(414);
    const bad = await client.request("/_dusk/fn/readOnly?p=%25%25", {
      headers: { "x-dusk-fn": "1" },
    });
    expect(bad.status).toBe(400);
    const noHeader = await client.request("/_dusk/fn/readOnly", {});
    expect(noHeader.status).toBe(400);
  });

  it("[SRPC-25] rpc.maxGetPayloadChars sets the longest GET payload: the default is 4096, a smaller or larger limit applies exactly", async () => {
    const call = async (chars: number): Promise<number> => {
      // `p` is base64url text; a run of "A" decodes to bytes that are not the wire format, so the
      // answer past the length check is 400. The length check comes first and answers 414.
      const response = await client.request(`/_dusk/fn/readOnly?p=${"A".repeat(chars)}`, {
        headers: { "x-dusk-fn": "1" },
      });
      return response.status;
    };
    expect(await call(4096)).toBe(400);
    expect(await call(4097)).toBe(414);

    await boot({ rpc: { maxGetPayloadChars: 200 } });
    expect(await call(200)).toBe(400);
    expect(await call(201)).toBe(414);
    // A real payload within the limit is served.
    const small = await client.serverFn("readOnly", { q: "x" }, { method: "GET" });
    expect(small.status).toBe(200);
    const big = await client.serverFn("readOnly", { q: "x".repeat(200) }, { method: "GET" });
    expect(big.status).toBe(414);

    // The URL limit (8192 characters) would answer 414 first, so it is raised for this case.
    await boot({
      rpc: { maxGetPayloadChars: 100_000 },
      security: { limits: { maxUrlLength: 200_000 } },
    });
    expect(
      (await client.serverFn("readOnly", { q: "x".repeat(6000) }, { method: "GET" })).status,
    ).toBe(200);
  });

  it("[SRPC-26] rpc.maxGetPayloadChars must be a positive integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(boot({ rpc: { maxGetPayloadChars: bad } }), String(bad)).rejects.toThrow(
        /rpc\.maxGetPayloadChars must be a positive integer/,
      );
    }
  });

  it("[SRPC-17] a middleware calling next() twice fails the call with a 500", async () => {
    const result = await client.serverFn("nextTwice", undefined);
    expect(result.status).toBe(500);
  });

  it("[SRPC-18] the answer never contains a stack trace or a file path", async () => {
    await boot({ dev: false, security: { allowedHosts: ["localhost"] } });
    const result = await client.serverFn("failing", undefined);
    const text = JSON.stringify(result.body);
    expect(text).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
    expect(text).not.toContain("/Users/");
  });

  it("[SRPC-19] form: true functions accept an HTML form post after the CSRF check and answer 303", async () => {
    const response = await client.request("/_dusk/fn/formFn", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        referer: "http://localhost/form",
      },
      body: "a=1&a=2&__proto__=x&b=%E2%9C%93",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/form");
    const cross = await client.request("/_dusk/fn/formFn", {
      method: "POST",
      crossSite: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(cross.status).toBe(403);
    // A function that is not declared form: true refuses form encodings.
    const refused = await client.request("/_dusk/fn/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-dusk-fn": "1" },
      body: "a=1",
    });
    expect(refused.status).toBe(415);
  });

  it("[SRPC-20] 100 concurrent calls are isolated: each gets its own event and input back", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_unused, n) => client.serverFn("withEvent", n)),
    );
    const ids = new Set(results.map((result) => (result.value as { id: string }).id));
    expect(ids.size).toBe(100);
    for (const result of results)
      expect((result.value as { path: string }).path).toBe("/_dusk/fn/withEvent");
  });

  it("[SRPC-21] a direct call inside a request validates and runs middleware; outside a request it names the problem", async () => {
    const { createTestEvent } = await import("../src/testing/index");
    const fn = app["addTodo"] as {
      invoke(input: unknown, event: ReturnType<typeof createTestEvent>): Promise<unknown>;
      (input: unknown): Promise<unknown>;
    };
    await expect(fn.invoke({ title: "" }, createTestEvent())).rejects.toMatchObject({
      status: 400,
    });
    expect(await fn.invoke({ title: "direct" }, createTestEvent())).toMatchObject({
      title: "direct",
    });
    await expect(fn({ title: "x" })).rejects.toMatchObject({ code: "SERVER_NO_REQUEST_EVENT" });
  });

  it("[SRPC-21b] on the server, call options are accepted and ignored: with() and a trailing options argument run the same call", async () => {
    const { createTestEvent } = await import("../src/testing/index");
    const { runWithEvent } = await import("../src/server/index");
    const fn = app["addTodo"] as unknown as {
      (input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
      with(options: { signal?: AbortSignal }): (input: unknown) => Promise<unknown>;
    };
    const controller = new AbortController();
    const event = createTestEvent();
    const viaOptions = await runWithEvent(event, () =>
      fn({ title: "a" }, { signal: controller.signal }),
    );
    expect(viaOptions).toMatchObject({ title: "a" });
    const viaWith = await runWithEvent(event, () =>
      fn.with({ signal: controller.signal })({ title: "b" }),
    );
    expect(viaWith).toMatchObject({ title: "b" });
  });

  it("[SRPC-22] the wire response of a result is exactly deserialize()-able", async () => {
    const response = await client.request("/_dusk/fn/echo", {
      method: "POST",
      headers: JSON_HEADERS,
      body: serialize([{ a: [1, 2] }]),
    });
    expect(deserialize(await response.text())).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  it("[SRPC-23] a base path moves the endpoint", async () => {
    await boot({ base: "/app" });
    const scoped = createTestClient(handler, { base: "/app" });
    expect((await scoped.serverFn("echo", 7)).value).toBe(7);
    expect(
      (
        await client.request("/_dusk/fn/echo", {
          method: "POST",
          headers: JSON_HEADERS,
          body: serialize([7]),
        })
      ).status,
    ).toBe(404);
  });

  it("[SRPC-24] a response over the limit is a 500 SERVER_FN_RESPONSE_TOO_LARGE, not a giant body", async () => {
    await boot({ rpc: { maxResponseBytes: 100 } });
    const result = await client.serverFn("echo", "x".repeat(1000));
    expect(result.status).toBe(500);
    expect(
      log.errors.some((entry) => String(entry.error).includes("SERVER_FN_RESPONSE_TOO_LARGE")),
    ).toBe(true);
  });
});
