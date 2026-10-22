import { describe, expect, it } from "vitest";
import { readEntryStatic } from "../../src/vite/entry-static-options";

/**
 * The Cloudflare file gate (`runMiddlewareForStaticFiles`) is decided at build time from the entry's options. A global
 * middleware in the same entry makes every prerendered page handler-rendered, but it does not change whether the flag is
 * set: the build must still read the flag, or the Worker is built without the gate while the handler expects it.
 * These tests pin that the reader keeps the flag next to a middleware reason (CFG-*).
 */

describe("the Cloudflare file gate is read from the entry beside a global middleware (CFG)", () => {
  it("[CFG-1] runMiddlewareForStaticFiles set before a global middleware is still read", () => {
    const reading = readEntryStatic(
      [
        'import { gate } from "./gate";',
        "export default {",
        '  security: { allowedHosts: ["127.0.0.1", "localhost"] },',
        "  runMiddlewareForStaticFiles: true,",
        "  middleware: [gate],",
        "};",
      ].join("\n"),
    );
    expect(reading.options.runMiddlewareForStaticFiles).toBe(true);
    expect(reading.reason).toMatch(/global middleware/);
  });

  it("[CFG-2] runMiddlewareForStaticFiles set after a global middleware is read too (key order does not matter)", () => {
    const reading = readEntryStatic(
      [
        'import { gate } from "./gate";',
        "export default { middleware: [gate], runMiddlewareForStaticFiles: true };",
      ].join("\n"),
    );
    expect(reading.options.runMiddlewareForStaticFiles).toBe(true);
    expect(reading.reason).toMatch(/global middleware/);
  });

  it("[CFG-3] with no middleware the flag is read and there is no page reason", () => {
    const reading = readEntryStatic(
      'export default { runMiddlewareForStaticFiles: true, security: { allowedHosts: ["127.0.0.1"] } };',
    );
    expect(reading.options.runMiddlewareForStaticFiles).toBe(true);
    expect(reading.reason).toBeUndefined();
  });

  it("[CFG-4] a flag the build cannot read (inside a spread) is not reported as true", () => {
    const reading = readEntryStatic("const base = {}; export default { ...base, middleware: [] };");
    expect(reading.options.runMiddlewareForStaticFiles).toBeUndefined();
    expect(reading.reason).toMatch(/spreads/);
  });
});
