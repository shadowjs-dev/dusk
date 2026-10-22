/**
 * `pwa()`: an opt-in build step that turns the client output into an installable, offline-capable web app. It writes the
 * web app manifest, an offline page, and a service worker generated from the files the build produced (a precache list
 * with a content-hash revision for each file) and the runtime caching rules of the app. The worker is TypeScript
 * (`pwa-worker.ts`) compiled by the build together with the app's configuration: no runtime library is involved.
 * Build time only (Node). The page-side half is `@shadow-js/dusk/features/pwa`.
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { type Manifest, manifestJson } from "../server/metadata-routes";
import { compileGlob, matchesAny } from "./glob";
import type { CacheStrategy, PrecacheEntry, WorkerConfig, WorkerRule } from "./pwa-core";

/**
 * One runtime caching rule: which requests it covers and how they are answered.
 * @since 1.0.0
 */
export interface PwaRuntimeRule {
  /** Glob (or globs) of the path below the mount base: `/api/**`, `/images/*.{png,jpg}`. The first rule that matches wins. */
  readonly pattern: string | readonly string[];
  /** `network-first`, `cache-first` or `stale-while-revalidate`. */
  readonly strategy: CacheStrategy;
  /** A name for this rule's cache (letters, digits, dashes). Default: `rule<position>`. */
  readonly cacheName?: string;
  /** The most entries the cache keeps; the oldest are deleted first. `0` is no limit. Default 50. */
  readonly maxEntries?: number;
  /** Seconds a kept answer is used. `0` is no limit. Default 30 days. */
  readonly maxAgeSeconds?: number;
  /** `network-first` only: seconds to wait for the network before the kept answer is used. Default 0 (wait). */
  readonly networkTimeoutSeconds?: number;
}

/**
 * The page the worker shows when a navigation fails and no app shell answers it.
 * @since 1.0.0
 */
export interface PwaOfflinePage {
  /** The document title. Default `Offline`. */
  readonly title?: string;
  /** The heading. Default: the title. */
  readonly heading?: string;
  /** The message under the heading. Default: a sentence that the page needs a connection. */
  readonly message?: string;
  /** The `lang` of the page. Default `en`. */
  readonly lang?: string;
  /** The file name of the page in the output folder. Default `offline.html`. */
  readonly file?: string;
}

/**
 * Options of {@link pwa}.
 * @since 1.0.0
 */
export interface PwaOptions {
  /** The web app manifest to write. Without it no manifest file is written (serve one from a metadata route instead). */
  readonly manifest?: Manifest;
  /** The manifest's file name in the output folder. Default `manifest.webmanifest`. */
  readonly manifestFile?: string;
  /** The service worker's file name in the output folder. Default `sw.js`. */
  readonly serviceWorkerFile?: string;
  /** The prefix of every cache name; keep it unique among the apps of one origin. Default `dusk`. */
  readonly cacheNamePrefix?: string;
  /** Names the build in the cache names. Default: a hash of the precache list, so an unchanged build keeps its caches. */
  readonly buildId?: string;
  /**
   * What is kept at install. `include` and `exclude` are globs of paths in the output folder (`assets/**`). By default
   * the build's assets folder is kept; a file over `maxFileBytes` (default 2 MiB) is left out with a warning.
   */
  readonly precache?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly maxFileBytes?: number;
  };
  /** Runtime caching rules, in order. Without any, only the precache and the offline fallback are active. */
  readonly runtime?: readonly PwaRuntimeRule[];
  /** Globs of the path below the mount base that the worker never touches. Default `["/_dusk/**"]`. */
  readonly exclude?: readonly string[];
  /**
   * A document that is precached and answers a navigation the network cannot. It is fetched at install, so the server
   * must answer it with a `200`. Without it the offline page answers.
   */
  readonly appShell?: string;
  /** The offline page, or `false` for none (a failed navigation is then an ordinary browser error). */
  readonly offline?: false | PwaOfflinePage;
}

