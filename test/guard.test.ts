import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiHandler } from "../src/server/api";
import { all, any, defineGuard, runGuards } from "../src/server/guard";
import { HttpError } from "../src/server/index";
import { defineLocals } from "../src/server/locals";
import { executeServerFn, serverFn } from "../src/server/server-fn";
import type { Guard, ServerFnDefinition } from "../src/server/types";
import { createTestEvent } from "../src/testing/index";

const session = defineLocals({ user: undefined as { id: string; role: string } | undefined });

/** A guard that records its name in `calls` and passes or refuses. */
function recording(calls: string[], name: string, outcome: "pass" | "refuse" | "false"): Guard {
  return () => {
    calls.push(name);
    if (outcome === "refuse") throw new HttpError(401, `${name} refused`);
    if (outcome === "false") return false;
    return undefined;
  };
}

function definitionOf(
  options: Parameters<typeof serverFn>[0],
  calls: string[],
): ServerFnDefinition {
  const fn = serverFn(options, (input: unknown) => {
    calls.push("handler");
    return input;
  });
  // The definition the build's manifest holds: serverFn() returns it with the callable on top.
  return fn as unknown as ServerFnDefinition;
}

/** The value a call settles with, or the error it rejects with. A guard may return a plain value. */
async function outcomeOf(value: unknown): Promise<unknown> {
  try {
    return await value;
  } catch (error) {
    return error;
  }
}

describe("guard on serverFn", () => {
  it("[GRD-1] a refused guard answers with its status and the handler never runs", async () => {
    const calls: string[] = [];
    const definition = definitionOf({ guard: recording(calls, "auth", "refuse") }, calls);
    const error = await outcomeOf(executeServerFn(definition, {}, createTestEvent()));
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect(calls).toEqual(["auth"]);
  });

  it("[GRD-2] guards run before the input is validated: an invalid input is not reported when a guard refuses", async () => {
    const calls: string[] = [];
    const schema = z.object({ title: z.string().min(1) });
    const fn = serverFn({ input: schema, guard: recording(calls, "auth", "refuse") }, () => {
      calls.push("handler");
      return 1;
    });
    const definition = fn as unknown as ServerFnDefinition;
    const error = await outcomeOf(executeServerFn(definition, { title: "" }, createTestEvent()));
    expect((error as HttpError).status).toBe(401);
    expect(calls).toEqual(["auth"]);
  });

  it("[GRD-3] a guard returning false refuses with 403", async () => {
    const calls: string[] = [];
    const definition = definitionOf({ guard: recording(calls, "role", "false") }, calls);
    const error = await outcomeOf(executeServerFn(definition, {}, createTestEvent()));
    expect((error as HttpError).status).toBe(403);
    expect(calls).toEqual(["role"]);
  });

  it("[GRD-4] an array of guards runs in order, and the first refusal stops the rest", async () => {
    const calls: string[] = [];
    const definition = definitionOf(
      {
        guard: [
          recording(calls, "a", "pass"),
          recording(calls, "b", "refuse"),
          recording(calls, "c", "pass"),
        ],
      },
      calls,
    );
    const error = await outcomeOf(executeServerFn(definition, {}, createTestEvent()));
    expect((error as HttpError).status).toBe(401);
    expect(calls).toEqual(["a", "b"]);
  });

  it("[GRD-5] guards run before the serverFn middleware", async () => {
    const calls: string[] = [];
    const fn = serverFn(
      {
        guard: recording(calls, "guard", "refuse"),
        middleware: [
          async (_context, next) => {
            calls.push("middleware");
            return next();
          },
        ],
      },
      () => {
        calls.push("handler");
        return 1;
      },
    );
    const error = await outcomeOf(
      executeServerFn(fn as unknown as ServerFnDefinition, {}, createTestEvent()),
    );
    expect((error as HttpError).status).toBe(401);
    expect(calls).toEqual(["guard"]);
  });

  it("[GRD-6] a guard reads the locals that middleware or the caller set on the request", async () => {
    let seenRole: string | undefined;
    const requireAdmin = defineGuard((event) => {
      const user = session.of(event).user;
      seenRole = user?.role;
      if (user?.role !== "admin") throw new HttpError(403, "Admins only");
    });
    const definition = definitionOf({ guard: requireAdmin }, []);
    const event = createTestEvent();
    session.of(event).user = { id: "u1", role: "reader" };
    const refused = await outcomeOf(executeServerFn(definition, {}, event));
    expect((refused as HttpError).status).toBe(403);
    expect(seenRole).toBe("reader");

    const admin = createTestEvent();
    session.of(admin).user = { id: "u2", role: "admin" };
    // The handler echoes its input, so an admin reaches it and gets `{}` back.
    await expect(executeServerFn(definition, {}, admin)).resolves.toEqual({});
  });

  it("[GRD-7] a guard list that holds a non-function is a TypeError when the function is defined", () => {
    expect(() =>
      serverFn({ guard: [recording([], "ok", "pass"), 3 as unknown as Guard] }, () => 1),
    ).toThrow(TypeError);
  });
});

