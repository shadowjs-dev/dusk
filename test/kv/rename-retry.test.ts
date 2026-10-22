import { describe, expect, it } from "vitest";
import { KV_RENAME_ATTEMPTS, renameWithRetry } from "../../src/node/kv-file";

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

/** A rename that fails with the code `fail` names for an attempt (1-based), counting every attempt. */
function fakeRename(fail: (attempt: number) => string | undefined): {
  rename: (from: string, to: string) => Promise<void>;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    rename: async (): Promise<void> => {
      attempts += 1;
      const code = fail(attempts);
      if (code !== undefined) throw errorWithCode(code);
    },
    attempts: () => attempts,
  };
}

describe("KV file writes on Windows", () => {
  it("[DSK-W-09] a sharing error that clears after two attempts is retried, and the write completes", async () => {
    const fake = fakeRename((attempt) => (attempt <= 2 ? "EBUSY" : undefined));
    await expect(renameWithRetry(fake.rename, "k.tmp", "k.json", "win32")).resolves.toBeUndefined();
    expect(fake.attempts()).toBe(3);
  });

  it("[DSK-W-10] a rename that never succeeds stops after four attempts and rethrows its error", async () => {
    expect(KV_RENAME_ATTEMPTS).toBe(4);
    const fake = fakeRename(() => "EPERM");
    const outcome = await renameWithRetry(fake.rename, "k.tmp", "k.json", "win32").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(Reflect.get(outcome as object, "code")).toBe("EPERM");
    expect(fake.attempts()).toBe(4);
  });

  it("[DSK-W-11] other errors, and every error off Windows, are rethrown at once", async () => {
    const missing = fakeRename(() => "ENOENT");
    await expect(renameWithRetry(missing.rename, "k.tmp", "k.json", "win32")).rejects.toThrow(
      /ENOENT/,
    );
    expect(missing.attempts()).toBe(1);

    const posix = fakeRename((attempt) => (attempt === 1 ? "EBUSY" : undefined));
    await expect(renameWithRetry(posix.rename, "k.tmp", "k.json", "darwin")).rejects.toThrow(
      /EBUSY/,
    );
    expect(posix.attempts()).toBe(1);
  });
});