/** Options with every default applied. @internal */
export interface ResolvedPwa {
  readonly manifest: Manifest | undefined;
  readonly manifestFile: string;
  readonly serviceWorkerFile: string;
  readonly prefix: string;
  readonly buildId: string | undefined;
  readonly include: readonly string[] | undefined;
  readonly exclude: readonly string[];
  readonly maxFileBytes: number;
  readonly rules: readonly WorkerRule[];
  readonly neverTouch: readonly string[];
  readonly appShell: string | undefined;
  readonly offline: Required<PwaOfflinePage> | undefined;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RULES = 64;
const MAX_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 256;
const CACHE_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STRATEGIES: readonly string[] = ["network-first", "cache-first", "stale-while-revalidate"];
const NEVER_PRECACHED = ["**/*.map", ".vite/**"];

/** A pattern of the path below the mount base: starts with `/`, compiles, and stays short. */
function checkedPattern(pattern: unknown, where: string): string {
  if (
    typeof pattern !== "string" ||
    !pattern.startsWith("/") ||
    pattern.length > MAX_PATTERN_LENGTH
  ) {
    throw new TypeError(
      `pwa: ${where} must be a glob that starts with "/" (at most ${MAX_PATTERN_LENGTH} characters).`,
    );
  }
  if (pattern.split("/").includes("..")) {
    throw new TypeError(`pwa: ${where} must not contain ".." segments.`);
  }
  compileGlob(pattern);
  return pattern;
}

function checkedPatterns(value: unknown, where: string): readonly string[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PATTERNS) {
    throw new TypeError(`pwa: ${where} must be a glob or a list of up to ${MAX_PATTERNS} globs.`);
  }
  return list.map((item, index) => checkedPattern(item, `${where}[${index}]`));
}

function checkedCount(value: number | undefined, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new RangeError(`pwa: ${where} must be a whole number of 0 or more.`);
  }
  return value;
}

function checkedFile(value: string, where: string): string {
  if (!FILE_NAME.test(value)) {
    throw new TypeError(`pwa: ${where} must be a plain file name such as "sw.js" (no folders).`);
  }
  return value;
}

/** A URL path of the app: starts with a single slash, no control characters, no `..`. */
function checkedPath(value: string, where: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them.
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `pwa: ${where} must be a path on this origin that starts with a single "/".`,
    );
  }
  return value;
}

function resolveRules(rules: readonly PwaRuntimeRule[] | undefined): readonly WorkerRule[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules) || rules.length > MAX_RULES) {
    throw new TypeError(`pwa: runtime must be a list of up to ${MAX_RULES} rules.`);
  }
  const labels = new Set<string>();
  return rules.map((rule, index) => {
    if (!STRATEGIES.includes(rule.strategy)) {
      throw new TypeError(
        `pwa: runtime[${index}].strategy must be ${STRATEGIES.map((name) => `"${name}"`).join(", ")}.`,
      );
    }
    const cache = rule.cacheName ?? `rule${index}`;
    if (!CACHE_LABEL.test(cache)) {
      throw new TypeError(
        `pwa: runtime[${index}].cacheName must be lower case letters, digits and dashes.`,
      );
    }
    if (labels.has(cache)) {
      throw new TypeError(`pwa: two runtime rules use the cache name "${cache}".`);
    }
    labels.add(cache);
    return {
      patterns: checkedPatterns(rule.pattern, `runtime[${index}].pattern`),
      strategy: rule.strategy,
      cache,
      maxEntries: checkedCount(
        rule.maxEntries,
        DEFAULT_MAX_ENTRIES,
        `runtime[${index}].maxEntries`,
      ),
      maxAgeSeconds: checkedCount(
        rule.maxAgeSeconds,
        DEFAULT_MAX_AGE_SECONDS,
        `runtime[${index}].maxAgeSeconds`,
      ),
      networkTimeoutSeconds: checkedCount(
        rule.networkTimeoutSeconds,
        0,
        `runtime[${index}].networkTimeoutSeconds`,
      ),
    };
  });
}

/**
 * Applies the defaults of {@link PwaOptions} and refuses a value the build would write into the worker unchecked.
 *
 * @param options The options as written.
 * @returns The options with every default applied.
 * @throws TypeError or RangeError for a bad value, naming the option.
 * @example
 * resolvePwaOptions({}).serviceWorkerFile; // "sw.js"
 * @since 1.0.0
 */
