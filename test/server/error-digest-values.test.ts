import { describe, expect, it } from "vitest";
import { errorDigest } from "../../src/server/digest";
import { publicError } from "../../src/server/route-wrap";
import { hostileThrown } from "../support/hostile-thrown";

/**
 * The digest of an error is the code the error UI shows and the log line prints. It is computed for every thrown
 * value, so it must not throw for any of them: a cycle, a getter, a toString or a null prototype would otherwise
 * replace the error the page is answering with an unrelated TypeError.
 */
describe("error digests of hostile thrown values", () => {
  for (const [name, value] of hostileThrown()) {
    it(`[ERR-D1] ${name}: errorDigest returns an 8-character code`, () => {
      const digest = errorDigest(value);
      expect(digest).toMatch(/^[0-9a-f]{8}$/);
      expect(errorDigest(value)).toBe(digest);
    });

    it(`[ERR-D2] ${name}: the production error keeps a string digest`, () => {
      const error = publicError(value, false);
      expect(error).toBeInstanceOf(Error);
      expect(typeof (error as { digest?: unknown }).digest).toBe("string");
    });
  }
});
