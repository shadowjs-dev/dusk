/**
 * `dusk.config.ts`: the declarative configuration of a Dusk app. It is read twice.
 *
 * - At build time, the Vite plugin loads the file (Vite's own config loader, so TypeScript works without
 *   a second toolchain), validates it, and merges it with the plugin options (`dusk({ ... })` wins for
 *   the keys both have: `adapter`, `prerender`, `buildId`).
 * - At server start, the server part of the file is written into the server bundle as plain JSON
 *   ({@link bakeServerConfig}); the handler validates it again with the same rules when the bundle loads.
 *
 * Secrets never belong in the file: it is written into the bundle. Secrets come from the environment.
 *
 * @packageDocumentation
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFromFile } from "vite";
import type { Adapter } from "../adapter/types";
import { assertAdapter } from "../adapter/types";
import {
  checkLocaleInstance,
  checkLocales,
  type DuskI18nRoutingConfig,
  type LocaleRoutingSettings,
  resolveLocaleRouting,
} from "../i18n/settings";
import type { BakedServerConfig } from "../server/baked-config";
import type { CorsOptions } from "../server/cors";
import type { CspOptions } from "../server/csp";
import type {
  CsrfOptions,
  LimitsOptions,
  SecureHeadersOptions,
  TrustProxyOptions,
} from "../server/types";
import { type CacheLifeProfile, resolveCacheLife } from "../shared/cache-life";
import { expectKeys, isRecord } from "../shared/check";
import type { ImageWidths } from "../shared/image";
import { checkImageWidths } from "../shared/image-check";
import { cacheControlOf, type RoutingConfig, validateRouting } from "../shared/routing-config";
import type { PrerenderOptions } from "./options";

export type {
  DuskI18nRoutingConfig,
  LocaleDetectionSource,
  LocaleInstanceConfig,
  LocalePrefixMode,
} from "../i18n/settings";
export type { BakedServerConfig } from "../server/baked-config";

/**
 * Locales of the app (`i18n` in `dusk.config.ts`). The default locale sets `<html lang>`; `routing` turns on automatic
 * locale routing (see {@link DuskI18nRoutingConfig}).
 * @example
 * const i18n: DuskI18nConfig = {
 *   locales: ["en", "fr"],
 *   defaultLocale: "en",
 *   routing: { instance: { module: "./src/i18n" } },
 * };
 * @since 1.0.0
 */
export interface DuskI18nConfig {
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  /** Declare it to let Dusk route by locale: the middleware, the redirects, the `hreflang` links and the client sync. */
  readonly routing?: DuskI18nRoutingConfig;
}

/** Env declarations as written in the file: the same plain shape `defineEnv` takes. @since 1.0.0 */
export type DuskEnvShape = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * The key of `env` that is not a variable declaration: the public environment contract. A variable
 * named `public` cannot be declared in `dusk.config.ts`.
 *
 * @example
 * PUBLIC_ENV_KEY; // "public"
 * @since 1.0.0
 */
export const PUBLIC_ENV_KEY = "public";

/**
 * The public environment contract (`env.public` in `dusk.config.ts`): which variables the browser
 * may read, and whether shared code can read them as `process.env.NAME` (Next's `NEXT_PUBLIC_*`
 * convention). Secrets are never public. @since 1.0.0
 */
export interface DuskPublicEnvConfig {
  /**
   * Prefixes whose variables reach the browser, in addition to `DUSK_PUBLIC_` and Vite's `envPrefix`.
   * Each is at least three characters; `*` is refused.
   */
  readonly prefixes?: readonly string[];
  /**
   * Names whose values are public on purpose even though a value looks like a credential (a key a
   * vendor documents as publishable, a preview link with a token). The build checks the values of
   * public names for credential shapes and fails on a match unless the name is listed here.
   */
  readonly allow?: readonly string[];
  /**
   * Give the client bundle `process.env`: each public variable as a literal (`process.env.NAME`) and
   * a `process.env` object holding the public variables only. Default `false`.
   */
  readonly processEnv?: boolean;
}

/** Security settings of the file. Secrets are not among them. @since 1.0.0 */
export interface DuskSecurityConfig {
  readonly allowedHosts?: readonly string[];
  /** With `allowedHosts: []` in production: accept any Host on purpose. */
  readonly acknowledgeNoHostCheck?: boolean;
  readonly headers?: false | SecureHeadersOptions;
  readonly csp?: false | CspOptions;
  readonly csrf?: false | CsrfOptions;
  readonly limits?: LimitsOptions;
  readonly trustProxy?: false | TrustProxyOptions;
  readonly nonce?: boolean;
  /** Origins that may send state-changing requests and absolute redirects. */
  readonly trustedOrigins?: readonly string[];
  /** Cross-origin access to API routes, for the listed origins only. */
  readonly cors?: CorsOptions;
  readonly rpc?: {
    readonly maxGetPayloadChars?: number;
    readonly maxResponseBytes?: number;
    readonly maxBatchSize?: number;
  };
  readonly maxPayloadBytes?: number;
  /** The `cache-control` of a response that sets none: a value, or `false` for none. Default `private, no-store`. */
  readonly defaultCacheControl?: string | false;
}

