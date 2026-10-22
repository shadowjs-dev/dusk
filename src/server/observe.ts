/**
 * Production observability of a request: the `Server-Timing` header, child spans of an OpenTelemetry-shaped tracer, the
 * `onTimings` hook and the metrics of a `Meter`-shaped object. The handler loads this module only when one of them is
 * configured (a tracer in `instrumentation`, `serverTiming`, `metrics`, or development mode), so an app that uses none of
 * them does not run or ship it.
 *
 * Nothing here can fail a request: a throwing tracer, meter or hook is reported to the error sink (phase
 * `instrumentation`) and the request goes on.
 *
 * @packageDocumentation
 */

import type { EventState } from "./event";
import type { SpanLike, TracerLike } from "./instrumentation";
import type {
  CounterLike,
  EventTiming,
  HistogramLike,
  RequestTimings,
  ServerTimingOptions,
} from "./observe-types";
import {
  checkTimingName,
  cleanTimingDescription,
  MAX_TIMING_METRICS,
  serializeServerTiming,
  type TimingEntry,
} from "./server-timing";
import type { ErrorPhase, HandlerOptions } from "./types";

type Attributes = Readonly<Record<string, string | number | boolean>>;

/** Ends a span or a measured phase. Calling it again does nothing. Pass the error when the work failed. @internal */
export type Stop = (error?: unknown) => void;

/** Ends the stream of a response body: `canceled` is true when the client canceled the body. @internal */
export type TailStop = (error?: unknown, canceled?: boolean) => void;

/** The observer of one handler. @internal */
export interface Observer {
  /** Starts observing a request. `span` is the request span of the tracer (undefined without a tracer). */
  begin(event: EventState, span: SpanLike | undefined): Observation;
}

interface Shared {
  readonly tracer: TracerLike | undefined;
  /** The status a thrown value is answered with; `undefined` for a redirect. */
  readonly statusOf: (error: unknown) => number | undefined;
  /** Reports a failure of the tracer, the meter or a hook (phase `instrumentation`). */
  readonly report: (error: unknown, phase: ErrorPhase, event: EventState | undefined) => void;
  /** Child spans are created. Turns off after the tracer fails once, so a broken tracer is reported once. */
  tracing: boolean;
  /** Metrics are recorded for the header and `onTimings`. */
  readonly timing: boolean;
  /** The `Server-Timing` header is sent. */
  readonly header: boolean;
  readonly onTimings: ServerTimingOptions["onTimings"];
  readonly requests: CounterLike | undefined;
  readonly duration: HistogramLike | undefined;
}

const STANDARD_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
]);

/** The route of the framework's own endpoints, for the metrics and the `route` entry. */
const INTERNAL_ROUTES: Readonly<Record<string, string>> = {
  rpc: "/_dusk/fn/:id",
  image: "/_dusk/image",
  nav: "/_dusk/nav",
};

/**
 * Validates the options and builds the observer, or returns `undefined` when nothing is to be observed.
 *
 * @param options The `serverTiming` and `metrics` options of the handler.
 * @param tracer The tracer of the instrumentation module, or `undefined` when it has none (the no-op tracer).
 * @param dev Development mode: `Server-Timing` is on unless `serverTiming` says otherwise.
 * @param report The error reporter of the handler.
 * @param describe `describeError` of the handler: what a thrown value is answered with.
 * @returns The observer.
 * @throws TypeError for an option of the wrong shape.
 * @internal
 */
