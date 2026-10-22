import { describe, expect, it, vi } from "vitest";
import {
  NOOP_TRACER,
  registerInstrumentation,
  resolveInstrumentation,
} from "../../src/server/instrumentation";

describe("instrumentation", () => {
  it("[INS-1] the module shape is checked: hooks must be functions, the tracer must have startActiveSpan", () => {
    expect(() => resolveInstrumentation({ register: "nope" as unknown as () => void })).toThrow(
      TypeError,
    );
    expect(() => resolveInstrumentation({ tracer: {} as never })).toThrow(/startActiveSpan/);
    expect(resolveInstrumentation(undefined).tracer).toBe(NOOP_TRACER);
  });

  it("[INS-2] register runs once per module object, and a rejected register is reported, not thrown", async () => {
    const reported: unknown[] = [];
    const module = {
      register: vi.fn(async () => {
        throw new Error("otel init failed");
      }),
    };
    const resolved = resolveInstrumentation(module);
    registerInstrumentation(resolved, (error) => reported.push(error));
    registerInstrumentation(resolved, (error) => reported.push(error));
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(module.register).toHaveBeenCalledTimes(1);
  });

  it("[INS-3] the no-op tracer runs the work and returns its value; a span has the OpenTelemetry methods", () => {
    const result = NOOP_TRACER.startActiveSpan(
      "dusk.request",
      { attributes: { "http.request.method": "GET" } },
      (span) => {
        span.setAttribute("a", 1);
        span.recordException(new Error("x"));
        span.setStatus({ code: 2, message: "boom" });
        span.end();
        return 42;
      },
    );
    expect(result).toBe(42);
  });
});
