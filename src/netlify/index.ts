/**
 * `@shadow-js/dusk/netlify`: the Netlify adapter. It writes a deployable folder (`dist/netlify` by
 * default) with a `netlify.toml` whose publish folder is `client/` (the client build, with a
 * `_headers` file for the hashed assets and a `_redirects` file from the options), and one of:
 * - `functions/render.mjs`, a Netlify Function (v2, Node.js runtime) on `path = "/*"`;
 * - `edge-functions/render.mjs`, an Edge Function (Deno) on `path = "/*"`.
 *
 * Static files are served before the function: the function declares `preferStatic` (a function with a catch-all path would
 * otherwise answer them), and the edge function excludes the static folders and files by name, so `/assets/...` and prerendered
 * pages never reach the server.
 * @packageDocumentation
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { IMMUTABLE_CACHE_CONTROL, immutableFolders } from "../adapter/immutable";
import { pageHeaderBlock } from "../adapter/page-headers";
import { checkOutDir } from "../adapter/paths";
import { type Adapter, NODE_LIKE_CAPABILITIES } from "../adapter/types";
import type { DuskManifest } from "../vite/build";

/** A redirect of the `_redirects` file. @since 1.0.0 */
export interface NetlifyRedirect {
  /** Path the request names: `/old` or `/blog/*`. */
  readonly from: string;
  /** Where to go: a path (`/new`) or an absolute URL. */
  readonly to: string;
  /** HTTP status. Default 301. */
  readonly status?: 301 | 302 | 303 | 307 | 308;
}

/** Options of the {@link netlify} adapter. @since 1.0.0 */
export interface NetlifyAdapterOptions {
  /** Output folder relative to the project. Default `dist/netlify`. */
  readonly outDir?: string;
  /** `"functions"` (default, Node.js Netlify Function) or `"edge"` (Deno Edge Function). */
  readonly target?: "functions" | "edge";
  /** Redirects written to `_redirects`. Checked: a path or an absolute URL, no spaces. */
  readonly redirects?: readonly NetlifyRedirect[];
}

const SAFE_TOKEN = /^[^\s]+$/;

/**
 * The paths the edge function leaves to the platform. Edge functions run before static files (a function with `preferStatic`
 * is the other target), so the build folders and the `public/` files are excluded by name; pages stay with the function.
 * @internal
 */
export function staticPaths(context: {
  readonly manifest: DuskManifest;
  readonly clientDir: string;
}): string[] {
  const paths = new Set<string>(immutableFolders(context.manifest).map((folder) => `/${folder}/*`));
  for (const entry of readdirSync(context.clientDir, { withFileTypes: true })) {
    if (entry.name.startsWith("_") || entry.name.endsWith(".html")) continue;
    if (!entry.isDirectory()) paths.add(`/${entry.name}`);
    else if (holdsFiles(join(context.clientDir, entry.name))) paths.add(`/${entry.name}/*`);
  }
  return [...paths].sort();
}

/** True when a folder holds anything but prerendered HTML (a page folder stays with the function). */
function holdsFiles(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() ? holdsFiles(join(dir, entry.name)) : !entry.name.endsWith(".html"))
      return true;
  }
  return false;
}

