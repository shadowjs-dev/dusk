/**
 * Shape checks for configuration objects. Shared by `dusk.config.ts` (build time) and the handler
 * options (server start), so both report the same errors. Unknown keys are refused with a suggestion
 * instead of being ignored, because an ignored `secuirty` is a silent loss of protection.
 *
 * @packageDocumentation
 */

/** Edit distance between two strings (iterative, two rows). Shared with the option check of `internal/known-options`. @internal */
export function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The known key closest to `name`: a case-insensitive match, or an edit distance of at most a third
 * of the name's length (at least 1). `undefined` when nothing is close.
 *
 * @param name The key that was written.
 * @param known The keys that are allowed.
 * @returns The suggestion.
 * @example suggestKey("adaptr", ["adapter"]); // "adapter"
 * @since 1.0.0
 */
export function suggestKey(name: string, known: readonly string[]): string | undefined {
  const lowered = name.toLowerCase();
  const exact = known.find((candidate) => candidate.toLowerCase() === lowered);
  if (exact !== undefined) return exact;
  const limit = Math.max(1, Math.floor(name.length / 3));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const d = distance(lowered, candidate.toLowerCase());
    if (d <= limit && d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/** True for a plain object (not null, not an array). @since 1.0.0 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuses a value that is not an object, or one with a key that is not allowed.
 *
 * @param where The name of the value, used in the message (`redirects[0]`).
 * @param value The value.
 * @param allowed The allowed keys.
 * @throws TypeError naming the key, with a suggestion when one is close.
 * @example expectKeys("dusk.config", { adaptr: 1 }, ["adapter"]); // throws
 * @since 1.0.0
 */
export function expectKeys(
  where: string,
  value: unknown,
  allowed: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${where} must be an object.`);
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const hint = suggestKey(key, allowed);
    throw new TypeError(
      `${where}: unknown key "${key}"${hint === undefined ? "" : `; did you mean "${hint}"?`}`,
    );
  }
}
