import { beforeAll, describe, expect, it } from "vitest";
import { createHandler, type DuskHandler } from "../src/server/index";
import { createTestClient, type TestClient } from "../src/testing/index";
import { load } from "./support/compile";
import { allFeatures } from "./support/features";

/** The contract: an `Error` instance is not a codec value; a function that returns one fails with a masked 500. */
const FIXTURE = `
import { serverFn } from "@start/server";
export const returnsError = serverFn({}, () => new Error("secret detail: db password is hunter2"));
export const returnsValue = serverFn({}, () => ({ fine: true }));
`;

let fixture: { returnsError: unknown; returnsValue: unknown };
let handler: DuskHandler;
let client: TestClient;
const leaks: string[] = [];

beforeAll(async () => {
  fixture = await load<typeof fixture>(FIXTURE);
  handler = createHandler({
    features: allFeatures(),
    manifest: {
      routes: [],
      apiRoutes: [],
      serverFns: {
        returnsError: { load: async () => fixture.returnsError as never },
        returnsValue: { load: async () => fixture.returnsValue as never },
      },
      assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "/" },
      App: ((props: { children?: unknown }) => props.children) as never,
    },
    dev: false,
    onError: (error: unknown) => {
      leaks.push(String((error as { message?: string }).message ?? error));
    },
    security: { allowedHosts: ["localhost"] },
  });
  client = createTestClient(handler);
});

describe("a server function that returns an Error", () => {
  it("[SFE-01] answers a masked 500 that never carries the message", async () => {
    const result = await client.serverFn("returnsError");
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("[SFE-02] the failure is reported to the server's error hook, not to the client", async () => {
    await client.serverFn("returnsError");
    expect(leaks.length).toBeGreaterThan(0);
  });

  it("[SFE-03] an ordinary value still goes through", async () => {
    const result = await client.serverFn("returnsValue");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ fine: true });
  });
});