/** Image settings: the remote hosts the optimizer may fetch, and the widths, formats and qualities it serves. @since 1.0.0 */
export interface DuskImageConfig {
  /** Hosts whose images may be optimized (`cdn.example`, `cdn.example:8443`). */
  readonly domains?: readonly string[];
  /** Origins whose images may be optimized (`https://images.example`). Added to `domains`. */
  readonly remotePatterns?: readonly string[];
  /**
   * The widths the optimizer serves: `deviceSizes` (responsive images, `fill`) and `imageSizes` (small fixed images).
   * A list given replaces its default. `<Image>` snaps to these widths, and the server serves exactly them, so an image
   * never asks for a width the optimizer refuses. The largest is the optimizer's maximum width.
   * Default: 640 to 3840 for `deviceSizes`, 32 to 384 for `imageSizes`.
   */
  readonly widths?: ImageWidths;
  /** Same as `widths.deviceSizes`, kept for existing configurations. Not with `widths`. */
  readonly sizes?: readonly number[];
  /** The formats the optimizer may produce. `original` is the source's own. Default: all of them. */
  readonly formats?: readonly ("original" | "webp" | "avif" | "jpeg" | "png")[];
  /** The qualities the optimizer may produce (1 to 100). Default: any. */
  readonly qualities?: readonly number[];
}

/** Draft (preview) mode settings. @since 1.0.0 */
export interface DuskDraftModeConfig {
  /** The environment variable that holds the secret (at least 32 characters). Default `DUSK_DRAFT_SECRET`. */
  readonly secretEnv?: string;
  /** Cookie name. Default `__dusk_draft`. */
  readonly cookieName?: string;
  /** The enable endpoint (POST). Default `/_dusk/draft/enable`. */
  readonly enablePath?: string;
  /** The disable endpoint (POST). Default `/_dusk/draft/disable`. */
  readonly disablePath?: string;
}

/**
 * Size budgets of the production build, in gzip bytes. `dusk build` prints a warning for each page over its budget, and
 * fails the build instead when `enforce` is set. The size of a page is the JavaScript it loads first: its entry and the
 * chunks of its route.
 * @since 1.0.0
 */
export interface DuskBuildBudgets {
  /**
   * Fail the build (exit code 1, `DUSK_BUDGET_EXCEEDED` in `--json`) when a page is over its budget, after the summary is
   * printed. For CI: a regression of the bundle size stops the pipeline. A budget for a path no page has stays a warning.
   * @default false
   */
  readonly enforce?: boolean;
  /** The budget of every page's first-load JavaScript. */
  readonly firstLoadJs?: number;
  /** Budgets of single pages, by route path (`/dashboard`); each one replaces `firstLoadJs` for that page. */
  readonly routes?: Readonly<Record<string, number>>;
}

/** Build-time settings (not part of the server bundle). @since 1.0.0 */
export interface DuskBuildConfig {
  /**
   * Whether the build scans the client output for secrets. Default `true`: the build fails when a text file under
   * `dist/client` (bundles, prerendered pages, files from `public/`, source maps) holds the value of a server variable
   * or the shape of a common credential (an AWS key id, a Stripe or Clerk secret key, a GitHub, Slack or Google token,
   * a webhook signing secret, a private key). `false` turns the scan off for the app; a secret in the browser output is
   * then the app's responsibility.
   */
  readonly secretScan?: boolean;
  /** Size budgets; `dusk build` warns for a page over one, or fails when `enforce` is set. */
  readonly budgets?: DuskBuildBudgets;
}

/** Settings of `dusk dev` only; they never reach the server bundle. @since 1.0.0 */
export interface DuskDevConfig {
  /**
   * Host names the dev server answers besides `localhost`. Vite refuses every other `Host` header with a 403, so a
   * name mapped to `127.0.0.1` in `/etc/hosts` (to try host-based routing) or a tunnel needs to be listed here.
   * Write a host name (`join.example.com`), a name with a port (the port is ignored), or `*.example.com` for the
   * subdomains (also `.example.com`, Vite's spelling, which includes `example.com` itself). `true` accepts every
   * host: use it only on a machine nobody else can reach, because a page that any host can read is open to DNS rebinding.
   *
   * The hosts the app declares in `security.allowedHosts` are always allowed in development; this list adds to them. It only
   * opens Vite's check: the app's own host check still applies, so a name that is not in `security.allowedHosts` passes Vite
   * and is then answered 400 by the handler.
   */
  readonly allowedHosts?: readonly string[] | true;
}

/** The whole configuration. Every key is optional. @since 1.0.0 */
export interface DuskConfig extends RoutingConfig {
  /** The platform the build emits for (build time). A `dusk({ adapter })` option wins. */
  readonly adapter?: Adapter;
  readonly security?: DuskSecurityConfig;
  /**
   * Environment variables the server validates at start (see `defineEnv`). The key `public` is the
   * public environment contract ({@link DuskPublicEnvConfig}), not a variable.
   */
  readonly env?: DuskEnvShape;
  /**
   * Locales of the app. The default locale sets `<html lang>`; `i18n.routing` turns on automatic locale routing.
   */
  readonly i18n?: DuskI18nConfig;
  readonly image?: DuskImageConfig;
  /** Prerendering (build time). A `dusk({ prerender })` option wins. */
  readonly prerender?: false | PrerenderOptions;
  /** Named cache lifetimes; they add to or replace the presets. */
  readonly cacheLife?: Readonly<Record<string, CacheLifeProfile>>;
  readonly draftMode?: DuskDraftModeConfig;
  /** `false` turns off the `instrumentation.ts` convention. */
  readonly instrumentation?: false;
  /** Identifies the deployment; a client from another deployment is told to reload. A `dusk({ buildId })` option wins. */
  readonly deploymentId?: string;
  readonly skew?: { readonly reload?: boolean };
  /** Build-time settings of the client output. */
  readonly build?: DuskBuildConfig;
  /** Settings of `dusk dev` (not part of the server bundle). */
  readonly dev?: DuskDevConfig;
}

