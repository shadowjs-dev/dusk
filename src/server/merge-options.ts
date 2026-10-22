/**
 * The merge of the handler options a generated server entry builds from two sources: the file (`dusk.config.ts`, baked
 * into the bundle as JSON) and the entry (`src/entry-server.ts`). The entry's values win, key by key, at every depth
 * of a plain object.
 *
 * @packageDocumentation
 */

import type { HandlerOptions } from "./types";

/**
 * Keys that are never merged, at any depth: copying them would reach the prototype of the merged object (a
 * prototype-pollution path from `JSON.parse` input or a computed key). A user key with one of these names is ignored.
 * @internal
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Objects one merge may create. A cycle in the input, or a config far beyond any real app, stops here with a
 * RangeError instead of growing without bound. The walk is iterative, so the depth itself is not limited.
 * @internal
 */
const MAX_MERGED_OBJECTS = 10_000;

/** A unit of work: fill `target` from `base` (the file side, may be absent) and `next` (the entry side). @internal */
interface MergeTask {
  readonly target: Record<string, unknown>;
  readonly base: object | undefined;
  readonly next: object;
}

/** True for an object literal or `Object.create(null)`: the only objects the merge descends into. @internal */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The own value of a key, or `undefined`: an inherited name such as `toString` is not a value of the object. @internal */
function ownValue(object: object, key: string): unknown {
  return Object.hasOwn(object, key) ? Reflect.get(object, key) : undefined;
}

/**
 * Merges the handler options of the file (`baked`) with the entry's (`user`). The result is a new object; neither input
 * is changed.
 *
 * The rules, in short (the entry is `user`):
 * - a plain object on both sides is merged key by key, recursively: `security.csp` from the entry keeps the file's
 *   `security.headers`;
 * - any other value replaces the file's: a primitive, `false`, `null`, an array, a function, a class instance (its
 *   reference is kept). An array is never concatenated: `allowedHosts` in the entry replaces the file's list;
 * - `undefined` means "not set": it does NOT erase a file value. A key that neither side sets is absent from the result;
 * - the keys `__proto__`, `constructor` and `prototype` are ignored at every depth;
 * - a merge may create at most 10 000 objects; more throws a RangeError (a cycle in the input).
 *
 * @param baked The file's options, as `serverOptionsFromConfig` returns them.
 * @param user The entry's options (`undefined`: none).
 * @returns The merged options.
 * @throws RangeError when the inputs are cyclic or nest beyond the object bound.
 * @example
 * const options = mergeHandlerOptions(
 *   { security: { allowedHosts: ["example.com"], headers: { frameOptions: "DENY" } } },
 *   { security: { csp: { directives: { "default-src": ["'self'"] } } } },
 * );
 * // security: { allowedHosts: ["example.com"], headers: { frameOptions: "DENY" }, csp: { ... } }
 * @since 1.0.0
 */
export function mergeHandlerOptions(
  baked: Partial<HandlerOptions>,
  user: Partial<HandlerOptions> | undefined,
): Partial<HandlerOptions> {
  const root: Record<string, unknown> = {};
  const tasks: MergeTask[] = [{ target: root, base: baked, next: user ?? {} }];
  let created = 0;
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    created += 1;
    if (created > MAX_MERGED_OBJECTS) {
      throw new RangeError(
        `mergeHandlerOptions: more than ${MAX_MERGED_OBJECTS} objects to merge (a cycle in the options, or an oversized config)`,
      );
    }
    const { target, base, next } = task;
    // The file's values the entry does not name are kept as they are (the same references, never written to).
    if (base !== undefined) {
      for (const key of Object.keys(base)) {
        if (UNSAFE_KEYS.has(key)) continue;
        const value: unknown = Reflect.get(base, key);
        if (value !== undefined) target[key] = value;
      }
    }
    for (const key of Object.keys(next)) {
      if (UNSAFE_KEYS.has(key)) continue;
      const value: unknown = Reflect.get(next, key);
      if (value === undefined) continue;
      if (!isPlainObject(value)) {
        target[key] = value;
        continue;
      }
      // Both sides are plain objects: a fresh object, filled from the two of them. Otherwise the entry's object is
      // the value, with the entry's own undefined keys left out.
      const child: Record<string, unknown> = {};
      target[key] = child;
      const fileValue = base === undefined ? undefined : ownValue(base, key);
      tasks.push({
        target: child,
        base: isPlainObject(fileValue) ? fileValue : undefined,
        next: value,
      });
    }
  }
  return root as Partial<HandlerOptions>;
}
