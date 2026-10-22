import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateRouteTree, scanRoutes } from "@shadow-js/router/vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Scale checks for the route scanner and generator, run by Dusk's vite plugin on every route change. The trees are
 * real files on disk and the scanner and generator are the real ones (no mocks). Each group of 50 files holds one
 * `_layout.tsx` and 49 pages, mixing static pages, `index` pages in nested folders and dynamic `[id]` pages.
 */

const PAGE = "export default function Page() { return null }\n";
const LAYOUT = "export default function Layout(props: { children?: unknown }) { return null }\n";
const GROUP = 50;
const SMALL = 1_000;
const LARGE = 10_000;

interface Tree {
  readonly root: string;
  readonly routesDir: string;
  readonly generatedFile: string;
  /** Every route file written, relative to `routesDir` with POSIX separators. */
  readonly files: readonly string[];
  readonly layouts: number;
  readonly pages: number;
}

/** Writes `total` route files (layouts included) into a fresh temp directory. */
function writeTree(total: number): Tree {
  const root = mkdtempSync(join(tmpdir(), "dusk-route-scale-"));
  const routesDir = join(root, "routes");
  const generatedFile = join(root, "routeTree.gen.ts");
  const files: string[] = [];
  const emit = (relative: string, content: string): void => {
    const target = join(routesDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    files.push(relative);
  };

  let layouts = 0;
  for (let group = 0, start = 0; start < total; group++, start += GROUP) {
    const size = Math.min(GROUP, total - start);
    const dir = `g${group}`;
    emit(`${dir}/_layout.tsx`, LAYOUT);
    layouts++;
    for (let j = 1; j < size; j++) {
      if (j % 3 === 0) {
        emit(`${dir}/page${j}.tsx`, PAGE);
      } else if (j % 3 === 1) {
        emit(`${dir}/section${j}/index.tsx`, PAGE);
      } else {
        emit(`${dir}/section${j}/[id].tsx`, PAGE);
      }
    }
  }

  return { root, routesDir, generatedFile, files, layouts, pages: total - layouts };
}

async function scanAndGenerate(tree: Tree): Promise<string> {
  const scan = await scanRoutes({ routesDir: tree.routesDir });
  return generateRouteTree(scan, { generatedFile: tree.generatedFile });
}

async function timeOnce(tree: Tree): Promise<number> {
  const started = performance.now();
  await scanAndGenerate(tree);
  return performance.now() - started;
}

/** The fastest of three runs: the least noisy estimate of the cost. */
async function bestOfThree(tree: Tree): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    best = Math.min(best, await timeOnce(tree));
  }
  return best;
}

describe("route tree at scale", () => {
  let small: Tree;
  let large: Tree;

  beforeAll(() => {
    small = writeTree(SMALL);
    large = writeTree(LARGE);
  });

  afterAll(() => {
    rmSync(small?.root ?? "", { recursive: true, force: true });
    rmSync(large?.root ?? "", { recursive: true, force: true });
  });

  it("[RT-SCALE-01] finds every route file in trees of 1,000 and 10,000 files", async () => {
    for (const tree of [small, large]) {
      const scan = await scanRoutes({ routesDir: tree.routesDir });

      expect(scan.files.length).toBe(tree.files.length);
      expect(new Set(scan.files)).toEqual(new Set(tree.files));

      const pages = scan.entries.filter((entry) => entry.kind === "page");
      const layouts = scan.entries.filter((entry) => entry.kind === "layout");
      expect(pages.length).toBe(tree.pages);
      expect(layouts.length).toBe(tree.layouts);
    }
  });

  it("[RT-SCALE-02] generates the same route tree text on every run", async () => {
    for (const tree of [small, large]) {
      const first = await scanAndGenerate(tree);
      const second = await scanAndGenerate(tree);
      expect(second).toBe(first);
    }
  });

  it("[RT-SCALE-03] scans and generates 10,000 routes in under 20x the time of 1,000", async () => {
    let ratio = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3 && !(ratio < 20); attempt++) {
      const smallMs = await bestOfThree(small);
      const largeMs = await bestOfThree(large);
      ratio = largeMs / smallMs;
    }
    expect(ratio, "time ratio of 10,000 routes to 1,000 routes").toBeLessThan(20);
  });

  it("[RT-SCALE-04] generates a route tree under 12x the size of the 1,000-route tree at 10,000 routes", async () => {
    const smallText = await scanAndGenerate(small);
    const largeText = await scanAndGenerate(large);
    const ratio = largeText.length / smallText.length;
    expect(ratio, "size ratio of 10,000 routes to 1,000 routes").toBeLessThan(12);
  });
});
