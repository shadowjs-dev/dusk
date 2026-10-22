/**
 * The locale routing settings of `dusk.config.ts` (`i18n.routing`): their shape, their defaults and the one validation
 * the build (`validateDuskConfig`) and the server start (`withLocaleRouting`) both run, so a value is refused with the
 * same message in both places. Plain data only: the server part is written into the server bundle as JSON.
 *
 * Nothing here imports `@shadow-js/i18n`: the build and the baked configuration read this module, and an app without
 * locale routing never loads the i18n package through it.
 *
 * @packageDocumentation
 */

import { expectKeys, isRecord } from "../shared/check";

/**
 * How URLs carry the locale: `"as-needed"` (the default locale has no prefix: `/about`, `/fr/about`), `"always"`
 * (`/en/about`, `/fr/about`) or `"never"` (the locale comes from the cookie or `Accept-Language`, never the URL). The
 * same values as the `prefix` option of `createI18n`.
 *
 * @example
 * const prefix: LocalePrefixMode = "always";
 * @since 1.0.0
 */
export type LocalePrefixMode = "as-needed" | "always" | "never";

/**
 * A request source the locale is read from when the URL does not name one: the locale cookie or the
 * `Accept-Language` header (with its q-values).
 *
 * @example
 * const detection: LocaleDetectionSource[] = ["cookie", "accept-language"];
 * @since 1.0.0
 */
export type LocaleDetectionSource = "cookie" | "accept-language";

/**
 * The module that exports the app's i18n instance, as written in `dusk.config.ts`. Build time only: the generated
 * entries import it, and it is not part of the server bundle's configuration.
 *
 * @example
 * const instance: LocaleInstanceConfig = { module: "./src/i18n", export: "i18n" };
 * @since 1.0.0
 */
export interface LocaleInstanceConfig {
  /** The module, relative to the project root, starting with `./` (`./src/i18n`); the extension may be left out. */
  readonly module: string;
  /** The name of the export that holds the instance, or `"default"`. Default `"i18n"`. */
  readonly export?: string;
}

/**
 * `i18n.routing` of `dusk.config.ts`: declaring it turns on automatic locale routing (a locale middleware, the redirects,
 * `<html lang dir>`, the `hreflang` links and the client sync). Every key but `instance` has a default.
 *
 * @example
 * const routing: DuskI18nRoutingConfig = {
 *   instance: { module: "./src/i18n" },
 *   prefix: "as-needed",
 *   detection: ["cookie", "accept-language"],
 *   cookie: { name: "locale", maxAge: 31_536_000 },
 * };
 * @since 1.0.0
 */
export interface DuskI18nRoutingConfig {
  /** The module that exports the app's i18n instance (build time). */
  readonly instance: LocaleInstanceConfig;
  /** How URLs carry the locale. Default `"as-needed"`. It must equal the `prefix` the instance was created with. */
  readonly prefix?: LocalePrefixMode;
  /**
   * Where the locale is read from when the URL does not name one, in order; the URL prefix always comes first under
   * `"as-needed"` and `"always"`. Default `["cookie", "accept-language"]`. `[]` means the default locale.
   */
  readonly detection?: readonly LocaleDetectionSource[];
  /**
   * The cookie that remembers the locale a URL chose: `SameSite=Lax`, `Path=/`, readable by scripts, `Secure` on https.
   * Default `{ name: "locale", maxAge: 31536000 }` (one year). `false` writes none (the `"cookie"` source then reads a
   * cookie named `locale`, which the app may write itself).
   */
  readonly cookie?: false | { readonly name?: string; readonly maxAge?: number };
  /** Write `hreflang` alternate links and a canonical link into the head of every localized page. Default `true`. */
  readonly alternates?: boolean;
  /**
   * The origin of the `hreflang` and canonical URLs (`https://example.com`). Default: the origin of the request, which
   * the host check (`security.allowedHosts`) guards.
   */
  readonly origin?: string;
}

/**
 * The locale routing settings with every default applied: what the build writes into the server bundle (without the
 * build-only `instance`) and what the server reads.
 *
 * @example
 * const settings: LocaleRoutingSettings = {
 *   prefix: "as-needed",
 *   detection: ["cookie", "accept-language"],
 *   cookie: { name: "locale", maxAge: 31_536_000 },
 *   alternates: true,
 * };
 * @since 1.0.0
 */
export interface LocaleRoutingSettings {
  /** How URLs carry the locale. */
  readonly prefix: LocalePrefixMode;
  /** The sources read, in order, when the URL does not name the locale. */
  readonly detection: readonly LocaleDetectionSource[];
  /** The locale cookie (its name and life in seconds), or `false` for none. */
  readonly cookie: false | { readonly name: string; readonly maxAge: number };
  /** Whether localized pages get the `hreflang` alternates and the canonical link. */
  readonly alternates: boolean;
  /** The origin of those links; absent: the request's. */
  readonly origin?: string;
}