export function createObserver(
  options: Pick<HandlerOptions, "serverTiming" | "metrics">,
  tracer: TracerLike | undefined,
  dev: boolean,
  report: Shared["report"],
  describe: (error: unknown, dev: boolean) => { readonly status: number },
): Observer | undefined {
  const { serverTiming, metrics } = options;
  if (
    serverTiming !== undefined &&
    typeof serverTiming !== "boolean" &&
    (typeof serverTiming !== "object" || serverTiming === null)
  ) {
    throw new TypeError("serverTiming must be true, false or an object ({ header, onTimings }).");
  }
  const timingOptions = typeof serverTiming === "object" ? serverTiming : undefined;
  if (timingOptions?.header !== undefined && typeof timingOptions.header !== "boolean") {
    throw new TypeError("serverTiming.header must be true or false.");
  }
  if (timingOptions?.onTimings !== undefined && typeof timingOptions.onTimings !== "function") {
    throw new TypeError("serverTiming.onTimings must be a function.");
  }
  if (
    metrics !== undefined &&
    (typeof metrics !== "object" ||
      metrics === null ||
      typeof metrics.createCounter !== "function" ||
      typeof metrics.createHistogram !== "function")
  ) {
    throw new TypeError(
      "metrics must have createCounter and createHistogram (an OpenTelemetry Meter).",
    );
  }
  // `undefined` is the development default: on in development, off in production (the numbers describe internals).
  const timing = serverTiming === undefined ? dev : serverTiming !== false;
  if (!timing && tracer === undefined && metrics === undefined) return undefined;
  const shared: Shared = {
    tracer,
    report,
    // A redirect signal (`kind: "redirect"`) is an answer with a status of its own: no status here.
    statusOf: (error) =>
      typeof error === "object" && error !== null && Reflect.get(error, "kind") === "redirect"
        ? undefined
        : describe(error, false).status,
    tracing: tracer !== undefined,
    timing,
    header: timing && timingOptions?.header !== false,
    onTimings: timingOptions?.onTimings,
    requests: metrics?.createCounter("dusk.server.requests", {
      description: "Requests served, by route, method and status class.",
      unit: "{request}",
    }),
    duration: metrics?.createHistogram("http.server.request.duration", {
      description: "Duration of the requests served, until the response body ended.",
      unit: "s",
    }),
  };
  return { begin: (event, span) => new Observation(shared, event, span) };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
}

/** Runs `fn` and calls `end` once when it is over: now for a value, on settling for a promise. */
function settle<T>(fn: () => T, end: Stop, ok?: (value: Awaited<T>) => void): T {
  let result: T;
  try {
    result = fn();
  } catch (error) {
    end(error);
    throw error;
  }
  if (isThenable(result)) {
    return result.then(
      (value) => {
        ok?.(value as Awaited<T>);
        end();
        return value;
      },
      (error: unknown) => {
        end(error);
        throw error;
      },
    ) as T;
  }
  ok?.(result as Awaited<T>);
  end();
  return result;
}

function errorType(error: unknown): string {
  return error instanceof Error && error.name !== "" ? error.name : "_OTHER";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "error";
}

/** A child span the observation tracks, so it ends exactly once. */
class ChildSpan {
  #ended = false;
  readonly span: SpanLike;
  readonly #observation: Observation;
  readonly #tracked: boolean;

  constructor(span: SpanLike, observation: Observation, tracked: boolean) {
    this.span = span;
    this.#observation = observation;
    this.#tracked = tracked;
  }

  /**
   * Ends the span once. `error` is the error of failed work; `reason` marks a span the request outlived (`aborted`,
   * `timeout`, `abandoned`); `status` is the status of a response.
   */
  end(error: unknown, reason?: string, status?: number): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#tracked) this.#observation.forget(this);
    this.#observation.guard(() => {
      if (status !== undefined) this.span.setAttribute("http.response.status_code", status);
      if (error !== undefined && this.#observation.failed(error)) {
        this.span.recordException(error);
        this.span.setAttribute("error.type", errorType(error));
        this.span.setStatus({ code: 2, message: errorMessage(error) });
      } else if (reason !== undefined) {
        this.span.setAttribute("error.type", reason);
        this.span.setStatus({ code: 2, message: reason });
      } else if (status !== undefined && status >= 500) {
        this.span.setAttribute("error.type", String(status));
        this.span.setStatus({ code: 2, message: String(status) });
      }
    });
    this.#observation.guard(() => this.span.end());
  }
}

/**
 * The observation of one request. It is `event.timing` too (the API of {@link EventTiming}). The handler creates it
 * after the event exists and the request pipeline calls it at fixed points; none of its methods throws except the
 * validation of a metric name.
 * @internal
 */
