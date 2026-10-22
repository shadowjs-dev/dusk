import { createCookieSigner } from "../server/cookies";
import { EventState } from "../server/event";
import type { RequestEvent } from "../server/types";
import { buildRequest } from "./request";

/** Options of {@link createTestEvent}. @since 1.0.0 */
export interface TestEventOptions {
  /** Absolute URL of the request. Default `"http://localhost/"`. */
  readonly url?: string;
  readonly method?: string;
  readonly headers?: HeadersInit;
  readonly body?: BodyInit | null;
  /** Cookies to send, name to value. */
  readonly cookies?: Readonly<Record<string, string>>;
  /** Secrets for signed cookies (32+ characters each). */
  readonly cookieSecrets?: readonly string[];
  /** Validated environment. */
  readonly env?: Readonly<Record<string, unknown>>;
  /** Development mode. Default `true`. */
  readonly dev?: boolean;
  readonly signal?: AbortSignal;
  readonly clientAddress?: string;
  readonly nonce?: string;
}

/**
 * Builds a request event for unit tests of middleware, API handlers and server functions that run
 * without the handler.
 *
 * @param options Request line, headers and context.
 * @returns A fresh event.
 * @example
 * const event = createTestEvent({ url: "http://localhost/api/x", cookies: { sid: "abc" } });
 * await myServerFn.invoke({ title: "t" }, event);
 * @since 1.0.0
 */
export function createTestEvent(options: TestEventOptions = {}): RequestEvent {
  const url = new URL(options.url ?? "http://localhost/");
  const headers = new Headers(options.headers);
  if (options.cookies !== undefined) {
    headers.set(
      "cookie",
      Object.entries(options.cookies)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    );
  }
  const method = (options.method ?? "GET").toUpperCase();
  const request = buildRequest(
    url,
    {
      method,
      ...(options.body === undefined || method === "GET" || method === "HEAD"
        ? {}
        : { body: options.body }),
    },
    headers,
  );
  return new EventState({
    request,
    url,
    signal: options.signal ?? new AbortController().signal,
    id: crypto.randomUUID(),
    nonce: options.nonce,
    signer:
      options.cookieSecrets === undefined ? undefined : createCookieSigner(options.cookieSecrets),
    secureCookies: url.protocol === "https:",
    env: options.env ?? {},
    platform: undefined,
    clientAddress: options.clientAddress,
    dev: options.dev ?? true,
    lang: "en",
  });
}
