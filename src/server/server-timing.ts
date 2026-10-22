/**
 * The `Server-Timing` header (W3C Server Timing): the validation of a metric name and description, and the
 * serialization of a list of metrics. A name or description a request, a route or a user supplies reaches a
 * response header here, so both are checked or reduced to safe characters: a header cannot be injected.
 *
 * @packageDocumentation
 */

/** The longest metric name, in characters. @since 1.0.0 */
export const MAX_TIMING_NAME_LENGTH = 64;

/** The longest metric description, in characters; a longer one is cut. @since 1.0.0 */
export const MAX_TIMING_DESCRIPTION_LENGTH = 100;

/** The most distinct application metrics one request records (the same name measured again adds to its total). @since 1.0.0 */
export const MAX_TIMING_METRICS = 20;

/** The names the framework records itself; an application metric cannot take one. */
export const RESERVED_TIMING_NAMES: ReadonlySet<string> = new Set([
  "total",
  "route",
  "loaders",
  "render",
]);

/** An RFC 9110 `token`: the characters a metric name may hold. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** A character that is not safe inside the quoted description: control characters, non-ASCII, `"` and `\`, and the separators. */
const UNSAFE_DESCRIPTION = /[^ -~]|["\\,;]/g;

/**
 * Checks the name of an application metric.
 *
 * @param name The name given to `event.timing.measure` or `event.timing.add`.
 * @returns The name.
 * @throws TypeError when it is not a string of token characters, is empty or longer than 64 characters, or is one of
 *   the names the framework records (`total`, `route`, `loaders`, `render`).
 * @since 1.0.0
 */
export function checkTimingName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_TIMING_NAME_LENGTH) {
    throw new TypeError(
      `A Server-Timing metric name must be a string of 1 to ${MAX_TIMING_NAME_LENGTH} characters.`,
    );
  }
  if (!TOKEN.test(name)) {
    throw new TypeError(
      `The Server-Timing metric name ${JSON.stringify(name)} may hold only letters, digits and the characters !#$%&'*+-.^_\`|~ (no spaces, quotes, commas or semicolons).`,
    );
  }
  if (RESERVED_TIMING_NAMES.has(name)) {
    throw new TypeError(`The Server-Timing metric name "${name}" is used by the framework.`);
  }
  return name;
}

/**
 * Reduces a description to characters that are safe inside the quoted string of a `Server-Timing` entry. Anything else
 * (a control character, a character outside printable ASCII, a quote, a backslash, a comma, a semicolon) becomes `_`; a
 * long description is cut at 100 characters. A description is never refused: a route pattern or a user label must not
 * be able to fail a request.
 *
 * @param description The text.
 * @returns The safe text, or `undefined` when nothing is left.
 * @since 1.0.0
 */
export function cleanTimingDescription(description: unknown): string | undefined {
  if (typeof description !== "string" || description.length === 0) return undefined;
  const cut = description.length > MAX_TIMING_DESCRIPTION_LENGTH;
  const text = (cut ? description.slice(0, MAX_TIMING_DESCRIPTION_LENGTH) : description).replace(
    UNSAFE_DESCRIPTION,
    "_",
  );
  return text.length === 0 ? undefined : text;
}

/** A duration in milliseconds as the header writes it: one decimal, never negative, never `NaN`. */
export function timingDuration(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? (Math.round(ms * 10) / 10).toString() : "0";
}

/** One metric of a response. @since 1.0.0 */
export interface TimingEntry {
  /** A token (the built-in names, or a name {@link checkTimingName} accepted). */
  readonly name: string;
  /** Milliseconds. */
  readonly durationMs: number;
  /** Already reduced by {@link cleanTimingDescription}. */
  readonly description?: string | undefined;
}

/**
 * Serializes metrics as the value of a `Server-Timing` header: `name;desc="text";dur=1.2, other;dur=3`.
 *
 * @param entries The metrics, in output order. A name that is not a token is skipped (defense in depth: callers
 *   check names first).
 * @returns The header value, or `undefined` for an empty list.
 * @example
 * serializeServerTiming([{ name: "total", durationMs: 12.34 }, { name: "db", durationMs: 3, description: "users" }]);
 * // 'total;dur=12.3, db;desc="users";dur=3'
 * @since 1.0.0
 */
export function serializeServerTiming(entries: Iterable<TimingEntry>): string | undefined {
  const parts: string[] = [];
  for (const entry of entries) {
    if (!TOKEN.test(entry.name)) continue;
    const description = cleanTimingDescription(entry.description);
    parts.push(
      `${entry.name}${description === undefined ? "" : `;desc="${description}"`};dur=${timingDuration(entry.durationMs)}`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}
