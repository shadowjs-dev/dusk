import { HttpError } from "../internal/http-error";
import type { Guard, RequestEvent } from "./types";

/** An awaited guard may resume after cancellation; its continuation must not invoke another user callback. */

/**
 * Checks and normalizes a guard list (one guard, an array, or nothing).
 *
 * @param input The guard option as written.
 * @param where Names the call in the error message.
 * @returns The guards, in order.
 * @throws TypeError when an entry is not a function.
 * @internal
 */
export function guardList(input: Guard | readonly Guard[] | undefined, where: string): Guard[] {
  if (input === undefined) return [];
  const list: readonly unknown[] = typeof input === "function" ? [input] : input;
  for (const entry of list) {
    if (typeof entry !== "function") {
      throw new TypeError(`${where}: each guard must be a function.`);
    }
  }
  return [...(list as readonly Guard[])];
}

/**
 * Identity helper that types a reusable guard. Use it to name a check once and pass it to any number of
 * server functions or API methods.
 *
 * @param guard The check.
 * @returns The same guard.
 * @throws TypeError when `guard` is not a function.
 * @example
 * export const requireAdmin = defineGuard((event) => {
 *   if (event.locals.user?.role !== "admin") throw new HttpError(403, "Admins only");
 * });
 * @since 1.0.0
 */
export function defineGuard(guard: Guard): Guard {
  guardList([guard], "defineGuard()");
  return guard;
}

/**
 * Passes when every guard passes, in order. The first one that throws (or returns `false`) stops the
 * chain, so a later guard never runs for a request an earlier one refused.
 *
 * @param guards The guards to run.
 * @returns One guard.
 * @throws The request signal's reason when cancellation precedes a guard or its awaited result.
 * @example
 * serverFn({ guard: all(requireUser, requireAdmin) }, handler);
 * @since 1.0.0
 */
export function all(...guards: readonly Guard[]): Guard {
  const list = guardList(guards, "all()");
  return async (event) => {
    for (const guard of list) {
      event.signal.throwIfAborted();
      const result = await guard(event);
      event.signal.throwIfAborted();
      if (result === false) return false;
    }
    return undefined;
  };
}

/**
 * Passes when at least one guard passes. Guards run in order; the first to pass ends the check. When
 * none passes, the last refusal is the outcome: its thrown error, or a 403 for a guard that returned
 * `false`.
 *
 * @param guards At least one guard.
 * @returns One guard.
 * @throws TypeError when no guard is given.
 * @throws The request signal's reason when cancellation precedes a guard or its awaited result.
 * @example
 * serverFn({ guard: any(requireAdmin, requireOwner) }, handler);
 * @since 1.0.0
 */
export function any(...guards: readonly Guard[]): Guard {
  if (guards.length === 0) throw new TypeError("any(): give at least one guard.");
  const list = guardList(guards, "any()");
  return async (event) => {
    let outcome: unknown = new HttpError(403, "Forbidden");
    for (const guard of list) {
      event.signal.throwIfAborted();
      let passed = false;
      try {
        passed = (await guard(event)) !== false;
        if (!passed) outcome = new HttpError(403, "Forbidden");
      } catch (error) {
        // The refusal is kept and rethrown below if no guard passes; it is not dropped.
        outcome = error;
      }
      // Outside the refusal catch: cancellation is terminal and cannot become an alternative guard attempt.
      event.signal.throwIfAborted();
      if (passed) return undefined;
    }
    throw outcome;
  };
}

/**
 * Runs guards in order for one request. A guard that returns `false` refuses with 403; a guard that
 * throws propagates its error (an `HttpError` keeps its status).
 *
 * @param guards The guards.
 * @param event The request event.
 * @throws HttpError 403 when a guard returns `false`; whatever a guard throws otherwise.
 * @throws The request signal's reason when cancellation precedes a guard or its awaited result.
 * @internal
 */
export async function runGuards(guards: readonly Guard[], event: RequestEvent): Promise<void> {
  for (const guard of guards) {
    event.signal.throwIfAborted();
    const result = await guard(event);
    event.signal.throwIfAborted();
    if (result === false) throw new HttpError(403, "Forbidden");
  }
}
