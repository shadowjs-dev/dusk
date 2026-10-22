import { describe, expect, it } from "vitest";
import { redirect, redirectStatus } from "../src/internal/redirect";

describe("Dusk redirect with an object target", () => {
  it("[DRO-02] the status defaults to 302 and an invalid one is a RangeError", () => {
    expect(redirectStatus(redirect({ to: "/login" }))).toBe(302);
    expect(() => redirect({ to: "/login", status: 200 as never })).toThrow(RangeError);
  });

  it("[DRO-03] the string form still takes its options", () => {
    const signal = redirect("/login", { status: 303, replace: false });
    expect(signal.to).toBe("/login");
    expect(signal.replace).toBe(false);
    expect(redirectStatus(signal)).toBe(303);
  });
});
