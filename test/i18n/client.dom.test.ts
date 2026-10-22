import { flushSync, useSignal } from "@shadow-js/core";
import { createI18n } from "@shadow-js/i18n";
import { localeRouting } from "@shadow-js/i18n/routing";
import { afterEach, describe, expect, it } from "vitest";
import { startLocaleSync } from "../../src/i18n/client";

/**
 * The client half of locale routing: the generated client entry calls `startLocaleSync` with the app's instance and the
 * Dusk router after hydration. A client navigation to another locale's URL sets the locale and `<html lang dir>`.
 */

const messages = {
  en: { title: "Welcome" },
  fr: { title: "Bienvenue" },
  ar: { title: "أهلا" },
} as const;
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
});

/** A Dusk router stand-in: its live location, and a navigation that changes it. */
function fakeRouter(initial: string) {
  const [pathname, setPathname] = useSignal<string>(initial);
  return {
    router: { state: { location: () => ({ pathname: pathname() }) } },
    navigate(next: string): void {
      setPathname(() => next);
      flushSync();
    },
  };
}

function setup(prefix: "as-needed" | "always" | "never", path: string, base = "") {
  const i18n = createI18n({
    defaultLocale: "en",
    locales: ["en", "fr", "ar"],
    messages,
    prefix,
    features: [localeRouting],
  });
  const router = fakeRouter(path);
  stops.push(startLocaleSync(i18n, router.router, { base }));
  return { i18n, router };
}

describe("startLocaleSync", () => {
  it("[I18N-545] a client navigation to another locale's URL sets the locale, <html lang> and dir", () => {
    const { i18n, router } = setup("as-needed", "/about");
    expect(i18n.locale()).toBe("en");
    router.navigate("/ar/about");
    expect(i18n.locale()).toBe("ar");
    expect(document.documentElement.getAttribute("lang")).toBe("ar");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    expect(i18n.t("title")).toBe("أهلا");
    // An unprefixed path is the default locale's page under as-needed.
    router.navigate("/contact");
    expect(i18n.locale()).toBe("en");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
  });

  it("[I18N-546] the URL on screen when the sync starts wins over the instance's locale; the mount point is skipped", () => {
    const { i18n, router } = setup("always", "/app/fr/about", "/app/");
    expect(i18n.locale()).toBe("fr");
    expect(document.documentElement.getAttribute("lang")).toBe("fr");
    router.navigate("/app/ar");
    expect(i18n.locale()).toBe("ar");
    // A path outside the mount point names no locale.
    router.navigate("/elsewhere/en");
    expect(i18n.locale()).toBe("ar");
  });

  it("[I18N-547] prefix never: the URL names no locale, so a navigation changes nothing", () => {
    const { i18n, router } = setup("never", "/fr/about");
    expect(i18n.locale()).toBe("en");
    router.navigate("/ar/about");
    expect(i18n.locale()).toBe("en");
  });

  it("[I18N-548] a value that is not an i18n instance is refused with the export to check", () => {
    const { router } = fakeRouter("/");
    expect(() => startLocaleSync({} as never, router)).toThrow(
      /i18n\.routing\.instance does not export an i18n instance/,
    );
    expect(() => startLocaleSync(null as never, router)).toThrow(
      /does not export an i18n instance/,
    );
  });
});
