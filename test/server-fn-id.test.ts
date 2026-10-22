import { describe, expect, it } from "vitest";
import { serverFnStub } from "../src/client/fn";
import { bindServerFn, serverFn } from "../src/server/index";

describe("server function id and url", () => {
  it("[SFID-01] before the build binds an id, reading id or url fails with a message that says why", () => {
    const fn = serverFn({}, () => 1);
    expect(() => fn.id).toThrow(/SERVER_FN_NOT_BUILT/);
    expect(() => fn.url).toThrow(/dusk/);
    // Spreading or listing the function must not trip over the unbound members.
    expect(Object.keys(fn)).not.toContain("id");
    expect(Object.keys(fn)).not.toContain("url");
  });

  it("[SFID-02] bindServerFn gives the function the id and url its browser stub has", () => {
    const fn = serverFn({ form: true }, () => 1);
    const bound = bindServerFn(fn, "q3Zr0b1g2yTt0m5Qk9w3xA", "/app");
    expect(bound).toBe(fn);
    expect(fn.id).toBe("q3Zr0b1g2yTt0m5Qk9w3xA");
    expect(fn.url).toBe("/app/_dusk/fn/q3Zr0b1g2yTt0m5Qk9w3xA");
    const stub = serverFnStub("q3Zr0b1g2yTt0m5Qk9w3xA", {
      method: "POST",
      form: true,
      base: "/app",
    });
    expect(fn.url).toBe(stub.url);
    expect(fn.id).toBe(stub.id);
  });

  it("[SFID-03] a bound function is still callable and keeps its definition", async () => {
    const fn = bindServerFn(
      serverFn({ method: "GET" }, (input) => ({ got: input })),
      "abc",
      "",
    );
    expect(fn.method).toBe("GET");
    expect(fn.form).toBe(false);
    expect(await fn.invoke(1, {} as never)).toEqual({ got: 1 });
  });

  it("[SFID-04] binding twice, or binding something that is not a serverFn() result, throws", () => {
    const fn = bindServerFn(
      serverFn({}, () => 1),
      "abc",
      "",
    );
    expect(() => bindServerFn(fn, "other", "")).toThrow(/SERVER_FN_ALREADY_BOUND/);
    expect(() => bindServerFn((() => 1) as never, "abc", "")).toThrow(TypeError);
  });

  it("[SFID-05] an id that is not URL-safe is refused, so a url can never carry a path or a query", () => {
    for (const id of ["", "a/b", "a?b", "a b", "../x", "x".repeat(129)]) {
      expect(() =>
        bindServerFn(
          serverFn({}, () => 1),
          id,
          "",
        ),
      ).toThrow(TypeError);
    }
  });
});
