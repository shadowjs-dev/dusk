import { createI18n } from "@shadow-js/i18n";
import { localeRouting } from "@shadow-js/i18n/routing";
import { type LocaleRoutingInstance, withLocaleRouting } from "../../src/i18n/server";
import type { LocaleRoutingConfig, LocaleRoutingSettings } from "../../src/i18n/settings";
import {
  createHandler,
  type DuskRuntimeManifest,
  type HandlerOptions,
} from "../../src/server/index";
import { load } from "../support/compile";
import { allFeatures } from "../support/features";

/**
 * The locale routing fixture: a `/:locale?` layout with a home page, an about page, a cached page (`revalidate`) and a
 * page that reads the request's instance through the event, plus an API route outside `/api`. Every text comes from
 * the request's i18n instance, so a page shows the locale it was rendered in. Compiled with the real compiler.
 */
const SOURCE = `
import { defineRoute, Outlet } from "@shadow-js/router";
import { apiRoute, getRequestEvent, json } from "@start/server";
import { getEventI18n, tryGetRequestI18n } from "@shadow-js/i18n";

export const counts = { cached: 0 };

function say(key) { return tryGetRequestI18n()?.t(key) ?? "no instance"; }
function Text(props) { return <p class={props.cls}>{props.text}</p>; }

const home = defineRoute("/", { id: "home", component: () => <Text cls="home" text={say("hello")} /> });
const about = defineRoute("/about", { id: "about", component: () => <Text cls="about" text={say("about")} /> });
const cached = defineRoute("/cached", {
  id: "cached",
  revalidate: 60,
  loader: () => { counts.cached += 1; return counts.cached; },
  component: () => <Text cls="cached" text={say("hello")} />,
});
const fromEvent = defineRoute("/event", {
  id: "event",
  component: () => <Text cls="event" text={getEventI18n(getRequestEvent()).t("about")} />,
});
const layout = defineRoute("/:locale?", {
  id: "locale",
  component: () => <div class="layout"><Outlet /></div>,
  children: [home, about, cached, fromEvent],
});

export const routes = [layout];
export function App(props) { return <main class="app">{props.children}</main>; }

export const feed = apiRoute({ GET: () => json({ feed: true }) });
export const items = apiRoute({ GET: () => json({ items: true }), POST: () => json({ posted: true }) });
`;

/** The compiled fixture. */
export interface LocaleFixture {
  readonly routes: DuskRuntimeManifest["routes"];
  readonly App: DuskRuntimeManifest["App"];
  readonly counts: { cached: number };
  readonly feed: unknown;
  readonly items: unknown;
}

/** The catalogs: every page text names its locale. */
export const MESSAGES = {
  en: { hello: "Hello", about: "About us" },
  fr: { hello: "Bonjour", about: "À propos" },
  ar: { hello: "مرحبا", about: "من نحن" },
} as const;

/** An instance of the fixture's locales with the given prefix. */
export function instanceFor(prefix: LocaleRoutingSettings["prefix"]): LocaleRoutingInstance {
  return createI18n({
    defaultLocale: "en",
    locales: ["en", "fr", "ar"],
    messages: MESSAGES,
    prefix,
    features: [localeRouting],
  });
}

/** The `i18n` object of the server bundle, with the defaults of `dusk.config.ts` and the given overrides. */
export function configFor(routing: Partial<LocaleRoutingSettings> = {}): LocaleRoutingConfig {
  return {
    locales: ["en", "fr", "ar"],
    defaultLocale: "en",
    routing: {
      prefix: "as-needed",
      detection: ["cookie", "accept-language"],
      cookie: { name: "locale", maxAge: 31_536_000 },
      alternates: true,
      ...routing,
    },
  };
}

/** A booted handler and its helpers. */
export interface LocaleApp {
  readonly app: LocaleFixture;
  readonly handler: ReturnType<typeof createHandler>;
  /** Sends a request to `https://example.com<path>` (or the given origin). */
  readonly fetch: (path: string, init?: RequestInit, origin?: string) => Promise<Response>;
  readonly errors: unknown[];
  readonly warnings: string[];
}

/**
 * Boots the fixture behind `withLocaleRouting`, as the generated server entry does.
 *
 * @param routing Overrides of the routing settings.
 * @param options Extra handler options (they go through `withLocaleRouting` too).
 */
export async function bootLocaleApp(
  routing: Partial<LocaleRoutingSettings> = {},
  options: Partial<HandlerOptions> = {},
): Promise<LocaleApp> {
  const app = await load<LocaleFixture>(SOURCE);
  const config = configFor(routing);
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const manifest: DuskRuntimeManifest = {
    routes: app.routes,
    apiRoutes: [
      { id: "feed", path: "/feed", load: async () => app.feed as never },
      { id: "items", path: "/api/items", load: async () => app.items as never },
    ],
    serverFns: {},
    assets: { entry: "/assets/entry.js", css: [], preloads: {}, base: "" },
    App: app.App,
  };
  const handler = createHandler(
    withLocaleRouting(
      {
        features: allFeatures(),
        manifest,
        dev: false,
        security: { allowedHosts: ["example.com", "localhost"] },
        onError: (error) => void errors.push(error),
        onWarning: (message) => void warnings.push(message),
        ...options,
      },
      instanceFor(config.routing.prefix),
      config,
    ),
  );
  return {
    app,
    handler,
    errors,
    warnings,
    fetch: (path, init, origin = "https://example.com") =>
      handler.fetch(new Request(`${origin}${path}`, init)),
  };
}

/** The `<html ...>` start tag of a document. */
export function htmlTag(body: string): string {
  return /<html[^>]*>/.exec(body)?.[0] ?? "";
}
