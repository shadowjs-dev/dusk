/**
 * The types of production observability: the `Server-Timing` option, the per-request timings handed to a
 * hook, the `event.timing` API and the minimal OpenTelemetry Metrics API shape. Types only, so importing them
 * adds nothing to a bundle.
 *
 * @packageDocumentation
 */

/**
 * `event.timing`: records your own metrics for the `Server-Timing` header and for the `onTimings` hook. When
 * `serverTiming` is off (the production default) both methods only run your function and record nothing.
 * @since 1.0.0
 */
export interface EventTiming {
  /**
   * Runs `fn` and records how long it took under `name`. A function that returns a promise is measured until the
   * promise settles. With a tracer, the call is also a child span `dusk.timing`. The same name measured again adds to
   * its total.
   *
   * @param name A token (letters, digits and `!#$%&'*+-.^_\`|~`), at most 64 characters; not `total`, `route`,
   *   `loaders` or `render`.
   * @param fn The work. Its result, or its error, is passed through.
   * @param description An optional label (reduced to safe ASCII, at most 100 characters).
   * @returns What `fn` returns.
   * @throws TypeError for an invalid name, or for a 21st distinct name, while `serverTiming` is on.
   * @example
   * const user = await event.timing.measure("db", () => loadUser(id), "load user");
   * @since 1.0.0
   */
  measure<T>(name: string, fn: () => T, description?: string): T;
  /**
   * Records a duration you measured yourself.
   *
   * @param name See {@link EventTiming.measure}.
   * @param durationMs Milliseconds; a negative or non-finite value is recorded as 0.
   * @param description An optional label.
   * @throws TypeError for an invalid name, or for a 21st distinct name, while `serverTiming` is on.
   * @since 1.0.0
   */
  add(name: string, durationMs: number, description?: string): void;
}

/**
 * What the `onTimings` hook learns about one finished request. Durations are milliseconds from `performance.now()`.
 * @since 1.0.0
 */
export interface RequestTimings {
  /** The request id (the `x-request-id` header). */
  readonly requestId: string;
  readonly method: string;
  /** The URL path of the request. */
  readonly path: string;
  /** The matched route pattern (`/posts/:id`), or `undefined` when no route matched. */
  readonly route: string | undefined;
  /** The final status code. */
  readonly status: number;
  /** Time to the response head: what the `total` entry of the header holds. */
  readonly totalMs: number;
  /** Time until the route was resolved (`undefined` when the request ended before that). */
  readonly routeMs: number | undefined;
  /** The route loader chain (`undefined` for a request that ran none). */
  readonly loadersMs: number | undefined;
  /** The render up to the shell (`undefined` for a request that rendered no page). */
  readonly renderMs: number | undefined;
  /**
   * Time until the response body ended, for a streamed page: the full render time. `undefined` for any other
   * response and for a stream the client canceled.
   */
  readonly streamMs: number | undefined;
  /** True when the response body did not finish: the client disconnected or the request timed out. */
  readonly aborted: boolean;
  /** Your metrics (`event.timing`), in the order first recorded. */
  readonly metrics: readonly {
    readonly name: string;
    readonly durationMs: number;
    readonly description: string | undefined;
  }[];
}

/**
 * The `serverTiming` option as an object.
 * @since 1.0.0
 */
export interface ServerTimingOptions {
  /**
   * Send the `Server-Timing` header. Default `true`. `false` records the timings for `onTimings` only, which keeps
   * the numbers out of responses.
   */
  readonly header?: boolean;
  /**
   * Called once per request when it is over (for a streamed page, when the body ends; for a canceled or timed-out
   * request, when it is abandoned). A throw is reported to the error sink (phase `instrumentation`) and never reaches
   * the client.
   */
  readonly onTimings?: (timings: RequestTimings) => void;
}

/** A counter, with the OpenTelemetry `Counter.add` signature. @since 1.0.0 */
export interface CounterLike {
  add(value: number, attributes?: Readonly<Record<string, string | number | boolean>>): unknown;
}

/** A histogram, with the OpenTelemetry `Histogram.record` signature. @since 1.0.0 */
export interface HistogramLike {
  record(value: number, attributes?: Readonly<Record<string, string | number | boolean>>): unknown;
}

/**
 * The subset of the OpenTelemetry Metrics `Meter` that Dusk uses: pass `metrics.getMeter("my-app")` of
 * `@opentelemetry/api`, or any object with the two methods.
 * @since 1.0.0
 */
export interface MetricsLike {
  createCounter(
    name: string,
    options?: { readonly description?: string; readonly unit?: string },
  ): CounterLike;
  createHistogram(
    name: string,
    options?: { readonly description?: string; readonly unit?: string },
  ): HistogramLike;
}
