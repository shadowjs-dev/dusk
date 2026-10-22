/**
 * The result shapes of the mutation model, shared by the server and the browser. A server function
 * returns `fail(status, data)` to answer a call with a failure that is not an exception (the call
 * itself succeeded); a thrown error is an error. A form post without JavaScript carries the outcome
 * to the page it is sent back to in a signed, one-time flash cookie: the shapes below. No imports, so
 * both sides can use them.
 */

/** Name of the signed one-time cookie that carries a submission result or a flash value to the next page. @since 1.0.0 */
export const FLASH_COOKIE = "__dusk_flash";

/** Id of the `<script type="application/json">` element with the flash payload of a page. @since 1.0.0 */
export const FLASH_ELEMENT_ID = "__shadow_flash";

/** Longest flash payload, in characters of its encoded cookie value. Larger outcomes keep their status only. @since 1.0.0 */
export const FLASH_MAX_CHARS = 3000;

/** The brand of a failure value: the marker field, always `1`. @internal */
const FAILURE_MARK = "__duskFailure";

/**
 * A failure returned by a server function with {@link fail}: the call succeeded and answers with a
 * status and data (typically field problems) for the page to show.
 * @since 1.0.0
 */
export interface ActionFailure<Data = unknown> {
  /** The brand: `1`. */
  readonly __duskFailure: 1;
  /** The HTTP status the failure stands for (400 to 599). */
  readonly status: number;
  /** What the page shows: field problems, a message, anything JSON-able. */
  readonly data: Data;
}

/**
 * Makes a failure result. Return it from a server function, or from a form function, instead of
 * throwing: the call still succeeds on the wire, the browser sees `failed` and the page keeps its
 * input. A thrown `HttpError` is the other way to answer with an error; it is shown as an error result.
 *
 * @param status An HTTP status from 400 to 599.
 * @param data What to show: `{ issues: [{ message, path }] }` puts problems on fields.
 * @returns The failure value.
 * @throws RangeError when `status` is not an integer from 400 to 599.
 * @example
 * export const signUp = serverFn({ form: true }, (input) =>
 *   taken(input.email) ? fail(409, { issues: [{ message: "Taken", path: ["email"] }] }) : { ok: true },
 * );
 * @since 1.0.0
 */
export function fail<Data = undefined>(status: number, data?: Data): ActionFailure<Data> {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`fail(): the status must be an integer from 400 to 599, got ${status}.`);
  }
  return { [FAILURE_MARK]: 1, status, data: data as Data };
}

/**
 * True for a value {@link fail} made (or one that has its shape, after the wire).
 *
 * @param value Anything a server function returned.
 * @returns `true` for a failure.
 * @example
 * if (isFailure(result)) showProblems(result.data);
 * @since 1.0.0
 */
export function isFailure(value: unknown): value is ActionFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, FAILURE_MARK) === 1 &&
    typeof Reflect.get(value, "status") === "number"
  );
}

/** A field problem: a message and the path of the field (`["lines", 0, "sku"]`). @internal */
export interface WireIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/** The error of a failed submission as it is kept in a flash. @since 1.0.0 */
export interface WireError {
  readonly status: number;
  readonly message: string;
  readonly issues?: readonly WireIssue[];
  readonly data?: unknown;
}

/**
 * One submission outcome as it is carried to the next page: the key of the function (its id), and
 * either the value it returned (a success, or a `fail()` result) or the error it threw.
 * @since 1.0.0
 */
export interface WireSubmission {
  readonly key: string;
  readonly status: "success" | "error";
  readonly value?: unknown;
  readonly error?: WireError;
}

/**
 * Everything a flash carries: the last submission outcome and one application value
 * (`setFlash`). Both are read once and cleared by the page that renders them.
 * @since 1.0.0
 */
export interface FlashPayload {
  readonly submission?: WireSubmission;
  readonly flash?: unknown;
}
