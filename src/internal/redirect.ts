import {
  isNotFound,
  isRedirect,
  notFound,
  type RedirectSignal,
  type RedirectTarget,
  redirect as routerRedirect,
} from "@shadow-js/router/core";

/** Statuses a redirect can use. 303 turns a POST into a GET, 307 and 308 keep the method. @since 1.0.0 */
export type RedirectStatus = 301 | 302 | 303 | 307 | 308;

/** Options of {@link redirect}. @since 1.0.0 */
export interface RedirectOptions {
  /** The HTTP status when the redirect is answered by a server. Defaults to 302. */
  readonly status?: RedirectStatus;
  /** Replace the history entry on the client. Defaults to `true`, like the router. */
  readonly replace?: boolean;
}

const STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Status of each redirect signal created here. Weak, so signals are collected with their request. */
const statuses = new WeakMap<object, RedirectStatus>();

/**
 * Creates the signal to throw for a redirect. It is the router's own signal (so `beforeLoad` and
 * loaders understand it) with an HTTP status attached, which the server uses for the `Location`
 * response and for the `{ redirect }` answer of a server function.
 *
 * @param to Target: an app path (`/login`), an absolute URL whose origin the server allows, or an object `{ to, params?,
 * search?, hash?, status?, replace? }` with the typed params and search that links take.
 * @param options Status and history behavior (the string form).
 * @returns The signal. `throw` it.
 * @throws RangeError for a status that is not 301, 302, 303, 307 or 308.
 * @example
 * export const requireUser = () => { if (!signedIn()) throw redirect("/login", { status: 303 }); };
 * @example
 * export const toPost = () => redirect({ to: "/posts/:id", params: { id: "7" }, search: { tab: "edit" }, status: 308 });
 * @since 1.0.0
 */
export function redirect(to: string, options?: RedirectOptions): RedirectSignal;
export function redirect<P extends string>(
  target: RedirectTarget<P> & { readonly status?: RedirectStatus },
): RedirectSignal;
export function redirect(
  to: string | (RedirectTarget & { readonly status?: RedirectStatus }),
  options: RedirectOptions = {},
): RedirectSignal {
  const status = (typeof to === "string" ? options.status : to.status) ?? 302;
  if (!STATUSES.has(status)) {
    throw new RangeError(`redirect(): status must be 301, 302, 303, 307 or 308, got ${status}.`);
  }
  const signal =
    typeof to === "string"
      ? routerRedirect(to, options.replace === undefined ? {} : { replace: options.replace })
      : routerRedirect(to as RedirectTarget);
  statuses.set(signal, status);
  return signal;
}

/**
 * The HTTP status of a redirect signal: the one given to {@link redirect}, or 302 for a signal
 * made by the router's own `redirect()`.
 *
 * @param signal A redirect signal.
 * @returns The status.
 * @example
 * redirectStatus(redirect("/a", { status: 308 })); // 308
 * @since 1.0.0
 */
export function redirectStatus(signal: RedirectSignal): RedirectStatus {
  return statuses.get(signal) ?? 302;
}

export { isNotFound, isRedirect, notFound, type RedirectSignal };
