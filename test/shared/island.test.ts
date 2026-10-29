import { describe, expect, it } from "vitest";
import { islandAttributes } from "../../src/shared/island";

/**
 * An island is an element the server renders with its static content, plus the attributes the browser
 * needs to hydrate it later. The props travel in an attribute, so they are plain data only, and a `<` in a
 * prop cannot end a script or an attribute early.
 */
describe("islandAttributes", () => {
  it("[ISL-01] the attributes name the island, its strategy and its props; the default strategy is visible", () => {
    expect(islandAttributes({ id: "chart", props: { series: [1, 2], title: "Sales" } })).toEqual({
      "data-island": "chart",
      "data-client": "visible",
      "data-props": '{"series":[1,2],"title":"Sales"}',
    });
    expect(islandAttributes({ id: "menu", client: "interaction" })["data-client"]).toBe(
      "interaction",
    );
    expect(
      islandAttributes({ id: "banner", client: "media", media: "(min-width: 768px)" }),
    ).toMatchObject({
      "data-client": "media",
      "data-media": "(min-width: 768px)",
    });
  });

  it("[ISL-02] only plain data is a prop: functions, class instances, bigint, NaN and cycles are refused", () => {
    expect(() => islandAttributes({ id: "x", props: { run: () => 1 } })).toThrow(TypeError);
    expect(() => islandAttributes({ id: "x", props: { when: new Date() } })).toThrow(TypeError);
    expect(() => islandAttributes({ id: "x", props: { big: 1n } })).toThrow(TypeError);
    expect(() => islandAttributes({ id: "x", props: { n: Number.NaN } })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => islandAttributes({ id: "x", props: cyclic })).toThrow(TypeError);
  });

  it("[ISL-03] a prop cannot end the script or the attribute early: < > & and the line separators are escaped", () => {
    const attributes = islandAttributes({ id: "x", props: { text: "</script><b>& " } });
    const json = attributes["data-props"] ?? "";
    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(json).not.toContain("&");
    expect(json).not.toContain(" ");
    expect(JSON.parse(json)).toEqual({ text: "</script><b>& " });
  });

  it("[ISL-04] the id is a registry key of lowercase letters, digits and dashes; the props are limited in size", () => {
    expect(() => islandAttributes({ id: "Chart Panel" })).toThrow(TypeError);
    expect(() => islandAttributes({ id: "../escape" })).toThrow(TypeError);
    expect(() => islandAttributes({ id: "x", props: { blob: "y".repeat(20_000) } })).toThrow(
      RangeError,
    );
    expect(() => islandAttributes({ id: "x", client: "media" })).toThrow(TypeError);
  });

  it("[DUSK-R5-1] props nested 100,000 deep are refused with the size-limit RangeError, not a stack overflow; cycles and bad values are still named", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let level = 0; level < 100_000; level++) {
      const next: Record<string, unknown> = {};
      deep["a"] = next;
      deep = next;
    }
    const thrown = (() => {
      try {
        islandAttributes({ id: "x", props: root });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(RangeError);
    expect(String((thrown as Error).message)).toMatch(
      /nested deeper than the 16384 character limit/,
    );
    // 4,000 levels are inside the limit and still work, as arrays or as objects.
    let ok: unknown[] = [];
    const okRoot = ok;
    for (let level = 0; level < 4_000; level++) {
      const next: unknown[] = [];
      ok.push(next);
      ok = next;
    }
    expect(islandAttributes({ id: "x", props: { list: okRoot } })["data-props"]).toMatch(
      /^\{"list":\[\[/,
    );
    const cycle: unknown[] = [];
    cycle.push([cycle]);
    expect(() => islandAttributes({ id: "x", props: { list: cycle } })).toThrow(
      /props\.list\[0\]\[0\] is a cycle/,
    );
    expect(() => islandAttributes({ id: "x", props: { a: { b: [1, { c: () => 1 }] } } })).toThrow(
      /props\.a\.b\[1\]\.c is a function/,
    );
    const shared = { n: 1 };
    expect(islandAttributes({ id: "x", props: { a: shared, b: shared } })["data-props"]).toBe(
      '{"a":{"n":1},"b":{"n":1}}',
    );
  });
});