/**
 * The `i18n` part of the server bundle's configuration when locale routing is declared: the locales, the default
 * locale and the resolved routing settings.
 *
 * @example
 * const config: LocaleRoutingConfig = {
 *   locales: ["en", "fr"],
 *   defaultLocale: "en",
 *   routing: { prefix: "as-needed", detection: ["cookie", "accept-language"], cookie: false, alternates: true },
 * };
 * @since 1.0.0
 */
export interface LocaleRoutingConfig {
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly routing: LocaleRoutingSettings;
}

/** The default cookie name, the same as `createI18nMiddleware`'s. @internal */
export const DEFAULT_LOCALE_COOKIE = "locale";

/** One year in seconds: the default life of the locale cookie. @internal */
export const DEFAULT_LOCALE_COOKIE_MAX_AGE = 31_536_000;

/** 400 days: browsers cap a cookie's life there, so a longer `maxAge` is a configuration error. @internal */
export const MAX_LOCALE_COOKIE_MAX_AGE = 34_560_000;

const PREFIXES: readonly LocalePrefixMode[] = Object.freeze(["as-needed", "always", "never"]);
const SOURCES: readonly LocaleDetectionSource[] = Object.freeze(["cookie", "accept-language"]);
const ROUTING_KEYS = ["instance", "prefix", "detection", "cookie", "alternates", "origin"] as const;
const SETTINGS_KEYS = ["prefix", "detection", "cookie", "alternates", "origin"] as const;
const COOKIE_KEYS = ["name", "maxAge"] as const;
const INSTANCE_KEYS = ["module", "export"] as const;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Checks the locales and the default locale of an `i18n` value: language tags, at least one, no repeat, and a default
 * locale that is one of them.
 *
 * @param value The `i18n` object.
 * @param where The name of the value in messages (`i18n`).
 * @returns The locales and the default locale.
 * @throws TypeError naming the key at fault.
 * @example
 * checkLocales({ locales: ["en", "fr"], defaultLocale: "en" }, "i18n");
 * @internal
 */
export function checkLocales(
  value: Readonly<Record<string, unknown>>,
  where: string,
): { locales: string[]; defaultLocale: string } {
  const raw = value["locales"];
  if (!Array.isArray(raw)) throw new TypeError(`${where}.locales must be an array.`);
  const locales = raw.map((item: unknown, index) => {
    if (typeof item !== "string" || !LANGUAGE.test(item)) {
      throw new TypeError(`${where}.locales[${index}] must be a language tag such as en or pt-BR.`);
    }
    return item;
  });
  if (locales.length === 0) throw new TypeError(`${where}.locales must list at least one locale.`);
  if (new Set(locales.map((locale) => locale.toLowerCase())).size !== locales.length)
    throw new TypeError(`${where}.locales must not repeat a locale.`);
  const defaultLocale = value["defaultLocale"];
  if (typeof defaultLocale !== "string" || !locales.includes(defaultLocale)) {
    throw new TypeError(
      `${where}.defaultLocale must be one of the locales (${locales.join(", ")}).`,
    );
  }
  return { locales, defaultLocale };
}

/**
 * Checks `i18n.routing.instance` (build time only): a `./` path inside the project and an export name.
 *
 * @param value The `instance` value.
 * @param where The name of the value in messages (`i18n.routing.instance`).
 * @returns The module path and the export name (`"i18n"` when omitted).
 * @throws TypeError naming the key at fault.
 * @example
 * checkLocaleInstance({ module: "./src/i18n" }, "i18n.routing.instance"); // { module: "./src/i18n", exportName: "i18n" }
 * @internal
 */
export function checkLocaleInstance(
  value: unknown,
  where: string,
): { module: string; exportName: string } {
  if (!isRecord(value)) {
    throw new TypeError(
      `${where} must be an object such as { module: "./src/i18n", export: "i18n" }: the module that exports the app's i18n instance.`,
    );
  }
  expectKeys(where, value, INSTANCE_KEYS);
  const module = value["module"];
  if (typeof module !== "string" || !isProjectModule(module)) {
    throw new TypeError(
      `${where}.module must be a path inside the project that starts with ./ (for example "./src/i18n"), without "..", backslashes, a query or control characters.`,
    );
  }
  const exportName = value["export"] ?? "i18n";
  if (
    typeof exportName !== "string" ||
    (exportName !== "default" && !IDENTIFIER.test(exportName))
  ) {
    throw new TypeError(
      `${where}.export must be the name of an export (an identifier such as i18n) or "default".`,
    );
  }
  return { module, exportName };
}

