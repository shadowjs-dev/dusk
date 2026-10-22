/**
 * Compile-time checks for the component shapes `hydrateDusk` accepts. Vitest does not run this
 * file; `tsc -p packages/dusk/tsconfig.json` does, so a wrong type fails the typecheck.
 */
import type { JSX } from "@shadow-js/web";
import { describe, expectTypeOf, it } from "vitest";
import { type HydrateDuskOptions, hydrateDusk } from "../../src/client/hydrate";
import type { DuskRuntimeManifest } from "../../src/server/types";

function Typed(_props: { children?: JSX.Element }): JSX.Element {
  throw new Error("never called: types only");
}
function Bare(): JSX.Element {
  throw new Error("never called: types only");
}
function WithOthers(_props: { children?: JSX.Element; title: string }): JSX.Element {
  throw new Error("never called: types only");
}

describe("hydrateDusk App", () => {
  it("[SHT-01] accepts every component shape the server manifest accepts", () => {
    expectTypeOf(Typed).toExtend<DuskRuntimeManifest["App"]>();
    expectTypeOf(Bare).toExtend<DuskRuntimeManifest["App"]>();
    expectTypeOf(WithOthers).toExtend<DuskRuntimeManifest["App"]>();
    expectTypeOf(Typed).toExtend<NonNullable<HydrateDuskOptions["App"]>>();
    expectTypeOf(Bare).toExtend<NonNullable<HydrateDuskOptions["App"]>>();
    expectTypeOf(WithOthers).toExtend<NonNullable<HydrateDuskOptions["App"]>>();
  });

  it("[SHT-02] hydrateDusk({ App }) takes a component whose children prop is a JSX element", () => {
    const call = (): unknown => hydrateDusk({ routes: [], App: Typed });
    expectTypeOf(call).toBeFunction();
  });
});
