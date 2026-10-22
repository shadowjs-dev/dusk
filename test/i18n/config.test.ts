import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createI18n } from "@shadow-js/i18n";
import { localeRouting } from "@shadow-js/i18n/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localeRoutingMiddleware, withLocaleRouting } from "../../src/i18n/server";
import { type LocaleRoutingConfig, resolveLocaleRouting } from "../../src/i18n/settings";
import { serverOptionsFromConfig } from "../../src/server/baked-config";
import type { DuskRuntimeManifest } from "../../src/server/index";
import {
  bakeServerConfig,
  localeInstanceOf,
  localeRoutingStaticReason,
  validateDuskConfig,
} from "../../src/vite/config-file";

/** The baked `i18n` of an app with the locales en, fr and ar and every routing default. */
function configFor(): LocaleRoutingConfig {
  return {
    locales: ["en", "fr", "ar"],
    defaultLocale: "en",
    routing: {
      prefix: "as-needed",
      detection: ["cookie", "accept-language"],
      cookie: { name: "locale", maxAge: 31_536_000 },
      alternates: true,
    },
  };
}

const locales = { locales: ["en", "fr"], defaultLocale: "en" } as const;
const instance = { module: "./src/i18n" } as const;

/** Validates a file whose `i18n.routing` is `routing`. */
function withRouting(routing: unknown): () => unknown {
  return () => validateDuskConfig({ i18n: { ...locales, routing } });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dusk-i18n-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("i18n.routing in dusk.config.ts", () => {
  it("[I18N-500] declared with only the instance, every default applies, and the bundle gets the settings without the instance", () => {
    const config = validateDuskConfig({ i18n: { ...locales, routing: { instance } } });
    const baked = bakeServerConfig(config);
    expect(baked.i18n).toEqual({
      locales: ["en", "fr"],
      defaultLocale: "en",
      routing: {
        prefix: "as-needed",
        detection: ["cookie", "accept-language"],
        cookie: { name: "locale", maxAge: 31_536_000 },
        alternates: true,
      },
    });
    expect(JSON.stringify(baked)).not.toContain("src/i18n");
    // A file without routing bakes the locales as before.
    expect(bakeServerConfig(validateDuskConfig({ i18n: locales })).i18n).toEqual({
      locales: ["en", "fr"],
      defaultLocale: "en",
    });
  });

  it("[I18N-501] every key is baked as written: prefix, detection, cookie, alternates and origin", () => {
    const config = validateDuskConfig({
      i18n: {
        ...locales,
        routing: {
          instance: { module: "./src/i18n.ts", export: "default" },
          prefix: "always",
          detection: ["accept-language"],
          cookie: { name: "lang", maxAge: 600 },
          alternates: false,
          origin: "https://example.com/",
        },
      },
    });
    expect(bakeServerConfig(config).i18n?.routing).toEqual({
      prefix: "always",
      detection: ["accept-language"],
      cookie: { name: "lang", maxAge: 600 },
      alternates: false,
      origin: "https://example.com",
    });
    expect(
      bakeServerConfig(
        validateDuskConfig({ i18n: { ...locales, routing: { instance, cookie: false } } }),
      ).i18n?.routing?.cookie,
    ).toBe(false);
  });

  it("[I18N-502] the instance is required, and its module and export are checked", () => {
    expect(withRouting({})).toThrow(/i18n\.routing\.instance is required/);
    expect(withRouting(true)).toThrow(/i18n\.routing must be an object/);
    expect(withRouting({ instance: "./src/i18n" })).toThrow(
      /i18n\.routing\.instance must be an object/,
    );
    for (const module of [
      "src/i18n",
      "../i18n",
      "./a/../../b",
      "./a\\b",
      "./a?x",
      "/abs/i18n",
      "./dir/",
      "",
    ]) {
      expect(withRouting({ instance: { module } }), module).toThrow(
        /i18n\.routing\.instance\.module must be a path inside the project/,
      );
    }
    expect(withRouting({ instance: { module: "./src/i18n", export: "not valid" } })).toThrow(
      /i18n\.routing\.instance\.export must be the name of an export/,
    );
    expect(withRouting({ instance: { module: "./src/i18n", exprt: "i18n" } })).toThrow(
      /unknown key "exprt"; did you mean "export"\?/,
    );
  });

  it("[I18N-503] prefix, detection, cookie, alternates and origin are refused with the key at fault", () => {
    expect(withRouting({ instance, prefix: "sometimes" })).toThrow(
      'i18n.routing.prefix must be "as-needed", "always" or "never".',
    );
    expect(withRouting({ instance, detection: "cookie" })).toThrow(
      /i18n\.routing\.detection must be an array/,
    );
    expect(withRouting({ instance, detection: ["url", "cookie"] })).toThrow(
      /i18n\.routing\.detection\[0\]: "url" is not listed: the URL prefix always decides first/,
    );
    expect(withRouting({ instance, detection: ["navigator"] })).toThrow(
      'i18n.routing.detection[0] must be "cookie" or "accept-language".',
    );
    expect(withRouting({ instance, detection: ["cookie", "cookie"] })).toThrow(
      /must not repeat "cookie"/,
    );
    expect(withRouting({ instance, cookie: true })).toThrow(
      /i18n\.routing\.cookie must be false or an object/,
    );
    expect(withRouting({ instance, cookie: { name: "bad name" } })).toThrow(
      /i18n\.routing\.cookie\.name must be a cookie name/,
    );
    expect(withRouting({ instance, cookie: { name: "__Host-locale" } })).toThrow(
      /must not start with __Host-/,
    );
    for (const maxAge of [0, -1, 1.5, 34_560_001, "1"]) {
      expect(withRouting({ instance, cookie: { maxAge } }), String(maxAge)).toThrow(
        /i18n\.routing\.cookie\.maxAge must be a whole number of seconds from 1 to 34560000/,
      );
    }
    expect(withRouting({ instance, alternates: "yes" })).toThrow(
      "i18n.routing.alternates must be true or false.",
    );
    for (const origin of [
      "example.com",
      "https://example.com/path",
      "ftp://example.com",
      "https://user@example.com",
    ]) {
      expect(withRouting({ instance, origin }), origin).toThrow(
        /i18n\.routing\.origin must be an http\(s\) origin/,
      );
    }
    expect(withRouting({ instance, prefx: "always" })).toThrow(
      /unknown key "prefx"; did you mean "prefix"\?/,
    );
  });

  it("[I18N-504] the locales may not repeat in any case, and the default locale must be one of them", () => {
    expect(() =>
      validateDuskConfig({ i18n: { locales: ["en", "EN"], defaultLocale: "en" } }),
    ).toThrow("i18n.locales must not repeat a locale.");
    expect(() =>
      validateDuskConfig({
        i18n: { locales: ["en", "fr"], defaultLocale: "de", routing: { instance } },
      }),
    ).toThrow("i18n.defaultLocale must be one of the locales (en, fr).");
    expect(() => validateDuskConfig({ i18n: { locales: ["e"], defaultLocale: "e" } })).toThrow(
      "i18n.locales[0] must be a language tag such as en or pt-BR.",
    );
  });

  it("[I18N-505] the server start validates the baked settings with the same rules; the instance is not part of them", () => {
    expect(() =>
      resolveLocaleRouting({ instance, prefix: "always" }, "i18n.routing", false),
    ).toThrow(/unknown key "instance"/);
    expect(() => resolveLocaleRouting({ prefix: "sometimes" }, "i18n.routing", false)).toThrow(
      'i18n.routing.prefix must be "as-needed", "always" or "never".',
    );
    // The handler gets only the locales; the routing settings go to withLocaleRouting.
    const options = serverOptionsFromConfig(
      bakeServerConfig(validateDuskConfig({ i18n: { ...locales, routing: { instance } } })),
    );
    expect(options.i18n).toEqual({ locales: ["en", "fr"], defaultLocale: "en" });
  });

  it("[I18N-506] the instance must match the declaration: locales, default locale and prefix", () => {
    const manifest: DuskRuntimeManifest = {
      routes: [],
      apiRoutes: [],
      serverFns: {},
      assets: { entry: "/e.js", css: [], preloads: {}, base: "" },
      App: () => null,
    };
    const config = configFor();
    const make = (options: {
      locales: string[];
      defaultLocale: string;
      prefix: "as-needed" | "always";
    }) => createI18n({ ...options, messages: {}, features: [localeRouting] });
    expect(() =>
      withLocaleRouting(
        { manifest },
        make({ locales: ["en", "fr"], defaultLocale: "en", prefix: "as-needed" }),
        config,
      ),
    ).toThrow(
      /the instance has the locales en, fr \(default en\), and dusk\.config\.ts declares en, fr, ar/,
    );
    expect(() =>
      withLocaleRouting(
        { manifest },
        make({ locales: ["en", "fr", "ar"], defaultLocale: "fr", prefix: "as-needed" }),
        config,
      ),
    ).toThrow(/Declare the same locales in both/);
    expect(() =>
      withLocaleRouting(
        { manifest },
        make({ locales: ["ar", "fr", "en"], defaultLocale: "en", prefix: "always" }),
        config,
      ),
    ).toThrow(/created with prefix "always", and dusk\.config\.ts declares prefix "as-needed"/);
    expect(() => localeRoutingMiddleware({} as never, config)).toThrow(/is not an i18n instance/);
    expect(() => localeRoutingMiddleware(undefined as never, config)).toThrow(
      /is not an i18n instance/,
    );
    // An instance created without the routing feature names the feature it needs.
    const bare = createI18n({ locales: ["en", "fr", "ar"], defaultLocale: "en", messages: {} });
    expect(() => localeRoutingMiddleware(bare as never, config)).toThrow(/localeRouting/);
    expect(() =>
      withLocaleRouting(
        { manifest },
        make({ locales: ["en", "fr", "ar"], defaultLocale: "en", prefix: "as-needed" }),
        {
          ...config,
          routing: { ...config.routing, prefix: "sometimes" as never },
        },
      ),
    ).toThrow('i18n.routing.prefix must be "as-needed", "always" or "never".');
  });

  it("[I18N-507] the instance module is found with or without its extension, or as a folder index; a missing one is named", () => {
    mkdirSync(join(dir, "src", "locale"), { recursive: true });
    writeFileSync(join(dir, "src", "i18n.ts"), "export const i18n = {};\n");
    writeFileSync(join(dir, "src", "locale", "index.tsx"), "export default {};\n");
    const configOf = (routing: Record<string, unknown>) =>
      validateDuskConfig({ i18n: { ...locales, routing } });
    expect(localeInstanceOf(configOf({ instance: { module: "./src/i18n" } }), dir)).toEqual({
      file: join(dir, "src", "i18n.ts"),
      exportName: "i18n",
    });
    expect(localeInstanceOf(configOf({ instance: { module: "./src/i18n.ts" } }), dir)?.file).toBe(
      join(dir, "src", "i18n.ts"),
    );
    expect(
      localeInstanceOf(configOf({ instance: { module: "./src/locale", export: "default" } }), dir),
    ).toEqual({ file: join(dir, "src", "locale", "index.tsx"), exportName: "default" });
    expect(() =>
      localeInstanceOf(configOf({ instance: { module: "./src/missing" } }), dir),
    ).toThrow(/i18n\.routing\.instance\.module: "\.\/src\/missing" was not found/);
    expect(localeInstanceOf(validateDuskConfig({ i18n: locales }), dir)).toBeUndefined();
    expect(localeInstanceOf(undefined, dir)).toBeUndefined();
  });

  it("[I18N-508] with locale routing every prerendered page is answered by the handler (the middleware must run)", () => {
    expect(
      localeRoutingStaticReason(
        validateDuskConfig({ i18n: { ...locales, routing: { instance } } }),
      ),
    ).toBe("i18n.routing in dusk.config.ts runs the locale middleware for every page");
    expect(localeRoutingStaticReason(validateDuskConfig({ i18n: locales }))).toBeUndefined();
    expect(localeRoutingStaticReason(undefined)).toBeUndefined();
  });
});