export function resolvePwaOptions(options: PwaOptions = {}): ResolvedPwa {
  const prefix = options.cacheNamePrefix ?? "dusk";
  if (!CACHE_LABEL.test(prefix)) {
    throw new TypeError("pwa: cacheNamePrefix must be lower case letters, digits and dashes.");
  }
  if (options.buildId !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(options.buildId)) {
    throw new TypeError(
      "pwa: buildId must be 1 to 64 letters, digits, dots, dashes or underscores.",
    );
  }
  const offline = options.offline;
  return {
    manifest: options.manifest,
    manifestFile: checkedFile(options.manifestFile ?? "manifest.webmanifest", "manifestFile"),
    serviceWorkerFile: checkedFile(options.serviceWorkerFile ?? "sw.js", "serviceWorkerFile"),
    prefix,
    buildId: options.buildId,
    include: options.precache?.include,
    exclude: [...NEVER_PRECACHED, ...(options.precache?.exclude ?? [])],
    maxFileBytes: checkedCount(
      options.precache?.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      "precache.maxFileBytes",
    ),
    rules: resolveRules(options.runtime),
    neverTouch: checkedPatterns(options.exclude ?? ["/_dusk/**"], "exclude"),
    appShell:
      options.appShell === undefined ? undefined : checkedPath(options.appShell, "appShell"),
    offline:
      offline === false
        ? undefined
        : {
            title: offline?.title ?? "Offline",
            heading: offline?.heading ?? offline?.title ?? "Offline",
            message: offline?.message ?? "This page needs a connection. Check it, then try again.",
            lang: offline?.lang ?? "en",
            file: checkedFile(offline?.file ?? "offline.html", "offline.file"),
          },
  };
}

