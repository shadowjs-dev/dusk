/**
 * The `instrumentation.ts` convention: `register()` runs once when the server starts, `onRequest` sees each
 * request before it is routed, and `onRequestError` sees every error the framework reports. A `tracer` with
 * the OpenTelemetry shape (`startActiveSpan`, `setAttribute`, `recordException`, `setStatus`, `end`) wraps each
 * request in a span. There is no dependency on OpenTelemetry: pass the tracer of `@opentelemetry/api` (its
 * `trace.getTracer(...)` already has this shape) or any object of the same methods.
 *
 * None of these hooks can fail a request or stop the process: a failure is reported to the error sink.
 *
 * @packageDocumentation
 */

import type { ErrorPhase } from "./types";

/** A span, with the OpenTelemetry method names. @since 1.0.0 */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  recordException(error: unknown): unknown;
  setStatus(status: { readonly code: 0 | 1 | 2; readonly message?: string }): unknown;
  end(): unknown;
}

/** A tracer with the OpenTelemetry `startActiveSpan` shape. @since 1.0.0 */
export interface TracerLike {
  startActiveSpan<T>(
    name: string,
    options: { readonly attributes?: Readonly<Record<string, string | number | boolean>> },
    fn: (span: SpanLike) => T,
  ): T;
}

/** What `onRequest` and `onRequestError` learn about the request. @since 1.0.0 */
export interface RequestErrorContext {
  readonly phase: ErrorPhase;
  /** `page`, `api`, `rpc`, `stream`, `none`, or `undefined` when no route was resolved. */
  readonly routeKind: string | undefined;
  readonly routeId: string | undefined;
  /** The request id (the same as the `x-request-id` header). */
  readonly requestId: string | undefined;
}

/** The module `src/instrumentation.ts` exports. @since 1.0.0 */
export interface InstrumentationModule {
  readonly register?: () => void | Promise<void>;
  readonly onRequest?: (
    request: Request,
    context: { readonly requestId: string; readonly routeKind: string },
  ) => void | Promise<void>;
  readonly onRequestError?: (
    error: unknown,
    request: Request | undefined,
    context: RequestErrorContext,
  ) => void | Promise<void>;
  readonly tracer?: TracerLike;
}

/** A checked instrumentation module, with the default tracer filled in. @internal */
export interface ResolvedInstrumentation {
  readonly register: (() => void | Promise<void>) | undefined;
  readonly onRequest: InstrumentationModule["onRequest"];
  readonly onRequestError: InstrumentationModule["onRequestError"];
  readonly tracer: TracerLike;
}

const NOOP_SPAN: SpanLike = {
  setAttribute: () => undefined,
  recordException: () => undefined,
  setStatus: () => undefined,
  end: () => undefined,
};

/** The tracer when none is given: it runs the work and records nothing. @since 1.0.0 */
export const NOOP_TRACER: TracerLike = {
  startActiveSpan: (_name, _options, fn) => fn(NOOP_SPAN),
};

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/**
 * Checks an instrumentation module and fills the defaults.
 *
 * @param value The module namespace, or `undefined` when the project has none.
 * @returns The checked module.
 * @throws TypeError when a hook is not a function or the tracer has no `startActiveSpan`.
 * @since 1.0.0
 */
export function resolveInstrumentation(value: unknown): ResolvedInstrumentation {
  if (value === undefined)
    return {
      register: undefined,
      onRequest: undefined,
      onRequestError: undefined,
      tracer: NOOP_TRACER,
    };
  if (typeof value !== "object" || value === null)
    throw new TypeError(
      __DEV__
        ? "instrumentation must export functions (register, onRequest, onRequestError) and an optional tracer."
        : "DUSK_INSTR_2",
    );
  const read = (name: string): unknown => Reflect.get(value, name);
  for (const name of ["register", "onRequest", "onRequestError"] as const) {
    const hook = read(name);
    if (hook !== undefined && !isFunction(hook))
      throw new TypeError(__DEV__ ? `instrumentation.${name} must be a function.` : "DUSK_INSTR_1");
  }
  const tracer = read("tracer");
  if (tracer !== undefined) {
    if (
      typeof tracer !== "object" ||
      tracer === null ||
      !isFunction(Reflect.get(tracer, "startActiveSpan"))
    ) {
      throw new TypeError(
        __DEV__
          ? "instrumentation.tracer must have a startActiveSpan method (the OpenTelemetry tracer shape)."
          : "DUSK_INSTR_3",
      );
    }
  }
  return {
    register: read("register") as ResolvedInstrumentation["register"],
    onRequest: read("onRequest") as ResolvedInstrumentation["onRequest"],
    onRequestError: read("onRequestError") as ResolvedInstrumentation["onRequestError"],
    tracer: tracer === undefined ? NOOP_TRACER : (tracer as TracerLike),
  };
}

const registered = new WeakSet<ResolvedInstrumentation>();

/**
 * Runs `register` once for a module. A failure, synchronous or asynchronous, is reported.
 *
 * @param resolved The checked module.
 * @param report Receives a failure.
 * @internal
 */
export function registerInstrumentation(
  resolved: ResolvedInstrumentation,
  report: (error: unknown) => void,
): void {
  if (registered.has(resolved) || resolved.register === undefined) return;
  registered.add(resolved);
  try {
    const outcome = resolved.register();
    if (outcome instanceof Promise) outcome.catch(report);
  } catch (error) {
    report(error);
  }
}
