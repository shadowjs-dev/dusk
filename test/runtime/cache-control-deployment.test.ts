import { describe, expect, it } from "vitest";
import { cacheControlHeader, resolveCacheControl } from "../../src/server/cache-control";
import { checkDeploymentHeader, DEPLOYMENT_HEADER } from "../../src/server/deployment";

describe("per-function cache-control", () => {
  it("[CC-1] the default is no-store; `public` with max-age and stale-while-revalidate names both", () => {
    expect(
      cacheControlHeader(resolveCacheControl(undefined, "GET"), new Request("https://a.example/x")),
    ).toEqual({ value: "no-store" });
    const header = cacheControlHeader(
      resolveCacheControl({ visibility: "public", maxAge: 60, staleWhileRevalidate: 300 }, "GET"),
      new Request("https://a.example/x"),
    );
    expect(header.value).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  it("[CC-2] `private` names the vary headers it depends on", () => {
    const header = cacheControlHeader(
      resolveCacheControl(
        { visibility: "private", maxAge: 10, vary: ["Cookie", "accept-language"] },
        "GET",
      ),
      new Request("https://a.example/x"),
    );
    expect(header).toEqual({ value: "private, max-age=10", vary: "cookie, accept-language" });
  });

  it("[CC-3] a public answer to a request that carries cookies or authorization is private: a shared cache must not keep it", () => {
    const option = resolveCacheControl({ visibility: "public", maxAge: 60 }, "GET");
    expect(
      cacheControlHeader(
        option,
        new Request("https://a.example/x", { headers: { cookie: "sid=1" } }),
      ).value,
    ).toBe("private, max-age=60");
    expect(
      cacheControlHeader(
        option,
        new Request("https://a.example/x", { headers: { authorization: "Bearer x" } }),
      ).value,
    ).toBe("private, max-age=60");
  });

  it("[CC-4] a POST function may not be public (a shared cache would answer a write); a bad max-age is refused", () => {
    expect(() => resolveCacheControl({ visibility: "public", maxAge: 5 }, "POST")).toThrow(/POST/);
    expect(resolveCacheControl({ visibility: "private", maxAge: 5 }, "POST")).toBeDefined();
    expect(() => resolveCacheControl({ maxAge: -1 }, "GET")).toThrow(/maxAge/);
    expect(() => resolveCacheControl({ vary: ["bad name"] }, "GET")).toThrow(/vary/);
  });

  it("[CC-5] a named cacheLife profile sets max-age to its stale time and stale-while-revalidate to its revalidate time", () => {
    const option = resolveCacheControl({ visibility: "public", profile: "hours" }, "GET", {
      hours: { stale: 300, revalidate: 3600, expire: 86400 },
    });
    expect(cacheControlHeader(option, new Request("https://a.example/x")).value).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
  });
});

describe("deployment skew", () => {
  it("[DEP-1] the header is compared with the deployment id; no header or no id is no mismatch", () => {
    expect(DEPLOYMENT_HEADER).toBe("x-dusk-deployment");
    expect(
      checkDeploymentHeader(
        new Request("https://a.example/", { headers: { [DEPLOYMENT_HEADER]: "r1" } }),
        "r1",
      ),
    ).toBe(true);
    expect(
      checkDeploymentHeader(
        new Request("https://a.example/", { headers: { [DEPLOYMENT_HEADER]: "r0" } }),
        "r1",
      ),
    ).toBe(false);
    expect(checkDeploymentHeader(new Request("https://a.example/"), "r1")).toBe(true);
    expect(
      checkDeploymentHeader(
        new Request("https://a.example/", { headers: { [DEPLOYMENT_HEADER]: "r0" } }),
        undefined,
      ),
    ).toBe(true);
  });
});
