import { describe, expect, it } from "vitest";
import { errorDigest } from "../../src/server/digest";
import { publicError } from "../../src/server/route-wrap";

/**
 * In development the error UI keeps the message of the error and also carries its digest, so the code the page shows is
 * the code the log line prints (the same value production shows, with the reason phrase in place of the message).
 */
describe("the development error carries its digest", () => {
  it("[ERR-D3] the original error is returned, with its message and the digest of production", () => {
    const error = new Error("db is down");
    const expected = errorDigest(error);
    const shown = publicError(error, true);
    expect(shown).toBe(error);
    expect((shown as Error).message).toBe("db is down");
    expect((shown as Error & { digest?: unknown }).digest).toBe(expected);
  });

  it("[ERR-D4] the digest is taken once: a later call keeps it, even when the stack was rewritten in between", () => {
    const error = new Error("db is down");
    const first = (publicError(error, true) as Error & { digest?: string }).digest;
    error.stack = "Error: db is down\n    at rewritten (mapped.ts:1:1)";
    const again = (publicError(error, true) as Error & { digest?: string }).digest;
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(again).toBe(first);
  });

  it("[ERR-D5] a frozen error and a value that is not an object are returned as they are", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(publicError(frozen, true)).toBe(frozen);
    expect("digest" in frozen).toBe(false);
    expect(publicError("text", true)).toBe("text");
    expect(publicError(undefined, true)).toBeUndefined();
  });

  it("[ERR-D6] an error with a fixed digest property is not redefined (the error path never throws)", () => {
    const error = new Error("fixed");
    Object.defineProperty(error, "digest", { value: 7, configurable: false });
    expect(() => publicError(error, true)).not.toThrow();
    expect((error as Error & { digest?: unknown }).digest).toBe(7);
  });
});
