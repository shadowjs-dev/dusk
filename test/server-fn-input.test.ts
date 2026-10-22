import { describe, expect, it } from "vitest";
import { z } from "zod";
import { executeServerFn, serverFn } from "../src/server/server-fn";
import { ValidationError } from "../src/server/validate";
import { createTestEvent } from "../src/testing/index";

describe("the input a server function handler receives", () => {
  it("[SFI-01] with a schema and no middleware, the handler gets the schema's output (transformed), not the raw input", async () => {
    const seen: unknown[] = [];
    const fn = serverFn(
      { input: z.object({ title: z.string().transform((title) => title.trim()) }) },
      ({ title }) => {
        seen.push(title);
        return title.length;
      },
    );
    const length = await executeServerFn(fn, { title: "  hi  " }, createTestEvent());
    expect(length).toBe(2);
    expect(seen).toEqual(["hi"]);
  });

  it("[SFI-02] with middleware, the handler receives the same validated value the middleware saw", async () => {
    const fromMiddleware: unknown[] = [];
    const fromHandler: unknown[] = [];
    const fn = serverFn(
      {
        input: z.object({ n: z.coerce.number() }),
        middleware: [
          async ({ input }, next) => {
            fromMiddleware.push(input);
            return next();
          },
        ],
      },
      (input) => {
        fromHandler.push(input);
        return input.n;
      },
    );
    await expect(executeServerFn(fn, { n: "7" }, createTestEvent())).resolves.toBe(7);
    expect(fromMiddleware).toEqual([{ n: 7 }]);
    expect(fromHandler).toEqual([{ n: 7 }]);
  });

  it("[SFI-03] without a schema, the handler gets the untrusted input by reference, unchanged", async () => {
    const raw = { nested: { value: 1 } };
    let received: unknown;
    const fn = serverFn({}, (input: unknown) => {
      received = input;
      return "ok";
    });
    await expect(executeServerFn(fn, raw, createTestEvent())).resolves.toBe("ok");
    expect(received).toBe(raw);
  });

  it("[SFI-04] an input the schema refuses never reaches the handler", async () => {
    let calls = 0;
    const fn = serverFn({ input: z.object({ id: z.string().min(1) }) }, () => {
      calls += 1;
      return "ran";
    });
    await expect(executeServerFn(fn, { id: "" }, createTestEvent())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toBe(0);
  });
});
