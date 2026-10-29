import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceFingerprint } from "../../src/vite/fingerprint";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dusk-fp-review-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

describe("fingerprint review", () => {
  it("[DUSK-VITE-REV-8] a source folder that cannot be listed fails, instead of giving the id of an empty one", async () => {
    // `src` is a file: the listing fails with ENOTDIR whoever runs the test (a permission error would need a non-root user).
    write("src", "not a folder");
    await expect(sourceFingerprint(root, "src", undefined)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    // A folder that does not exist is still an empty source: the id of "no files".
    const empty = await sourceFingerprint(join(root, "nowhere"), "src", undefined);
    expect(empty).toMatch(/^[0-9a-f]{16}$/);
  });

  it("[DUSK-VITE-REV-9] the id follows the files in path order, folders included, and a deep tree is walked without recursion", async () => {
    write("src/b.ts", "b");
    write("src/a/z.ts", "z");
    write("src/a.ts", "a");
    write("src/a/y/q.ts", "q");
    write("src/c.ts", "c");
    // Pinned: the walk order (files and folders interleaved by name) is part of every deployment id.
    expect(await sourceFingerprint(root, "src", undefined)).toBe("ffedf4699cc82088");
    const first = await sourceFingerprint(root, "src", undefined);
    expect(await sourceFingerprint(root, "src", undefined)).toBe(first);
    write("src/a/z.ts", "changed");
    expect(await sourceFingerprint(root, "src", undefined)).not.toBe(first);
    let deep = "src/deep";
    for (let level = 0; level < 150; level += 1) deep += "/d";
    write(`${deep}/leaf.ts`, "leaf");
    expect(await sourceFingerprint(root, "src", undefined)).toMatch(/^[0-9a-f]{16}$/);
  });
});
