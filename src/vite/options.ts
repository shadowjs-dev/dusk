import type { ShadowRouterOptions } from "@shadow-js/router/vite";
import type { ShadowPluginOptions } from "@shadow-js/vite";
import { type Adapter, assertAdapter } from "../adapter/types";
import { crawlPolicyOf } from "../static/crawl";

/**
 * Options of `dusk()`. Every option has a default that works for a project laid out like
 * `create-shadow-app` makes it (`src/routes`, `src/app.tsx`, `src/entry-server.ts`).
 */

/** Glob lists of the import protection. @since 1.0.0 */
export interface ImportProtectionOptions {
  /** Extra files (globs, relative to the project root) that client code must not import. */
  readonly server?: readonly string[];
  /** Extra files that server code must not import. */
  readonly client?: readonly string[];
  /** Files exempt from the check (globs). */
  readonly ignore?: readonly string[];
}

/** A page that was written. @since 1.0.0 */
export interface PrerenderSuccess {
  readonly path: string;
  /** Absolute path of the written file. */
  readonly file: string;
  readonly status: number;
}

/** A page that did not render. @since 1.0.0 */
export interface PrerenderFailureEvent {
  readonly path: string;
  /** The reason: an `Error`, usually a `PrerenderError`. */
  readonly error: unknown;
  /** True for a path the build listed; false for a path the crawl found. */
  readonly explicit: boolean;
  /** For a path the crawl found: the page whose link led to it. */
  readonly from?: string;
}

/** What to prerender at build time. @since 1.0.0 */
export interface PrerenderOptions {
  /** Paths to render in addition to the routes that declare `export const prerender`. */
  readonly routes?: readonly string[];
  /**
   * More paths to render: a list, or a function that returns one (it may be async). Use it for the
   * params of a dynamic route when the list is easier to write here than in the route file.
   */
  readonly entries?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
  /**
   * Follows the internal links of the rendered pages. `true` follows three hops and adds at most 500
   * pages; an object sets `depth` (hops from the listed paths, at least 1) and `limit` (pages the
   * crawl may add, at least 0). Links to other origins, to fragments, to files (a last segment with
   * a dot) and under `/_dusk` are not followed. Off by default.
   */
  readonly crawlLinks?: boolean | { readonly depth?: number; readonly limit?: number };
  /** Keeps a path (listed or found by the crawl) out when it returns false. */
  readonly filter?: (path: string) => boolean;
  /** Attempts after a page that threw or answered 5xx. Default 0. Max 5. */
  readonly retry?: number;
  /** Called after each page is written. */
  readonly onSuccess?: (page: PrerenderSuccess) => void | Promise<void>;
  /** Called for each page that did not render, listed or found, before the run fails. */
  readonly onError?: (failure: PrerenderFailureEvent) => void | Promise<void>;
  /**
   * Origin of the requests sent to the handler. Default `http://localhost`; when the handler's
   * `security.allowedHosts` does not list `localhost`, the first plain (non-wildcard) host it lists,
   * so a production host list needs no extra setting. A 400 caused by the host check fails the
   * build with a message that names `security.allowedHosts` and the host used.
   */
  readonly origin?: string;
  /** Requests in flight at once. Default 4. */
  readonly concurrency?: number;
  /** A response that is not 200 fails the build. Default true. */
  readonly failOnError?: boolean;
  /**
   * A listed path that matches no route (it was removed or renamed) is skipped with a warning instead of failing the
   * build. The warning names the path, where it was listed and the closest route. Any other failure still fails the
   * build. Default false.
   */
  readonly skipMissing?: boolean;
}

/** Options of {@link dusk}. @since 1.0.0 */
export interface DuskOptions {
  /** Source folder relative to the project root. Default `src`. */
  readonly srcDir?: string;
  /** Build output folder relative to the project root; gets `client/` and `server/`. Default `dist`. */
  readonly outDir?: string;
  /** Options of the `shadow()` compiler plugin. */
  readonly shadow?: ShadowPluginOptions;
  /** Options of the file-route plugin. `routesDir` defaults to `<srcDir>/routes`. */
  readonly router?: ShadowRouterOptions;
  /** Import protection rules, besides the built-in conventions. */
  readonly importProtection?: false | ImportProtectionOptions;
  /** Prerendering at build time. `false` turns it off. */
  readonly prerender?: false | PrerenderOptions;
  /** Most preload entries per route in the manifest. Default 24. */
  readonly maxPreloadsPerRoute?: number;
  /** Build id baked into the manifest. Default: a hash of the client assets. */
  readonly buildId?: string;
  /**
   * The platform the build emits for, after the bundles are written: `node()`, `bun()`, `deno()`,
   * `cloudflare()`, `vercel()`, `netlify()`, `tarout()` or `staticSite()` from their subpaths.
   * Without it the build writes `dist/client`, `dist/server` and `dusk-manifest.json` only.
   */
  readonly adapter?: Adapter;
  /**
   * The origin the built client assets (the bundles, the CSS, and the files of the assets folder) are served from, for a
   * CDN, such as `https://cdn.example`. The pages and the modules point there; the routes, the public files and the
   * server stay on the app's own origin. The CDN must serve the files at `<origin><base><file>`. Default: same origin.
   */
  readonly assetOrigin?: string;
}

