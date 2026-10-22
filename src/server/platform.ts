import { tryGetRequestEvent } from "./context";
import type { AssetDecision, Handler } from "./types";

/**
 * Glue between a platform's request arguments and the handler's `fetch(request, platform)`. Every
 * adapter entry goes through here, so the rules are the same on every platform: environment
 * bindings are the enumerable keys of the host object, the client address and `waitUntil` are
 * not enumerable (so they never become environment variables).
 *
 * @packageDocumentation
 */

/** What a platform adds to a request. @since 1.0.0 */
export interface PlatformInit {
  /** The client address the platform reports (already trusted by the platform, never by the client). */
  readonly clientAddress?: string | undefined;
  /** Keeps background work alive after the response (Workers `ctx.waitUntil`, Vercel, Netlify). */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
  /** Where the visitor is, as the platform reported it (see `event.geo`). */
  readonly geo?: GeoInfo | undefined;
}

/** The platforms whose geo the adapter entries read (see {@link geoOf}). @since 1.0.0 */
export type GeoPlatform = "cloudflare" | "vercel" | "netlify";

/**
 * Where the visitor is, as the platform reports it. A field is `undefined` when the platform sent no value for it.
 * Read only by an adapter entry for that platform (see {@link CreateFetchOptions.geo}); a client's own headers are
 * never a source. @since 1.0.0
 */
export interface GeoInfo {
  readonly country: string | undefined;
  readonly region: string | undefined;
  readonly city: string | undefined;
  readonly latitude: number | undefined;
  readonly longitude: number | undefined;
  readonly timezone: string | undefined;
}

const NO_GEO: GeoInfo = Object.freeze({
  country: undefined,
  region: undefined,
  city: undefined,
  latitude: undefined,
  longitude: undefined,
  timezone: undefined,
});

/** The key under which the host object carries the geo. A symbol, so no environment binding can collide with it. */
const GEO_KEY: unique symbol = Symbol("dusk.geo");

/** A non-empty text value, or undefined. */
function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A finite number from text or a number, or undefined. */
function numberOf(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return value === "" || !Number.isFinite(parsed) ? undefined : parsed;
}

/** A header value percent-decoded, or the raw text when it is not valid encoding (Vercel encodes the city). */
function decodedText(text: string | null): string | undefined {
  if (text === null || text === "") return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The geo a platform reported for a request. Cloudflare reads `request.cf`; Vercel reads its `x-vercel-ip-*` headers
 * (the city percent-encoded); Netlify reads the `x-nf-geo` JSON. Anything missing or malformed is `undefined`.
 *
 * @param request The request as the platform passed it.
 * @param platform The platform whose entry is running.
 * @returns The geo, every field `undefined` when absent.
 * @example
 * geoOf(request, "vercel").country; // "FR" when the x-vercel-ip-country header says so
 * @since 1.0.0
 */
export function geoOf(request: Request, platform: GeoPlatform): GeoInfo {
  if (platform === "cloudflare") {
    const cf: unknown = Reflect.get(request, "cf");
    if (typeof cf !== "object" || cf === null) return NO_GEO;
    return {
      country: textOf(Reflect.get(cf, "country")),
      region: textOf(Reflect.get(cf, "region")),
      city: textOf(Reflect.get(cf, "city")),
      latitude: numberOf(Reflect.get(cf, "latitude")),
      longitude: numberOf(Reflect.get(cf, "longitude")),
      timezone: textOf(Reflect.get(cf, "timezone")),
    };
  }
  if (platform === "vercel") {
    const headers = request.headers;
    return {
      country: textOf(headers.get("x-vercel-ip-country")),
      region: textOf(headers.get("x-vercel-ip-country-region")),
      city: decodedText(headers.get("x-vercel-ip-city")),
      latitude: numberOf(headers.get("x-vercel-ip-latitude") ?? undefined),
      longitude: numberOf(headers.get("x-vercel-ip-longitude") ?? undefined),
      timezone: textOf(headers.get("x-vercel-ip-timezone")),
    };
  }
  const raw = request.headers.get("x-nf-geo");
  if (raw === null) return NO_GEO;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_GEO;
  }
  if (typeof parsed !== "object" || parsed === null) return NO_GEO;
  const country: unknown = Reflect.get(parsed, "country");
  const subdivision: unknown = Reflect.get(parsed, "subdivision");
  return {
    country: textOf(
      typeof country === "object" && country !== null ? Reflect.get(country, "code") : undefined,
    ),
    region: textOf(
      typeof subdivision === "object" && subdivision !== null
        ? Reflect.get(subdivision, "code")
        : undefined,
    ),
    city: textOf(Reflect.get(parsed, "city")),
    latitude: numberOf(Reflect.get(parsed, "latitude")),
    longitude: numberOf(Reflect.get(parsed, "longitude")),
    timezone: textOf(Reflect.get(parsed, "timezone")),
  };
}

