import { HttpError } from "../internal/http-error";
import type { StandardSchemaV1 } from "./standard-schema";
import type { ValidationIssue } from "./types";

/** Limits on the validation issues sent to a client. @since 1.0.0 */
export const ISSUE_LIMITS: Readonly<{
  maxIssues: number;
  maxMessageLength: number;
  maxPathLength: number;
}> = Object.freeze({ maxIssues: 20, maxMessageLength: 200, maxPathLength: 16 });

/**
 * Thrown when input does not pass its schema. It is an {@link HttpError} with status 400 whose
 * `data` carries the (bounded) issues, so the client can show them next to its fields.
 *
 * @example
 * try { await createPost(input); } catch (error) { if (error instanceof ValidationError) show(error.issues); }
 * @since 1.0.0
 */
export class ValidationError extends HttpError {
  /** The issues, at most 20, each with a short message and a path. */
  readonly issues: readonly ValidationIssue[];

  /** @param issues The issues reported by the schema. */
  constructor(issues: readonly ValidationIssue[]) {
    super(400, "Invalid input", { data: { issues }, expose: true });
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Converts a path segment (a key or `{ key }`) to something a client can show. */
function segmentOf(segment: PropertyKey | { readonly key: PropertyKey }): string | number {
  const key = typeof segment === "object" ? segment.key : segment;
  if (typeof key === "number") return key;
  if (typeof key === "symbol") return key.description ?? "symbol";
  return key;
}

/** Bounds and normalizes the issues of a schema result for the client. @internal */
export function boundIssues(
  issues: ReadonlyArray<{
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
  }>,
): ValidationIssue[] {
  return issues.slice(0, ISSUE_LIMITS.maxIssues).map((issue) => ({
    message: String(issue.message).slice(0, ISSUE_LIMITS.maxMessageLength),
    path: (issue.path ?? []).slice(0, ISSUE_LIMITS.maxPathLength).map(segmentOf),
  }));
}

/**
 * Validates `value` with a Standard Schema.
 *
 * @param schema Any Standard Schema v1 (Zod, Valibot, ArkType, ...).
 * @param value Untrusted input.
 * @returns The schema's output.
 * @throws ValidationError (status 400) when the schema reports issues.
 * @example
 * const input = await validate(z.object({ title: z.string() }), body);
 * @since 1.0.0
 */
export async function validate<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<Output> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) throw new ValidationError(boundIssues(result.issues));
  return result.value;
}
