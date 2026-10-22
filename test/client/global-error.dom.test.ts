import { afterEach, describe, expect, it, vi } from "vitest";
import { type DuskClient, hydrateDusk } from "../../src/client/hydrate";
import { load } from "./support/compile";

/*
 * The browser side of the global error: when the app itself fails to mount, `hydrateDusk` replaces the document with the
 * `_global-error` module's page (its `<html>` attributes, its `<body>`, its title). The error goes to `onError`; the
 * component receives the reason phrase, never the original message.
 */

const APP_SOURCE = `
export const routes = [];
export const App = () => { throw new Error("database password is hunter2"); };
`;

const GLOBAL_SOURCE = `
export const metadata = { title: "Malaf could not load" };
export default function GlobalError(props) {
  return (
    <html lang="en" class="global-html">
      <body class="global">
        <p class="message">{props.error.message}</p>
        <button class="retry" onClick={props.reset}>retry</button>
      </body>
    </html>
  );
}
`;

interface GlobalModule {
  default: (props: { error: Error; reset: () => void }) => unknown;
  metadata?: { title?: string };
}
const GLOBAL_ERROR_MARK = "dusk:global-error-reload";

const started: DuskClient[] = [];
afterEach(() => {
  for (const client of started.splice(0)) client.dispose();
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("lang");
  document.body.innerHTML = "";
  document.title = "";
  window.sessionStorage.clear();
});

describe("hydrateDusk and the global error", () => {
  it("[GERR-7] an app that fails to mount asks the server for the page again; the error is reported, not shown", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    const app = await load<{ routes: never[]; App: () => unknown }>(APP_SOURCE, "dom");
    const globalError = await load<GlobalModule>(GLOBAL_SOURCE, "dom");
    const reloads = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    const reported: unknown[] = [];
    const client = await hydrateDusk({
      routes: app.routes,
      App: app.App as never,
      globalError: globalError as never,
      onError: (error) => reported.push(error),
    });
    started.push(client);
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(GLOBAL_ERROR_MARK)).toBe("1");
    // The original error is reported once, as it was thrown; the document is left as it was.
    expect(reported.length).toBe(1);
    expect(String((reported[0] as Error).message)).toContain("hunter2");
    expect(document.body.textContent).not.toContain("hunter2");
  });

  it("[GERR-7b] a second failure in the same session is not retried: the loop guard stops the reload", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    window.sessionStorage.setItem(GLOBAL_ERROR_MARK, "1");
    const app = await load<{ routes: never[]; App: () => unknown }>(APP_SOURCE, "dom");
    const globalError = await load<GlobalModule>(GLOBAL_SOURCE, "dom");
    const reloads = vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    const reported: unknown[] = [];
    const client = await hydrateDusk({
      routes: app.routes,
      App: app.App as never,
      globalError: globalError as never,
      onError: (error) => reported.push(error),
    });
    started.push(client);
    expect(reloads).not.toHaveBeenCalled();
    expect(reported.length).toBe(1);
  });

  it("[GERR-7c] without a global error module the failure is thrown, as before", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    const app = await load<{ routes: never[]; App: () => unknown }>(APP_SOURCE, "dom");
    await expect(
      hydrateDusk({ routes: app.routes, App: app.App as never, onError: () => undefined }),
    ).rejects.toThrow("hunter2");
  });
});