export class Observation implements EventTiming {
  readonly #shared: Shared;
  readonly #event: EventState;
  readonly #span: SpanLike | undefined;
  readonly #began = performance.now();
  readonly #open = new Set<ChildSpan>();
  readonly #phases = new Map<string, number>();
  readonly #metrics = new Map<string, { durationMs: number; description: string | undefined }>();
  #routeMs: number | undefined;
  #route: string | undefined;
  #headMs = 0;
  #status = 0;
  #finished = false;
  #completed = false;
  #tails = 0;
  #streamMs: number | undefined;
  #recordedError = false;
  /** The client left before the response body ended (canceled it, or aborted the request). */
  #left = false;

  constructor(shared: Shared, event: EventState, span: SpanLike | undefined) {
    this.#shared = shared;
    this.#event = event;
    this.#span = span;
    event.obs = this;
  }

  /** Runs `fn` and reports a failure of an observability call instead of throwing it. */
  guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.#shared.tracing = false;
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    try {
      this.#shared.report(error, "instrumentation", this.#event);
    } catch {
      // The sink of the failure threw as well: nothing is left to tell.
    }
  }

  /** Called by a child span that ended. */
  forget(child: ChildSpan): void {
    this.#open.delete(child);
  }

  /** Whether a thrown value is a failure of the server: a redirect, a not-found and a 4xx are answers, not failures. */
  failed(error: unknown): boolean {
    return (this.#shared.statusOf(error) ?? 0) >= 500;
  }

  /** Starts a child span without making it the active span of the code that follows. */
  #child(
    name: string,
    attributes: Attributes | undefined,
    tracked: boolean,
  ): ChildSpan | undefined {
    const tracer = this.#shared.tracing ? this.#shared.tracer : undefined;
    if (tracer === undefined) return undefined;
    try {
      const span = tracer.startActiveSpan(
        name,
        attributes === undefined ? {} : { attributes },
        (created) => created,
      );
      const child = new ChildSpan(span, this, tracked);
      if (tracked) this.#open.add(child);
      return child;
    } catch (error) {
      this.#shared.tracing = false;
      this.#fail(error);
      return undefined;
    }
  }

  #account(name: string, durationMs: number): void {
    this.#phases.set(name, (this.#phases.get(name) ?? 0) + durationMs);
  }

  /** The route is known: the matched pattern (or `undefined`), for the `route` entry, spans and metrics. */
  routed(resolution: {
    readonly kind: string;
    readonly hit?: { readonly pattern: string };
    readonly pattern?: string;
  }): void {
    this.#routeMs ??= performance.now() - this.#began;
    this.#route = resolution.hit?.pattern ?? resolution.pattern ?? INTERNAL_ROUTES[resolution.kind];
  }

  /**
   * Starts a phase: a child span `name` (with a tracer) and, for `dusk.loaders` and `dusk.render`, the duration of the
   * `Server-Timing` entry of that name. The span is not the active span of the work that follows; use {@link run} for
   * work that creates spans of its own.
   *
   * @returns The function that ends the phase.
   */
  start(name: string, attributes?: Attributes): Stop {
    const began = performance.now();
    const child = this.#child(name, attributes, true);
    let stopped = false;
    return (error) => {
      if (stopped) return;
      stopped = true;
      this.#account(name, performance.now() - began);
      child?.end(error);
    };
  }

  /** Runs `fn` inside a child span `name`, which is the active span while it runs; its duration feeds the entry of that name. */
  run<T>(name: string, attributes: Attributes | undefined, fn: () => T): T {
    return this.#traced(name, attributes, fn, undefined, true);
  }

  #traced<T>(
    name: string,
    attributes: Attributes | undefined,
    fn: () => T,
    onValue: ((value: Awaited<T>) => number) | undefined,
    account: boolean,
    answers = false,
  ): T {
    const began = performance.now();
    let status: number | undefined;
    const work = (child: ChildSpan | undefined): T =>
      settle(
        fn,
        (error) => {
          if (account) this.#account(name, performance.now() - began);
          // An endpoint that throws is answered by the failure mapper outside the span: its status is the error's.
          if (answers && error !== undefined) status = this.#shared.statusOf(error);
          child?.end(error, undefined, status);
        },
        (value) => {
          status = onValue?.(value);
        },
      );
    const tracer = this.#shared.tracing ? this.#shared.tracer : undefined;
    if (tracer === undefined) return work(undefined);
    let ran = false;
    try {
      return tracer.startActiveSpan(
        name,
        attributes === undefined ? {} : { attributes },
        (span) => {
          ran = true;
          const child = new ChildSpan(span, this, true);
          this.#open.add(child);
          return work(child);
        },
      );
    } catch (error) {
      // The work failed, or the tracer did before the work ran. Only the second case is ours to absorb.
      if (ran) throw error;
      this.#shared.tracing = false;
      this.#fail(error);
      return work(undefined);
    }
  }

  /**
   * Runs the endpoint that answers the request (`rpc`, `api`, `page`, `stream`, ...) inside the span `dusk.<kind>`,
   * which records the status of its response.
   */
  endpoint(kind: string, id: string | undefined, fn: () => Promise<Response>): Promise<Response> {
    // A path no route claims (404) and a refused method have no endpoint to trace.
    if (kind === "none" || kind === "allow") return fn();
    const attributes: Record<string, string> = {};
    if (this.#route !== undefined) attributes["http.route"] = this.#route;
    if (id !== undefined) attributes[kind === "rpc" ? "dusk.rpc.name" : "dusk.route.id"] = id;
    return this.#traced(`dusk.${kind}`, attributes, fn, (response) => response.status, false, true);
  }

  /**
   * The response body is a stream that outlives the response head (a streamed page): the request completes when the
   * returned function is called, or when the request is aborted. Its span `name` covers the stream.
   */
  tail(name: string): TailStop {
    this.#tails += 1;
    const child = this.#child(name, undefined, false);
    let stopped = false;
    const { signal } = this.#event;
    const stop: TailStop = (error, canceled = false) => {
      if (stopped) return;
      stopped = true;
      signal.removeEventListener("abort", onAbort);
      const left = canceled || signal.aborted;
      if (error === undefined && !left) this.#streamMs = performance.now() - this.#began;
      if (left) this.#left = true;
      child?.end(error, error === undefined && left ? this.#abortReason() : undefined);
      this.#tails -= 1;
      if (this.#tails === 0 && this.#finished) this.#complete();
    };
    const onAbort = (): void => stop();
    signal.addEventListener("abort", onAbort, { once: true });
    return stop;
  }

  #abortReason(): string {
    const reason: unknown = this.#event.signal.reason;
    return this.#event.signal.aborted &&
      reason instanceof Error &&
      reason.name === "RequestTimeoutError"
      ? "timeout"
      : "aborted";
  }

  // --- EventTiming -------------------------------------------------------------------------------------------------

  /** @inheritDoc */
  measure<T>(name: string, fn: () => T, description?: string): T {
    this.#claim(name, description);
    const began = performance.now();
    return this.#traced(
      "dusk.timing",
      { "dusk.timing.name": name },
      () => settle(fn, () => this.#store(name, performance.now() - began)),
      undefined,
      false,
    );
  }

  /** @inheritDoc */
  add(name: string, durationMs: number, description?: string): void {
    this.#claim(name, description);
    this.#store(name, durationMs);
  }

  /** Checks a name and reserves its slot. */
  #claim(name: string, description: string | undefined): void {
    checkTimingName(name);
    if (!this.#metrics.has(name) && this.#metrics.size >= MAX_TIMING_METRICS) {
      throw new TypeError(
        `A request records at most ${MAX_TIMING_METRICS} Server-Timing metrics; "${name}" is one too many.`,
      );
    }
    if (!this.#metrics.has(name)) {
      this.#metrics.set(name, { durationMs: 0, description: cleanTimingDescription(description) });
    }
  }

  #store(name: string, durationMs: number): void {
    const entry = this.#shared.timing ? this.#metrics.get(name) : undefined;
    if (entry !== undefined)
      entry.durationMs += Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  }

  // --- the response -------------------------------------------------------------------------------------------------

  #entries(): TimingEntry[] {
    const entries: TimingEntry[] = [{ name: "total", durationMs: this.#headMs }];
    if (this.#routeMs !== undefined) {
      entries.push({
        name: "route",
        durationMs: this.#routeMs,
        description: this.#route ?? "unmatched",
      });
    }
    const loaders = this.#phases.get("dusk.loaders");
    if (loaders !== undefined) entries.push({ name: "loaders", durationMs: loaders });
    const render = this.#phases.get("dusk.render");
    if (render !== undefined) entries.push({ name: "render", durationMs: render });
    for (const [name, entry] of this.#metrics) {
      entries.push({ name, durationMs: entry.durationMs, description: entry.description });
    }
    return entries;
  }

  /** An error the framework reported for this request: recorded on the request span. */
  error(error: unknown): void {
    const span = this.#span;
    if (span === undefined || this.#finished) return;
    this.#recordedError = true;
    this.guard(() => {
      span.recordException(error);
      span.setAttribute("error.type", errorType(error));
    });
  }

  /**
   * The final response is known. Adds `Server-Timing` (unless the app set its own), ends the child spans the request
   * outlived, and completes the request if its body is not a stream still being written.
   */
  done(response: Response): Response {
    if (this.#finished) return response;
    this.#finished = true;
    this.#status = response.status;
    this.#headMs = performance.now() - this.#began;
    if (this.#shared.header && !response.headers.has("server-timing")) {
      const value = serializeServerTiming(this.#entries());
      if (value !== undefined) response.headers.set("server-timing", value);
    }
    this.#finish();
    return response;
  }

  #finish(): void {
    const span = this.#span;
    if (span !== undefined) {
      this.guard(() => {
        span.setAttribute("http.response.status_code", this.#status);
        if (this.#route !== undefined) span.setAttribute("http.route", this.#route);
        if (this.#status >= 500 && !this.#recordedError) {
          span.setAttribute("error.type", String(this.#status));
        }
      });
    }
    if (this.#open.size > 0) {
      const reason = this.#event.signal.aborted ? this.#abortReason() : "abandoned";
      for (const child of [...this.#open]) child.end(undefined, reason);
    }
    if (this.#tails === 0) this.#complete();
  }

  /** The request is over, its body included: the metrics and the `onTimings` hook. Runs once. */
  #complete(): void {
    if (this.#completed) return;
    this.#completed = true;
    const shared = this.#shared;
    const totalMs = performance.now() - this.#began;
    const method = this.#event.method;
    if (shared.requests !== undefined || shared.duration !== undefined) {
      const attributes: Record<string, string> = {
        "http.request.method": STANDARD_METHODS.has(method) ? method : "_OTHER",
        "http.response.status_class": `${Math.floor(this.#status / 100)}xx`,
      };
      if (this.#route !== undefined) attributes["http.route"] = this.#route;
      this.guard(() => shared.requests?.add(1, attributes));
      this.guard(() => shared.duration?.record(totalMs / 1000, attributes));
    }
    const hook = shared.onTimings;
    if (hook === undefined) return;
    const timings: RequestTimings = {
      requestId: this.#event.id,
      method,
      path: this.#event.url.pathname,
      route: this.#route,
      status: this.#status,
      totalMs: this.#headMs,
      routeMs: this.#routeMs,
      loadersMs: this.#phases.get("dusk.loaders"),
      renderMs: this.#phases.get("dusk.render"),
      streamMs: this.#streamMs,
      aborted: this.#left || this.#event.signal.aborted,
      metrics: [...this.#metrics].map(([name, entry]) => ({
        name,
        durationMs: entry.durationMs,
        description: entry.description,
      })),
    };
    try {
      hook(timings);
    } catch (error) {
      this.#fail(error);
    }
  }
}
