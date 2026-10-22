/**
 * `@shadow-js/dusk/vercel`: the Vercel adapter, which writes the Build Output API v3 tree
 * (`.vercel/output`): `config.json` with the routes, `static/` with the client folder, and one
 * function under `functions/render.func/` with a `.vc-config.json` for the Node.js runtime or the
 * Edge runtime. The function folder carries its own copy of the server bundle and a
 * `package.json` with `"type": "module"`, so it runs without a `node_modules` folder.
 *
 * Deploy the prebuilt output with `vercel deploy --prebuilt` (after `vercel build` or this adapter),
 * or commit `.vercel/output` in a build step that Vercel runs.
 * @packageDocumentation
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostListSource } from "../adapter/host-routes";
import { IMMUTABLE_CACHE_CONTROL, immutableFolders } from "../adapter/immutable";
import { namesMentionedIn, packageClosure, RUNTIME_PACKAGES } from "../adapter/packages";
import { checkOutDir } from "../adapter/paths";
import { type Adapter, NODE_LIKE_CAPABILITIES } from "../adapter/types";
import type { StaticPage } from "../shared/static-page";

/** Options of the {@link vercel} adapter. @since 1.0.0 */
export interface VercelAdapterOptions {
  /** Where the output goes, relative to the project. Default `.vercel/output`. */
  readonly outDir?: string;
  /** `"nodejs"` (default) or `"edge"`. The edge runtime cannot use Node built-ins; the build checks that. */
  readonly runtime?: "nodejs" | "edge";
  /** Node.js version of the function, such as `nodejs22.x`. Default `nodejs22.x`. Node runtime only. */
  readonly nodeVersion?: `nodejs${number}.x`;
  /** Longest run of the function in seconds (1 to 900). Node runtime only. Default: the platform's default. */
  readonly maxDuration?: number;
  /** Name of the single function (lower case letters, digits, hyphens). Default `render`. */
  readonly functionName?: string;
}

const FUNCTION_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const NODE_VERSION = /^nodejs\d{1,2}\.x$/;

/** Validates the options and fills defaults. @internal */
export function checkVercelOptions(options: VercelAdapterOptions): {
  outDir: string;
  runtime: "nodejs" | "edge";
  nodeVersion: string;
  maxDuration: number | undefined;
  functionName: string;
} {
  const runtime = options.runtime ?? "nodejs";
  if (runtime !== "nodejs" && runtime !== "edge") {
    throw new TypeError(`vercel(): runtime must be "nodejs" or "edge" (got "${String(runtime)}")`);
  }
  const nodeVersion = options.nodeVersion ?? "nodejs22.x";
  if (!NODE_VERSION.test(nodeVersion))
    throw new TypeError(`vercel(): nodeVersion "${nodeVersion}" must look like nodejs22.x`);
  const maxDuration = options.maxDuration;
  if (
    maxDuration !== undefined &&
    (!Number.isInteger(maxDuration) || maxDuration < 1 || maxDuration > 900)
  ) {
    throw new TypeError("vercel(): maxDuration must be an integer from 1 to 900 seconds");
  }
  const functionName = options.functionName ?? "render";
  if (!FUNCTION_NAME.test(functionName)) {
    throw new TypeError(
      `vercel(): functionName "${functionName}" must be lower case letters, digits and hyphens`,
    );
  }
  return {
    outDir: checkOutDir("vercel()", options.outDir ?? ".vercel/output"),
    runtime,
    nodeVersion,
    maxDuration,
    functionName,
  };
}

/**
 * The Vercel adapter.
 *
 * @param options See {@link VercelAdapterOptions}.
 * @returns The adapter for `dusk({ adapter })`.
 * @throws TypeError for an invalid option.
 * @example
 * import { vercel } from "@shadow-js/dusk/vercel";
 * export default { plugins: [dusk({ adapter: vercel({ runtime: "edge" }) })] };
 * @since 1.0.0
 */