/**
 * Typed identity for `dusk.config.ts`: `export default defineConfig({ ... })`.
 *
 * @param config The configuration.
 * @returns The same object, typed.
 * @example
 * export default defineConfig({ redirects: [{ source: "/old", destination: "/new", permanent: true }] });
 * @since 1.0.0
 */
export function defineConfig<const C extends DuskConfig>(config: C): C {
  return config;
}

/** Keys that are options of `dusk({ ... })` in `vite.config.ts`, not of the file. */
const PLUGIN_ONLY = [
  "srcDir",
  "outDir",
  "shadow",
  "router",
  "importProtection",
  "maxPreloadsPerRoute",
] as const;
const TOP_KEYS = [
  "adapter",
  "security",
  "env",
  "i18n",
  "image",
  "prerender",
  "redirects",
  "rewrites",
  "headers",
  "routeRules",
  "cacheLife",
  "draftMode",
  "instrumentation",
  "deploymentId",
  "skew",
  "build",
  "buildId",
  "dev",
] as const;
const SECURITY_KEYS = [
  "allowedHosts",
  "acknowledgeNoHostCheck",
  "headers",
  "csp",
  "csrf",
  "cookieSecrets",
  "limits",
  "trustProxy",
  "nonce",
  "trustedOrigins",
  "cors",
  "rpc",
  "maxPayloadBytes",
  "requestId",
  "methodNotAllowed",
  "defaultCacheControl",
] as const;
const DEV_KEYS = ["allowedHosts"] as const;
const LIMIT_KEYS = ["maxUrlLength", "maxBodyBytes", "requestTimeoutMs", "streamTimeoutMs"] as const;
const RPC_KEYS = ["maxGetPayloadChars", "maxResponseBytes", "maxBatchSize"] as const;
const CORS_KEYS = ["origins", "methods", "headers", "credentials", "maxAgeSeconds"] as const;
const ENV_KINDS = ["string", "number", "boolean", "url", "enum"] as const;
const ENV_FIELD_KEYS = [
  "type",
  "required",
  "secret",
  "default",
  "minLength",
  "maxLength",
  "integer",
  "min",
  "max",
  "protocols",
  "values",
] as const;
const I18N_KEYS = ["locales", "defaultLocale", "routing"] as const;
const IMAGE_KEYS = [
  "domains",
  "remotePatterns",
  "widths",
  "sizes",
  "formats",
  "qualities",
] as const;
const IMAGE_FORMATS: readonly string[] = ["original", "webp", "avif", "jpeg", "png"];
const PRERENDER_KEYS = [
  "routes",
  "entries",
  "crawlLinks",
  "filter",
  "retry",
  "onSuccess",
  "onError",
  "origin",
  "concurrency",
  "failOnError",
  "skipMissing",
] as const;
const DRAFT_KEYS = ["secretEnv", "cookieName", "enablePath", "disablePath"] as const;
const SKEW_KEYS = ["reload"] as const;
const BUILD_KEYS = ["secretScan", "budgets"] as const;
const BUDGET_KEYS = ["firstLoadJs", "routes", "enforce"] as const;
const HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const DEPLOYMENT = /^[A-Za-z0-9._-]{1,128}$/;
const ROUTING_FIELDS = ["redirects", "rewrites", "headers", "routeRules"] as const;
const CONFIG_FILES = [
  "dusk.config.ts",
  "dusk.config.mts",
  "dusk.config.js",
  "dusk.config.mjs",
] as const;

function positive(where: string, value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new TypeError(
      `${where} must be a positive integer${max === Number.MAX_SAFE_INTEGER ? "" : ` up to ${max}`}.`,
    );
  }
  return value;
}

function stringList(
  where: string,
  value: unknown,
  check: (item: string) => boolean,
  rule: string,
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${where} must be an array.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !check(item)) {
      throw new TypeError(`${where}[${index}] ${rule}.`);
    }
    return item;
  });
}

function originList(where: string, value: unknown): string[] {
  return stringList(
    where,
    value,
    (item) => {
      if (!URL.canParse(item)) return false;
      const url = new URL(item);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin === item.replace(/\/$/, "")
      );
    },
    "must be an origin such as https://partner.example",
  );
}

