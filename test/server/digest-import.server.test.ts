import { describe, expect, it, vi } from "vitest";

/**
 * A Worker may not generate random values outside a request, so loading the digest module must not draw its key
 * (the key is drawn at the first digest). The Cloudflare conformance test (SCONF-workerd) runs the built Worker.
 */
describe("error digest", () => {
  it("[DIG-L1] importing the module draws no random value; the first digest does", async () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("random values outside a request");
    });
    vi.resetModules();
    const digest = await import("../../src/server/digest");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(digest.errorDigest(new Error("db down"))).toMatch(/^[0-9a-f]{8}$/);
  });
});