export function vercel(options: VercelAdapterOptions = {}): Adapter {
  const checked = checkVercelOptions(options);
  const edge = checked.runtime === "edge";
  const fn = checked.functionName;
  return {
    name: "vercel",
    outDir: checked.outDir,
    env: "process",
    bundling: "all",
    edge,
    capabilities: { ...NODE_LIKE_CAPABILITIES, staticAssets: "adapter", asyncContext: !edge },
    async build(context) {
      const functionDir = `functions/${fn}.func`;
      const entry = edge ? "index.js" : "index.mjs";
      await context.emit(
        "config.json",
        `${JSON.stringify(
          {
            version: 3,
            // The Build Output API reads headers from `routes` (a top-level `headers` key is ignored), so the
            // immutable rule is a route; see vercelRoutes.
            routes: vercelRoutes(
              context.staticPages,
              fn,
              immutableFolders(context.manifest),
              context.allowedHosts,
            ),
          },
          null,
          2,
        )}\n`,
      );
      await context.copy(context.clientDir, "static");
      await context.copy(directoryOf(context.serverEntry), `${functionDir}/server`);
      // The packages the server loads by name at run time (satori, resvg, sharp) are not in the bundle: the function folder
      // gets its own node_modules with them (B3). The edge runtime has no file system, so it gets none.
      if (!edge) {
        const packages = packageClosure(
          [context.root, dirname(fileURLToPath(import.meta.url))],
          namesMentionedIn(directoryOf(context.serverEntry), RUNTIME_PACKAGES),
        );
        for (const pkg of packages) {
          await context.copy(pkg.dir, `${functionDir}/node_modules/${pkg.name}`);
        }
        if (packages.length > 0) {
          context.log(
            `copied ${packages.map((pkg) => pkg.name).join(", ")} into ${functionDir}/node_modules`,
          );
        }
      }
      await context.emit(`${functionDir}/package.json`, '{\n  "type": "module"\n}\n');
      await context.emit(
        `${functionDir}/${entry}`,
        [
          "// Generated by @shadow-js/dusk (adapter: vercel).",
          'import { handler, createFetch } from "./server/entry.js";',
          "",
          'const app = createFetch(handler, { clientAddressHeader: "x-real-ip", geo: "vercel" });',
          "export default { fetch: (request, context) => app.fetch(request, undefined, context) };",
          "",
        ].join("\n"),
      );
      const config = edge
        ? { runtime: "edge", entrypoint: entry }
        : {
            runtime: checked.nodeVersion,
            handler: entry,
            launcherType: "Nodejs",
            shouldAddHelpers: false,
            shouldAddSourcemapSupport: false,
            supportsResponseStreaming: true,
            ...(checked.maxDuration === undefined ? {} : { maxDuration: checked.maxDuration }),
          };
      await context.emit(`${functionDir}/.vc-config.json`, `${JSON.stringify(config, null, 2)}\n`);
      context.log(
        `wrote ${checked.outDir}/config.json, static/ and ${functionDir} (${edge ? "edge" : checked.nodeVersion})`,
      );
    },
  };
}

/**
 * A regular expression for a Vercel route `src` that matches one page path, with or without its trailing slash.
 * @internal
 */
function pathSource(path: string): string {
  if (path === "/") return "^/$";
  return `^${escapeRegex(path)}/?$`;
}

/**
 * The routes of `config.json`, in the order Vercel reads them (B2):
 * 1. a page the app's rules apply to (`mode: "handler"`) goes to the function before the filesystem handler, so its
 *    rules and the host routing run for it, and its prerendered file is not served;
 * 2. a static page with headers gets them from a route that only adds headers (`continue: true`, as the Vercel
 *    `headers` conversion does): the file still comes from the CDN, and no function runs for it;
 * 3. the immutable folders get their year-long rule the same way, before the filesystem handler;
 * 4. the filesystem handler; then, for an immutable folder, a missing file is a `no-store` 404 (a year-long rule must
 *    not stick to a fall-through response); then the catch-all to the function.
 * Before all of them, when the app lists its hosts (`security.allowedHosts`), a request whose Host is not listed goes to
 * the function first (`missing` host condition): the function answers the handler's 400, and no file is served.
 * @param pages How each prerendered page is answered.
 * @param fn The function name.
 * @param immutable The URL folders of the immutable files (see `immutableFolders`).
 * @param allowedHosts The app's host list; absent or empty for no host routing.
 * @internal
 */
export function vercelRoutes(
  pages: readonly StaticPage[],
  fn: string,
  immutable: readonly string[] = [],
  allowedHosts: readonly string[] = [],
): Array<Record<string, unknown>> {
  const routes: Array<Record<string, unknown>> = [];
  if (allowedHosts.length > 0) {
    // Written with anchors (`^/(.*)$`): it is the same route as the catch-all, and tools that look for the one
    // unconditional catch-all skip it by its spelling.
    routes.push({
      src: "^/(.*)$",
      missing: [{ type: "host", value: { re: hostListSource(allowedHosts) } }],
      dest: `/${fn}`,
    });
  }
  for (const page of pages) {
    if (page.mode === "handler") routes.push({ src: pathSource(page.path), dest: `/${fn}` });
  }
  for (const page of pages) {
    if (page.mode !== "static") continue;
    const headers = [...page.headers, ...page.httpsHeaders];
    if (headers.length === 0) continue;
    routes.push({
      src: pathSource(page.path),
      headers: Object.fromEntries(headers),
      continue: true,
    });
  }
  for (const folder of immutable) {
    routes.push({
      src: folderSource(folder),
      headers: { "Cache-Control": IMMUTABLE_CACHE_CONTROL },
      continue: true,
    });
  }
  routes.push({ handle: "filesystem" });
  for (const folder of immutable) {
    routes.push({
      src: folderSource(folder),
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  routes.push({ src: "/(.*)", dest: `/${fn}` });
  return routes;
}

/**
 * A regular expression for a Vercel route `src` that matches any path below one URL folder (`/assets`).
 * @internal
 */
function folderSource(folder: string): string {
  return `^${escapeRegex(folder)}/.+$`;
}

/** Escapes the characters a regular expression reads as syntax. @internal */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The folder of a file path (POSIX or Windows separators). @internal */
function directoryOf(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut === -1 ? "." : file.slice(0, cut);
}
