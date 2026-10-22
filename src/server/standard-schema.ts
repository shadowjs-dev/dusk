/**
 * The Standard Schema v1 interface (https://standardschema.dev), inlined so that Zod, Valibot,
 * ArkType and any other conforming library work without a dependency on any of them.
 * @since 1.0.0
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

/** The `~standard` member of a {@link StandardSchemaV1}. @since 1.0.0 */
export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
  /** Inference-only. Never read at runtime. */
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

/** Result of validating: a value, or issues. @since 1.0.0 */
export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

/** One problem found by a schema. @since 1.0.0 */
export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** The output type of a schema. @since 1.0.0 */
export type InferOutput<S extends StandardSchemaV1> = NonNullable<
  S["~standard"]["types"]
>["output"];

/** The input type of a schema. @since 1.0.0 */
export type InferInput<S extends StandardSchemaV1> = NonNullable<S["~standard"]["types"]>["input"];

/**
 * True when `value` has the Standard Schema shape. Used to accept any conforming library.
 *
 * @param value Anything.
 * @returns Whether `value` can validate.
 * @example
 * isStandardSchema(z.string()); // true for Zod, Valibot, ArkType
 * @since 1.0.0
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== "object" && typeof value !== "function") return false;
  if (value === null) return false;
  const props: unknown = Reflect.get(value, "~standard");
  return (
    typeof props === "object" &&
    props !== null &&
    Reflect.get(props, "version") === 1 &&
    typeof Reflect.get(props, "validate") === "function"
  );
}
