import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRouteTree, scanRoutes } from "@shadow-js/router/vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileImages } from "../../src/metadata/file-images";
import { ConventionError, discoverConventions } from "../../src/vite/conventions";
import { attachFileImages, FILE_IMAGES_ID, injectFileImages } from "../../src/vite/file-images";

/**
 * The static metadata images written into the generated route tree. The text under test is what the router's own
 * generator writes for a real routes folder, so a change of its format that this step relied on fails here.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dusk-file-images-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function treeOf(files: Record<string, string>): Promise<string> {
  const routesDir = join(root, "routes");
  for (const [path, content] of Object.entries(files)) {
    const target = join(routesDir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const scan = await scanRoutes({ routesDir });
  return generateRouteTree(scan, { generatedFile: join(root, "routeTree.gen.ts") });
}

const image = (path: string): FileImages => ({
  openGraph: { path, hash: "a1b2c3d4", type: "image/png", width: 1200, height: 630 },
});
const LAYOUT = "export default function Layout() { return null }\n";
const PAGE = "export default function Page() { return null }\n";

describe("file images in the generated route tree", () => {
  it("[CNV-40] each route that carries images gets a fileImages property right after its id; the others are untouched", async () => {
    const tree = await treeOf({ "_layout.tsx": LAYOUT, "index.tsx": PAGE, "about.tsx": PAGE });
    const attached = new Map<string, FileImages>([["/_layout", image("/opengraph-image.png")]]);
    const out = injectFileImages(tree, attached);
    const lines = out.split("\n");
    const at = lines.indexOf('  id: "/_layout",');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(
      `  fileImages: __duskFileImages(${JSON.stringify(image("/opengraph-image.png"))}),`,
    );
    expect(out.match(/fileImages:/g)).toHaveLength(1);
    // The hook comes from the virtual module, imported on the first line.
    expect(lines[0]).toBe(`import __duskFileImages from ${JSON.stringify(FILE_IMAGES_ID)};`);
    // Nothing else changed: removing the two added lines gives the generator's text back.
    expect(lines.filter((_line, index) => index !== 0 && index !== at + 1).join("\n")).toBe(tree);
  });

  it("[CNV-41] no images leaves the text as it is; a route the tree does not define is an error naming it", async () => {
    const tree = await treeOf({ "index.tsx": PAGE });
    expect(injectFileImages(tree, new Map())).toBe(tree);
    const attempt = (): string =>
      injectFileImages(tree, new Map([["/missing", image("/opengraph-image.png")]]));
    expect(attempt).toThrow(ConventionError);
    expect(attempt).toThrow(/"\/missing"/);
  });

  it("[CNV-52] an app with no image files has no metadata image: the generated tree is byte-identical, dynamic folders included", async () => {
    const tree = await treeOf({
      "_layout.tsx": LAYOUT,
      "index.tsx": PAGE,
      "blog/[slug]/index.tsx": PAGE,
      "(shop)/cart.tsx": PAGE,
      "blog/[slug]/comments.tsx": PAGE,
    });
    const scan = await scanRoutes({ routesDir: join(root, "routes") });
    const found = await discoverConventions(
      join(root, "src-without-images"),
      [],
      join(root, "routes"),
    );
    expect(found.images).toEqual([]);
    expect(attachFileImages(found.images, scan.entries, "").size).toBe(0);
    expect(injectFileImages(tree, attachFileImages(found.images, scan.entries, ""))).toBe(tree);
    expect(scan.metadataImages).toEqual([]);
  });

  it("[CNV-42] a layout inside a group is matched by its id", async () => {
    const tree = await treeOf({ "(shop)/_layout.tsx": LAYOUT, "(shop)/cart.tsx": PAGE });
    const out = injectFileImages(
      tree,
      new Map([["/(shop)/_layout", image("/opengraph-image.png")]]),
    );
    expect(out).toContain('  id: "/(shop)/_layout",\n  fileImages:');
  });
});
