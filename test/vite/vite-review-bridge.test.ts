import { describe, expect, it } from "vitest";
import { BadRequestError, toWebRequest } from "../../src/vite/node-bridge";

function requestOf(url: string, host = "localhost:3000"): Request {
  return toWebRequest(
    { headers: { host }, url, method: "GET" } as unknown as Parameters<typeof toWebRequest>[0],
    { protocol: "http", signal: new AbortController().signal },
  );
}

describe("dev request bridge review", () => {
  it("[DUSK-VITE-REV-13] a request target that starts with two slashes is a path on the Host, never another host", () => {
    const url = new URL(requestOf("//evil.example/x?y=1").url);
    expect(url.host).toBe("localhost:3000");
    expect(url.pathname).toBe("//evil.example/x");
    expect(url.search).toBe("?y=1");
  });

  it("[DUSK-VITE-REV-13] an ordinary target and the origin-form query keep their meaning", () => {
    const url = new URL(requestOf("/posts/1?a=b#ignored").url);
    expect(url.href).toBe("http://localhost:3000/posts/1?a=b#ignored");
  });

  it("[DUSK-VITE-REV-13] a Host that cannot be a URL authority is still a 400", () => {
    expect(() => requestOf("/", "bad host")).toThrow(BadRequestError);
  });
});
