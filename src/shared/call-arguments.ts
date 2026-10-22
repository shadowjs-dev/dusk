/**
 * The argument list of a server function call: `[input?: I]` when `undefined` is a valid input (no
 * schema, or a schema of an optional value), `[input: I]` otherwise. The server function and the
 * browser stub that stands for it use this one type, so a call that compiles on one side compiles
 * on the other.
 * @since 1.0.0
 */
export type CallArguments<I> = undefined extends I ? [input?: I] : [input: I];
