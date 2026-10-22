import { isRefusedImageAddress, isRefusedImageHost } from "./image-hosts";

/**
 * A `fetch` for the image optimizer that refuses private addresses at the connect step (Node only).
 *
 * The route checks the host it is asked for, but a public name can resolve to a loopback, private, link-local or
 * metadata address (DNS rebinding, or simply an attacker-owned name pointing inside the network). Checking the name
 * before `fetch` and letting `fetch` resolve it again leaves a gap between the two lookups. Here the resolver result is
 * checked by the same call that picks the address the socket connects to, so what is checked is what is connected.
 *
 * ```ts
 * createHandler({ manifest, features: [pages(), images()], images: { processor: sharpProcessor(), remotePatterns: ["https://cdn.example"], fetch: safeImageFetch() } });
 * ```
 *
 * It never follows a redirect (the route refuses a 3xx anyway) and needs the Node built-ins, which are loaded on first
 * use through a specifier the bundler does not see, so importing this module costs nothing on a runtime without them.
 */

/** One resolved address. @since 1.0.0 */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Options of {@link safeImageFetch}. @since 1.0.0 */
export interface SafeImageFetchOptions {
  /** Resolves a name to all of its addresses. Default: the system resolver (`dns.lookup` with `all`). */
  readonly lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  /**
   * Decides whether an address is refused. Default: loopback, private, link-local, CGNAT, reserved and unique-local
   * ranges (`isRefusedImageAddress`). Replaced only by tests that must reach a server on loopback.
   * @internal
   */
  readonly refuse?: (address: string) => boolean;
}

const HTTP_MODULE = "node:http";
const HTTPS_MODULE = "node:https";
const DNS_MODULE = "node:dns";
const STREAM_MODULE = "node:stream";

/** Statuses a `Response` cannot carry a body with. */
const NO_BODY = new Set([101, 204, 205, 304]);

type LookupCallback = (
  error: Error | null,
  address?: string | readonly ResolvedAddress[],
  family?: number,
) => void;

interface LookupOptions {
  readonly all?: boolean;
}

/**
 * Loads a Node built-in by a specifier the bundler and Vite cannot analyze. It is the only dynamic import in this file,
 * so its `@vite-ignore` annotation sits on a plain identifier, where a bundler keeps it (on a conditional it is dropped).
 */
function loadBuiltin<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier);
}

/** The URL a `fetch` input names. */
function urlOf(input: string | URL | Request): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/** An error from an abort signal's reason (a reason need not be an Error). */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The request was aborted.");
}

/**
 * Creates a `fetch` that only connects to addresses `refuse` allows.
 *
 * @param options The resolver and the predicate (both default to the system's).
 * @returns A `fetch` for `images.fetch`.
 * @throws TypeError (from the returned function) for a URL that is not http(s), has credentials, or names a refused host.
 * @throws Error (from the returned function) when the name resolves to no address, or to any refused one.
 * @since 1.0.0
 */
export function safeImageFetch(options: SafeImageFetchOptions = {}): typeof fetch {
  const refuse = options.refuse ?? isRefusedImageAddress;
  return async (input, init): Promise<Response> => {
    const url = urlOf(input as string | URL | Request);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("safeImageFetch: only http and https URLs are fetched.");
    }
    if (url.username !== "" || url.password !== "") {
      throw new TypeError("safeImageFetch: a URL with credentials is not fetched.");
    }
    // A literal address skips the resolver (the socket connects to it as written), so it is judged here.
    if (options.refuse === undefined && isRefusedImageHost(url.hostname)) {
      throw new TypeError("safeImageFetch: the image host is refused.");
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw abortError(signal);
    const dns: typeof import("node:dns") = await loadBuiltin(DNS_MODULE);
    const stream: typeof import("node:stream") = await loadBuiltin(STREAM_MODULE);
    const transport: typeof import("node:http") | typeof import("node:https") = await loadBuiltin(
      url.protocol === "https:" ? HTTPS_MODULE : HTTP_MODULE,
    );
    const resolve =
      options.lookup ??
      (async (hostname: string): Promise<readonly ResolvedAddress[]> =>
        dns.promises.lookup(hostname, { all: true }));
    // `lookup` is what `net.connect` calls to pick the address, so a refused answer stops the connect itself.
    const guardedLookup = (
      hostname: string,
      lookupOptions: LookupOptions,
      done: LookupCallback,
    ) => {
      resolve(hostname).then(
        (addresses) => {
          if (addresses.length === 0) {
            done(new Error("safeImageFetch: the host did not resolve to an address."));
            return;
          }
          if (addresses.some((entry) => refuse(entry.address))) {
            done(new Error("safeImageFetch: the host resolves to an address that is not allowed."));
            return;
          }
          const first = addresses[0];
          if (lookupOptions.all === true || first === undefined) done(null, addresses);
          else done(null, first.address, first.family);
        },
        (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
      );
    };
    return new Promise<Response>((resolveResponse, reject) => {
      // The module loads above are asynchronous: a signal can have fired while they ran.
      if (signal?.aborted === true) {
        reject(abortError(signal));
        return;
      }
      const request = transport.request(
        url,
        {
          method: "GET",
          headers: { accept: "image/*", "accept-encoding": "identity" },
          lookup: guardedLookup as never,
          agent: false,
        },
        (res) => {
          // The signal keeps covering the body (the route's timeout ends a stalled download); it is released when the
          // response is over.
          res.once("close", () => signal?.removeEventListener("abort", onAbort));
          const headers = new Headers();
          for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) {
            const name = res.rawHeaders[index];
            const value = res.rawHeaders[index + 1];
            if (name === undefined || value === undefined) continue;
            try {
              headers.append(name, value);
            } catch (error) {
              // A header the Fetch API refuses is dropped; the answer is judged on the ones it keeps.
              if (!(error instanceof TypeError)) throw error;
            }
          }
          const status = res.statusCode ?? 502;
          if (NO_BODY.has(status)) {
            res.resume();
            resolveResponse(new Response(null, { status, headers }));
            return;
          }
          const body = stream.Readable.toWeb(res) as ReadableStream<Uint8Array>;
          resolveResponse(new Response(body, { status, headers }));
        },
      );
      const onAbort = (): void => {
        if (signal !== undefined) request.destroy(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      request.end();
    });
  };
}
