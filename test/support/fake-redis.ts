import type { RedisClient } from "../../src/server/stores/redis";

/**
 * An in-memory Redis with exactly the commands of `RedisClient` (`get`, `set` with `PX`, `del`, `sAdd`, `sRem`, `sMembers`,
 * `pExpire`) and the behavior a server shows where the store depends on it: a key holds a string or a set (the other
 * use is `WRONGTYPE`), a string expires when the clock reaches its `PX`, a set expires by `pExpire`, a set that loses its
 * last member disappears, reads return copies. Optional jitter makes every command settle after a random number of
 * microtask turns (a seeded generator, so a run is repeatable), which is how overlapping commands from concurrent
 * callers are interleaved the way a network interleaves them.
 */

export interface FakeRedis extends RedisClient {
  /** Every command received, as `"NAME key"`. */
  readonly commands: string[];
  /** Live keys. */
  keys(): string[];
  /** Milliseconds left on a key, or `undefined` when it has none (or does not exist). */
  ttlOf(key: string): number | undefined;
  /** The raw string at a key. */
  raw(key: string): string | undefined;
  /** Makes the next command whose name is in `names` reject. */
  failNext(names: readonly string[], error: Error): void;
}

export interface FakeRedisOptions {
  readonly now?: () => number;
  /** Seed of the jitter; absent: commands settle in order, without extra turns. */
  readonly seed?: number;
  /** Most extra microtask turns a command waits. Default 6. */
  readonly maxTurns?: number;
  /** Without `pExpire` the client is exactly the five-command interface. Default true. */
  readonly withPExpire?: boolean;
}

type Slot =
  | { kind: "string"; value: string; expiresAt: number | undefined }
  | { kind: "set"; members: Set<string>; expiresAt: number | undefined };

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

function generator(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function createFakeRedis(options: FakeRedisOptions = {}): FakeRedis {
  const now = options.now ?? Date.now;
  const random = options.seed === undefined ? undefined : generator(options.seed);
  const maxTurns = options.maxTurns ?? 6;
  const slots = new Map<string, Slot>();
  const commands: string[] = [];
  const failures: { names: readonly string[]; error: Error }[] = [];

  const live = (key: string): Slot | undefined => {
    const slot = slots.get(key);
    if (slot === undefined) return undefined;
    if (slot.expiresAt !== undefined && now() >= slot.expiresAt) {
      slots.delete(key);
      return undefined;
    }
    return slot;
  };

  /** Runs a command after its jitter: the effect happens at the end of the wait, like a server handling it. */
  const command = async <T>(name: string, key: string, effect: () => T): Promise<T> => {
    commands.push(`${name} ${key}`);
    const turns = random === undefined ? 0 : Math.floor(random() * (maxTurns + 1));
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
    const failure = failures.findIndex((item) => item.names.includes(name));
    if (failure !== -1) {
      const [item] = failures.splice(failure, 1);
      if (item !== undefined) throw item.error;
    }
    return effect();
  };

  const client: FakeRedis = {
    commands,
    keys: () => [...slots.keys()].filter((key) => live(key) !== undefined),
    ttlOf(key) {
      const slot = live(key);
      return slot?.expiresAt === undefined ? undefined : slot.expiresAt - now();
    },
    raw(key) {
      const slot = live(key);
      return slot?.kind === "string" ? slot.value : undefined;
    },
    failNext(names, error) {
      failures.push({ names, error });
    },
    get: (key) =>
      command("GET", key, () => {
        const slot = live(key);
        if (slot === undefined) return null;
        if (slot.kind !== "string") throw new TypeError(WRONGTYPE);
        return slot.value;
      }),
    set: (key, value, setOptions) =>
      command("SET", key, () => {
        const px = setOptions?.pxExpire;
        slots.set(key, {
          kind: "string",
          value,
          expiresAt: px === undefined ? undefined : now() + px,
        });
        return "OK";
      }),
    del: (key) =>
      command("DEL", key, () => {
        const existed = live(key) !== undefined;
        slots.delete(key);
        return existed ? 1 : 0;
      }),
    sAdd: (key, member) =>
      command("SADD", key, () => {
        const slot = live(key);
        if (slot !== undefined && slot.kind !== "set") throw new TypeError(WRONGTYPE);
        const members = slot?.kind === "set" ? slot.members : new Set<string>();
        const added = members.has(member) ? 0 : 1;
        members.add(member);
        slots.set(key, { kind: "set", members, expiresAt: slot?.expiresAt });
        return added;
      }),
    sRem: (key, member) =>
      command("SREM", key, () => {
        const slot = live(key);
        if (slot === undefined) return 0;
        if (slot.kind !== "set") throw new TypeError(WRONGTYPE);
        const removed = slot.members.delete(member) ? 1 : 0;
        if (slot.members.size === 0) slots.delete(key);
        return removed;
      }),
    sMembers: (key) =>
      command("SMEMBERS", key, () => {
        const slot = live(key);
        if (slot === undefined) return [];
        if (slot.kind !== "set") throw new TypeError(WRONGTYPE);
        return [...slot.members];
      }),
  };
  if (options.withPExpire !== false) {
    client.pExpire = (key, milliseconds) =>
      command("PEXPIRE", key, () => {
        const slot = live(key);
        if (slot === undefined) return 0;
        slot.expiresAt = now() + milliseconds;
        return 1;
      });
  }
  return client;
}