describe("guard composition", () => {
  it("[GRD-10] all() passes when every guard passes and refuses at the first refusal", async () => {
    const calls: string[] = [];
    const guard = all(
      recording(calls, "a", "pass"),
      recording(calls, "b", "refuse"),
      recording(calls, "c", "pass"),
    );
    await expect(guard(createTestEvent())).rejects.toBeInstanceOf(HttpError);
    expect(calls).toEqual(["a", "b"]);
    const passing = all(recording(calls, "d", "pass"), recording(calls, "e", "pass"));
    await expect(passing(createTestEvent())).resolves.toBe(undefined);
  });

  it("[GRD-11] any() passes as soon as one guard passes, and keeps the last refusal when none does", async () => {
    const calls: string[] = [];
    const guard = any(recording(calls, "owner", "refuse"), recording(calls, "admin", "pass"));
    await expect(guard(createTestEvent())).resolves.toBe(undefined);
    expect(calls).toEqual(["owner", "admin"]);

    const none = any(recording(calls, "owner2", "refuse"), recording(calls, "admin2", "false"));
    const error = await outcomeOf(none(createTestEvent()));
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).toBe("Forbidden");
  });

  it("[GRD-12] any() with no guard is a TypeError (it would refuse everything, silently)", () => {
    expect(() => any()).toThrow(TypeError);
  });

  it("[GRD-13] defineGuard returns the guard it is given and rejects a non-function", () => {
    const guard = (): undefined => undefined;
    expect(defineGuard(guard)).toBe(guard);
    expect(() => defineGuard(3 as unknown as Guard)).toThrow(TypeError);
  });

  it.each(["all", "any", "run"] as const)(
    "[GRD-14] %s runs no guard for an already aborted event",
    async (kind) => {
      const abort = new AbortController();
      const reason = new Error("request already gone");
      abort.abort(reason);
      const event = createTestEvent({ signal: abort.signal });
      const calls: string[] = [];
      const guards = [recording(calls, "first", "pass")];
      const result =
        kind === "all"
          ? all(...guards)(event)
          : kind === "any"
            ? any(...guards)(event)
            : runGuards(guards, event);
      await expect(result).rejects.toBe(reason);
      expect(calls).toEqual([]);
    },
  );

  it("[GRD-17] any treats cancellation as terminal even when the resumed guard throws a refusal", async () => {
    const abort = new AbortController();
    const event = createTestEvent({ signal: abort.signal });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const guard = any(
      async () => {
        calls.push("first");
        await held;
        throw new HttpError(401, "late refusal");
      },
      recording(calls, "later", "pass"),
    );
    const pending = guard(event);
    const reason = new Error("canceled during refusal");
    abort.abort(reason);
    if (release === undefined) throw new Error("missing release");
    release();
    await expect(pending).rejects.toBe(reason);
    expect(calls).toEqual(["first"]);
  });

  it.each(["all", "any", "run"] as const)(
    "[GRD-15] %s stops nested callbacks when an awaited guard resumes after cancellation",
    async (kind) => {
      const abort = new AbortController();
      const event = createTestEvent({ signal: abort.signal });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls: string[] = [];
      const first: Guard = async () => {
        calls.push("first");
        await held;
        return kind === "any" ? false : undefined;
      };
      const guards = [first, recording(calls, "later", "pass")];
      const result =
        kind === "all"
          ? all(...guards)(event)
          : kind === "any"
            ? any(...guards)(event)
            : runGuards(guards, event);
      const reason = new Error("request left while guard awaited");
      abort.abort(reason);
      if (release === undefined) throw new Error("missing release");
      release();
      await expect(result).rejects.toBe(reason);
      expect(calls).toEqual(["first"]);
    },
  );

  it.each(["all", "any", "run"] as const)(
    "[GRD-16] %s preserves cancellation over the final awaited guard outcome",
    async (kind) => {
      const abort = new AbortController();
      const event = createTestEvent({ signal: abort.signal });
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first: Guard = async () => {
        await held;
        return kind === "any";
      };
      const result =
        kind === "all"
          ? all(first)(event)
          : kind === "any"
            ? any(first)(event)
            : runGuards([first], event);
      const reason = new Error("last guard canceled");
      abort.abort(reason);
      if (release === undefined) throw new Error("missing release");
      release();
      await expect(result).rejects.toBe(reason);
    },
  );
});

describe("guard on API route methods", () => {
  it("[GRD-20] apiHandler runs its guard before the body is read: a refusal is the guard's status, not a 400 or 415", async () => {
    const calls: string[] = [];
    const handler = apiHandler(
      {
        body: z.object({ title: z.string() }),
        guard: recording(calls, "auth", "refuse"),
      },
      () => {
        calls.push("handler");
        return { ok: true };
      },
    );
    const event = createTestEvent({
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    const error = await outcomeOf(Promise.resolve().then(() => handler(event)));
    expect((error as HttpError).status).toBe(401);
    expect(calls).toEqual(["auth"]);
  });
});
