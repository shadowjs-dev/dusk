import { describe, expect, it } from "vitest";
import { file } from "../src/server/index";

const bytes = new TextEncoder().encode("hello world");

/** A request with the given headers, for the conditional and Range rules of `file()`. */
function requestWith(headers: Record<string, string>, method = "GET"): Request {
  return new Request("https://app.test/report.pdf", { method, headers });
}

describe("[G-B6] file() response helper", () => {
  it("[G-B6] sets Content-Type and Content-Length from the bytes and the type option", () => {
    const response = file(bytes, { type: "application/pdf" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe("11");
  });

  it("[G-B6] defaults the type to application/octet-stream", () => {
    expect(file(bytes).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("[G-B6] Content-Disposition uses an ASCII fallback and RFC 5987 for a non-ASCII filename", () => {
    const response = file(bytes, { filename: "résumé 2026.pdf", type: "application/pdf" });
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="resume 2026.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%202026.pdf`,
    );
  });

  it("[G-B6] an ASCII filename needs no RFC 5987 parameter", () => {
    const response = file(bytes, { filename: "report.pdf" });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
  });

  it("[G-B6] refuses CR and LF in the filename (header injection)", () => {
    expect(() => file(bytes, { filename: "a.pdf\r\nSet-Cookie: x=1" })).toThrow(TypeError);
    expect(() => file(bytes, { filename: "a\nb.pdf" })).toThrow(TypeError);
  });

  it("[G-B6] cacheControl is sent as given", () => {
    expect(file(bytes, { cacheControl: "private, max-age=60" }).headers.get("cache-control")).toBe(
      "private, max-age=60",
    );
  });

  it("[G-B6] a single Range gives 206 with Content-Range and the slice", async () => {
    const response = file(bytes, {
      request: requestWith({ range: "bytes=0-4" }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("hello");
  });

  it("[G-B6] an open-ended and a suffix Range are satisfied", async () => {
    const tail = file(bytes, { request: requestWith({ range: "bytes=6-" }) });
    expect(tail.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(await tail.text()).toBe("world");
    const suffix = file(bytes, { request: requestWith({ range: "bytes=-5" }) });
    expect(await suffix.text()).toBe("world");
  });

  it("[G-B6] an unsatisfiable Range gives 416 with the size", () => {
    const response = file(bytes, { request: requestWith({ range: "bytes=50-60" }) });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */11");
  });

  it("[G-B6] a multi-range request is answered with the whole file", () => {
    const response = file(bytes, { request: requestWith({ range: "bytes=0-1,4-5" }) });
    expect(response.status).toBe(200);
  });

  it("[G-B6] an etag is sent and If-None-Match with that etag gives 304 with no body", async () => {
    const response = file(bytes, {
      etag: '"v1"',
      request: requestWith({ "if-none-match": '"v1"' }),
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(await response.text()).toBe("");
  });

  it("[G-B6] an If-None-Match that does not match gives the file", () => {
    const response = file(bytes, {
      etag: '"v1"',
      request: requestWith({ "if-none-match": '"v0"' }),
    });
    expect(response.status).toBe(200);
  });

  it("[G-B6] If-Modified-Since at or after lastModified gives 304", () => {
    const lastModified = new Date("2026-01-01T00:00:00Z");
    const response = file(bytes, {
      lastModified,
      request: requestWith({ "if-modified-since": "Fri, 02 Jan 2026 00:00:00 GMT" }),
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("last-modified")).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
  });

  it("[G-B6] a HEAD request gets the headers and no body", async () => {
    const response = file(bytes, { request: requestWith({}, "HEAD") });
    expect(response.headers.get("content-length")).toBe("11");
    expect(await response.text()).toBe("");
  });
});
