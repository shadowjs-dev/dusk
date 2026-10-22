import { describe, expect, it } from "vitest";
import {
  expandTree,
  Fragment,
  h,
  jsx,
  jsxs,
  MAX_OG_NODES,
  type OgComponent,
} from "../../src/og/element";

describe("element tree", () => {
  it("[OG-01] h builds an element with its style and its children, one child or many", () => {
    const one = h("div", { style: { display: "flex", fontSize: 48 } }, "Malaf");
    expect(one).toEqual({
      type: "div",
      props: { style: { display: "flex", fontSize: 48 }, children: "Malaf" },
    });
    const many = h("div", null, h("span", null, "a"), "b");
    expect(Array.isArray(many.props.children)).toBe(true);
    expect(h("span").props).toEqual({});
  });

  it("[OG-02] a child passed as a props.children is kept when no children argument is given", () => {
    expect(h("p", { children: "from props" }).props.children).toBe("from props");
  });

  it("[OG-03] tag names satori cannot draw are refused when the element is built", () => {
    expect(() => h("Div")).toThrow(TypeError);
    expect(() => h("script")).not.toThrow();
    expect(() => h("my-element")).toThrow(TypeError);
  });

  it("[OG-04] the JSX runtime entries and Fragment produce the same tree as h", () => {
    expect(jsx("div", { children: "x" })).toEqual(h("div", null, "x"));
    expect(jsxs("div", { children: ["a", "b"] })).toEqual(h("div", null, "a", "b"));
    expect(Fragment({ children: "f" })).toBe("f");
  });

  it("[OG-05] expandTree calls function components and drops nothing that draws", () => {
    const Badge: OgComponent = (props) =>
      h("span", { style: { color: "red" } }, String(Reflect.get(props, "label")));
    const tree = expandTree(
      h("div", { style: { display: "flex" } }, h(Badge, { label: "new" }), null, false, "tail"),
    );
    expect(tree).toEqual({
      type: "div",
      props: {
        style: { display: "flex" },
        children: [{ type: "span", props: { style: { color: "red" }, children: "new" } }, "tail"],
      },
    });
  });

  it("[OG-06] a top-level array is wrapped in a flex column so satori receives one node", () => {
    const tree = expandTree([h("p", null, "a"), h("p", null, "b")]);
    expect(tree).toEqual({
      type: "div",
      props: {
        style: { display: "flex", flexDirection: "column" },
        children: [
          { type: "p", props: { children: "a" } },
          { type: "p", props: { children: "b" } },
        ],
      },
    });
  });

  it("[OG-07] a tree past the node limit is refused before any drawing (bounded work)", () => {
    const many = Array.from({ length: MAX_OG_NODES + 1 }, (_, index) => `n${index}`);
    expect(() => expandTree(h("div", null, ...many))).toThrow(RangeError);
  });

  it("[OG-08] a deeply nested tree is refused (bounded depth)", () => {
    let node: ReturnType<typeof h> = h("span", null, "deep");
    for (let level = 0; level < 300; level += 1) node = h("div", null, node);
    expect(() => expandTree(node)).toThrow(RangeError);
  });
});
