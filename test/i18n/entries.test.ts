import { describe, expect, it } from "vitest";
import type { BakedServerConfig } from "../../src/server/baked-config";
import {
  clientEntrySource,
  type ServerEntryInput,
  serverEntrySource,
} from "../../src/vite/virtual";

const server: ServerEntryInput = {
  dev: false,
  base: "",
  generatedTree: "/app/src/routeTree.gen.ts",
  appFile: "/app/src/app.tsx",
  entryServerFile: undefined,
  apiRoutes: [],
  serverFns: [],
  assets: { entry: "/app.js", css: [], preloads: {}, base: "" },
};
const client = {
  base: "",
  generatedTree: "/app/src/routeTree.gen.ts",
  appFile: "/app/src/app.tsx",
};

const routing = {
  prefix: "as-needed",
  detection: ["cookie", "accept-language"],
  cookie: { name: "locale", maxAge: 31_536_000 },
  alternates: true,
} as const;
const baked: BakedServerConfig = {
  skew: { reload: true },
  instrumentation: true,
  i18n: { locales: ["en", "fr"], defaultLocale: "en", routing },
};
const localeInstance = { file: "/app/src/i18n.ts", exportName: "i18n" };

describe("the generated entries and locale routing", () => {
  it("[I18N-509] an app without i18n gets entries with no i18n text at all", () => {
    expect(serverEntrySource(server)).not.toMatch(/i18n|locale/i);
    expect(clientEntrySource(client)).not.toMatch(/i18n|locale/i);
    // Locales without routing: the default <html lang> only, nothing wired.
    const localesOnly = serverEntrySource({
      ...server,
      baked: {
        skew: { reload: true },
        instrumentation: true,
        i18n: { locales: ["en", "fr"], defaultLocale: "en" },
      },
    });
    expect(localesOnly).not.toContain("@shadow-js/dusk/i18n");
    expect(localesOnly).not.toContain("duskWithLocaleRouting");
    expect(localesOnly).not.toContain("duskI18nInstance");
  });

  it("[I18N-510] the server entry imports the instance and wraps the final handler options with withLocaleRouting", () => {
    const source = serverEntrySource({ ...server, baked, localeInstance });
    expect(source).toContain(
      'import { withLocaleRouting as duskWithLocaleRouting } from "@shadow-js/dusk/i18n";',
    );
    expect(source).toContain('import { i18n as duskI18nInstance } from "/app/src/i18n.ts";');
    expect(source).toContain(
      `export const handler = createHandler(duskWithLocaleRouting({ ...{ ...{ dev: false, features: duskFeatures }, ...bakedOptions }, manifest, base: "" }, duskI18nInstance, ${JSON.stringify(baked.i18n)}));`,
    );
    // With an entry file, the entry's options are merged first, so its middleware and head are kept.
    const withEntry = serverEntrySource({
      ...server,
      entryServerFile: "/app/src/entry-server.ts",
      baked,
      localeInstance,
    });
    expect(withEntry).toContain(
      "createHandler(duskWithLocaleRouting({ ...mergeHandlerOptions(mergeHandlerOptions({ dev: false, features: duskFeatures }, bakedOptions), userOptions), manifest",
    );
    // A default export is imported by name.
    expect(
      serverEntrySource({
        ...server,
        baked,
        localeInstance: { file: "C:\\app\\src\\i18n.ts", exportName: "default" },
      }),
    ).toContain('import { default as duskI18nInstance } from "C:/app/src/i18n.ts";');
  });

  it("[I18N-511] the instance and the declaration go together, and an export name is never written as code", () => {
    expect(() => serverEntrySource({ ...server, baked })).toThrow(
      /localeInstance is given exactly when the baked configuration declares i18n\.routing/,
    );
    expect(() => serverEntrySource({ ...server, localeInstance })).toThrow(
      /localeInstance is given exactly/,
    );
    expect(() =>
      serverEntrySource({
        ...server,
        baked,
        localeInstance: { file: "/a.ts", exportName: "x } from 'evil'; //" },
      }),
    ).toThrow(/is not an export name/);
  });

  it("[I18N-512] the client entry starts the locale sync after hydration, from a chunk it loads on demand", () => {
    const source = clientEntrySource({
      ...client,
      base: "/app",
      localeRouting: { ...localeInstance, prefix: "as-needed" },
    });
    expect(source).toContain('import { i18n as duskI18nInstance } from "/app/src/i18n.ts";');
    expect(source).not.toMatch(/^import .*@shadow-js\/dusk\/i18n\/client/m);
    const hydrate = source.indexOf("const duskClient = await hydrateDusk(");
    const sync = source.indexOf('import("@shadow-js/dusk/i18n/client")');
    expect(hydrate).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(hydrate);
    expect(source).toContain(
      'duskLocaleSync.startLocaleSync(duskI18nInstance, duskClient.router, { base: "/app" });',
    );
    expect(source).toContain(".catch((error) => { console.error(error); });");
  });

  it("[I18N-513] prefix never: the URL names no locale, so the client entry has nothing of i18n", () => {
    const source = clientEntrySource({
      ...client,
      localeRouting: { ...localeInstance, prefix: "never" },
    });
    expect(source).toBe(clientEntrySource(client));
  });
});