function validateSecurity(value: unknown): DuskSecurityConfig {
  expectKeys("security", value, SECURITY_KEYS);
  if (value["cookieSecrets"] !== undefined) {
    throw new TypeError(
      "security.cookieSecrets is a secret and is not read from dusk.config.ts (the file is written into the server bundle): set the secrets in the server environment and pass them to createHandler in entry-server.ts.",
    );
  }
  if (value["allowedHosts"] !== undefined) {
    stringList(
      "security.allowedHosts",
      value["allowedHosts"],
      (item) => item !== "",
      "must be a non-empty host name",
    );
  }
  if (
    value["acknowledgeNoHostCheck"] !== undefined &&
    typeof value["acknowledgeNoHostCheck"] !== "boolean"
  ) {
    throw new TypeError("security.acknowledgeNoHostCheck must be true or false.");
  }
  if (value["trustedOrigins"] !== undefined)
    originList("security.trustedOrigins", value["trustedOrigins"]);
  if (value["limits"] !== undefined) expectKeys("security.limits", value["limits"], LIMIT_KEYS);
  if (value["rpc"] !== undefined) {
    expectKeys("security.rpc", value["rpc"], RPC_KEYS);
    for (const key of RPC_KEYS) {
      const item = (value["rpc"] as Record<string, unknown>)[key];
      if (item !== undefined) positive(`security.rpc.${key}`, item);
    }
  }
  if (value["maxPayloadBytes"] !== undefined)
    positive("security.maxPayloadBytes", value["maxPayloadBytes"]);
  if (value["cors"] !== undefined) {
    const cors = value["cors"];
    expectKeys("security.cors", cors, CORS_KEYS);
    originList("security.cors.origins", cors["origins"]);
    if (cors["methods"] !== undefined)
      stringList(
        "security.cors.methods",
        cors["methods"],
        (item) => TOKEN.test(item),
        "must be an HTTP method",
      );
    if (cors["headers"] !== undefined)
      stringList(
        "security.cors.headers",
        cors["headers"],
        (item) => TOKEN.test(item),
        "must be a header name",
      );
    if (cors["credentials"] !== undefined && typeof cors["credentials"] !== "boolean") {
      throw new TypeError("security.cors.credentials must be a boolean.");
    }
    if (
      cors["maxAgeSeconds"] !== undefined &&
      (typeof cors["maxAgeSeconds"] !== "number" ||
        !Number.isInteger(cors["maxAgeSeconds"]) ||
        cors["maxAgeSeconds"] < 0)
    ) {
      throw new TypeError("security.cors.maxAgeSeconds must be an integer, 0 or more.");
    }
  }
  if (value["requestId"] !== undefined && typeof value["requestId"] !== "boolean") {
    throw new TypeError(
      "security.requestId in dusk.config.ts is true or false (a function is written into the bundle: pass one to createHandler).",
    );
  }
  if (
    value["methodNotAllowed"] !== undefined &&
    value["methodNotAllowed"] !== "json" &&
    value["methodNotAllowed"] !== "empty"
  ) {
    throw new TypeError('security.methodNotAllowed must be "json" or "empty".');
  }
  if (value["defaultCacheControl"] !== undefined) {
    cacheControlOf("security.defaultCacheControl", value["defaultCacheControl"]);
  }
  return value as DuskSecurityConfig;
}

/** Validates `env.public` (see {@link DuskPublicEnvConfig}). */
function validatePublicEnv(value: unknown): void {
  const where = `env.${PUBLIC_ENV_KEY}`;
  if (!isRecord(value))
    throw new TypeError(
      `${where} must be an object (for example { prefixes: ["NEXT_PUBLIC_"], processEnv: true }).`,
    );
  expectKeys(where, value, ["prefixes", "processEnv", "allow"]);
  const prefixes = value["prefixes"];
  if (prefixes !== undefined) {
    if (!Array.isArray(prefixes))
      throw new TypeError(`${where}.prefixes must be an array of strings.`);
    for (const prefix of prefixes) {
      if (typeof prefix !== "string" || prefix === "*" || prefix.length < 3) {
        throw new TypeError(
          `${where}.prefixes: ${JSON.stringify(prefix)} would expose server variables to the browser; use a prefix of at least three characters such as "NEXT_PUBLIC_".`,
        );
      }
    }
  }
  if (value["processEnv"] !== undefined && typeof value["processEnv"] !== "boolean") {
    throw new TypeError(`${where}.processEnv must be true or false.`);
  }
  const allow = value["allow"];
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((name) => typeof name !== "string"))
      throw new TypeError(`${where}.allow must be an array of variable names.`);
  }
}

/**
 * The public environment contract of a validated configuration, with defaults applied. A missing
 * `env.public` gives no extra prefixes and no `process.env`.
 *
 * @param config A validated configuration (or undefined without a file).
 * @returns The extra public prefixes and whether the client gets `process.env`.
 * @example
 * publicEnvOf(undefined); // { prefixes: [], processEnv: false, allow: [] }
 * @since 1.0.0
 */
export function publicEnvOf(config: DuskConfig | undefined): {
  readonly prefixes: readonly string[];
  readonly processEnv: boolean;
  readonly allow: readonly string[];
} {
  const raw = config?.env?.[PUBLIC_ENV_KEY];
  if (!isRecord(raw)) return { prefixes: [], processEnv: false, allow: [] };
  const prefixes = Array.isArray(raw["prefixes"]) ? raw["prefixes"].map(String) : [];
  const allow = Array.isArray(raw["allow"]) ? raw["allow"].map(String) : [];
  return { prefixes, processEnv: raw["processEnv"] === true, allow };
}

function validateEnv(value: unknown): DuskEnvShape {
  if (!isRecord(value)) throw new TypeError("env must be an object of variable declarations.");
  for (const [name, field] of Object.entries(value)) {
    if (name === PUBLIC_ENV_KEY) {
      validatePublicEnv(field);
      continue;
    }
    if (!ENV_NAME.test(name))
      throw new TypeError(`env: the variable name ${JSON.stringify(name)} is not valid.`);
    const where = `env.${name}`;
    if (!isRecord(field))
      throw new TypeError(`${where} must be an object (for example { type: "string" }).`);
    if (field["pattern"] !== undefined) {
      throw new TypeError(
        `${where}.pattern is not supported in dusk.config.ts (a RegExp cannot be written into the server bundle); check the value in code with defineEnv.`,
      );
    }
    expectKeys(where, field, ENV_FIELD_KEYS);
    if (
      typeof field["type"] !== "string" ||
      !(ENV_KINDS as readonly string[]).includes(field["type"])
    ) {
      throw new TypeError(`${where}.type must be one of ${ENV_KINDS.join(", ")}.`);
    }
  }
  return value as DuskEnvShape;
}

