import type { HydrationData } from "@shadow-js/router";

/**
 * Where the loader data of a single-flight answer goes. A page runs one router, so one registration
 * is kept: `hydrateDusk` registers its router while the app runs, and removes the registration when it
 * is disposed. Without a registration (a page without the router, or a unit test) the data is dropped:
 * the calls still resolve with their value.
 */

type Applier = (data: HydrationData) => Promise<unknown>;

interface Registration {
  readonly apply: Applier;
  readonly report: (error: unknown) => void;
}

let registration: Registration | undefined;

/**
 * Registers the applier of revalidated loader data. Returns the function that removes it, which removes
 * only this registration.
 *
 * @param apply Applies hydration data to the router (`router.applyHydration`).
 * @param report Receives a failure of `apply`; the call that caused it still resolves.
 * @returns A function that removes the registration.
 * @internal
 */
export function registerRevalidation(apply: Applier, report: (error: unknown) => void): () => void {
  const entry: Registration = { apply, report };
  registration = entry;
  return (): void => {
    if (registration === entry) registration = undefined;
  };
}

/** True for the router's hydration data (version 1 with a list of matches). */
function isHydrationData(value: unknown): value is HydrationData {
  if (typeof value !== "object" || value === null) return false;
  return Reflect.get(value, "version") === 1 && Array.isArray(Reflect.get(value, "matches"));
}

/**
 * Applies the loader data a single-flight answer carried. Resolves once the router has rendered it, so
 * the call's own `then` sees the page already updated. Data that is not hydration data is ignored.
 *
 * @param data What the answer's `revalidated` member held.
 * @returns A promise that resolves when the data is applied (or dropped).
 * @internal
 */
export async function applyRevalidated(data: unknown): Promise<void> {
  const current = registration;
  if (current === undefined || !isHydrationData(data)) return;
  try {
    await current.apply(data);
  } catch (error) {
    current.report(error);
  }
}
