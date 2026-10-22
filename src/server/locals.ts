import { getRequestEvent } from "./context";
import type { DuskLocals, Middleware, RequestEvent } from "./types";

/**
 * A typed set of locals with defaults. See {@link defineLocals}.
 * @since 1.0.0
 */
export interface DefinedLocals<T extends Record<string, unknown>> {
  /** The defaults, frozen. Each one is set on a request that has no value for its key yet. */
  readonly defaults: Readonly<T>;
  /**
   * Middleware that sets each default the request does not have yet. Put it first in the chain that
   * reads the locals; it is harmless to run twice.
   */
  readonly middleware: Middleware;
  /**
   * The request's locals, typed as `T`. The defaults are applied first, so an unset key reads as its
   * default.
   */
  of(event: RequestEvent): T;
}

/**
 * Declares a typed group of locals with defaults. It does not change the global {@link DuskLocals}
 * interface (merge into that for the app-wide types); it gives one module a typed view and a middleware
 * that makes sure the keys exist.
 *
 * @param defaults The default value of each key. A key a middleware set earlier keeps that value. An array, plain object,
 *   `Set`, `Map` or `Date` is copied for each request (so its mutation stays in that request); it must be
 *   structured-cloneable.
 * @throws TypeError when a default cannot be copied for each request.
 * @returns The middleware and the typed view.
 * @example
 * const session = defineLocals({ user: undefined as User | undefined, requestedAt: 0 });
 * export const middleware = [session.middleware, async (event, next) => {
 *   session.of(event).user = await readUser(event);
 *   return next();
 * }];
 * @since 1.0.0
 */
export function defineLocals<T extends Record<string, unknown>>(defaults: T): DefinedLocals<T> {
  const keys = Object.keys(defaults);
  const frozen = Object.freeze({ ...defaults });
  // A default that is an array, a plain object, a Set, a Map or a Date is copied for each request: sharing it would
  // let one request's `cart.push(...)` appear in every later request. Anything else (a primitive, a function, a class
  // instance) is shared as it is. A default that cannot be copied is refused here, when it is declared.
  for (const key of keys) {
    try {
      fresh(frozen[key]);
    } catch (cause) {
      throw new TypeError(
        `defineLocals: the default of "${key}" cannot be copied for each request (a function inside it?). Set it in a middleware instead.`,
        { cause },
      );
    }
  }
  const apply = (event: RequestEvent): void => {
    const target = event.locals as Record<string, unknown>;
    for (const key of keys) {
      if (!Object.hasOwn(target, key)) target[key] = fresh(frozen[key]);
    }
  };
  return {
    defaults: frozen,
    middleware: (event, next) => {
      apply(event);
      return next();
    },
    of: (event) => {
      apply(event);
      // The view is the request's own locals object; the keys were just set to their defaults.
      return event.locals as unknown as T;
    },
  };
}

/** A copy of a default that holds state, the value itself for anything else. */
function fresh(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  const copied =
    Array.isArray(value) ||
    value instanceof Set ||
    value instanceof Map ||
    value instanceof Date ||
    prototype === Object.prototype ||
    prototype === null;
  return copied ? structuredClone(value) : value;
}

/**
 * The locals of the request being handled. Available wherever {@link getRequestEvent} is (middleware,
 * guards, loaders, API routes and server functions) on runtimes with `AsyncLocalStorage`.
 *
 * @returns The request's locals.
 * @throws DuskError when there is no request or no async context (see `getRequestEvent`).
 * @example
 * const user = getLocals().user;
 * @since 1.0.0
 */
export function getLocals(): DuskLocals {
  return getRequestEvent().locals;
}

/**
 * Same as {@link getLocals}, named for use inside a loader or a server function body.
 *
 * @returns The request's locals.
 * @example
 * export const whoami = serverFn({}, () => useRequestLocals().user?.id ?? null);
 * @since 1.0.0
 */
export function useRequestLocals(): DuskLocals {
  return getLocals();
}
