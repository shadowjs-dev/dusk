import { describe, expect, it } from "vitest";
import { createHandler, type HandlerOptions } from "../../src/server/index";
import { mergeHandlerOptions } from "../../src/server/merge-options";
import { loadApp, manifestOf } from "../support/app";
import { allFeatures } from "../support/features";

/**
 * The generated server entry merges the baked file config with the entry file's options, then builds the handler.
 * These tests build the handler the same way and check what the merged options do on the wire.
 */
async function handlerFor(baked: Partial<HandlerOptions>, user: Partial<HandlerOptions>) {
  const app = await loadApp();
  return createHandler({
    ...mergeHandlerOptions(baked, user),
    dev: true,
    features: allFeatures(),
    manifest: manifestOf(app),
  });
}

describe("merged handler options, on the wire", () => {
  it("[MHO-20] security.headers from the file and security.csp from the entry coexist: both headers are sent", async () => {
    const handler = await handlerFor(
      { security: { allowedHosts: ["app.test"], headers: { frameOptions: "DENY" } } },
      { security: { csp: { directives: { "default-src": ["'self'"] } } } },
    );
    const response = await handler.fetch(new Request("https://app.test/"));
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy") ?? "").toContain("default-src 'self'");
  });

  it("[MHO-21] csp: false in the entry turns off a csp the file declares (false overrides)", async () => {
    const handler = await handlerFor(
      {
        security: {
          allowedHosts: ["app.test"],
          csp: { directives: { "default-src": ["'self'"] } },
        },
      },
      { security: { csp: false } },
    );
    const response = await handler.fetch(new Request("https://app.test/"));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("[MHO-22] allowedHosts in the entry replaces the file's list: the old host is refused", async () => {
    const handler = await handlerFor(
      { security: { allowedHosts: ["example.com"] } },
      { security: { allowedHosts: ["app.test"] } },
    );
    const refused = await handler.fetch(new Request("https://example.com/"));
    expect(refused.status).toBe(400);
    const accepted = await handler.fetch(new Request("https://app.test/"));
    expect(accepted.status).not.toBe(400);
  });

  it("[MHO-23] without an entry option the file's security settings stay in force", async () => {
    const handler = await handlerFor(
      { security: { allowedHosts: ["app.test"], headers: { frameOptions: "DENY" } } },
      {},
    );
    const response = await handler.fetch(new Request("https://app.test/"));
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const other = await handler.fetch(new Request("https://evil.test/"));
    expect(other.status).toBe(400);
  });
});
