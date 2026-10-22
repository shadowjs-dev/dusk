import { describe, expect, it } from "vitest";
import { assertKnownOptions } from "../src/internal/known-options";
import { serve } from "../src/node/index";
import { serverFn } from "../src/server/index";

const known = new Set(["port", "host", "static", "compress"]);

describe("unknown options are rejected", () => {
  it("[OPT-01] names the option and suggests the closest known one", () => {
    expect(() => assertKnownOptions("serve", { staticDir: "x" }, known)).toThrow(
      /unknown option "staticDir"\. Did you mean "static"\?/,
    );
    expect(() => assertKnownOptions("serve", { prot: 1 }, known)).toThrow(/Did you mean "port"\?/);
  });

  it("[OPT-02] no hint when nothing is close; the known names are listed", () => {
    expect(() => assertKnownOptions("serve", { zzzzzzzz: 1 }, known)).toThrow(
      /unknown option "zzzzzzzz"\. Known options: port, host, static, compress\./,
    );
  });

  it("[OPT-03] known options, undefined and non-objects pass", () => {
    expect(() => assertKnownOptions("serve", { port: 1, host: "x" }, known)).not.toThrow();
    expect(() => assertKnownOptions("serve", undefined, known)).not.toThrow();
    expect(() => assertKnownOptions("serve", null, known)).not.toThrow();
  });

  it("[OPT-04] serve() refuses a misspelled option before it listens", async () => {
    await expect(
      serve({ fetch: async () => new Response("x") }, { staticDir: "dist" } as never),
    ).rejects.toThrow(/Did you mean "static"/);
  });
});

describe("client disconnects are not server errors", () => {
  it("[OPT-05] premature close, reset, broken pipe and aborts are recognized; real errors are not", async () => {
    const { isClientDisconnect } = await import("../src/node/serve");
    for (const code of [
      "ERR_STREAM_PREMATURE_CLOSE",
      "ECONNRESET",
      "EPIPE",
      "ERR_STREAM_DESTROYED",
    ]) {
      expect(isClientDisconnect(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    expect(isClientDisconnect(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isClientDisconnect(new Error("boom"))).toBe(false);
    expect(isClientDisconnect(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe(false);
    expect(isClientDisconnect("text")).toBe(false);
    expect(isClientDisconnect(null)).toBe(false);
  });
});

describe("server function call types", () => {
  it("[SFN-T1] an input-less function is callable without arguments; a schema with a required input requires it", () => {
    const ping = serverFn({}, () => "pong");
    const schema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value: value as { id: string } }),
        types: undefined as unknown as { input: { id: string }; output: { id: string } },
      },
    };
    const needsInput = serverFn({ input: schema }, async (input) => input.id);
    const compileOnly = (): void => {
      void ping();
      void ping(1);
      void needsInput({ id: "a" });
      // @ts-expect-error a function whose input is required cannot be called without it
      void needsInput();
    };
    expect(typeof compileOnly).toBe("function");
  });
});
