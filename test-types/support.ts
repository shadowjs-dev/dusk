/** `true` when `A` and `B` are the same type. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless `T` is `true`. */
export type Expect<T extends true> = T;

/**
 * A minimal Standard Schema for type tests: input `I`, output `O`, no runtime rules beyond the cast.
 * Only the type of the schema matters here; `validate` is a stand-in that the tests never run.
 */
export interface TestSchema<I, O> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "test";
    readonly validate: (value: unknown) => { readonly value: O };
    readonly types?: { readonly input: I; readonly output: O } | undefined;
  };
}

/** Builds a {@link TestSchema} whose input and output types are declared, not inferred. */
export function testSchema<I, O>(): TestSchema<I, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => ({ value: value as O }),
    },
  };
}
