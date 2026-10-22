import type { RouteVisibility } from "@shadow-js/router/core";
import { DuskError } from "./context";
import { type CookieSigner, createCookieJar, createCookieSigner } from "./cookies";
import { type BodyCap, DEFAULT_FORM_LIMITS, DEFAULT_LIMITS, readBodyBytes } from "./limits";
import type { Observation } from "./observe";
import type { EventTiming } from "./observe-types";
import type { GeoInfo } from "./platform";
import type { ContextKey, DocumentAttributes, DuskLocals, RequestEvent, RouteInfo } from "./types";

/** Everything needed to build the event of one request. @internal */
export interface EventInit {
  readonly request: Request;
  readonly url: URL;
  readonly signal: AbortSignal;
  readonly id: string;
  readonly nonce: string | undefined;
  readonly signer: CookieSigner | undefined;
  readonly secureCookies: boolean;
  readonly env: Readonly<Record<string, unknown>>;
  readonly platform: unknown;
  readonly clientAddress: string | undefined;
  readonly dev: boolean;
  readonly lang: string;
  /** The body limit and form caps of the request (see `boundRequest`). Built by hand, a body has the default limit. */
  readonly bodyCap?: BodyCap;
  /** The app's mount path (`""` at the root, `/app` under a base). Default `""`. */
  readonly base?: string;
  /** The app's `trailingSlash` policy. Default `preserve`. */
  readonly trailingSlash?: "never" | "always" | "preserve";
  /** The platform's geo (see `GeoInfo`). Default: every field undefined. */
  readonly geo?: GeoInfo;
}

/** `event.timing` while nothing is observed: runs the function, records nothing. */
const NO_TIMING: EventTiming = { measure: (_name, fn) => fn(), add: () => undefined };

const NO_ROUTE: RouteInfo = Object.freeze({
  kind: "none",
  id: undefined,
  params: Object.freeze({}),
});

/**
 * The request event. The framework creates one per request and sets the route once it is known.
 * @internal
 */
export class EventState implements RequestEvent {
  /** Replaced by a rewrite (see `rewrite()`), which gives the target the headers the middleware set. */
  request: Request;
  /** Changed by a rewrite (`rewrites` of the config, or `rewrite()` in middleware). */
  url: URL;
  /** Set once a rewrite has moved this request; the middleware chain does not run again after it. */
  rewritten = false;
  /**
   * Set once a rewrite (`rewrite()` in middleware, or a `rewrites` rule of the config) has moved this request. Only
   * then may the route answer be a private route (a `_`-prefixed path); a request from outside never is.
   */
  internalAccess = false;
  /** Set only while the navigation gate runs a target's chain (see `isNavigationCheck`). */
  #navigationCheck = false;

  /** True while the navigation gate runs the chain of a client navigation's target. */
  get isNavigationCheck(): boolean {
    return this.#navigationCheck;
  }

  /**
   * Runs `fn` as the navigation check of `target`: `url` is the target and `isNavigationCheck` is true
   * while it runs. Both are restored in `finally`, so the request that follows (none, for the gate) sees
   * its own URL again.
   *
   * @internal
   */
  async asNavigationCheck<T>(target: URL, fn: () => Promise<T>): Promise<T> {
    const previousUrl = this.url;
    const previousFlag = this.#navigationCheck;
    this.url = target;
    this.#navigationCheck = true;
    try {
      return await fn();
    } finally {
      this.url = previousUrl;
      this.#navigationCheck = previousFlag;
    }
  }
  readonly signal: AbortSignal;
  readonly id: string;
  readonly nonce: string | undefined;
  readonly cookies: RequestEvent["cookies"];
  readonly responseHeaders: Headers = new Headers();
  /** Request-scoped values (see {@link DuskLocals}). A null-prototype object: keys are set by middleware. */
  readonly locals: DuskLocals = Object.create(null) as DuskLocals;
  /** Set once per request, after the environment is validated. */
  env: Readonly<Record<string, unknown>>;
  readonly platform: unknown;
  readonly clientAddress: string | undefined;
  readonly dev: boolean;
  /** The app's mount path (`""` at the root). Relative URLs of metadata routes resolve against it. */
  readonly base: string;
  /** The app's `trailingSlash` policy (see `RequestEvent`). */
  readonly trailingSlash: "never" | "always" | "preserve";
  /** Where the visitor is, as the platform reported it (see `RequestEvent.geo`). */
  readonly geo: GeoInfo;
  readonly document: DocumentAttributes;
  /** The body limit of this request. A route that raises it (`apiHandler({ maxBodyBytes })`) sets `limit` before reading. */
  readonly bodyCap: BodyCap;
  route: RouteInfo = NO_ROUTE;
  /** Draft mode is on for this request (set by the handler from the draft cookie). */
  draft = false;
  /** The app path the request asked for, before a rewrite (header rules match it). */
  sourcePath: string | undefined = undefined;
  /** Set when a route rule says the page ships no client code (`csr: false`). */
  noClient = false;
  /** The route's choice of entity-tag handling (see `RequestEvent.etag`); `undefined` leaves the framework's default. */
  etagPolicy: boolean | undefined = undefined;
  readonly #values = new Map<ContextKey<unknown>, unknown>();
  /** The observation of this request (spans, `Server-Timing`, metrics). `undefined` when none is configured. */
  obs: Observation | undefined = undefined;

