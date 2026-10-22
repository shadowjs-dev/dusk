/**
 * Constants and shapes shared by the build output, the browser and the server. They describe the
 * wire between a page and the handler; `@shadow-js/dusk/server` defines the same values on its
 * side (`RPC_PREFIX`, `RPC_HEADER`, `ROUTER_PAYLOAD_ID`, `ErrorBody`).
 */

/** Path (below the base) under which server functions are served. @since 1.0.0 */
export const RPC_PREFIX = "/_dusk/fn/";

/**
 * The endpoint a browser asks before it navigates into a route whose chain runs server middleware:
 * `POST {base}/_dusk/nav` with `{ "path": "/app-path" }`. Its answer is 204 with `NAV_GATE_HEADER: allowed`
 * when the chain let the navigation through, or 200 with `NAV_GATE_HEADER: refused` and a JSON body
 * `{ status, redirect? }` otherwise (JSON, so a redirect is readable from `fetch`: a 3xx is opaque to it).
 */
export const NAV_PATH = "/_dusk/nav";

/** Response header of the gate answer: `allowed` (204) or `refused` (200, JSON body). */
export const NAV_GATE_HEADER = "x-dusk-gate";

/** Value of {@link NAV_GATE_HEADER} when the chain let the navigation through. */
export const NAV_GATE_ALLOWED = "allowed";

/** Value of {@link NAV_GATE_HEADER} when the chain refused the navigation (or redirected it). */
export const NAV_GATE_REFUSED = "refused";
/**
 * Request header the browser sends with a navigation check (`check`). The server marks the request
 * `event.isNavigationCheck` from the endpoint itself; the header is there for proxies and logs.
 */
export const NAV_CHECK_HEADER = "x-dusk-navigation";
/** Value of {@link NAV_CHECK_HEADER}. */
export const NAV_CHECK_VALUE = "check";

/** The request header every server function call carries. @since 1.0.0 */
export const RPC_HEADER = "x-dusk-fn";

/** Id under which the batch endpoint answers: `POST {base}/_dusk/fn/_batch`. @since 1.0.0 */
export const RPC_BATCH_ID = "_batch";

/**
 * The request header that tells the server which page the browser is on, so a single-flight answer
 * can carry the loader data of that page (the path and query, same origin). @since 1.0.0
 */
export const RPC_LOCATION_HEADER = "x-dusk-location";

/**
 * Most calls the browser stub puts in one batch request; the server default for `rpc.maxBatchSize` is the
 * same. A longer tick is sent as several requests. @since 1.0.0
 */
export const RPC_MAX_BATCH_CALLS = 25;

/** Id of the `<script type="application/json">` element with the router's hydration data. @since 1.0.0 */
export const ROUTER_PAYLOAD_ID = "__shadow_router";

/** Attribute of the script elements with resource data (`data-sh="<renderId>"`). @since 1.0.0 */
export const RESOURCE_PAYLOAD_ATTRIBUTE = "data-sh";

/** The error object of a failed server function call. @since 1.0.0 */
export interface RpcErrorBody {
  readonly name: string;
  readonly message: string;
  readonly status: number;
  readonly requestId?: string;
  readonly issues?: readonly {
    readonly message: string;
    readonly path: readonly (string | number)[];
  }[];
  readonly data?: unknown;
}

/** What a server function call answers with (after `deserialize`). @since 1.0.0 */
export type RpcEnvelope =
  | { readonly ok: true; readonly value: unknown; readonly revalidated?: unknown }
  | { readonly ok: false; readonly error: RpcErrorBody }
  | { readonly redirect: { readonly to: string; readonly status: number } };

/** What the build knows about a server function and the client stub needs. @since 1.0.0 */
export interface ServerFnStubMeta {
  /** `"POST"` (default) or `"GET"`. */
  readonly method: "GET" | "POST";
  /** Whether the function also accepts HTML form posts. */
  readonly form: boolean;
  /** Mount base of the app without a trailing slash (`""` or `"/app"`). */
  readonly base: string;
  /** Whether calls may be sent in a batch with the calls made in the same tick (default true). */
  readonly batch?: boolean;
  /** Whether the answer carries the refreshed loader data of the current route (single flight). */
  readonly singleFlight?: boolean;
}