/**
 * `i18n`: the locales (language tags, no repeat in any case, the default among them) and, when declared, the locale
 * routing (`i18n.routing`, the same rules the server runs at start; see `i18n/settings.ts`).
 */
function validateI18n(value: unknown): {
  locales: string[];
  defaultLocale: string;
  routing: LocaleRoutingSettings | undefined;
} {
  expectKeys("i18n", value, I18N_KEYS);
  const { locales, defaultLocale } = checkLocales(value, "i18n");
  const routing =
    value["routing"] === undefined
      ? undefined
      : resolveLocaleRouting(value["routing"], "i18n.routing", true);
  return { locales, defaultLocale, routing };
}

/** The extensions a module named without one is looked up with, in order (as the project's own files). */
const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"] as const;

/**
 * The module of the app's i18n instance when `dusk.config.ts` declares `i18n.routing`: its absolute path (the extension
 * found when the file names none, or the `index` file of a folder) and the export that holds the instance. The generated
 * server and client entries import it.
 *
 * @param config A validated configuration (or undefined without a file).
 * @param root The project root.
 * @returns The file and the export name, or `undefined` when locale routing is not declared.
 * @throws TypeError when the module does not exist, naming the paths that were tried.
 * @example
 * localeInstanceOf({ i18n: { locales: ["en"], defaultLocale: "en", routing: { instance: { module: "./src/i18n" } } } }, root);
 * // { file: "<root>/src/i18n.ts", exportName: "i18n" }
 * @since 1.0.0
 */