  /** `event.timing`: the observation of the request when there is one, else a stand-in that records nothing. */
  get timing(): EventTiming {
    return this.obs ?? NO_TIMING;
  }

  constructor(init: EventInit) {
    this.request = init.request;
    this.url = init.url;
    this.signal = init.signal;
    this.id = init.id;
    this.nonce = init.nonce;
    this.cookies = createCookieJar({
      header: init.request.headers.get("cookie"),
      signer: init.signer,
      secure: init.secureCookies,
    });
    this.env = init.env;
    this.platform = init.platform;
    this.clientAddress = init.clientAddress;
    this.dev = init.dev;
    this.base = init.base ?? "";
    this.trailingSlash = init.trailingSlash ?? "preserve";
    this.geo = init.geo ?? {
      country: undefined,
      region: undefined,
      city: undefined,
      latitude: undefined,
      longitude: undefined,
      timezone: undefined,
    };
    this.document = { lang: init.lang, dir: undefined };
    this.bodyCap = init.bodyCap ?? {
      limit: DEFAULT_LIMITS.maxBodyBytes,
      form: DEFAULT_FORM_LIMITS,
    };
  }

  get method(): string {
    return this.request.method;
  }

  etag(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("event.etag(enabled) takes a boolean.");
    this.etagPolicy = enabled;
  }

  get params(): Readonly<Record<string, string>> {
    return this.route.params;
  }

  /**
   * The request body as bytes, exactly as sent: a UTF-8 byte order mark and invalid UTF-8 included. It is the same read
   * the framework's readers use, so `readJson` after it sees the same bytes (a webhook verifies the signature over
   * these bytes, not over re-encoded text). Bounded by the body limit of the route (`apiHandler({ maxBodyBytes })`) or
   * the app's `limits.maxBodyBytes`: a larger body gives 413.
   */
  rawBody(): Promise<Uint8Array<ArrayBuffer>> {
    return readBodyBytes(this.request);
  }

  set<T>(key: ContextKey<T>, value: T): void {
    this.#values.set(key, value);
  }

  get<T>(key: ContextKey<T>): T {
    if (!this.#values.has(key)) {
      throw new DuskError("CONTEXT_KEY_UNSET", `the context key "${key.name}" was never set.`);
    }
    return this.#values.get(key) as T;
  }

  tryGet<T>(key: ContextKey<T>): T | undefined {
    return this.#values.get(key) as T | undefined;
  }
}

/** A signer for the configured secrets, or `undefined` when none are configured. @internal */
export function signerFor(secrets: readonly string[] | undefined): CookieSigner | undefined {
  return secrets === undefined || secrets.length === 0 ? undefined : createCookieSigner(secrets);
}

/**
 * The visibility of routes for a request: a private route (a `_`-prefixed path) answers only a request a rewrite moved
 * inside the app. Every route match of the server asks through this function, so the rule is in one place.
 *
 * @param event The request event.
 * @returns `"all"` for a rewritten request, else `"public"`.
 * @internal
 */
export function visibilityOf(event: Pick<EventState, "internalAccess">): RouteVisibility {
  return event.internalAccess ? "all" : "public";
}
