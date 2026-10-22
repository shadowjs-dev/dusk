import { unsafeHref } from "@shadow-js/router";
import { describe, expect, it } from "vitest";
import { redirect, redirectStatus } from "../src/internal/redirect";

describe("redirect() takes a validated run-time path (unsafeHref)", () => {
  it("[RH-DUSK-01] a RuntimeHref target keeps its path and query, with the requested status", () => {
    const target = unsafeHref("/sign-in?redirect_url=%2Fdashboard%2Ffiles#top");
    const signal = redirect(target, { status: 307 });
    expect(signal.to).toBe("/sign-in?redirect_url=%2Fdashboard%2Ffiles#top");
    expect(redirectStatus(signal)).toBe(307);
  });

  it("[RH-DUSK-02] the same refusal applies: a run-time path to another origin cannot be built in development", () => {
    expect(() => redirect(unsafeHref("https://evil.example/x"))).toThrow(TypeError);
  });
});
