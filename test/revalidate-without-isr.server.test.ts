import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/features/api-routes";
import { apiRoute, createHandler, json, revalidatePath, revalidateTag } from "../src/server/index";
import { createTestClient } from "../src/testing/index";
import { handmade } from "./support/sec2-core";

/**
 * `revalidatePath` and `revalidateTag` are called from server code that may run in a handler without `isr()` (the
 * generated entry passes `isr()` only when a page revalidates). A handler without a page cache has nothing to discard,
 * so the calls resolve and do nothing; they must not throw.
 */
describe("revalidation without the isr feature", () => {
  it("[REV-01] an API route in a handler without isr() can call revalidatePath and revalidateTag", async () => {
    const REVALIDATE = apiRoute({
      GET: async () => {
        await revalidatePath("/posts/7");
        await revalidateTag("posts");
        return json({ revalidated: true });
      },
    });
    const handler = createHandler({
      dev: true,
      manifest: handmade([{ id: "revalidate", path: "/api/revalidate", module: REVALIDATE }]),
      features: [apiRoutes()],
    });
    const response = await createTestClient(handler).get("/api/revalidate");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revalidated: true });
  });
});