/** The geo a host object carries; every field `undefined` for a host the adapter did not give one. @internal */
export function hostGeoOf(platform: unknown): GeoInfo {
  if (typeof platform !== "object" || platform === null) return NO_GEO;
  const geo: unknown = Reflect.get(platform, GEO_KEY);
  return typeof geo === "object" && geo !== null ? (geo as GeoInfo) : NO_GEO;
}

/** The execution context of a Workers-style `fetch(request, env, ctx)`. @since 1.0.0 */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** The module shape a platform expects: a Web `fetch`. @since 1.0.0 */
export interface FetchModule {
  fetch(request: Request, env?: unknown, ctx?: WaitUntilContext): Promise<Response>;
  /**
   * Present when the handler runs its middleware for files (`runMiddlewareForStaticFiles`): decides a file request the
   * same way the handler's `gateAsset` does, with the platform the `fetch` of this module would pass.
   */
  gateAsset?(request: Request, env?: unknown, ctx?: WaitUntilContext): Promise<AssetDecision>;
}

/** Options of {@link createFetch}. @since 1.0.0 */
export interface CreateFetchOptions {
  /**
   * Header the platform sets to the real client address and overwrites on the way in (for example
   * `cf-connecting-ip` on Cloudflare). Read as the peer address, so trusted proxy settings are not
   * needed for it. Omit it when the platform does not give the address.
   */
  readonly clientAddressHeader?: string;
  /**
   * The platform this entry runs on. Its geo source (Cloudflare `request.cf`, Vercel's `x-vercel-ip-*` headers, Netlify's
   * `x-nf-geo`) becomes `event.geo`. Omit it and `event.geo` is empty: a client's own headers are never read.
   */
  readonly geo?: GeoPlatform;
}

/**
 * Builds the host object passed to `handler.fetch`. The environment bindings are copied as own
 * enumerable properties (the handler reads only strings from them); the platform hooks are
 * non-enumerable.
 *
 * @param env The bindings or environment object of the platform, or `undefined`.
 * @param init The platform's client address and `waitUntil`.
 * @returns The host object.
 * @example
 * handler.fetch(request, platformHost(env, { waitUntil: (p) => ctx.waitUntil(p) }));
 * @since 1.0.0
 */
export function platformHost(env: unknown, init: PlatformInit = {}): Record<string, unknown> {
  const host: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (typeof env === "object" && env !== null) {
    for (const key of Object.keys(env)) host[key] = Reflect.get(env, key);
  }
  if (init.clientAddress !== undefined) {
    Object.defineProperty(host, "clientAddress", { value: init.clientAddress, enumerable: false });
  }
  if (init.waitUntil !== undefined) {
    Object.defineProperty(host, "waitUntil", { value: init.waitUntil, enumerable: false });
  }
  if (init.geo !== undefined) {
    Object.defineProperty(host, GEO_KEY, { value: init.geo, enumerable: false });
  }
  return host;
}

/**
 * Keeps `promise` running after the response is sent. On a platform with `ctx.waitUntil` the
 * request's platform hook is used; elsewhere the work simply continues in the process, and a
 * failure is logged (it is never dropped).
 *
 * @param promise The background work.
 * @example
 * export async function POST(event) { waitUntil(sendAuditLog(event)); return new Response(null, { status: 202 }); }
 * @since 1.0.0
 */
