import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ViteDevServer } from "vite";

/**
 * Resolves once the dev server's file watcher reports new files. A watcher starts listening asynchronously, and on Linux a
 * file written before that is never reported, so a test that edits or adds a file right after `createServer` can wait
 * forever. The probe writes a file until the watcher sees one, then removes its files and lets the watcher settle.
 */
export async function watcherReady(server: ViteDevServer, root: string): Promise<void> {
  const probes: string[] = [];
  let seen = false;
  const onAdd = (path: string): void => {
    if (basename(path).startsWith("watch-probe-")) seen = true;
  };
  server.watcher.on("add", onAdd);
  try {
    for (let attempt = 0; attempt < 50 && !seen; attempt += 1) {
      const probe = join(root, `watch-probe-${attempt}.tmp`);
      probes.push(probe);
      writeFileSync(probe, "");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    server.watcher.off("add", onAdd);
    for (const probe of probes) rmSync(probe, { force: true });
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}
