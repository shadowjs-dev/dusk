import { hasControl } from "../internal/text";

/**
 * Third-party and app scripts: where a script goes, when it runs, and the CSP nonce every script carries.
 * `scriptTag` returns the markup for the document head or body; `scriptsHtml` orders a list of them;
 * `loadScript` loads a `lazyOnload` script in the browser. The head registry refuses `<script>` (a script
 * there would bypass the nonce), so the markup goes through `document.head` of the handler options, where
 * the request's nonce is available: `document: { head: (event) => scriptsHtml(scripts, event.nonce) }`.
 */

/**
 * When a script runs: `beforeInteractive` blocks parsing (for code the page needs first), `afterInteractive`
 * loads asynchronously as soon as possible, `lazyOnload` loads after the window's load event, from the browser.
 * @since 1.0.0
 */
export type ScriptStrategy = "beforeInteractive" | "afterInteractive" | "lazyOnload";

/** Options of {@link scriptTag}. @since 1.0.0 */
export interface ScriptOptions {
  /** A path on this origin, or an http(s) URL. */
  readonly src: string;
  /** Default `afterInteractive`. */
  readonly strategy?: ScriptStrategy;
  /** The request's CSP nonce (`event.nonce`), when the policy uses one. */
  readonly nonce?: string;
}

/**
 * A short key for inline code, written on the server's `<script data-dusk-script>` so the browser can tell the script the
 * server wrote from one it has yet to run. It is a 32-bit FNV-1a hash and the length; a match is confirmed by comparing the
 * text, so a collision costs nothing.
 * @internal
 */
export function inlineScriptKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

const NONCE = /^[A-Za-z0-9+/=_-]{1,256}$/;
const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes a value for a double-quoted HTML attribute. */
function attribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function checkSource(src: string): void {
  // A browser drops tabs and line breaks from a URL before it reads it, so `/<TAB>/host` is `//host`.
  if (hasControl(src)) {
    throw new TypeError(
      `scriptTag: the src ${JSON.stringify(src)} must not contain control characters.`,
    );
  }
  if (src.startsWith("/") && !src.startsWith("//") && !src.startsWith("/\\")) return;
  if (URL.canParse(src)) {
    const { protocol } = new URL(src);
    if (protocol === "http:" || protocol === "https:") return;
  }
  throw new TypeError(
    `scriptTag: the src ${JSON.stringify(src)} must be a path on this origin or an http(s) URL.`,
  );
}

/**
 * The markup of one script: `<script src nonce>` (with `async` for `afterInteractive`), or nothing for
 * `lazyOnload`, which the browser loads itself. Attribute values are escaped.
 *
 * @param options The source, strategy and nonce.
 * @returns The markup (empty for `lazyOnload`).
 * @throws TypeError for a source that is not a path or an http(s) URL, or a nonce that is not a token.
 * @example
 * scriptTag({ src: "/polyfill.js", strategy: "beforeInteractive", nonce: event.nonce });
 * @since 1.0.0
 */
export function scriptTag(options: ScriptOptions): string {
  checkSource(options.src);
  if (options.nonce !== undefined && !NONCE.test(options.nonce)) {
    throw new TypeError("scriptTag: the nonce must be a token of letters, digits and + / = _ -.");
  }
  const strategy = options.strategy ?? "afterInteractive";
  if (strategy === "lazyOnload") return "";
  const nonce = options.nonce === undefined ? "" : ` nonce="${options.nonce}"`;
  const async = strategy === "afterInteractive" ? " async" : "";
  return `<script src="${attribute(options.src)}"${async}${nonce}></script>`;
}

/**
 * The markup of a list of scripts for the document head: the `beforeInteractive` ones first, then the
 * `afterInteractive` ones, each source once, in the order given. `lazyOnload` scripts are left out.
 *
 * @param scripts The scripts.
 * @param nonce The request's nonce, given to each.
 * @returns The markup.
 * @example
 * import { scriptsHtml } from "@shadow-js/dusk";
 * scriptsHtml([{ src: "/late.js" }, { src: "/early.js", strategy: "beforeInteractive" }]);
 * // '<script src="/early.js"></script><script src="/late.js" async></script>'
 * @since 1.0.0
 */
export function scriptsHtml(scripts: readonly ScriptOptions[], nonce?: string): string {
  const seen = new Set<string>();
  const ordered: ScriptOptions[] = [];
  for (const strategy of ["beforeInteractive", "afterInteractive"] as const) {
    for (const script of scripts) {
      if ((script.strategy ?? "afterInteractive") !== strategy || seen.has(script.src)) continue;
      seen.add(script.src);
      ordered.push(script);
    }
  }
  return ordered
    .map((script) => {
      const value = script.nonce ?? nonce;
      return scriptTag(value === undefined ? script : { ...script, nonce: value });
    })
    .join("");
}

/** Options of {@link loadScript}. @since 1.0.0 */
export interface LoadScriptOptions {
  /** The script's source (a path or an http(s) URL). */
  readonly src: string;
  /** The nonce of the page's policy, when it uses one. */
  readonly nonce?: string;
  /** The document to add the script to. Default: the global one. */
  readonly document?: Document;
}

/**
 * Loads a script in the browser (the `lazyOnload` strategy: call it after the window's load event). Resolves
 * when the script has run and rejects when it fails to load. A source already loaded resolves at once.
 *
 * @param options The source, nonce and document.
 * @returns A promise for the load.
 * @throws TypeError for a source that is not a path or an http(s) URL.
 * @example
 * window.addEventListener("load", () => void loadScript({ src: "/chat-widget.js" }));
 * @since 1.0.0
 */
export function loadScript(options: LoadScriptOptions): Promise<void> {
  checkSource(options.src);
  const doc = options.document ?? document;
  const existing = doc.querySelector(`script[src="${CSS.escape(options.src)}"]`);
  if (existing !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const element = doc.createElement("script");
    element.src = options.src;
    element.async = true;
    if (options.nonce !== undefined) element.nonce = options.nonce;
    element.addEventListener("load", () => resolve(), { once: true });
    element.addEventListener(
      "error",
      () => reject(new Error(`the script ${options.src} failed to load.`)),
      { once: true },
    );
    doc.head.append(element);
  });
}