export function waitUntil(promise: Promise<unknown>): void {
  const host: unknown = tryGetRequestEvent()?.platform;
  const hook: unknown =
    typeof host === "object" && host !== null ? Reflect.get(host, "waitUntil") : undefined;
  if (typeof hook === "function") {
    Reflect.apply(hook, host, [promise]);
    return;
  }
  promise.catch((error: unknown) => {
    console.error("[dusk] background work failed", error);
  });
}

/**
 * Wraps a handler as the `{ fetch(request, env, ctx) }` module that Workers, Vercel and Netlify
 * expect. The result is what a generated entry exports as its default.
 *
 * @param handler The handler from the server bundle.
 * @param options See {@link CreateFetchOptions}.
 * @returns The module.
 * @example
 * export default createFetch(handler, { clientAddressHeader: "cf-connecting-ip" });
 * @since 1.0.0
 */
export function createFetch(handler: Handler, options: CreateFetchOptions = {}): FetchModule {
  const header = options.clientAddressHeader;
  const geoSource = options.geo;
  /** The platform the handler gets for one request: the client address, the geo and the context hook. */
  const platformFor = (
    request: Request,
    env: unknown,
    ctx: WaitUntilContext | undefined,
  ): unknown => {
    const clientAddress =
      header === undefined ? undefined : (request.headers.get(header) ?? undefined);
    const geo = geoSource === undefined ? undefined : geoOf(request, geoSource);
    // The context is whatever the platform passed: a Workers context, a Vercel or Netlify context
    // (which may have no waitUntil). Only a function is used.
    const hook: unknown =
      typeof ctx === "object" && ctx !== null ? Reflect.get(ctx, "waitUntil") : undefined;
    return platformHost(env, {
      clientAddress,
      geo,
      waitUntil:
        typeof hook === "function" ? (promise) => Reflect.apply(hook, ctx, [promise]) : undefined,
    });
  };
  const gate = handler.gateAsset;
  return {
    fetch(request, env, ctx) {
      return handler.fetch(request, platformFor(request, env, ctx));
    },
    ...(gate === undefined
      ? {}
      : {
          gateAsset(request: Request, env?: unknown, ctx?: WaitUntilContext) {
            return gate(request, platformFor(request, env, ctx));
          },
        }),
  };
}

/**
 * The environment of a runtime that has no `process.env` of its own (Deno-based edge runtimes):
 * `Deno.env` when it exists, else `process.env`, else `undefined`. Edge entries pass it as the
 * environment of the request; it is read here, in the bundle, so the entry needs no import.
 *
 * @returns The environment as strings, or `undefined`.
 * @example
 * export default createFetch(handler); // with platformHost(runtimeEnvironment(), ...) in edge code
 * @since 1.0.0
 */
export function runtimeEnvironment(): Record<string, string> | undefined {
  const deno: unknown = Reflect.get(globalThis, "Deno");
  const denoEnv: unknown =
    typeof deno === "object" && deno !== null ? Reflect.get(deno, "env") : undefined;
  const toObject: unknown =
    typeof denoEnv === "object" && denoEnv !== null ? Reflect.get(denoEnv, "toObject") : undefined;
  if (typeof toObject === "function") {
    const value: unknown = Reflect.apply(toObject, denoEnv, []);
    if (typeof value === "object" && value !== null)
      return { ...(value as Record<string, string>) };
  }
  const host: unknown = Reflect.get(globalThis, "process");
  const env: unknown =
    typeof host === "object" && host !== null ? Reflect.get(host, "env") : undefined;
  if (typeof env === "object" && env !== null) {
    const copy: Record<string, string> = {};
    for (const key of Object.keys(env)) {
      const value: unknown = Reflect.get(env, key);
      if (typeof value === "string") copy[key] = value;
    }
    return copy;
  }
  return undefined;
}
