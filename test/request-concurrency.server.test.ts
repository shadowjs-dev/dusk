import { expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import {
  apiRoute,
  createHandler,
  defineLocals,
  getRequestEvent,
  json,
  type Middleware,
} from "../src/server/index";
import { get, handmade } from "./support/sec2-core";

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

it("[REQ-CONCURRENCY-01] 10,000 interleaved requests preserve their cookies, headers, mutable locals and async context", async () => {
  const total = 10_000;
  const batchSize = 250;
  const locals = defineLocals({ identity: "", visits: [] as string[] });
  const ids = new Set<string>();
  let releases: (() => void)[] = [];
  let entered = barrier();
  const gate: Middleware = async (event, next) => {
    const identity = event.url.searchParams.get("id") ?? "";
    locals.of(event).identity = identity;
    locals.of(event).visits.push(identity);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
      if (releases.length === batchSize) entered.resolve();
    });
    return next();
  };
  const handler = createHandler({
    features: [apiRoutes()],
    security: { allowedHosts: ["localhost"] },
    middleware: [locals.middleware, gate],
    manifest: handmade([
      {
        id: "isolate",
        path: "/isolate",
        module: apiRoute({
          GET: async (event) => {
            // Both hops occur after every request in this batch has entered middleware.
            await Promise.resolve();
            const first = getRequestEvent();
            await Promise.resolve();
            const current = getRequestEvent();
            event.cookies.set("result", locals.of(current).identity, { path: "/" });
            event.responseHeaders.set("x-result", locals.of(current).identity);
            return json({
              identity: locals.of(current).identity,
              visits: locals.of(current).visits,
              cookie: current.cookies.get("identity"),
              header: current.request.headers.get("x-identity"),
              same: first === event && current === event,
              requestId: current.id,
            });
          },
        }),
      },
    ]),
  });
  for (let offset = 0; offset < total; offset += batchSize) {
    releases = [];
    entered = barrier();
    const requests = Array.from({ length: batchSize }, (_, index) => {
      const identity = String(offset + index);
      return handler.fetch(
        get(`/isolate?id=${identity}`, {
          cookie: `identity=${identity}`,
          "x-identity": identity,
        }),
      );
    });
    try {
      await entered.promise;
      expect(releases.length).toBe(batchSize);
      // Resume in reverse arrival order to expose accidental shared current-event registers.
      for (const release of releases.toReversed()) release();
      const responses = await Promise.all(requests);
      for (const [index, response] of responses.entries()) {
        const identity = String(offset + index);
        const body: unknown = await response.json();
        expect(response.status).toBe(200);
        expect(body).toEqual({
          identity,
          visits: [identity],
          cookie: identity,
          header: identity,
          same: true,
          requestId: expect.any(String),
        });
        expect(response.headers.get("x-result")).toBe(identity);
        expect(response.headers.get("set-cookie")).toContain(`result=${identity};`);
        if (typeof body !== "object" || body === null) throw new Error("Missing response body");
        const id: unknown = Reflect.get(body, "requestId");
        if (typeof id !== "string") throw new Error("Missing request id");
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
    } finally {
      for (const release of releases) release();
      await Promise.all(requests);
    }
    expect(() => getRequestEvent()).toThrowError("SERVER_NO_REQUEST_EVENT");
  }
  expect(ids.size).toBe(total);
  expect(locals.defaults.visits).toEqual([]);
}, 10_000);