/** A `./` module path that stays inside the project: no `..` segment, backslash, query, hash or control character. */
function isProjectModule(path: string): boolean {
  if (!path.startsWith("./") || path.length > 512 || path.endsWith("/")) return false;
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || character === "\\" || character === "?" || character === "#")
      return false;
  }
  return path
    .slice(2)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Validates `i18n.routing` and applies its defaults. The build runs it on the file's value (with `instance`), and the
 * server runs it again on the baked settings (without it): the same rules, the same messages.
 *
 * @param value The `routing` value.
 * @param where The name of the value in messages (`i18n.routing`).
 * @param build `true` at build time: `instance` is required. `false` at server start: `instance` is not part of the
 *   server bundle and is refused.
 * @returns The settings with every default applied.
 * @throws TypeError naming the key at fault.
 * @example
 * resolveLocaleRouting({ instance: { module: "./src/i18n" } }, "i18n.routing", true).prefix; // "as-needed"
 * @since 1.0.0
 */
export function resolveLocaleRouting(
  value: unknown,
  where: string,
  build: boolean,
): LocaleRoutingSettings {
  if (!isRecord(value)) {
    throw new TypeError(
      `${where} must be an object such as { instance: { module: "./src/i18n" }, prefix: "as-needed" }.`,
    );
  }
  expectKeys(where, value, build ? ROUTING_KEYS : SETTINGS_KEYS);
  if (build) {
    if (value["instance"] === undefined) {
      throw new TypeError(
        `${where}.instance is required: name the module that exports the app's i18n instance, for example { module: "./src/i18n", export: "i18n" }.`,
      );
    }
    checkLocaleInstance(value["instance"], `${where}.instance`);
  }
  const prefix = value["prefix"] ?? "as-needed";
  if (typeof prefix !== "string" || !(PREFIXES as readonly string[]).includes(prefix)) {
    throw new TypeError(`${where}.prefix must be "as-needed", "always" or "never".`);
  }
  const detection = checkDetection(value["detection"], `${where}.detection`);
  const cookie = checkCookie(value["cookie"], `${where}.cookie`);
  const alternates = value["alternates"] ?? true;
  if (typeof alternates !== "boolean")
    throw new TypeError(`${where}.alternates must be true or false.`);
  const origin = value["origin"];
  if (origin !== undefined && (typeof origin !== "string" || !isOrigin(origin))) {
    throw new TypeError(
      `${where}.origin must be an http(s) origin such as https://example.com (no path, query or credentials).`,
    );
  }
  return {
    prefix: prefix as LocalePrefixMode,
    detection,
    cookie,
    alternates,
    ...(origin === undefined ? {} : { origin: (origin as string).replace(/\/$/, "") }),
  };
}

function checkDetection(value: unknown, where: string): LocaleDetectionSource[] {
  if (value === undefined) return [...SOURCES];
  if (!Array.isArray(value))
    throw new TypeError(`${where} must be an array of "cookie" and "accept-language".`);
  const seen = new Set<string>();
  return value.map((item: unknown, index) => {
    if (item === "url") {
      throw new TypeError(
        `${where}[${index}]: "url" is not listed: the URL prefix always decides first under prefix routing. List only "cookie" and "accept-language".`,
      );
    }
    if (typeof item !== "string" || !(SOURCES as readonly string[]).includes(item)) {
      throw new TypeError(`${where}[${index}] must be "cookie" or "accept-language".`);
    }
    if (seen.has(item)) throw new TypeError(`${where} must not repeat "${item}".`);
    seen.add(item);
    return item as LocaleDetectionSource;
  });
}

function checkCookie(value: unknown, where: string): LocaleRoutingSettings["cookie"] {
  if (value === false) return false;
  if (value === undefined)
    return { name: DEFAULT_LOCALE_COOKIE, maxAge: DEFAULT_LOCALE_COOKIE_MAX_AGE };
  if (!isRecord(value))
    throw new TypeError(`${where} must be false or an object such as { name: "locale" }.`);
  expectKeys(where, value, COOKIE_KEYS);
  const name = value["name"] ?? DEFAULT_LOCALE_COOKIE;
  if (typeof name !== "string" || !COOKIE_NAME.test(name)) {
    throw new TypeError(`${where}.name must be a cookie name (1 to 128 token characters).`);
  }
  if (name.startsWith("__Host-") || name.startsWith("__Secure-")) {
    throw new TypeError(
      `${where}.name must not start with __Host- or __Secure-: the cookie is written without Secure on a plain http development server.`,
    );
  }
  const maxAge = value["maxAge"] ?? DEFAULT_LOCALE_COOKIE_MAX_AGE;
  if (
    typeof maxAge !== "number" ||
    !Number.isInteger(maxAge) ||
    maxAge < 1 ||
    maxAge > MAX_LOCALE_COOKIE_MAX_AGE
  ) {
    throw new TypeError(
      `${where}.maxAge must be a whole number of seconds from 1 to ${MAX_LOCALE_COOKIE_MAX_AGE} (400 days).`,
    );
  }
  return { name, maxAge };
}

function isOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    url.origin === value.replace(/\/$/, "")
  );
}
