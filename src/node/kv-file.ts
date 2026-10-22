/**
 * A {@link KVStore} on the file system: one JSON file per key, written atomically (a temporary file, then a
 * rename). It is for development, tests and a single server that restarts; it is not a shared store. The
 * number of files is not bounded by the store (use TTLs and `list` to prune); the size of one value is.
 *
 * @packageDocumentation
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkKey,
  checkTtl,
  createKeyLock,
  encodeValue,
  KV_LIMITS,
  type KVListOptions,
  type KVListPage,
  type KVStore,
  type KVWriteOptions,
} from "../server/kv-store";

/** Options of {@link createFileKVStore}. @since 1.0.0 */
export interface FileKVStoreOptions {
  /** The folder the files live in (created when first written). */
  readonly directory: string;
  /** Largest value in bytes of JSON text. Default 1 MiB. */
  readonly maxValueBytes?: number;
  /** Clock in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

interface Stored {
  readonly key: string;
  readonly expiresAt: number | null;
  readonly text: string;
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record["key"] === "string" &&
    typeof record["text"] === "string" &&
    (record["expiresAt"] === null || typeof record["expiresAt"] === "number")
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

/** The attempts a rename gets on Windows before its error is rethrown. */
export const KV_RENAME_ATTEMPTS = 4;

/**
 * The codes a Windows rename raises while another process (an editor, the TypeScript server, a virus scanner)
 * holds the target open. They pass once the holder lets go, so a retry is worth it there and nowhere else.
 */
const SHARING_ERRORS: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Renames `from` over `to`, retrying a sharing error on Windows. The retry is immediate (a sleep would stall the
 * write without helping) and bounded by {@link KV_RENAME_ATTEMPTS}. Other platforms get the first error at once.
 *
 * @param rename The rename to run: `fs.promises.rename` in production, a fake in tests.
 * @param from The temporary file.
 * @param to The file to replace.
 * @param platform The platform the retry applies to. Default: this machine's.
 * @returns Resolves when the rename succeeded.
 * @throws The last error when every attempt failed, or the first error that is not a sharing error.
 * @since 1.0.0
 */
export async function renameWithRetry(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
      const retry =
        platform === "win32" &&
        attempt < KV_RENAME_ATTEMPTS &&
        typeof code === "string" &&
        SHARING_ERRORS.has(code);
      if (!retry) throw error;
    }
  }
}

/**
 * Creates the file store. The file name is the SHA-256 of the key, and the file holds the key, so any key
 * (up to 512 characters) fits in a file name.
 *
 * @param options The folder, the value bound and the clock.
 * @returns A {@link KVStore}.
 * @example
 * const kv = createFileKVStore({ directory: ".dusk/kv" });
 * @since 1.0.0
 */
export function createFileKVStore(options: FileKVStoreOptions): KVStore {
  const maxValueBytes = options.maxValueBytes ?? KV_LIMITS.defaultMaxValueBytes;
  if (!Number.isInteger(maxValueBytes) || maxValueBytes < 1) {
    throw new RangeError("createFileKVStore: maxValueBytes must be a positive integer.");
  }
  const now = options.now ?? Date.now;
  const lock = createKeyLock();
  const fileOf = (key: string): string =>
    join(options.directory, `${createHash("sha256").update(key).digest("hex")}.json`);

  /** Reads a file; a missing or damaged file is no entry. Expired entries are removed as found. */
  const read = async (key: string): Promise<Stored | undefined> => {
    let raw: string;
    try {
      raw = await readFile(fileOf(key), "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isStored(parsed)) return undefined;
    if (parsed.expiresAt !== null && now() >= parsed.expiresAt) {
      await remove(key);
      return undefined;
    }
    return parsed;
  };

  const write = async (key: string, text: string, expiresAt: number | null): Promise<void> => {
    await mkdir(options.directory, { recursive: true });
    const file = fileOf(key);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const body: Stored = { key, expiresAt, text };
    await writeFile(temporary, JSON.stringify(body), "utf8");
    await renameWithRetry(rename, temporary, file);
  };

  const remove = async (key: string): Promise<void> => {
    try {
      await unlink(fileOf(key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  return {
    async get(key) {
      checkKey(key);
      const stored = await read(key);
      return stored === undefined ? undefined : (JSON.parse(stored.text) as unknown);
    },
    async set(key, value, write_?: KVWriteOptions) {
      checkKey(key);
      const ttl = checkTtl(write_);
      const text = encodeValue(value, maxValueBytes);
      await lock(key, () => write(key, text, ttl === undefined ? null : now() + ttl * 1000));
    },
    async delete(key) {
      checkKey(key);
      await lock(key, () => remove(key));
    },
    async list(page: KVListOptions = {}): Promise<KVListPage> {
      const prefix = page.prefix ?? "";
      const limit = page.limit ?? KV_LIMITS.defaultListLimit;
      if (!Number.isInteger(limit) || limit < 1 || limit > KV_LIMITS.maxListLimit) {
        throw new RangeError(
          `KVStore.list: limit must be an integer from 1 to ${KV_LIMITS.maxListLimit}.`,
        );
      }
      let names: string[];
      try {
        names = await readdir(options.directory);
      } catch (error) {
        if (isMissing(error)) return { keys: [], cursor: undefined };
        throw error;
      }
      const keys: string[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        let raw: string;
        try {
          raw = await readFile(join(options.directory, name), "utf8");
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        const parsed: unknown = JSON.parse(raw);
        if (!isStored(parsed)) continue;
        if (parsed.expiresAt !== null && now() >= parsed.expiresAt) continue;
        if (!parsed.key.startsWith(prefix)) continue;
        if (page.cursor !== undefined && !(parsed.key > page.cursor)) continue;
        keys.push(parsed.key);
      }
      keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const shown = keys.slice(0, limit);
      return { keys: shown, cursor: keys.length > limit ? shown[shown.length - 1] : undefined };
    },
    async increment(key, by = 1, write_?: KVWriteOptions) {
      checkKey(key);
      const ttl = checkTtl(write_);
      if (typeof by !== "number" || !Number.isFinite(by))
        throw new TypeError("KVStore.increment: by must be a finite number.");
      return lock(key, async () => {
        const current = await read(key);
        let base = 0;
        let expiresAt: number | null = ttl === undefined ? null : now() + ttl * 1000;
        if (current !== undefined) {
          const parsed = JSON.parse(current.text) as unknown;
          if (typeof parsed !== "number")
            throw new TypeError("KVStore.increment: the value is not a number.");
          base = parsed;
          expiresAt = current.expiresAt;
        }
        const next = base + by;
        if (!Number.isFinite(next))
          throw new RangeError("KVStore.increment: the result is not finite.");
        await write(key, JSON.stringify(next), expiresAt);
        return next;
      });
    },
  };
}