/** One file of the build output. @since 1.0.0 */
export interface OutputFile {
  /** The path in the output folder, with `/` separators. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The hash a precache entry carries: the first 12 hex digits of the content's SHA-256. */
function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * The precache list of a build: one entry per file, with a revision that is a hash of the file's content, sorted by URL
 * so the same files always give the same list.
 *
 * @param files The files to keep.
 * @param base The mount base with a trailing slash (`/`, `/app/`).
 * @returns The entries.
 * @example
 * createPrecacheManifest([{ path: "assets/a.js", bytes: new Uint8Array([1]) }], "/")[0]?.url; // "/assets/a.js"
 * @since 1.0.0
 */
export function createPrecacheManifest(
  files: readonly OutputFile[],
  base: string,
): readonly PrecacheEntry[] {
  return files
    .map((file) => ({
      url: `${base}${file.path.split("/").map(encodeURIComponent).join("/")}`,
      revision: revisionOf(file.bytes),
    }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/**
 * The id of a build: a hash of its precache list, so an unchanged build keeps its caches and a changed one gets new ones.
 *
 * @param precache The precache list.
 * @returns Twelve hex digits.
 * @example
 * buildIdOf([]).length; // 12
 * @since 1.0.0
 */
export function buildIdOf(precache: readonly PrecacheEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of precache) hash.update(`${entry.url}\n${entry.revision}\n`);
  return hash.digest("hex").slice(0, 12);
}

/**
 * The configuration of the generated worker.
 *
 * @param resolved The options with their defaults.
 * @param precache The precache list.
 * @param base The mount base with a trailing slash.
 * @param offlineUrl The URL of the offline page, when there is one.
 * @returns The configuration (plain JSON).
 * @since 1.0.0
 * @example
 * ```ts
 * import { createWorkerConfig } from "./pwa";
 *
 * export type Config = ReturnType<typeof createWorkerConfig>;
 * ```
 */
export function createWorkerConfig(
  resolved: ResolvedPwa,
  precache: readonly PrecacheEntry[],
  base: string,
  offlineUrl: string | undefined,
): WorkerConfig {
  return {
    prefix: resolved.prefix,
    buildId: resolved.buildId ?? buildIdOf(precache),
    base,
    precache,
    rules: resolved.rules,
    exclude: resolved.neverTouch,
    appShell: resolved.appShell === undefined ? undefined : `${base}${resolved.appShell.slice(1)}`,
    offline: offlineUrl,
  };
}

/**
 * The TypeScript source of the worker's entry: it starts the runtime with the app's configuration.
 *
 * @param config The worker configuration.
 * @param workerModule The module that holds the runtime (a path the bundler resolves).
 * @returns Module text.
 * @since 1.0.0
 * @example
 * ```ts
 * import { type createWorkerConfig, serviceWorkerEntrySource } from "./pwa";
 *
 * export const entry = (config: ReturnType<typeof createWorkerConfig>) =>
 *   serviceWorkerEntrySource(config, "@shadow-js/dusk/pwa-worker");
 * ```
 */
export function serviceWorkerEntrySource(config: WorkerConfig, workerModule: string): string {
  // `JSON.stringify` output is a JavaScript expression, except that U+2028 and U+2029 end a line in older engines.
  const json = JSON.stringify(config)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `import { installServiceWorker } from ${JSON.stringify(workerModule)};\ninstallServiceWorker(${json});\n`;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * The offline page and its stylesheet. The page has no script and no inline style, so a strict
 * `Content-Security-Policy` leaves it intact.
 *
 * @param page The page text.
 * @param stylesheetUrl The URL the page loads its stylesheet from.
 * @returns The two files' text.
 * @example
 * offlinePage({ title: "Offline", heading: "Offline", message: "Try again.", lang: "en", file: "offline.html" }, "/offline.css").html.includes("<h1>Offline</h1>"); // true
 * @since 1.0.0
 */
export function offlinePage(
  page: Required<PwaOfflinePage>,
  stylesheetUrl: string,
): { readonly html: string; readonly css: string } {
  const html = `<!doctype html>
<html lang="${escapeHtml(page.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)}</title>
<link rel="stylesheet" href="${escapeHtml(stylesheetUrl)}">
</head>
<body>
<main>
<h1>${escapeHtml(page.heading)}</h1>
<p>${escapeHtml(page.message)}</p>
<p><a href="">Try again</a></p>
</main>
</body>
</html>
`;
  const css = `:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif}
main{max-width:32rem;padding:2rem;text-align:center}
`;
  return { html, css };
}

/** The files under a folder, as paths with `/` separators relative to it. */
async function listFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const pending: string[] = [""];
  while (pending.length > 0) {
    const folder = pending.pop() ?? "";
    for (const entry of await readdir(join(dir, folder), { withFileTypes: true })) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) out.push(path);
    }
  }
  return out.sort();
}

/** The module that holds the worker runtime: the compiled file next to this one, or its source when run from source. */
function workerModulePath(): string {
  for (const extension of [".js", ".ts"]) {
    const path = fileURLToPath(new URL(`./pwa-worker${extension}`, import.meta.url));
    if (existsSync(path)) return path;
  }
  throw new Error(
    "pwa: the service worker runtime (pwa-worker) is missing from this installation.",
  );
}

/** The ids of the worker build: its entry, and the runtime the entry imports. */
const ENTRY_ID = "virtual:dusk/service-worker-entry";
const RUNTIME_ID = "virtual:dusk/service-worker-runtime";

/**
 * Compiles the worker: bundles its entry (the runtime and the app's configuration) into one minified script.
 *
 * @param config The worker configuration.
 * @param root The project root.
 * @returns The text of `sw.js`.
 * @throws Error when the bundler produced no script.
 * @since 1.0.0
 * @example
 * ```ts
 * import { buildServiceWorker, createWorkerConfig } from "./pwa";
 *
 * export const build = (config: ReturnType<typeof createWorkerConfig>, root: string) =>
 *   buildServiceWorker(config, root);
 * ```
 */
export async function buildServiceWorker(config: WorkerConfig, root: string): Promise<string> {
  const { build } = await import("vite");
  const worker = workerModulePath();
  const entry = serviceWorkerEntrySource(config, RUNTIME_ID);
  // Vite resolves a library entry against the root, so the virtual module is reached through a path under it.
  const entryFile = resolve(root, "dusk-service-worker-entry.js");
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    publicDir: false,
    mode: "production",
    plugins: [
      {
        name: "dusk:pwa-entry",
        resolveId(id) {
          if (id === RUNTIME_ID) return worker;
          return id === entryFile ? `\0${ENTRY_ID}` : null;
        },
        load(id) {
          return id === `\0${ENTRY_ID}` ? entry : null;
        },
      },
    ],
    build: {
      write: false,
      minify: true,
      target: "es2022",
      sourcemap: false,
      reportCompressedSize: false,
      emptyOutDir: false,
      lib: {
        entry: entryFile,
        formats: ["iife"],
        name: "duskServiceWorker",
        fileName: () => "sw.js",
      },
    },
  });
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!("output" in output)) continue;
    for (const item of output.output) if (item.type === "chunk") return item.code;
  }
  throw new Error("pwa: the service worker build produced no script.");
}

/** Reads the files of the output folder that the precache keeps. */
async function precacheFiles(
  dir: string,
  include: readonly string[],
  exclude: readonly string[],
  maxFileBytes: number,
  skipped: string[],
): Promise<readonly OutputFile[]> {
  const included = include.map((pattern) => compileGlob(pattern));
  const excluded = exclude.map((pattern) => compileGlob(pattern));
  const files: OutputFile[] = [];
  for (const path of await listFiles(dir)) {
    if (!matchesAny(included, path) || matchesAny(excluded, path)) continue;
    const full = join(dir, ...path.split("/"));
    if ((await stat(full)).size > maxFileBytes) {
      skipped.push(path);
      continue;
    }
    files.push({ path, bytes: await readFile(full) });
  }
  return files;
}

