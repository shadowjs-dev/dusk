import { distance } from "../shared/check";

/**
 * Rejects option names a function does not know. A misspelled option (`staticDir` for `static`)
 * would otherwise be ignored without a word, and the server would run without what the caller meant
 * to turn on.
 */

/** The known name closest to `name`, when it is close enough to be a typo. */
function closest(name: string, known: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    const prefix = candidate.startsWith(name) || name.startsWith(candidate);
    const score = prefix ? 1 : d;
    if (score < bestDistance) {
      bestDistance = score;
      best = candidate;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

/**
 * Throws a TypeError naming the first option of `options` that is not in `known`, with the closest
 * known name as a hint.
 *
 * @param where Name shown in the message, such as `"serve"`.
 * @param options The object the caller passed (null and non-objects are ignored here).
 * @param known The accepted names.
 * @throws TypeError for an unknown name.
 * @since 1.0.0
 */
export function assertKnownOptions(
  where: string,
  options: unknown,
  known: ReadonlySet<string>,
): void {
  if (typeof options !== "object" || options === null) return;
  for (const key of Object.keys(options)) {
    if (known.has(key)) continue;
    const hint = closest(key, known);
    const suggestion = hint === undefined ? "." : `. Did you mean "${hint}"?`;
    throw new TypeError(
      `${where}: unknown option "${key}"${suggestion} Known options: ${[...known].join(", ")}.`,
    );
  }
}
