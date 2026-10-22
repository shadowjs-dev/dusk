/**
 * The request context: the event of the request being answered, found through `AsyncLocalStorage` where the runtime
 * has it. It lives outside `src/server` so client-reachable code (`useResponse`, the components) can read it without
 * importing server code (the import protection forbids that); `src/server/context.ts` re-exports it unchanged.
 * Nothing here imports a Node module: the storage is found through `process.getBuiltinModule`.
 */
import type { ContextKey, RequestEvent } from "../server/types";

/** The part of `AsyncLocalStorage` this module uses. */
interface EventStorage {
  run<T>(event: RequestEvent, callback: () => T): T;
  getStore(): RequestEvent | undefined;
}

type StorageConstructor = new () => EventStorage;

/** True for a constructor that makes a storage with `run` and `getStore`. */
function isStorageConstructor(value: unknown): value is StorageConstructor {
  if (typeof value !== "function") return false;
  const prototype: unknown = Reflect.get(value, "prototype");
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    typeof Reflect.get(prototype, "run") === "function"
  );
}

/**
 * Finds `AsyncLocalStorage` without importing a Node module: hosts that have it (Node, Bun, Deno,
 * Workers with `nodejs_compat`) expose it through `process.getBuiltinModule`. Anywhere else the
 * result is `undefined` and the handler passes the event explicitly.
 */
function detectStorage(): EventStorage | undefined {
  const host: unknown = Reflect.get(globalThis, "process");
  if (typeof host !== "object" || host === null) return undefined;
  const load: unknown = Reflect.get(host, "getBuiltinModule");
  if (typeof load !== "function") return undefined;
  const hooks: unknown = Reflect.apply(load, host, ["node:async_hooks"]);
  if (typeof hooks !== "object" || hooks === null) return undefined;
  const Storage: unknown = Reflect.get(hooks, "AsyncLocalStorage");
  return isStorageConstructor(Storage) ? new Storage() : undefined;
}

// One storage per process: `getRequestEvent()` is a free function, so the storage cannot be per
// handler. It holds no state of its own; every request enters it with `runWithEvent`.
const storage: EventStorage | undefined = detectStorage();

/** True when this runtime can track the request event across `await`. @since 1.0.0 */
export const hasAsyncContext: boolean = storage !== undefined;

/**
 * Error with a stable diagnostic code, for conditions the caller can fix.
 * @example
 * try { getRequestEvent(); } catch (error) { if (error instanceof DuskError) console.log(error.code); }
 * @since 1.0.0
 */
export class DuskError extends Error {
  readonly code: string;

  /**
   * @param code A code such as `SERVER_NO_REQUEST_EVENT`.
   * @param message What happened and what to do.
   */
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DuskError";
    this.code = code;
  }
}

/**
 * Runs `callback` with `event` as the current request event.
 *
 * @param event The event.
 * @param callback The work.
 * @param enabled Pass `false` to run without the context (the explicit-event fallback).
 * @returns Whatever `callback` returns.
 * @example
 * runWithEvent(event, () => getRequestEvent() === event); // true where AsyncLocalStorage exists
 * @since 1.0.0
 */
export function runWithEvent<T>(event: RequestEvent, callback: () => T, enabled = true): T {
  return storage !== undefined && enabled ? storage.run(event, callback) : callback();
}

/**
 * The event of the request being handled, or `undefined` outside a request or where the runtime
 * has no `AsyncLocalStorage`.
 *
 * @returns The event, if any.
 * @example
 * const user = tryGetRequestEvent()?.cookies.get("theme");
 * @since 1.0.0
 */
export function tryGetRequestEvent(): RequestEvent | undefined {
  return storage?.getStore();
}

/**
 * The event of the request being handled. Available in middleware, loaders, API routes, server
 * functions and while a page is streamed. Where the runtime has no `AsyncLocalStorage`, use the
 * event passed as an argument (`context.event` in loaders).
 *
 * @returns The current event.
 * @throws DuskError `SERVER_ALS_UNAVAILABLE` when the runtime cannot track it,
 *   `SERVER_NO_REQUEST_EVENT` when called outside a request.
 * @example
 * const { cookies } = getRequestEvent();
 * @since 1.0.0
 */
export function getRequestEvent(): RequestEvent {
  if (storage === undefined) {
    throw new DuskError(
      "SERVER_ALS_UNAVAILABLE",
      "this runtime has no AsyncLocalStorage; use the event passed as an argument.",
    );
  }
  const event = storage.getStore();
  if (event === undefined) {
    throw new DuskError(
      "SERVER_NO_REQUEST_EVENT",
      "getRequestEvent() was called outside a request.",
    );
  }
  return event;
}

/**
 * Creates a typed key for `event.set` / `event.get`. Keys compare by identity, so two keys with the
 * same name are different keys.
 *
 * @param name A name for diagnostics.
 * @returns The key.
 * @example
 * export const userKey = createKey<{ id: string }>("user");
 * @since 1.0.0
 */
export function createKey<T>(name: string): ContextKey<T> {
  return Object.freeze({ name });
}
