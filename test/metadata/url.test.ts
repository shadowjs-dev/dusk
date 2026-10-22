import { describe, expect, it } from "vitest";
import {
  MAX_METADATA_URL_LENGTH,
  resolveMetadataBase,
  resolveMetadataUrl,
} from "../../src/metadata/url";

describe("metadataBase", () => {
  it("[MD-URL-01] accepts an absolute http(s) URL, as a string or a URL", () => {
    expect(resolveMetadataBase("https://malaf.dev")?.href).toBe("https://malaf.dev/");
    expect(resolveMetadataBase(new URL("http://localhost:3000/app"))?.href).toBe(
      "http://localhost:3000/app",
    );
    expect(resolveMetadataBase(undefined)).toBeUndefined();
    expect(resolveMetadataBase(null)).toBeUndefined();
  });

  it("[MD-URL-02] refuses a relative value or another scheme as a configuration error", () => {
    expect(() => resolveMetadataBase("/just/a/path")).toThrow(TypeError);
    expect(() => resolveMetadataBase("javascript:alert(1)")).toThrow(TypeError);
    expect(() => resolveMetadataBase("ftp://example.com")).toThrow(TypeError);
  });
});

describe("metadata URLs", () => {
  const base = new URL("https://malaf.dev/");

  it("[MD-URL-03] resolves relative values against metadataBase", () => {
    expect(resolveMetadataUrl("/og.png", base)).toBe("https://malaf.dev/og.png");
    expect(resolveMetadataUrl("docs/", base)).toBe("https://malaf.dev/docs/");
    expect(resolveMetadataUrl(new URL("https://cdn.example/x.png"), base)).toBe(
      "https://cdn.example/x.png",
    );
  });

  it("[MD-URL-04] without a base a relative value is written as given", () => {
    expect(resolveMetadataUrl("/og.png", undefined)).toBe("/og.png");
    expect(resolveMetadataUrl("./", undefined)).toBe("./");
  });

  it("[MD-URL-05] refuses scripts, data URLs and other schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
    ]) {
      expect(resolveMetadataUrl(value, base)).toBeUndefined();
    }
  });

  it("[MD-URL-06] allows a named scheme only where the caller lists it (app deep links)", () => {
    expect(resolveMetadataUrl("myapp://open", base, { customSchemes: true })).toBe("myapp://open");
    expect(resolveMetadataUrl("myapp://open", base)).toBeUndefined();
    expect(
      resolveMetadataUrl("javascript:alert(1)", base, { customSchemes: true }),
    ).toBeUndefined();
    expect(resolveMetadataUrl("data:text/html,x", base, { customSchemes: true })).toBeUndefined();
  });

  it("[MD-URL-07] refuses protocol-relative values, which would leave the origin", () => {
    expect(resolveMetadataUrl("//evil.example/x.png", base)).toBeUndefined();
    expect(resolveMetadataUrl("\\\\evil.example\\x", base)).toBeUndefined();
  });

  it("[MD-URL-08] drops empty values, control characters and values past the length bound", () => {
    expect(resolveMetadataUrl("", base)).toBeUndefined();
    expect(resolveMetadataUrl("/a\nb", base)).toBeUndefined();
    expect(resolveMetadataUrl(`/${"a".repeat(MAX_METADATA_URL_LENGTH)}`, base)).toBeUndefined();
    expect(resolveMetadataUrl(undefined, base)).toBeUndefined();
  });
});