/** Validates the options. @internal */
export function checkNetlifyOptions(options: NetlifyAdapterOptions): {
  outDir: string;
  target: "functions" | "edge";
  redirects: readonly NetlifyRedirect[];
} {
  const target = options.target ?? "functions";
  if (target !== "functions" && target !== "edge") {
    throw new TypeError(
      `netlify(): target must be "functions" or "edge" (got "${String(target)}")`,
    );
  }
  const redirects = options.redirects ?? [];
  for (const redirect of redirects) {
    const pathOrUrl = (value: string): boolean =>
      SAFE_TOKEN.test(value) && (value.startsWith("/") || /^https?:\/\//.test(value));
    if (!pathOrUrl(redirect.from) || !redirect.from.startsWith("/")) {
      throw new TypeError(
        `netlify(): redirect "from" must be a path starting with / (got "${redirect.from}")`,
      );
    }
    if (!pathOrUrl(redirect.to)) {
      throw new TypeError(
        `netlify(): redirect "to" must be a path or an absolute http(s) URL (got "${redirect.to}")`,
      );
    }
    if (redirect.status !== undefined && ![301, 302, 303, 307, 308].includes(redirect.status)) {
      throw new TypeError(
        `netlify(): redirect status must be 301, 302, 303, 307 or 308 (got ${String(redirect.status)})`,
      );
    }
  }
  return { outDir: checkOutDir("netlify()", options.outDir ?? "dist/netlify"), target, redirects };
}

/**
 * The Netlify adapter.
 *
 * @param options See {@link NetlifyAdapterOptions}.
 * @returns The adapter for `dusk({ adapter })`.
 * @throws TypeError for an invalid option.
 * @example
 * import { netlify } from "@shadow-js/dusk/netlify";
 * export default { plugins: [dusk({ adapter: netlify({ target: "edge" }) })] };
 * @since 1.0.0
 */
export function netlify(options: NetlifyAdapterOptions = {}): Adapter {
  const checked = checkNetlifyOptions(options);
  const edge = checked.target === "edge";
  return {
    name: "netlify",
    outDir: checked.outDir,
    env: edge ? "platform" : "process",
    bundling: "all",
    edge,
    capabilities: { ...NODE_LIKE_CAPABILITIES, staticAssets: "adapter", asyncContext: !edge },
    async build(context) {
      await context.copy(context.clientDir, "client");
      await context.emit(
        "client/_headers",
        [
          "# Generated by @shadow-js/dusk (adapter: netlify). Hashed build assets and vendored fonts never change.",
          ...immutableFolders(context.manifest).flatMap((folder) => [
            `${folder}/*`,
            `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`,
          ]),
          ...context.staticPages.flatMap((page) => pageHeaderBlock(page)),
          "",
        ].join("\n"),
      );
      // B2: a prerendered page the app's rules apply to is answered by the function (a forced rewrite: a static file would
      // win otherwise), and a static page gets its headers in the _headers file. A header must not contain a line break.
      const functionPath = edge ? "/.netlify/edge-functions/render" : "/.netlify/functions/render";
      const pageRewrites = context.staticPages
        .filter((page) => page.mode === "handler")
        .map((page) => `${page.path} ${functionPath} 200!`);
      const redirectLines = [
        ...checked.redirects.map(
          (redirect) => `${redirect.from} ${redirect.to} ${redirect.status ?? 301}`,
        ),
        ...pageRewrites,
      ];
      await context.emit(
        "client/_redirects",
        [
          "# Generated by @shadow-js/dusk (adapter: netlify) from netlify({ redirects }).",
          // Netlify documents no Host condition for redirects, rewrites or function and edge declarations, so the host list
          // cannot be routed in this file. The handler refuses a foreign Host for every request a function answers (its
          // 400). Which files the platform answers without a function is set by its precedence rules, not checked here.
          ...(context.allowedHosts === undefined
            ? []
            : [
                "# security.allowedHosts is set: Netlify has no Host condition here; the function refuses a foreign Host (400).",
              ]),
          ...(redirectLines.length === 0 ? ["# No redirects configured."] : redirectLines),
          "",
        ].join("\n"),
      );
      const folder = edge ? "edge-functions" : "functions";
      await context.copy(directoryOf(context.serverEntry), `${folder}/server`);
      if (edge) {
        await context.emit(
          "netlify.toml",
          [
            "# Generated by @shadow-js/dusk (adapter: netlify, target: edge).",
            "[build]",
            '  publish = "client"',
            '  edge_functions = "edge-functions"',
            "",
          ].join("\n"),
        );
        await context.emit(
          "edge-functions/render.mjs",
          [
            "// Generated by @shadow-js/dusk (adapter: netlify, edge).",
            'import { handler, createFetch, runtimeEnvironment } from "./server/entry.js";',
            "",
            'const app = createFetch(handler, { clientAddressHeader: "x-nf-client-connection-ip", geo: "netlify" });',
            "export default (request, context) => app.fetch(request, runtimeEnvironment(), context);",
            `export const config = { path: "/*", excludedPath: ${JSON.stringify(staticPaths(context))} };`,
            "",
          ].join("\n"),
        );
      } else {
        await context.emit(
          "netlify.toml",
          [
            "# Generated by @shadow-js/dusk (adapter: netlify, target: functions).",
            "[build]",
            '  publish = "client"',
            "",
            "[functions]",
            '  directory = "functions"',
            "",
          ].join("\n"),
        );
        await context.emit("functions/package.json", '{\n  "type": "module"\n}\n');
        await context.emit(
          "functions/render.mjs",
          [
            "// Generated by @shadow-js/dusk (adapter: netlify, functions).",
            'import { handler, createFetch } from "./server/entry.js";',
            "",
            'const app = createFetch(handler, { clientAddressHeader: "x-nf-client-connection-ip", geo: "netlify" });',
            "export default (request, context) => app.fetch(request, undefined, context);",
            'export const config = { path: "/*", preferStatic: true };',
            "",
          ].join("\n"),
        );
      }
      context.log(`wrote netlify.toml, client/ and ${folder}/render.mjs (${checked.target})`);
    },
  };
}

/** The folder of a file path (POSIX or Windows separators). @internal */
function directoryOf(file: string): string {
  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return cut === -1 ? "." : file.slice(0, cut);
}