export function localeInstanceOf(
  config: DuskConfig | undefined,
  root: string,
): { readonly file: string; readonly exportName: string } | undefined {
  const routing = config?.i18n?.routing;
  if (routing === undefined) return undefined;
  const { module, exportName } = checkLocaleInstance(routing.instance, "i18n.routing.instance");
  const named = join(root, module);
  const candidates = [
    named,
    ...MODULE_EXTENSIONS.map((extension) => `${named}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) => join(named, `index${extension}`)),
  ];
  const isFile = (path: string): boolean =>
    existsSync(path) && MODULE_EXTENSIONS.some((extension) => path.endsWith(extension));
  const file = candidates.find(isFile);
  if (file === undefined) {
    throw new TypeError(
      `i18n.routing.instance.module: ${JSON.stringify(module)} was not found (tried ${module}, ${module}.ts, ${module}.tsx, ${module}.js and ${module}/index.ts, among others).`,
    );
  }
  return { file, exportName };
}

/**
 * Why every prerendered page is answered by the handler when locale routing is declared: the locale middleware runs for
 * each request (the redirects, `Vary`, `Content-Language` and the cookie), and a page served as a file would skip it.
 *
 * @param config A validated configuration (or undefined without a file).
 * @returns The reason, or `undefined` without locale routing.
 * @example
 * localeRoutingStaticReason(config); // "i18n.routing in dusk.config.ts runs the locale middleware for every page"
 * @since 1.0.0
 */
export function localeRoutingStaticReason(config: DuskConfig | undefined): string | undefined {
  return config?.i18n?.routing === undefined
    ? undefined
    : "i18n.routing in dusk.config.ts runs the locale middleware for every page";
}

function validateImage(value: unknown): DuskImageConfig {
  expectKeys("image", value, IMAGE_KEYS);
  if (value["domains"] !== undefined) {
    stringList(
      "image.domains",
      value["domains"],
      (item) => HOST.test(item),
      "must be a host name without a scheme, path or wildcard (domains)",
    );
  }
  if (value["remotePatterns"] !== undefined) {
    stringList(
      "image.remotePatterns",
      value["remotePatterns"],
      (item) => {
        const parsed = URL.canParse(item) ? new URL(item) : undefined;
        return (
          parsed !== undefined &&
          (parsed.protocol === "https:" || parsed.protocol === "http:") &&
          parsed.pathname === "/"
        );
      },
      "must be an http(s) origin such as https://images.example (remotePatterns)",
    );
  }
  if (value["formats"] !== undefined) {
    if (!Array.isArray(value["formats"]) || value["formats"].length === 0)
      throw new TypeError("image.formats must be a non-empty array of formats.");
    for (const format of value["formats"]) {
      if (typeof format !== "string" || !IMAGE_FORMATS.includes(format))
        throw new TypeError(
          `image.formats item ${JSON.stringify(format)} must be one of ${IMAGE_FORMATS.join(", ")}.`,
        );
    }
  }
  if (value["qualities"] !== undefined) {
    if (!Array.isArray(value["qualities"]) || value["qualities"].length === 0)
      throw new TypeError("image.qualities must be a non-empty array of qualities (1 to 100).");
    for (const quality of value["qualities"]) positive("image.qualities item", quality, 100);
  }
  if (value["sizes"] !== undefined) {
    if (value["widths"] !== undefined)
      throw new TypeError("image.sizes and image.widths are one setting: use image.widths.");
    if (!Array.isArray(value["sizes"]) || value["sizes"].length === 0)
      throw new TypeError("image.sizes must be a non-empty array of widths (sizes).");
    for (const size of value["sizes"]) positive("image.sizes item", size, 8192);
  }
  // The same check the server runs at start (see `imageWidthSet` in `shared/image-check.ts`): a list the optimizer could not serve fails here.
  checkImageWidths(value["widths"], "image.widths");
  return value as DuskImageConfig;
}

/**
 * Validates the file's default export. Throws at the first problem, with the key that has it.
 *
 * @param raw The value the file exports.
 * @returns The same value, typed.
 * @throws TypeError for an unknown or plugin-only key, a bad value, or a routing rule that fails
 *   {@link validateRouting}.
 * @example
 * import { validateDuskConfig } from "@shadow-js/dusk/vite";
 * validateDuskConfig({ deploymentId: "rel-42" }).deploymentId; // "rel-42"
 * @since 1.0.0
 */
export function validateDuskConfig(raw: unknown): DuskConfig {
  if (!isRecord(raw))
    throw new TypeError("dusk.config.ts must export an object (use defineConfig({ ... })).");
  for (const key of PLUGIN_ONLY) {
    if (Object.hasOwn(raw, key)) {
      throw new TypeError(
        `dusk.config.ts: "${key}" is an option of dusk({ ${key} }) in vite.config.ts, not of this file.`,
      );
    }
  }
  expectKeys("dusk.config", raw, TOP_KEYS);
  const security = raw["security"] === undefined ? undefined : validateSecurity(raw["security"]);
  if (raw["adapter"] !== undefined) assertAdapter(raw["adapter"]);
  if (raw["env"] !== undefined) validateEnv(raw["env"]);
  if (raw["i18n"] !== undefined) validateI18n(raw["i18n"]);
  if (raw["image"] !== undefined) validateImage(raw["image"]);
  if (raw["prerender"] !== undefined && raw["prerender"] !== false) {
    expectKeys("prerender", raw["prerender"], PRERENDER_KEYS);
    for (const key of ["failOnError", "skipMissing"] as const) {
      const flag = raw["prerender"][key];
      if (flag !== undefined && typeof flag !== "boolean") {
        throw new TypeError(`prerender.${key} must be true or false.`);
      }
    }
  }
  if (raw["cacheLife"] !== undefined) resolveCacheLife(raw["cacheLife"]);
  if (raw["draftMode"] !== undefined) {
    const draft = raw["draftMode"];
    expectKeys("draftMode", draft, DRAFT_KEYS);
    if (
      draft["secretEnv"] !== undefined &&
      (typeof draft["secretEnv"] !== "string" || !ENV_NAME.test(draft["secretEnv"]))
    ) {
      throw new TypeError("draftMode.secretEnv must be the name of an environment variable.");
    }
    if (
      draft["cookieName"] !== undefined &&
      (typeof draft["cookieName"] !== "string" || !TOKEN.test(draft["cookieName"]))
    ) {
      throw new TypeError("draftMode.cookieName must be a cookie name.");
    }
    for (const key of ["enablePath", "disablePath"] as const) {
      const path = draft[key];
      if (
        path !== undefined &&
        (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
      ) {
        throw new TypeError(`draftMode.${key} must be an app path such as /_dusk/draft/enable.`);
      }
    }
  }
  if (raw["instrumentation"] !== undefined && raw["instrumentation"] !== false) {
    throw new TypeError(
      "instrumentation: only false is accepted (it turns off src/instrumentation.ts).",
    );
  }
  if (
    raw["deploymentId"] !== undefined &&
    (typeof raw["deploymentId"] !== "string" || !DEPLOYMENT.test(raw["deploymentId"]))
  ) {
    throw new TypeError(
      "deploymentId must be 1 to 128 letters, digits, dots, dashes or underscores.",
    );
  }
  if (raw["skew"] !== undefined) {
    expectKeys("skew", raw["skew"], SKEW_KEYS);
    if (raw["skew"]["reload"] !== undefined && typeof raw["skew"]["reload"] !== "boolean") {
      throw new TypeError("skew.reload must be a boolean.");
    }
  }
  if (raw["build"] !== undefined) {
    expectKeys("build", raw["build"], BUILD_KEYS);
    if (
      raw["build"]["secretScan"] !== undefined &&
      typeof raw["build"]["secretScan"] !== "boolean"
    ) {
      throw new TypeError("build.secretScan must be a boolean.");
    }
    if (raw["build"]["budgets"] !== undefined) validateBudgets(raw["build"]["budgets"]);
  }
  if (raw["dev"] !== undefined) validateDev(raw["dev"]);
  const routing = Object.fromEntries(
    ROUTING_FIELDS.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]),
  ) as RoutingConfig;
  validateRouting(routing, { trustedOrigins: security?.trustedOrigins ?? [] });
  return raw as DuskConfig;
}

/** `build.budgets`: positive byte counts, with route paths as keys of `routes`. @internal */
/** Validates `dev` (see {@link DuskDevConfig}). */
function validateDev(value: unknown): void {
  expectKeys("dev", value, DEV_KEYS);
  const hosts = value["allowedHosts"];
  if (hosts === undefined || hosts === true) return;
  if (!Array.isArray(hosts)) {
    throw new TypeError("dev.allowedHosts must be an array of host names, or true.");
  }
  stringList(
    "dev.allowedHosts",
    hosts,
    (item) => item !== "" && item !== "*" && !/[\s/@]/.test(item),
    "must be a host name such as join.example.com",
  );
}

function validateBudgets(value: unknown): void {
  expectKeys("build.budgets", value, BUDGET_KEYS);
  if (!isRecord(value)) return;
  const bytes = (name: string, amount: unknown): void => {
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      throw new TypeError(`${name} must be a whole number of bytes above 0.`);
    }
  };
  if (value["firstLoadJs"] !== undefined) bytes("build.budgets.firstLoadJs", value["firstLoadJs"]);
  if (value["enforce"] !== undefined && typeof value["enforce"] !== "boolean") {
    throw new TypeError("build.budgets.enforce must be true or false.");
  }
  const routes = value["routes"];
  if (routes === undefined) return;
  if (!isRecord(routes)) throw new TypeError("build.budgets.routes must be an object.");
  for (const [path, amount] of Object.entries(routes)) {
    if (!path.startsWith("/")) {
      throw new TypeError(
        `build.budgets.routes: "${path}" must be a route path that starts with /.`,
      );
    }
    bytes(`build.budgets.routes["${path}"]`, amount);
  }
}

/** A value that can be written into the server bundle as JSON. @internal */
function assertPlainData(value: unknown, path: string): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return;
  if (typeof value === "number") return;
  if (typeof value !== "object") {
    throw new TypeError(
      `dusk.config.ts: ${path} must be plain data (no ${typeof value}), because the server bundle is written from it.`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPlainData(item, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      `dusk.config.ts: ${path} must be plain data (not a ${String((value as { constructor?: { name?: string } }).constructor?.name ?? "class instance")}).`,
    );
  }
  for (const [key, item] of Object.entries(value)) {
    const child = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
      ? `${path}.${key}`
      : `${path}[${JSON.stringify(key)}]`;
    assertPlainData(item, child);
  }
}

/** The optimizer settings as the server bundle receives them. @internal */
interface BakedImages {
  remotePatterns?: string[];
  widths?: ImageWidths;
  formats?: string[];
  qualities?: number[];
}

/**
 * The widths the optimizer serves, as plain lists, from `image.widths` or the older `image.sizes` (the device list).
 * The server bundle and the generated client entry both take this value, so they cannot disagree.
 *
 * @param config A validated configuration.
 * @returns The widths, or `undefined` for the defaults.
 * @example
 * imageWidthsOf({ image: { widths: { imageSizes: [64] } } }); // { imageSizes: [64] }
 * @since 1.0.0
 */
export function imageWidthsOf(config: DuskConfig): ImageWidths | undefined {
  const device = config.image?.widths?.deviceSizes ?? config.image?.sizes;
  const small = config.image?.widths?.imageSizes;
  if (device === undefined && small === undefined) return undefined;
  return {
    ...(device === undefined ? {} : { deviceSizes: [...device] }),
    ...(small === undefined ? {} : { imageSizes: [...small] }),
  };
}

/** One host pattern of Dusk (`host:port`, `*.host`) in the spelling of Vite's `server.allowedHosts`. */
function viteHostPattern(pattern: string): string | undefined {
  const lower = pattern.trim().toLowerCase();
  // Vite lets every IP address through, and an IPv6 literal has colons that are not a port.
  if (lower.startsWith("[")) return undefined;
  const portAt = lower.lastIndexOf(":");
  const name = portAt === -1 ? lower : lower.slice(0, portAt);
  return name.startsWith("*.") ? name.slice(1) : name;
}

/**
 * The hosts the dev server accepts in addition to `localhost`: `dev.allowedHosts` and the hosts the app declares in
 * `security.allowedHosts` (they are the hosts it serves, so they work in development too), written the way Vite's
 * `server.allowedHosts` reads them. Without either, `undefined`: Vite keeps its own default.
 *
 * @param config A validated configuration (or undefined without a file).
 * @returns `true` for every host, a list of host patterns, or `undefined`.
 * @example
 * devAllowedHostsOf({ security: { allowedHosts: ["*.example.com:8443"] } }); // [".example.com"]
 * @since 1.0.0
 */
export function devAllowedHostsOf(config: DuskConfig | undefined): true | string[] | undefined {
  const dev = config?.dev?.allowedHosts;
  if (dev === true) return true;
  const hosts: string[] = [];
  for (const pattern of [...(dev ?? []), ...(config?.security?.allowedHosts ?? [])]) {
    const host = viteHostPattern(pattern);
    if (host !== undefined && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.length === 0 ? undefined : hosts;
}

/**
 * The server part of a validated configuration, as plain JSON. The build writes it into the server
 * bundle, and the handler reads it at start. Build-only keys (adapter, prerender) are not part of it.
 *
 * @param config A validated configuration (see {@link validateDuskConfig}).
 * @returns The server configuration.
 * @throws TypeError when a value is not plain data (a function, a class instance), with its path.
 * @example
 * import { bakeServerConfig, validateDuskConfig } from "@shadow-js/dusk/vite";
 * bakeServerConfig(validateDuskConfig({ deploymentId: "rel-42" })).deploymentId; // "rel-42"
 * @since 1.0.0
 */
export function bakeServerConfig(config: DuskConfig): BakedServerConfig {
  const baked: {
    security?: DuskSecurityConfig;
    routing?: RoutingConfig;
    env?: DuskEnvShape;
    i18n?: {
      locales: readonly string[];
      defaultLocale: string;
      routing?: LocaleRoutingSettings;
    };
    images?: BakedImages;
    cacheLife?: Readonly<Record<string, CacheLifeProfile>>;
    draftMode?: DuskDraftModeConfig;
    deploymentId?: string;
    skew: { reload: boolean };
    instrumentation: boolean;
  } = {
    skew: { reload: config.skew?.reload !== false },
    instrumentation: config.instrumentation !== false,
  };
  if (config.security !== undefined) baked.security = config.security;
  const routing: RoutingConfig = {
    ...(config.redirects === undefined ? {} : { redirects: config.redirects }),
    ...(config.rewrites === undefined ? {} : { rewrites: config.rewrites }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    ...(config.routeRules === undefined ? {} : { routeRules: config.routeRules }),
  };
  if (Object.keys(routing).length > 0) baked.routing = routing;
  if (config.env !== undefined) {
    // `public` is the public-env contract (build time, client side), not a server declaration.
    baked.env = Object.fromEntries(
      Object.entries(config.env).filter(([name]) => name !== PUBLIC_ENV_KEY),
    );
  }
  if (config.i18n !== undefined) {
    // The routing settings with their defaults; `instance` is build-only (the entries import it), never baked.
    const routing =
      config.i18n.routing === undefined
        ? undefined
        : resolveLocaleRouting(config.i18n.routing, "i18n.routing", true);
    baked.i18n = {
      locales: [...config.i18n.locales],
      defaultLocale: config.i18n.defaultLocale,
      ...(routing === undefined ? {} : { routing }),
    };
  }
  if (config.image !== undefined) {
    const image: BakedImages = {};
    const origins = [
      ...(config.image.domains ?? []).map((host) => `https://${host}`),
      ...(config.image.remotePatterns ?? []),
    ];
    if (origins.length > 0) image.remotePatterns = origins;
    const widths = imageWidthsOf(config);
    if (widths !== undefined) image.widths = widths;
    if (config.image.formats !== undefined) image.formats = [...config.image.formats];
    if (config.image.qualities !== undefined) image.qualities = [...config.image.qualities];
    baked.images = image;
  }
  if (config.cacheLife !== undefined) baked.cacheLife = resolveCacheLife(config.cacheLife);
  if (config.draftMode !== undefined) baked.draftMode = config.draftMode;
  if (config.deploymentId !== undefined) baked.deploymentId = config.deploymentId;
  assertPlainData(baked, "the configuration");
  return baked as BakedServerConfig;
}

