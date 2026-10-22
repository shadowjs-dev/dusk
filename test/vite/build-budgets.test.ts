/**
 * `build.budgets` of `dusk.config.ts`: the shape the config check accepts and refuses (BUD-nn).
 *
 * - BUD-01 a budget is a whole number of bytes above 0; `firstLoadJs` and the route budgets take one.
 * - BUD-02 a route budget is keyed by a route path that starts with `/`; anything else is refused, naming the key.
 * - BUD-03 an unknown key under `budgets` is refused with a suggestion, as every config key is.
 */
import { describe, expect, it } from "vitest";
import { validateDuskConfig } from "../../src/vite/config-file";

describe("build.budgets", () => {
  it("[BUD-01] whole byte counts above 0 are accepted; anything else is refused, naming the key", () => {
    expect(() =>
      validateDuskConfig({
        build: { budgets: { firstLoadJs: 200_000, routes: { "/": 150_000 } } },
      }),
    ).not.toThrow();
    expect(() => validateDuskConfig({ build: { budgets: {} } })).not.toThrow();
    expect(() => validateDuskConfig({ build: { budgets: { firstLoadJs: 0 } } })).toThrow(
      "build.budgets.firstLoadJs must be a whole number of bytes above 0.",
    );
    expect(() => validateDuskConfig({ build: { budgets: { firstLoadJs: 12.5 } } })).toThrow(
      "build.budgets.firstLoadJs must be a whole number of bytes above 0.",
    );
    expect(() => validateDuskConfig({ build: { budgets: { firstLoadJs: "200kB" } } })).toThrow(
      "build.budgets.firstLoadJs",
    );
    expect(() => validateDuskConfig({ build: { budgets: { routes: { "/x": -1 } } } })).toThrow(
      'build.budgets.routes["/x"] must be a whole number of bytes above 0.',
    );
  });

  it("[BUD-02] route budgets are keyed by a path that starts with /", () => {
    expect(() => validateDuskConfig({ build: { budgets: { routes: [] } } })).toThrow(
      "build.budgets.routes must be an object.",
    );
    expect(() =>
      validateDuskConfig({ build: { budgets: { routes: { dashboard: 100 } } } }),
    ).toThrow('build.budgets.routes: "dashboard" must be a route path that starts with /.');
  });

  it("[BUD-03] an unknown key under budgets is refused", () => {
    expect(() => validateDuskConfig({ build: { budgets: { firstLoad: 100 } } })).toThrow(
      /build\.budgets/,
    );
    expect(() => validateDuskConfig({ build: { budget: {} } })).toThrow(/build/);
  });

  it("[BUD-04] enforce is true or false; nothing else is accepted", () => {
    expect(() =>
      validateDuskConfig({ build: { budgets: { firstLoadJs: 1000, enforce: true } } }),
    ).not.toThrow();
    expect(() => validateDuskConfig({ build: { budgets: { enforce: false } } })).not.toThrow();
    expect(() => validateDuskConfig({ build: { budgets: { enforce: "yes" } } })).toThrow(
      "build.budgets.enforce must be true or false.",
    );
  });
});
