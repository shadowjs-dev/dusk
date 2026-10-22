/**
 * The browser side of automatic locale routing (`@shadow-js/dusk/i18n/client`). The generated client entry of an app
 * that declares `i18n.routing` loads this module with a dynamic import after hydration, so its code is in a chunk of its
 * own and an app without locale routing never names it.
 *
 * @packageDocumentation
 */

import { type I18n, type RouteLocationSource, syncLocaleWithRoute } from "@shadow-js/i18n";

/**
 * Keeps the app's i18n instance in step with the locale segment of the URL: a client navigation (or a back or forward
 * traversal) to another locale's URL calls `setLocale`, which updates the translations and `<html lang dir>`. It wraps
 * `syncLocaleWithRoute`, and first aligns the instance with the URL already on screen: a navigation made between
 * hydration and the load of this module is not missed.
 *
 * Under `prefix: "never"` the URL names no locale, so nothing happens.
 *
 * @param i18n The app's instance (the export `i18n.routing.instance` names).
 * @param router The Dusk client's router (`(await hydrateDusk(...)).router`).
 * @param options `base`: the app's mount point, the same `base` the router has. Default `""`.
 * @returns A function that stops the sync.
 * @throws TypeError when `i18n` is not an i18n instance.
 * @example
 * import { startLocaleSync } from the "@shadow-js/dusk/i18n/client" subpath;
 * const client = await hydrateDusk({ routes: routeTree, base: "" });
 * const stop = startLocaleSync(i18n, client.router, { base: "" });
 * @since 1.0.0
 */
export function startLocaleSync<L extends string, M>(
  i18n: I18n<L, M>,
  router: RouteLocationSource,
  options: { readonly base?: string } = {},
): () => void {
  if (
    typeof i18n !== "object" ||
    i18n === null ||
    typeof i18n.setLocale !== "function" ||
    typeof i18n.routing?.parse !== "function"
  ) {
    throw new TypeError(
      "startLocaleSync: i18n.routing.instance does not export an i18n instance (the value createI18n returns).",
    );
  }
  const base = (options.base ?? "").replace(/\/+$/, "");
  const stop = syncLocaleWithRoute(i18n, router, { base });
  const pathname = router.state.location()?.pathname;
  if (pathname !== undefined) {
    const below =
      base === ""
        ? pathname
        : pathname === base
          ? "/"
          : pathname.startsWith(`${base}/`)
            ? pathname.slice(base.length)
            : undefined;
    if (below !== undefined) {
      const named =
        i18n.routing.parse(below).locale ??
        (i18n.routing.prefix === "as-needed" ? i18n.defaultLocale : undefined);
      // `setLocale` does not reject: a catalog that fails to load keeps the current locale and is reported by the instance.
      if (named !== undefined && named !== i18n.locale()) void i18n.setLocale(named);
    }
  }
  return stop;
}
