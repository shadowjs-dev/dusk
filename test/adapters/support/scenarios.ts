import { serialize } from "@shadow-js/web/server";

/**
 * The scenario list every adapter runs. A scenario is a request and the status the baseline (the
 * built handler, called in-process) must answer; every target must then answer with the same status,
 * the same selected headers and the same body. `accept-encoding: identity` keeps compression out of
 * the comparison (it has its own test per runtime).
 */

/** A request a scenario sends. `path` is relative to the target's origin. */
export interface ScenarioRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** One conformance scenario. */
export interface Scenario extends ScenarioRequest {
  readonly id: string;
  /** What the baseline answers; a sanity check that the scenario tests what it says. */
  readonly status: number;
  /** A substring the body must contain, if any. */
  readonly contains?: string;
  /**
   * A file of the client build. Served by the runtime, not the handler: only targets that serve
   * static files are compared on it (the baseline is the file itself).
   */
  readonly staticFile?: string;
  /**
   * A prerendered page (`about/index.html` in the client build). A target that serves static files answers the file's
   * own bytes with the static cache policy (not the handler's headers); the others are compared like any page.
   */
  readonly prerendered?: boolean;
}

/** The answer of one request, reduced to what is compared. */
export interface Normalized {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | null>>;
  readonly body: string;
}

/** Headers compared between targets. Request ids and dates differ per request; they are left out. */
export const COMPARED_HEADERS: readonly string[] = [
  "content-type",
  "location",
  "allow",
  "cache-control",
  "etag",
  "set-cookie",
  "x-content-type-options",
];

const IDENTITY = { "accept-encoding": "identity" } as const;
/** Same-origin state-changing request headers (CSRF accepts `Sec-Fetch-Site: same-origin`). */
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;

/** The scenarios; `shoutId` is the id of the server function of the fixture. */
export function scenariosFor(shoutId: string): readonly Scenario[] {
  return [
    {
      id: "ssr-page",
      method: "GET",
      path: "/",
      status: 200,
      contains: "Home page",
      headers: IDENTITY,
    },
    {
      id: "ssr-params",
      method: "GET",
      path: "/posts/42",
      status: 200,
      contains: "42",
      headers: IDENTITY,
    },
    {
      id: "streaming-suspense",
      method: "GET",
      path: "/posts/1",
      status: 200,
      contains: "streamed late value",
      headers: IDENTITY,
    },
    {
      id: "prerendered-page",
      method: "GET",
      path: "/about",
      status: 200,
      contains: "about us",
      headers: IDENTITY,
      prerendered: true,
    },
    {
      id: "api-get",
      method: "GET",
      path: "/api/echo",
      status: 200,
      contains: '"ok":true',
      headers: IDENTITY,
    },
    {
      id: "api-post",
      method: "POST",
      path: "/api/echo",
      status: 200,
      body: "hello",
      headers: { ...IDENTITY, ...SAME_ORIGIN, "content-type": "text/plain" },
    },
    {
      id: "cookies",
      method: "GET",
      path: "/api/cookie",
      status: 200,
      contains: "cookie set",
      headers: IDENTITY,
    },
    { id: "redirect", method: "GET", path: "/api/old", status: 301, headers: IDENTITY },
    { id: "not-found", method: "GET", path: "/no/such/page", status: 404, headers: IDENTITY },
    {
      id: "static-asset",
      method: "GET",
      path: "/robots.txt",
      status: 200,
      staticFile: "robots.txt",
      headers: IDENTITY,
    },
    { id: "head", method: "HEAD", path: "/", status: 200, headers: IDENTITY },
    { id: "options", method: "OPTIONS", path: "/posts/1", status: 204, headers: IDENTITY },
    {
      id: "server-function",
      method: "POST",
      path: `/_dusk/fn/${shoutId}`,
      status: 200,
      body: serialize(["hello"]),
      headers: {
        "content-type": "application/json",
        "x-dusk-fn": "1",
        ...SAME_ORIGIN,
        ...IDENTITY,
      },
      contains: "HELLO",
    },
    {
      id: "large-body",
      method: "POST",
      path: "/api/echo",
      status: 413,
      body: "x".repeat(2 * 1024 * 1024),
      headers: { "content-type": "text/plain", ...SAME_ORIGIN, ...IDENTITY },
    },
  ];
}

/** Request ids (UUIDs) differ on every request; the body keeps their place as a marker. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Turns a response into the compared shape. Cookies keep their attributes; order is kept. */
export async function normalize(response: Response): Promise<Normalized> {
  const headers: Record<string, string | null> = {};
  for (const name of COMPARED_HEADERS) {
    if (name === "set-cookie") {
      const cookies = response.headers.getSetCookie();
      headers[name] = cookies.length === 0 ? null : cookies.join(" | ");
    } else {
      headers[name] = response.headers.get(name);
    }
  }
  const body = response.body === null ? "" : (await response.text()).replace(UUID, "<uuid>");
  return { status: response.status, headers, body };
}

/** Lists the differences between two normalized answers, for a failure message. */
export function differences(expected: Normalized, actual: Normalized): string[] {
  const out: string[] = [];
  if (expected.status !== actual.status) out.push(`status ${expected.status} != ${actual.status}`);
  for (const name of COMPARED_HEADERS) {
    if (expected.headers[name] !== actual.headers[name]) {
      out.push(
        `${name}: ${JSON.stringify(expected.headers[name])} != ${JSON.stringify(actual.headers[name])}`,
      );
    }
  }
  if (expected.body !== actual.body) {
    out.push(`body differs (${expected.body.length} vs ${actual.body.length} characters)`);
  }
  return out;
}
