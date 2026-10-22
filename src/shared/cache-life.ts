/**
 * Named cache lifetimes (`cacheLife` profiles) for `cacheData`, `cachedFetch` and the cache-control of
 * server functions. A profile has three times, in seconds:
 *
 * - `stale`: how long a client may reuse a response without asking the server (the `max-age` of
 *   responses that name a profile);
 * - `revalidate`: how long a cached value is fresh on the server; after it, the value is served once
 *   more while one background render refreshes it;
 * - `expire`: when the cached value is dropped, however it is used.
 *
 * The presets are the ones of `seconds`, `minutes`, `hours`, `days`, `weeks` and `max`. A file can
 * add or replace profiles (`cacheLife` in `dusk.config.ts`); the same validation runs at build time and
 * at server start.
 *
 * @packageDocumentation
 */

import { expectKeys, isRecord } from "./check";

/** The three lifetimes of a profile, in seconds. @since 1.0.0 */
export interface CacheLifeProfile {
  readonly stale: number;
  readonly revalidate: number;
  readonly expire: number;
}

/** The built-in profile names. @since 1.0.0 */
export type CacheLifePreset = "seconds" | "minutes" | "hours" | "days" | "weeks" | "max";

/** The built-in profiles. @since 1.0.0 */
export const CACHE_LIFE_PRESETS: Readonly<Record<CacheLifePreset, CacheLifeProfile>> =
  Object.freeze({
    seconds: { stale: 1, revalidate: 1, expire: 60 },
    minutes: { stale: 300, revalidate: 60, expire: 3600 },
    hours: { stale: 300, revalidate: 3600, expire: 86_400 },
    days: { stale: 300, revalidate: 86_400, expire: 604_800 },
    weeks: { stale: 300, revalidate: 604_800, expire: 2_592_000 },
    max: { stale: 300, revalidate: 2_592_000, expire: 31_536_000 },
  });

const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PROFILE_KEYS = ["stale", "revalidate", "expire"] as const;
const MAX_SECONDS = 31_536_000 * 10;

function seconds(where: string, value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > MAX_SECONDS
  ) {
    throw new TypeError(
      `${where} must be an integer number of seconds from ${minimum} to ${MAX_SECONDS}.`,
    );
  }
  return value;
}

/**
 * The profiles in force: the presets, with the given profiles added or replacing them. Every profile is
 * checked: a name is lowercase letters, digits and dashes; `revalidate` is at least 1 second and `expire`
 * is at least `revalidate`.
 *
 * @param custom The profiles of the configuration, or `undefined`.
 * @returns The profiles by name.
 * @throws TypeError naming the profile and the rule it breaks.
 * @example resolveCacheLife({ quick: { stale: 0, revalidate: 5, expire: 10 } }).quick?.expire; // 10
 * @since 1.0.0
 */
export function resolveCacheLife(custom: unknown): Readonly<Record<string, CacheLifeProfile>> {
  const profiles: Record<string, CacheLifeProfile> = { ...CACHE_LIFE_PRESETS };
  if (custom === undefined) return profiles;
  if (!isRecord(custom)) throw new TypeError("cacheLife must be an object of named profiles.");
  for (const [name, value] of Object.entries(custom)) {
    if (!PROFILE_NAME.test(name)) {
      throw new TypeError(
        `cacheLife: the profile name ${JSON.stringify(name)} must be lowercase letters, digits and dashes (name).`,
      );
    }
    const where = `cacheLife.${name}`;
    expectKeys(where, value, PROFILE_KEYS);
    const stale = seconds(`${where}.stale`, value["stale"], 0);
    const revalidate = seconds(`${where}.revalidate`, value["revalidate"], 1);
    const expire = seconds(`${where}.expire`, value["expire"], 0);
    if (expire < revalidate) {
      throw new TypeError(`${where}.expire must be at least revalidate (${revalidate} seconds).`);
    }
    profiles[name] = { stale, revalidate, expire };
  }
  return profiles;
}

/**
 * The profile of a name.
 *
 * @param profiles The profiles in force (see {@link resolveCacheLife}).
 * @param name The profile name.
 * @returns The profile.
 * @throws TypeError for an unknown name (listing the known ones).
 * @since 1.0.0
 */
export function cacheLifeOf(
  profiles: Readonly<Record<string, CacheLifeProfile>>,
  name: string,
): CacheLifeProfile {
  const found = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (found === undefined) {
    throw new TypeError(
      `cacheLife profile "${name}" is not defined (known: ${Object.keys(profiles).join(", ")}).`,
    );
  }
  return found;
}
