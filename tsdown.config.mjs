import { readFileSync } from "node:fs";
import { compile } from "@shadow-js/compiler";
import { defineConfig } from "tsdown";
import { createConfig } from "./build/tsdown-preset.mjs";

/**
 * The compiled components (`@shadow-js/dusk/components`) are TSX. Like primitives, every build runs the ShadowJS
 * compiler on them: the `dom` target for the browser builds and the `ssr` target for the server builds. Other
 * modules are plain TypeScript and pass through untouched.
 * @param {"dom" | "ssr"} generate
 * @param {boolean} dev
 */
function shadowCompile(generate, dev) {
  return {
    name: "shadowjs-compile",
    transform: {
      filter: { id: /\.tsx$/ },
      handler(_code, id) {
        const source = readFileSync(id, "utf8");
        const result = compile(source, {
          filename: id,
          generate,
          dev,
          autoReactive: false,
          hmr: false,
          sourceMap: true,
        });
        return {
          code: result.code,
          map: result.map ?? { mappings: "" },
          moduleType: "ts",
        };
      },
    },
  };
}

// The Node adapter, the test client and the static renderer import `node:` modules; on the shared
// "neutral" platform they would be reported as unresolved. They are external by design.
const builds = createConfig({
  packageDir: import.meta.dirname,
  entries: {
    index: "src/index.ts",
    "client/stream": "src/client/stream.ts",
    "server/index": "src/server/index.ts",
    "node/index": "src/node/index.ts",
    "testing/index": "src/testing/index.ts",
    "static/index": "src/static/index.ts",
    "client/index": "src/client/index.ts",
    "auth/index": "src/auth/index.ts",
    "og/index": "src/og/index.ts",
    "components/index": "src/components/index.ts",
    "bun/index": "src/bun/index.ts",
    "deno/index": "src/deno/index.ts",
    "cloudflare/index": "src/cloudflare/index.ts",
    "vercel/index": "src/vercel/index.ts",
    "netlify/index": "src/netlify/index.ts",
    "tarout/index": "src/tarout/index.ts",
    "features/pages": "src/features/pages.ts",
    "features/data-cache": "src/features/data-cache.ts",
    "features/isr": "src/features/isr.ts",
    // Shared stores for the page cache, each in its own subpath so an app that does not use one pays nothing.
    "stores/redis": "src/server/stores/redis.ts",
    "stores/contract": "src/server/stores/contract.ts",
    "features/rpc": "src/features/rpc.ts",
    "features/api-routes": "src/features/api-routes.ts",
    "features/streams": "src/features/streams.ts",
    "features/images": "src/features/images.ts",
    "features/draft-mode": "src/features/draft-mode.ts",
    "features/routing": "src/features/routing.ts",
    // The page side of `pwa()` (registration and the update prompt): an app that does not import it ships none of it.
    "features/pwa": "src/features/pwa.ts",
    // The params check of `dynamicParams = false`: the generated server entry imports it only when a page sets that export.
    "features/dynamic-params": "src/server/dynamic-params.ts",
    // The metadata engine of the server (tags, JSON-LD, route headers): the generated server entry imports it only when a
    // route exports metadata (`pages({ metadata })`).
    "features/metadata": "src/metadata/server.ts",
    // Locale routing (`@shadow-js/dusk/i18n` and its client half): the generated entries import them only when
    // dusk.config.ts declares `i18n.routing`. `@shadow-js/i18n` stays external (an optional peer dependency).
    "i18n/server": "src/i18n/server.ts",
    "i18n/client": "src/i18n/client.ts",
  },
});

// `./vite` is build-time code that runs in Node. It has its own output folder (no dev/prod split,
// nothing in it depends on `__DEV__`), so cleaning it can never race with the browser builds.
const vite = defineConfig({
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: true,
  // `pwa-worker` is bundled into the app's service worker by the `pwa()` build step, so it is its own entry.
  entry: { index: "src/vite/index.ts", "pwa-worker": "src/vite/pwa-worker.ts" },
  outDir: "dist/vite",
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Per-module output: see tools/build/tsdown-preset.mjs (unbundle).
  unbundle: true,
});

// The server condition of `./components`: the same components compiled for the `ssr` target, so their markup is
// written by `renderToString` (the browser builds need a document). Only this entry is built for the server.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const serverComponents = [
  { outDir: "dist/server", dev: false, minify: true },
  { outDir: "dist/server-dev", dev: true, minify: false },
].map(({ outDir, dev, minify }) => ({
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: true,
  clean: true,
  unbundle: true,
  minify,
  dts: false,
  entry: { "components/index": "src/components/index.ts" },
  outDir,
  deps: { neverBundle: [/^node:/] },
  define: {
    __DEV__: JSON.stringify(dev),
    __SERVER__: "true",
    __TEST__: "false",
    __VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [shadowCompile("ssr", dev)],
}));

// The `dusk` command-line bin: a Node program, built on its own. `clean: false` keeps the other outputs, and the
// bin is never imported by another entry, so it cannot reach a client or server bundle.
const cli = defineConfig({
  entry: { index: "src/cli/index.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: false,
  dts: false,
  outDir: "dist/cli",
  // The package bin is dist/cli/index.js (tsdown would write .mjs for a module package). tsdown makes a file with a
  // shebang executable itself.
  outExtensions: () => ({ js: ".js" }),
  banner: "#!/usr/bin/env node",
});

export default [
  ...serverComponents,
  ...builds.map((build) => {
    const server = build.outDir === "dist/server" || build.outDir === "dist/server-dev";
    const dev = build.outDir === "dist/dev" || build.outDir === "dist/server-dev";
    return {
      ...build,
      deps: { neverBundle: [/^node:/] },
      plugins: [shadowCompile(server ? "ssr" : "dom", dev)],
    };
  }),
  vite,
  cli,
];