/** Refuses to continue when a file the build is about to write is already in the output (it came from `public/`). */
function refuseExisting(dir: string, names: readonly string[]): void {
  for (const name of names) {
    if (existsSync(join(dir, name))) {
      throw new Error(
        `pwa: ${name} already exists in the output (from public/ or another plugin). Rename the file or change the option that names it.`,
      );
    }
  }
}

/**
 * The `pwa()` Vite plugin. After the client build it writes `manifest.webmanifest` (when `manifest` is given), the offline
 * page, and `sw.js` into the client output. Nothing runs in `vite dev`.
 *
 * Add it next to `dusk()` in `vite.config.ts`, link the manifest through the app's metadata, and call
 * `registerServiceWorker()` of `@shadow-js/dusk/features/pwa` in the browser.
 *
 * @param options See {@link PwaOptions}.
 * @returns A Vite plugin.
 * @throws TypeError or RangeError for a bad option, and Error when a generated file would replace one from `public/`.
 * @example
 * ```ts
 * // vite.config.ts
 * import { dusk, pwa } from "@shadow-js/dusk/vite";
 *
 * export default {
 *   plugins: [
 *     dusk(),
 *     pwa({
 *       manifest: { name: "Shop", short_name: "Shop", start_url: "/", display: "standalone", icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }] },
 *       runtime: [{ pattern: "/api/products/*", strategy: "stale-while-revalidate", maxEntries: 30 }],
 *     }),
 *   ],
 * };
 * ```
 * @since 1.0.0
 */
export function pwa(options: PwaOptions = {}): Plugin {
  const resolved = resolvePwaOptions(options);
  let root = process.cwd();
  let base = "/";
  let assetsDir = "assets";
  let warn: (message: string) => void = (message) => console.warn(message);
  return {
    name: "dusk:pwa",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    configResolved(config) {
      root = config.root;
      assetsDir = config.build.assetsDir;
      warn = (message) => config.logger.warn(message);
      if (!config.base.startsWith("/") || config.base.startsWith("//")) {
        throw new TypeError(
          `pwa: the Vite base must be a path such as "/" or "/app/" (got ${JSON.stringify(config.base)}). A service worker only handles its own origin.`,
        );
      }
      base = config.base.endsWith("/") ? config.base : `${config.base}/`;
    },
    async writeBundle(outputOptions) {
      const dir = outputOptions.dir;
      if (dir === undefined) return;
      const skipped: string[] = [];
      const files: OutputFile[] = [
        ...(await precacheFiles(
          dir,
          resolved.include ?? [`${assetsDir}/**`],
          resolved.exclude,
          resolved.maxFileBytes,
          skipped,
        )),
      ];
      if (skipped.length > 0) {
        warn(
          `pwa: left out of the precache (over ${resolved.maxFileBytes} bytes): ${skipped.join(", ")}. Raise precache.maxFileBytes or serve them through a runtime rule.`,
        );
      }
      let offlineUrl: string | undefined;
      const generated: { name: string; text: string }[] = [];
      if (resolved.offline !== undefined) {
        const stem = resolved.offline.file.replace(/\.[^.]*$/, "");
        const sheet = `${stem}.css`;
        const page = offlinePage(resolved.offline, `${base}${sheet}`);
        generated.push(
          { name: resolved.offline.file, text: page.html },
          { name: sheet, text: page.css },
        );
        for (const item of generated)
          files.push({ path: item.name, bytes: Buffer.from(item.text) });
        offlineUrl = `${base}${resolved.offline.file}`;
      }
      const precache = createPrecacheManifest(files, base);
      const config = createWorkerConfig(resolved, precache, base, offlineUrl);
      // The app shell's content is the server's answer, unknown here: its revision is the build's.
      const withShell =
        config.appShell === undefined
          ? config
          : {
              ...config,
              precache: [...precache, { url: config.appShell, revision: config.buildId }],
            };
      const manifestText =
        resolved.manifest === undefined ? undefined : manifestJson(resolved.manifest);
      refuseExisting(dir, [
        ...generated.map((item) => item.name),
        ...(manifestText === undefined ? [] : [resolved.manifestFile]),
        resolved.serviceWorkerFile,
      ]);
      const worker = await buildServiceWorker(withShell, root);
      for (const item of generated) await writeFile(join(dir, item.name), item.text);
      if (manifestText !== undefined)
        await writeFile(join(dir, resolved.manifestFile), manifestText);
      await writeFile(join(dir, resolved.serviceWorkerFile), worker);
    },
  };
}
