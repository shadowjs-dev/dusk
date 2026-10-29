import { OidcError } from "./errors";

/** How the client talks to the identity provider. @internal */
export interface FetchPolicy {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** True in development: `http://localhost` and `http://127.0.0.1` are allowed. */
  readonly allowLoopbackHttp: boolean;
  /** The request's own signal; the call ends when it aborts. */
  readonly signal: AbortSignal | undefined;
}

/** What came back, with the body read under the size cap. @internal */
export interface BoundedResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string;
  readonly text: string;
}

/**
 * Waits for a promise other callers share without tying it to this caller: when `signal` aborts, only this wait ends (with
 * the signal's reason), the shared work goes on for the others.
 * @internal
 */
export function waitFor<T>(shared: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return shared;
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    shared.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error);
      },
    );
  });
}

/** True for a host name that only this machine can reach. @internal */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * Parses an endpoint of the identity provider and refuses what must not be called: anything but `https:` (an `http:` URL
 * only for a loopback host, and only when `allowLoopbackHttp` is on), user info in the URL, a fragment.
 * @internal
 */
export function checkEndpointUrl(value: string, what: string, allowLoopbackHttp: boolean): URL {
  if (!URL.canParse(value)) throw new OidcError("OIDC_INSECURE_URL", `${what} is not a URL.`);
  const url = new URL(value);
  const plain = url.protocol === "http:" && allowLoopbackHttp && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !plain) {
    throw new OidcError(
      "OIDC_INSECURE_URL",
      `${what} must use https (http is allowed only for localhost in development).`,
    );
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new OidcError("OIDC_INSECURE_URL", `${what} must not carry user info or a fragment.`);
  }
  return url;
}

/**
 * One call to the identity provider with every bound applied: a timeout (an `AbortController`, also stopped by the
 * request's own signal), no redirects (an endpoint that redirects is refused, so a compromised endpoint cannot bounce the
 * server to an internal address), no credentials or cookies, and a cap on the body that is enforced while it streams.
 * @internal
 */
export async function fetchBounded(
  policy: FetchPolicy,
  url: URL,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  },
): Promise<BoundedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  const signal =
    policy.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, policy.signal]);
  try {
    const response = await policy.fetch(url.href, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > policy.maxBytes) {
      await response.body?.cancel();
      throw tooLarge(policy.maxBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > policy.maxBytes) {
          await reader.cancel();
          throw tooLarge(policy.maxBytes);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? "",
      text: new TextDecoder().decode(bytes),
    };
  } catch (error) {
    if (error instanceof OidcError) throw error;
    if (controller.signal.aborted) {
      throw new OidcError("OIDC_TIMEOUT", `${url.origin}${url.pathname} did not answer in time.`, {
        cause: error,
      });
    }
    if (policy.signal?.aborted === true) throw policy.signal.reason;
    throw new OidcError(
      "OIDC_UPSTREAM_ERROR",
      `${url.origin}${url.pathname} could not be reached.`,
      {
        cause: error,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(limit: number): OidcError {
  return new OidcError(
    "OIDC_RESPONSE_TOO_LARGE",
    `The identity provider sent more than ${limit} bytes.`,
  );
}

/** The JSON object in `text`, or `undefined` when it is not valid JSON or not an object. @internal */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
