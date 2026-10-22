import { tryGetRequestEvent } from "../internal/request-context";
import type { CookieOptions } from "../server/cookies";
import type { RequestEvent } from "../server/types";

/**
 * `useResponse()`: the response of the request being answered, set from anywhere the request reaches (a
 * component during render, a loader, a middleware). It is one module for both sides of the wire: on the
 * server the calls write to the request's response; on the client, and outside a request, they do nothing.
 *
 * The status and the headers of a page are decided before its first byte. A component that streams in later
 * (a Suspense boundary after the shell) cannot change them: the call is ignored, and a development build says so.
 */

/** The status a request asked for, and whether its answer has started. @internal */
export interface ResponseControl {
  status: number | undefined;
  committed: boolean;
}

/** The response calls. Every method is a no-op outside a request; invalid arguments throw everywhere. @since 1.0.0 */
export interface ResponseHandle {
  /** True while a request is answered on the server. False on the client and outside a request. */
  readonly inRequest: boolean;
  /**
   * Sets the status of the page (200 to 599). A status set by a failing loader or an error boundary takes
   * precedence over the value set here when it is not 200.
   * @throws RangeError for a value that is not an integer from 200 to 599.
   */
  setStatus(status: number): void;
  /**
   * Sets a response header, replacing any value it had. Refused: `set-cookie` (use `setCookie`), `location`
   * (use `redirect()`), `content-length` and `transfer-encoding` (the framework owns them).
   * @throws TypeError for an invalid name or value, or a refused name.
   */
  setHeader(name: string, value: string): void;
  /** Adds a response header value after the ones it has. The same refusals as {@link ResponseHandle.setHeader}. */
  appendHeader(name: string, value: string): void;
  /** Sets a cookie on the response. `options` are the cookie attributes (`path`, `maxAge`, `httpOnly`, ...). */
  setCookie(name: string, value: string, options?: CookieOptions): void;
  /** Expires a cookie on the response. */
  deleteCookie(name: string, options?: CookieOptions): void;
}

const controls = new WeakMap<RequestEvent, ResponseControl>();

/** The response control of a request, created on first use. @internal */
export function responseControlOf(event: RequestEvent): ResponseControl {
  const existing = controls.get(event);
  if (existing !== undefined) return existing;
  const created: ResponseControl = { status: undefined, committed: false };
  controls.set(event, created);
  return created;
}

/**
 * Marks the answer as started: from here on the response calls are ignored. Called once, when the first byte
 * (the shell) of the body is ready, or just before the response is built for a whole-page render. @internal
 */
export function commitResponse(event: RequestEvent): void {
  responseControlOf(event).committed = true;
}

/**
 * The status a page answers with: a computed status other than 200 (a failure, an error boundary) stands;
 * otherwise the status a component or loader set. @internal
 */
export function responseStatus(event: RequestEvent, computed: number): number {
  if (computed !== 200) return computed;
  return responseControlOf(event).status ?? 200;
}

/** Header names the response calls refuse, with the call that does the job instead. */
const REFUSED: ReadonlyMap<string, string> = new Map([
  ["set-cookie", "use setCookie()"],
  ["location", "use redirect()"],
  ["content-length", "the framework sets it"],
  ["transfer-encoding", "the framework sets it"],
]);

function checkHeader(name: string, value: string): string {
  // `Headers` rejects an invalid name or value (TypeError) before anything is written.
  const probe = new Headers([[name, value]]);
  const key = probe.keys().next().value ?? name.toLowerCase();
  const reason = REFUSED.get(key);
  if (reason !== undefined) {
    throw new TypeError(`useResponse: the header "${key}" cannot be set here; ${reason}.`);
  }
  return key;
}

function checkStatus(status: number): void {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(
      `useResponse: setStatus takes an integer from 200 to 599, not ${String(status)}.`,
    );
  }
}

function late(what: string): void {
  if (__DEV__) {
    console.warn(
      `useResponse: ${what} after the first byte of the response was sent is ignored. Set it from a loader, a middleware or the first render.`,
    );
  }
}

/**
 * The response calls of the current request.
 *
 * @returns The calls. On the client, or outside a request, every call does nothing (invalid arguments still throw).
 * @example
 * export function Page() {
 *   useResponse().setHeader("cache-control", "private, no-store");
 *   return <p>private</p>;
 * }
 * @since 1.0.0
 */
export function useResponse(): ResponseHandle {
  const event = tryGetRequestEvent();
  if (event === undefined) return detached;
  const control = responseControlOf(event);
  return {
    inRequest: true,
    setStatus(status) {
      checkStatus(status);
      if (control.committed) return late("setStatus");
      control.status = status;
    },
    setHeader(name, value) {
      const key = checkHeader(name, value);
      if (control.committed) return late("setHeader");
      event.responseHeaders.set(key, value);
    },
    appendHeader(name, value) {
      const key = checkHeader(name, value);
      if (control.committed) return late("appendHeader");
      event.responseHeaders.append(key, value);
    },
    setCookie(name, value, options) {
      if (control.committed) return late("setCookie");
      event.cookies.set(name, value, options);
    },
    deleteCookie(name, options) {
      if (control.committed) return late("deleteCookie");
      event.cookies.delete(name, options);
    },
  };
}

/** The handle of a call made outside a request: every write is dropped, every argument is still checked. */
const detached: ResponseHandle = {
  inRequest: false,
  setStatus(status) {
    checkStatus(status);
  },
  setHeader(name, value) {
    checkHeader(name, value);
  },
  appendHeader(name, value) {
    checkHeader(name, value);
  },
  setCookie() {
    return;
  },
  deleteCookie() {
    return;
  },
};
