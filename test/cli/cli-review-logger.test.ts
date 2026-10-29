import { describe, expect, it, vi } from "vitest";
import { duskLogger, WARN_ONCE_LIMIT } from "../../src/cli/logger";

describe("logger review", () => {
  it("[DUSK-CLI-REV-2] the messages warnOnce remembers are bounded: the oldest is forgotten, the recent ones are kept", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const logger = duskLogger({
        term: { color: false, interactive: false, unicode: true, columns: undefined },
        verbose: false,
        quietInfo: false,
      });
      logger.warnOnce("first");
      logger.warnOnce("first");
      expect(err).toHaveBeenCalledTimes(1);
      for (let index = 0; index < WARN_ONCE_LIMIT; index += 1) logger.warnOnce(`message ${index}`);
      err.mockClear();
      // The newest message is still remembered; the first one fell out of the memory.
      logger.warnOnce(`message ${WARN_ONCE_LIMIT - 1}`);
      expect(err).not.toHaveBeenCalled();
      logger.warnOnce("first");
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      err.mockRestore();
    }
  });
});
