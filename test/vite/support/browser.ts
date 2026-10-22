/**
 * A browser for tests: a happy-dom window installed as the globals the DOM runtime reads, while
 * Node's own `fetch`, timers and URL stay. `uninstall` removes exactly what was added.
 */

/** The window of the test browser, typed as the DOM lib types a window. */
export type TestWindow = Window & typeof globalThis;

export interface TestBrowser {
  readonly window: TestWindow;
  readonly document: Document;
  uninstall(): void;
}

/**
 * happy-dom is loaded by name at run time: a static import would put its typings, which expect a
 * newer `@types/node`, into every type check of this package.
 */
const HAPPY_DOM = "happy-dom";

interface HappyWindow {
  happyDOM: { close(): Promise<void> };
}

/** Globals Node already has: the browser must not replace them. */
const KEEP = new Set([
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "Blob",
  "File",
  "Event",
  "EventTarget",
  "console",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "queueMicrotask",
  "structuredClone",
  "performance",
  "crypto",
  "navigator",
  "globalThis",
  "global",
  "process",
]);

export async function installBrowser(html: string, url: string): Promise<TestBrowser> {
  const happy: { Window: new (options: object) => HappyWindow } = await import(HAPPY_DOM);
  const window = new happy.Window({
    url,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  const dom = window as unknown as TestWindow;
  dom.document.write(html);
  // A real browser fetches stylesheets and reports `load`; the preload helper of a built app waits
  // for it before it runs a lazily loaded chunk. Here the file system is not a web server, so the
  // browser is told that every stylesheet link added to the page loaded.
  const observer = new dom.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof dom.HTMLLinkElement && node.rel === "stylesheet") {
          queueMicrotask(() => node.dispatchEvent(new dom.Event("load")));
        }
      }
    }
  });
  observer.observe(dom.document.head, { childList: true });
  const added: string[] = [];
  const target = globalThis as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(window)) {
    if (KEEP.has(key) || key in target) continue;
    // Copy the descriptor, so accessors stay accessors and nothing is read from the window here.
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(target, key, { ...descriptor, configurable: true });
    added.push(key);
  }
  target["window"] = dom;
  target["document"] = dom.document;
  target["self"] = dom;
  added.push("window", "document", "self");
  return {
    window: dom,
    document: dom.document,
    uninstall() {
      observer.disconnect();
      for (const key of added) Reflect.deleteProperty(target, key);
      void window.happyDOM.close();
    },
  };
}
