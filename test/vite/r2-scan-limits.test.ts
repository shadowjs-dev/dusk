import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { referencedImages } from "../../src/vite/image-variants";
import { analyzeFile, discoverProject, scanServerFns } from "../../src/vite/project";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(join(dir, "src", "locked"), 0o755);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "dusk-r2-scan-"));
  dirs.push(root);
  return root;
}

describe("referencedImages: folders that cannot be read", () => {
  it("[DUSK-R2-7] a missing public folder or source folder is fine (ENOENT, ENOTDIR)", async () => {
    const root = temp();
    expect(await referencedImages(root, join(root, "public"), [])).toEqual([]);
    writeFileSync(join(root, "src"), "a file where the folder should be");
    expect(await referencedImages(root, join(root, "public"), [])).toEqual([]);
  });

  it("[DUSK-R2-7] a folder that exists but cannot be read (EACCES) is an error, not an empty list", async () => {
    const root = temp();
    mkdirSync(join(root, "src", "locked"), { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "src", "locked", "a.ts"), 'const a = "/x.png";');
    chmodSync(join(root, "src", "locked"), 0o000);
    await expect(referencedImages(root, join(root, "public"), [])).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});

describe("referencedImages: scan limits", () => {
  it("[DUSK-R5-2] a source folder of more than 20 000 files warns that the rest was not read", async () => {
    const root = temp();
    const folder = join(root, "src", "many");
    mkdirSync(folder, { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    for (let index = 0; index < 20_001; index += 1) {
      writeFileSync(join(folder, `f${index}.ts`), "export const x = 1;\n");
    }
    const warn = vi.fn();
    await referencedImages(root, join(root, "public"), [], warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/imageVariants.*20000.*source files/s);
  }, 60_000);

  it("[DUSK-R5-2] a source file over 1 MB is skipped with a warning that names it, and its image is not prepared", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "public", "hero.png"), "x");
    writeFileSync(
      join(root, "src", "big.tsx"),
      `const a = "/hero.png";\n// ${"x".repeat(1024 * 1024)}\n`,
    );
    const warn = vi.fn();
    expect(await referencedImages(root, join(root, "public"), [], warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/imageVariants.*1\.0 MiB.*src\/big\.tsx/s);
  });

  it("[DUSK-R5-2] a small project warns about nothing", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "public", "hero.png"), "x");
    writeFileSync(join(root, "src", "a.tsx"), 'const a = "/hero.png";\n');
    const warn = vi.fn();
    expect(await referencedImages(root, join(root, "public"), [], warn)).toEqual(["hero.png"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("server function scan limits", () => {
  it("[DUSK-R2-7] a source file over 2 MB that holds a server function is skipped with a warning naming it", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    const big = join(root, "src", "big.ts");
    writeFileSync(
      big,
      `export const a = serverFn({}, async () => 1);\n// ${"x".repeat(2 * 1024 * 1024)}\n`,
    );
    const warn = vi.fn();
    expect(await analyzeFile(big, root, new Map(), warn)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/big\.ts.*2 MB|2 MB.*big\.ts/s);
  });

  it("[DUSK-R2-7] a big file that mentions no server function is skipped without a warning", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    const big = join(root, "src", "data.ts");
    writeFileSync(big, `export const data = "${"x".repeat(2 * 1024 * 1024)}";\n`);
    const warn = vi.fn();
    expect(await analyzeFile(big, root, new Map(), warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("[DUSK-R2-7] a source folder of more than 20 000 files stops the scan with a warning that says how many were read", async () => {
    const root = temp();
    const folder = join(root, "src", "many");
    mkdirSync(folder, { recursive: true });
    for (let index = 0; index < 20_001; index += 1) {
      writeFileSync(join(folder, `f${index}.ts`), "export const x = 1;\n");
    }
    const warn = vi.fn();
    await scanServerFns(discoverProject(root, "src"), new Map(), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/20000|20 000|20,000/);
  }, 60_000);

  it("[DUSK-R2-7] a small folder warns about nothing", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
    const warn = vi.fn();
    await scanServerFns(discoverProject(root, "src"), new Map(), warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