/** The build options after the precedence rule. @since 1.0.0 */
export interface MergedBuildOptions {
  readonly buildId: string | undefined;
  readonly prerender: false | PrerenderOptions | undefined;
  readonly adapter: Adapter | undefined;
}

/**
 * The precedence of build options: a `dusk({ ... })` option wins over the same key of `dusk.config.ts`
 * (`buildId` over `deploymentId`); the file fills what the plugin did not set.
 *
 * @param plugin The plugin options.
 * @param file The validated file, if any.
 * @returns The effective build options.
 * @example
 * import { mergeBuildOptions } from "@shadow-js/dusk/vite";
 * mergeBuildOptions({ buildId: "b-1" }, { deploymentId: "rel-42" }).buildId; // "b-1"
 * @since 1.0.0
 */
export function mergeBuildOptions(
  plugin: {
    readonly buildId?: string | undefined;
    readonly prerender?: false | PrerenderOptions | undefined;
    readonly adapter?: Adapter | undefined;
  },
  file: DuskConfig | undefined,
): MergedBuildOptions {
  return {
    buildId: plugin.buildId ?? file?.deploymentId,
    prerender: plugin.prerender ?? file?.prerender,
    adapter: plugin.adapter ?? file?.adapter,
  };
}

/** A loaded and validated configuration file. @since 1.0.0 */
export interface LoadedDuskConfig {
  /** Absolute path of the file. */
  readonly path: string;
  readonly config: DuskConfig;
  /** Files the configuration imported (watched in development). */
  readonly dependencies: readonly string[];
}

