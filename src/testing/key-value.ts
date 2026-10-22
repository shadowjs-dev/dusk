import type { KeyValueClient } from "../server/cache-store";

/**
 * A test double for a Redis-like key-value client, for the shared-store adapter of the ISR cache. It
 * has no network: keys live in a Map, with the behavior a real server shows where it matters to the
 * adapter. A key holds one kind of value (a string or a set), and using it as the other kind rejects
 * with `WRONGTYPE`. A key with a millisecond expiry disappears when the injected clock reaches it. A
 * set that loses its last member disappears. Reads return copies, so a caller cannot change what is
 * stored.
 */

/** A key-value client that also counts the commands it received. @since 1.0.0 */
export interface FakeKeyValue extends KeyValueClient {
  /** Number of live keys. */
  readonly size: number;
  /** Every command received, in order, as `"NAME key"` (for asserting the number of round trips). */
  readonly commands: readonly string[];
}

type Slot =
  | { readonly kind: "string"; readonly value: string; readonly expiresAt: number | undefined }
  | { readonly kind: "set"; readonly members: Set<string> };

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

/**
 * Creates a fake key-value client.
 *
 * @param options The clock used for expiry (epoch milliseconds).
 * @returns The client.
 * @example
 * const kv = createFakeKeyValue({ now: () => clock });
 * await kv.set("k", "v", { pxExpire: 1000 });
 * @since 1.0.0
 */
export function createFakeKeyValue(options: { readonly now?: () => number } = {}): FakeKeyValue {
  const now = options.now ?? Date.now;
  const slots = new Map<string, Slot>();
  const log: string[] = [];

  /** The live slot of a key: an expired string is removed first, as a server does on access. */
  const live = (key: string): Slot | undefined => {
    const slot = slots.get(key);
    if (slot === undefined) return undefined;
    if (slot.kind === "string" && slot.expiresAt !== undefined && now() >= slot.expiresAt) {
      slots.delete(key);
      return undefined;
    }
    return slot;
  };

  const record = (command: string, key: string): void => {
    log.push(`${command} ${key}`);
  };

  return {
    get size(): number {
      for (const key of [...slots.keys()]) live(key);
      return slots.size;
    },
    get commands(): readonly string[] {
      return [...log];
    },
    get(key) {
      record("GET", key);
      const slot = live(key);
      if (slot === undefined) return Promise.resolve(null);
      if (slot.kind !== "string") return Promise.reject(new TypeError(WRONGTYPE));
      return Promise.resolve(slot.value);
    },
    set(key, value, setOptions) {
      record("SET", key);
      const pxExpire = setOptions?.pxExpire;
      slots.set(key, {
        kind: "string",
        value,
        expiresAt: pxExpire === undefined ? undefined : now() + pxExpire,
      });
      return Promise.resolve("OK");
    },
    del(key) {
      record("DEL", key);
      const existed = live(key) !== undefined;
      slots.delete(key);
      return Promise.resolve(existed ? 1 : 0);
    },
    sAdd(key, member) {
      record("SADD", key);
      const slot = live(key);
      if (slot !== undefined && slot.kind !== "set")
        return Promise.reject(new TypeError(WRONGTYPE));
      const members = slot?.kind === "set" ? slot.members : new Set<string>();
      const added = members.has(member) ? 0 : 1;
      members.add(member);
      slots.set(key, { kind: "set", members });
      return Promise.resolve(added);
    },
    sRem(key, member) {
      record("SREM", key);
      const slot = live(key);
      if (slot === undefined) return Promise.resolve(0);
      if (slot.kind !== "set") return Promise.reject(new TypeError(WRONGTYPE));
      const removed = slot.members.delete(member) ? 1 : 0;
      if (slot.members.size === 0) slots.delete(key);
      return Promise.resolve(removed);
    },
    sMembers(key) {
      record("SMEMBERS", key);
      const slot = live(key);
      if (slot === undefined) return Promise.resolve([]);
      if (slot.kind !== "set") return Promise.reject(new TypeError(WRONGTYPE));
      return Promise.resolve([...slot.members]);
    },
  };
}
