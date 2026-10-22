import { availableParallelism } from "node:os";

/** The environment variable that sets the worker count of `dusk start` and of the generated `server.mjs`. @since 1.0.0 */
export const WORKERS_ENV = "DUSK_WORKERS";

/** The most workers `"auto"` starts, however many cores the machine has. @since 1.0.0 */
export const AUTO_WORKERS_CAP = 16;

/** The most workers an explicit count may ask for. A larger number is a typo, not a plan. */
const MAX_WORKERS = 256;

/**
 * How many workers a `workers` setting means: `"auto"` is one per available core (`os.availableParallelism()`, which
 * honors CPU affinity and container limits), at most {@link AUTO_WORKERS_CAP}; a number is taken as it is; absent is 1.
 *
 * @param value A whole number from 1 to 256, `"auto"`, or `undefined` for a single process.
 * @param name What to call the setting in an error, for example `"workers"` or `"--workers"`.
 * @returns The number of workers (1 means a single process, with no primary).
 * @throws RangeError for a number that is not a whole number from 1 to 256.
 * @throws TypeError for any other value.
 * @example
 * resolveWorkerCount("auto"); // 4 on a four-core machine
 * resolveWorkerCount(undefined); // 1
 * @since 1.0.0
 */
export function resolveWorkerCount(value: unknown, name = "workers"): number {
  if (value === undefined) return 1;
  if (value === "auto") return Math.max(1, Math.min(AUTO_WORKERS_CAP, availableParallelism()));
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > MAX_WORKERS) {
      throw new RangeError(
        `${name} must be a whole number from 1 to ${MAX_WORKERS}, or "auto" (got ${String(value)}).`,
      );
    }
    return value;
  }
  throw new TypeError(`${name} must be a number or "auto" (got ${typeof value}).`);
}

/**
 * Reads a worker count from text (a flag value or an environment variable): `"auto"` or a whole number. An empty or
 * absent text is no setting.
 *
 * @param text The text.
 * @param name What to call the setting in an error.
 * @returns A number, `"auto"`, or `undefined` for no setting.
 * @throws RangeError when the text is neither `"auto"` nor a whole number from 1 to 256.
 * @since 1.0.0
 */
export function parseWorkers(
  text: string | undefined,
  name = "workers",
): number | "auto" | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const trimmed = text.trim();
  if (trimmed === "auto") return "auto";
  if (!/^\d{1,4}$/.test(trimmed)) {
    throw new RangeError(
      `${name} must be a whole number from 1 to ${MAX_WORKERS}, or "auto" (got "${text}").`,
    );
  }
  const count = Number(trimmed);
  resolveWorkerCount(count, name);
  return count;
}