/**
 * Loads `dusk.config.(ts|mts|js|mjs)` from the project root with Vite's config loader, and validates it.
 *
 * @param root The project root.
 * @param mode The Vite mode.
 * @param command `build` or `serve`.
 * @returns The loaded file, or `undefined` when the project has none.
 * @throws Error when more than one config file exists; TypeError for an invalid file (its path is named).
 * @example
 * import { loadDuskConfigFile } from "@shadow-js/dusk/vite";
 * await loadDuskConfigFile(root, "production", "build"); // undefined when the project has no dusk.config file
 * @since 1.0.0
 */
export async function loadDuskConfigFile(
  root: string,
  mode: string,
  command: "build" | "serve",
): Promise<LoadedDuskConfig | undefined> {
  const found = CONFIG_FILES.filter((name) => existsSync(join(root, name)));
  if (found.length === 0) return undefined;
  if (found.length > 1) {
    throw new Error(`dusk: more than one config file (${found.join(", ")}) in ${root}; keep one.`);
  }
  const path = join(root, found[0] ?? "dusk.config.ts");
  let loaded: Awaited<ReturnType<typeof loadConfigFromFile>>;
  try {
    loaded = await loadConfigFromFile({ command, mode }, path, root, "silent");
  } catch (error) {
    // Vite's own message (a syntax error, a missing import, a non-object export) with the file named.
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${path}: ${reason}`, { cause: error });
  }
  if (loaded === null) return undefined;
  const exported: unknown = loaded.config;
  if (!isRecord(exported)) {
    throw new TypeError(
      `${path}: the default export must be an object (use defineConfig({ ... })).`,
    );
  }
  try {
    return { path, config: validateDuskConfig(exported), dependencies: loaded.dependencies };
  } catch (error) {
    if (error instanceof TypeError) throw new TypeError(`${path}: ${error.message}`);
    throw error;
  }
}