/**
 * Options with defaults filled in. @internal
 *
 * @since 1.0.0
 */
export interface ResolvedDuskOptions {
  readonly srcDir: string;
  readonly outDir: string;
  readonly shadow: ShadowPluginOptions;
  readonly router: ShadowRouterOptions;
  readonly importProtection: ImportProtectionOptions | false;
  readonly prerender: PrerenderOptions | false;
  readonly maxPreloadsPerRoute: number;
  readonly buildId: string | undefined;
  readonly adapter: Adapter | undefined;
  /** The CDN origin of the built client assets, without a trailing slash; `undefined` for same origin. */
  readonly assetOrigin: string | undefined;
}

const KNOWN = new Set([
  "srcDir",
  "outDir",
  "shadow",
  "router",
  "importProtection",
  "prerender",
  "maxPreloadsPerRoute",
  "buildId",
  "adapter",
  "assetOrigin",
]);

function suggest(name: string): string | undefined {
  const lowered = name.toLowerCase();
  for (const known of KNOWN) {
    if (known.toLowerCase() === lowered) return known;
    if (known.startsWith(name) || name.startsWith(known)) return known;
  }
  return undefined;
}

function relativeFolder(name: string, value: string): string {
  if (value === "" || value.startsWith("/") || value.split(/[\\/]/).includes("..")) {
    throw new TypeError(`dusk: ${name} must be a folder inside the project (got "${value}")`);
  }
  return value.replace(/[\\/]+$/, "");
}

/**
 * Validates and completes the options.
 *
 * @param options What the user passed.
 * @returns Options with defaults.
 * @throws TypeError for an unknown option (with a suggestion), a folder outside the project, or a
 *   number out of range.
 * @internal
 * @example resolveOptions({ srcDir: "app" }).router.routesDir; // "app/routes"
 * @since 1.0.0
 */
export function resolveOptions(options: DuskOptions = {}): ResolvedDuskOptions {
  for (const key of Object.keys(options)) {
    if (!KNOWN.has(key)) {
      const hint = suggest(key);
      throw new TypeError(
        `dusk: unknown option "${key}"${hint === undefined ? "" : `; did you mean "${hint}"?`}`,
      );
    }
  }
  const srcDir = relativeFolder("srcDir", options.srcDir ?? "src");
  const outDir = relativeFolder("outDir", options.outDir ?? "dist");
  const max = options.maxPreloadsPerRoute ?? 24;
  if (!Number.isInteger(max) || max < 1 || max > 1024) {
    throw new TypeError("dusk: maxPreloadsPerRoute must be an integer from 1 to 1024");
  }
  const prerender = options.prerender === undefined ? {} : options.prerender;
  if (prerender !== false) {
    const concurrency = prerender.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new TypeError("dusk: prerender.concurrency must be an integer from 1 to 64");
    }
    const retry = prerender.retry ?? 0;
    if (!Number.isInteger(retry) || retry < 0 || retry > 5) {
      throw new TypeError("dusk: prerender.retry must be an integer from 0 to 5");
    }
    // The crawl policy checks its own numbers when the build starts.
    crawlPolicyOf(prerender.crawlLinks);
    if (prerender.origin !== undefined && !URL.canParse(prerender.origin)) {
      throw new TypeError("dusk: prerender.origin must be an absolute URL");
    }
  }
  return {
    srcDir,
    outDir,
    shadow: options.shadow ?? {},
    router: {
      routesDir: `${srcDir}/routes`,
      generatedTree: `${srcDir}/routeTree.gen.ts`,
      ...options.router,
    },
    importProtection: options.importProtection === undefined ? {} : options.importProtection,
    prerender,
    maxPreloadsPerRoute: max,
    buildId: options.buildId,
    adapter: options.adapter === undefined ? undefined : assertAdapter(options.adapter),
    assetOrigin: assetOriginOf(options.assetOrigin),
  };
}

/**
 * Validates `assetOrigin`: an http(s) origin with no path, query or credentials. Returns it without a trailing slash.
 * @internal
 */
export function assetOriginOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = URL.canParse(value) ? new URL(value) : undefined;
  if (
    parsed === undefined ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError(
      `dusk: assetOrigin must be an http(s) origin such as https://cdn.example (got ${JSON.stringify(value)}).`,
    );
  }
  return parsed.origin;
}
