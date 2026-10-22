/**
 * Options of one server function call. The browser stub uses all of them; the server function
 * accepts them so that code shared by both (a component, a loader) compiles against either, and
 * ignores them: a direct call runs inside the current request, with no network in between.
 * @since 1.0.0
 */
export interface ServerFnCallOptions {
  /** Aborts the call: the promise rejects with the platform `AbortError`. */
  readonly signal?: AbortSignal;
  /** Extra request headers. `x-dusk-fn` and `content-type` cannot be replaced. */
  readonly headers?: HeadersInit;
  /** The `fetch` to use. Default: the global one. */
  readonly fetch?: typeof fetch;
  /**
   * For a function with `singleFlight: true`: `false` opts this call out of the refreshed loader data
   * (the request does not name the page, so the answer carries none). Default `true`. Ignored by a
   * function without single flight.
   */
  readonly revalidate?: boolean;
}
