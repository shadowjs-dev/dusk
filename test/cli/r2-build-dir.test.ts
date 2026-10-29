import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_MARKER, resolveBuildDir, writeBuildMarker } from "../../src/cli/build-dir";
import { CliError } from "../../src/cli/errors";
import { parseCommandLine } from "../../src/cli/parse";
import { runStart } from "../../src/cli/start";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "dusk-r2-dir-"));
  roots.push(root);
  return root;
}

const flags = { strictPort: false, open: false, verbose: false, log: false, json: true } as const;

describe("dusk start: where the build is", () => {
  it("[DUSK-R2-6] --dir parses for start and preview and is absent by default", () => {
    for (const name of ["start", "preview"]) {
      const parsed = parseCommandLine([name, "--dir", "out"]);
      expect(parsed.kind, name).toBe("run");
      if (parsed.kind === "run") expect(parsed.flags.dir).toBe("out");
    }
    const plain = parseCommandLine(["start"]);
    if (plain.kind === "run") expect(plain.flags.dir).toBeUndefined();
  });

  it("[DUSK-R2-6] without a marker or a flag the build is in dist", async () => {
    const root = project();
    expect(await resolveBuildDir(root, undefined)).toBe(join(root, "dist"));
  });

  it("[DUSK-R2-6] the marker the build wrote names the folder, and --dir wins over it", async () => {
    const root = project();
    await writeBuildMarker(root, join(root, "out", "web"));
    expect(JSON.parse(readFileSync(join(root, BUILD_MARKER), "utf8"))).toEqual({
      outDir: "out/web",
    });
    expect(await resolveBuildDir(root, undefined)).toBe(join(root, "out", "web"));
    expect(await resolveBuildDir(root, "elsewhere")).toBe(join(root, "elsewhere"));
  });

  it("[DUSK-R2-6] the marker folder ignores itself in git", async () => {
    const root = project();
    await writeBuildMarker(root, join(root, "out"));
    expect(readFileSync(join(root, ".dusk", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("[DUSK-R2-6] a later build into dist replaces the marker, so start goes back to dist", async () => {
    const root = project();
    await writeBuildMarker(root, join(root, "out"));
    await writeBuildMarker(root, join(root, "dist"));
    expect(await resolveBuildDir(root, undefined)).toBe(join(root, "dist"));
  });

  it("[DUSK-R2-6] a marker that is corrupt, or names a folder outside the project, is refused", async () => {
    const root = project();
    mkdirSync(join(root, ".dusk"), { recursive: true });
    for (const text of [
      "not json",
      "[]",
      '{"outDir":3}',
      '{"outDir":"../elsewhere"}',
      '{"outDir":"/etc"}',
    ]) {
      writeFileSync(join(root, BUILD_MARKER), text);
      await expect(resolveBuildDir(root, undefined), text).rejects.toBeInstanceOf(CliError);
    }
  });

  it("[DUSK-R2-6] dusk start looks for the build where the marker says, and names that folder", async () => {
    const root = project();
    await writeBuildMarker(root, join(root, "out"));
    await expect(runStart(flags, root)).rejects.toThrow(/no build found in out\b/);
    await expect(runStart({ ...flags, dir: "other" }, root)).rejects.toThrow(
      /no build found in other\b/,
    );
  });

  it("[DUSK-R2-6] dusk start reads the manifest of the marked folder", async () => {
    const root = project();
    await writeBuildMarker(root, join(root, "out"));
    mkdirSync(join(root, "out", "client"), { recursive: true });
    mkdirSync(join(root, "out", "server"), { recursive: true });
    writeFileSync(join(root, "out", "server", "entry.js"), "export const handler = {};");
    writeFileSync(
      join(root, "out", "dusk-manifest.json"),
      JSON.stringify({ adapter: { name: "vercel", outDir: "out/vercel" }, routes: {} }),
    );
    await expect(runStart(flags, root)).rejects.toThrow(/built with the vercel adapter/);
  });

  it("[DUSK-R6-1] a build folder outside the app writes no marker `dusk start` would refuse, and says so", async () => {
    const root = project();
    await expect(writeBuildMarker(root, join(root, "..", "elsewhere"))).rejects.toThrow(
      "is outside the app",
    );
    expect(() => readFileSync(join(root, BUILD_MARKER), "utf8")).toThrow();
  });
});
