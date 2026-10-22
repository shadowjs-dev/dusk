/**
 * Compile-time checks for the server function types. Vitest does not run this file; `tsc -p
 * packages/dusk/tsconfig.json` does, so a wrong type fails the typecheck.
 */
import { describe, expectTypeOf, it } from "vitest";
import { serverFnStub } from "../src/client/fn";
import type { DuskRuntimeManifest } from "../src/server/index";
import { serverFn } from "../src/server/server-fn";
import type { StandardSchemaV1 } from "../src/server/standard-schema";
import type { ServerFnDefinition } from "../src/server/types";

/** A Standard Schema with the given input and output types and no validation (types only). */
function schemaOf<I, O = I>(): StandardSchemaV1<I, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({ value: value as O }),
    },
  };
}

const meta = { method: "POST", form: false, base: "" } as const;

describe("server function call signature", () => {
  it("[SFT-01] a function without an input schema is callable without an argument, on the server and in the browser", async () => {
    const list = serverFn({ method: "GET" }, async () => [1, 2, 3]);
    const all: number[] = await list();
    expectTypeOf(all).toEqualTypeOf<number[]>();
    await list(undefined);
    const stub = serverFnStub<unknown, number[]>("id", { ...meta, method: "GET" });
    await stub();
  });

  it("[SFT-02] a schema that accepts undefined makes the argument optional on both sides", async () => {
    const maybe = serverFn({ input: schemaOf<string | undefined>() }, (value) => value ?? "none");
    await maybe();
    await maybe("x");
    const stub = serverFnStub<string | undefined, string>("id", meta);
    await stub();
    await stub("x");
  });

  it("[SFT-03] a schema that does not accept undefined requires the argument on both sides", async () => {
    const required = serverFn({ input: schemaOf<string>() }, (value) => value.length);
    await required("x");
    // @ts-expect-error the schema requires a string
    await required();
    const stub = serverFnStub<string, number>("id", meta);
    await stub("x");
    // @ts-expect-error the stub requires the same argument as the server function
    await stub();
    // @ts-expect-error `with()` keeps the same signature
    await stub.with({})();
    await stub.with({})("x");
  });
});

describe("server function call options", () => {
  it("[SFT-04] the server function takes the same call options as the browser stub, so shared code compiles on both sides", async () => {
    const find = serverFn(
      { method: "GET", input: schemaOf<{ q: string }>() },
      (input) => input.q.length,
    );
    const controller = new AbortController();
    // A component imports the server module, so it sees this type even though the browser runs the stub.
    await find({ q: "a" }, { signal: controller.signal }).catch(() => undefined);
    await find
      .with({ signal: controller.signal })({ q: "a" })
      .catch(() => undefined);
    expectTypeOf(find.with({})).returns.resolves.toEqualTypeOf<number>();
    // @ts-expect-error `with()` keeps the input requirement
    await find.with({})();
  });
});

describe("server function manifest entries", () => {
  it("[SFT-10] a function built with serverFn() and a typed schema is assignable to a manifest entry without a cast", () => {
    const typed = serverFn({ input: schemaOf<{ id: string }>() }, (input) => input.id.length);
    const untyped = serverFn({}, () => "pong");
    const mapped = serverFn(
      { input: schemaOf<string, number>(), method: "GET" },
      (input) => input * 2,
    );
    const serverFns: DuskRuntimeManifest["serverFns"] = {
      typed: { load: async () => typed },
      untyped: { load: async () => untyped },
      mapped: { load: async () => mapped },
    };
    expectTypeOf(serverFns).toBeObject();
  });
});

describe("call options as the last argument", () => {
  it("[SFT-04] a stub takes { signal } after the input, so it is assignable to (input, { signal }) callers", async () => {
    const controller = new AbortController();
    const required = serverFnStub<string, number>("id", meta);
    await required("x", { signal: controller.signal });
    // @ts-expect-error the input stays required when options are given
    await required({ signal: controller.signal });
    const optional = serverFnStub<string | undefined, number>("id", meta);
    await optional(undefined, { signal: controller.signal });
    await optional();
    // @ts-expect-error unknown call option
    await required("x", { cancel: true });
    const asAction: (
      input: string,
      options?: { readonly signal?: AbortSignal },
    ) => PromiseLike<number> = required;
    void asAction;
  });
});

describe("erased server function definitions", () => {
  it("[SFT-05] the erased definition's handler takes unknown input: the executor passes validated or untrusted input, never a typed value it did not check", () => {
    expectTypeOf<Parameters<ServerFnDefinition["handler"]>[0]>().toEqualTypeOf<unknown>();
  });

  it("[SFT-06] a typed server function is assignable to the erased definition the manifest and executeServerFn use", () => {
    const typed = serverFn({ input: schemaOf<{ title: string }>() }, ({ title }) => title.length);
    const erased: ServerFnDefinition = typed;
    expectTypeOf(erased).toEqualTypeOf<ServerFnDefinition>();
  });
});
