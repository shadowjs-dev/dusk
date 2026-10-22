import { onMount } from "@shadow-js/core";
import { isServer } from "@shadow-js/web";
import { tryGetRequestEvent } from "../internal/request-context";
import type { RequestEvent } from "../server/types";
import { loadScript, type ScriptStrategy } from "../shared/script";

/**
 * `<Script>`: a script in the page with a load strategy, a CSP nonce, de-duplication, and callbacks.
 * On the server it writes the `<script>` element (a source script with its nonce, or an inline one); the browser
 * loads it per strategy. A script is written once per response, however many components name it.
 */

/**
 * The props of {@link Script}. Give `src` (a file) or children (inline code), not both.
 * @since 1.0.0
 */
export interface ScriptProps {
  /** A path on this origin or an http(s) URL. */
  readonly src?: string;
  /** Inline code. It must not contain `</script` or `<!--`. */
  readonly children?: string;
  /**
   * When it runs. `beforeInteractive`: blocks parsing (the first code the page needs). `afterInteractive`: async,
   * as soon as possible (default). `lazyOnload`: after the window's load event, from the browser (not in the HTML).
   */
  readonly strategy?: ScriptStrategy;
  /** A key for de-duplication. Default: the `src`. Two scripts with one key are written once. */
  readonly id?: string;
  /** The CSP nonce. Default: the request's nonce, on the server. */
  readonly nonce?: string;
  /** Called in the browser once the script has loaded (or, for a script the server wrote, once the browser has it). */
  readonly onLoad?: () => void;
  /** Called in the browser when the script fails to load. */
  readonly onError?: (error: unknown) => void;
  /** Called in the browser after the script is available: after `onLoad`, or at once if it already was. */
  readonly onReady?: () => void;
}

const NONCE = /^[A-Za-z0-9+/=_-]{1,256}$/;
/** A path on this origin (not protocol-relative, not a backslash form) or an http(s) URL; no spaces, quotes or angle brackets. */
const SOURCE = /^(?:\/(?![/\\])[^\s"<>]*|https?:\/\/[^\s"<>]+)$/;
/** True for a C0 control character, which a source must not carry. */
const hasControlCharacter = (text: string): boolean =>
  [...text].some((character) => character.charCodeAt(0) < 0x20);

/** The keys each request has written, so a second `<Script>` for the same key writes nothing. Bounded by the requests. */
const written = new WeakMap<RequestEvent, Set<string>>();

/** True when this request has not written `key` yet; marks it as written. Server only. */
function firstWrite(key: string): boolean {
  const event = tryGetRequestEvent();
  if (event === undefined) return true;
  let keys = written.get(event);
  if (keys === undefined) {
    keys = new Set<string>();
    written.set(event, keys);
  }
  if (keys.has(key)) return false;
  if (keys.size >= 256) throw new RangeError("Script: more than 256 scripts on one page.");
  keys.add(key);
  return true;
}

function checkProps(props: ScriptProps): void {
  if ((props.src === undefined) === (props.children === undefined)) {
    throw new TypeError("Script: give exactly one of src (a file) or children (inline code).");
  }
  if (props.src !== undefined && (!SOURCE.test(props.src) || hasControlCharacter(props.src))) {
    throw new TypeError(
      `Script: the src ${JSON.stringify(props.src)} must be a path on this origin or an http(s) URL.`,
    );
  }
  if (props.children !== undefined && /<\/script|<!--/i.test(props.children)) {
    throw new TypeError('Script: inline code must not contain "</script" or "<!--".');
  }
  if (props.nonce !== undefined && !NONCE.test(props.nonce)) {
    throw new TypeError("Script: the nonce must be a token of letters, digits and + / = _ -.");
  }
}

/** Runs the callbacks for a source script once it is loaded (browser only). */
function loadSource(props: ScriptProps, src: string): void {
  loadScript(props.nonce === undefined ? { src } : { src, nonce: props.nonce }).then(
    () => {
      props.onLoad?.();
      props.onReady?.();
    },
    (error: unknown) => props.onError?.(error),
  );
}

/** Runs inline code once in the browser, unless the page already has it (the server wrote it). */
function runInline(props: ScriptProps): void {
  const id = props.id;
  if (id !== undefined && document.getElementById(id) !== null) {
    props.onReady?.();
    return;
  }
  try {
    const element = document.createElement("script");
    if (id !== undefined) element.id = id;
    if (props.nonce !== undefined) element.nonce = props.nonce;
    element.textContent = props.children ?? "";
    document.head.append(element);
    props.onLoad?.();
    props.onReady?.();
  } catch (error) {
    props.onError?.(error);
  }
}

/**
 * A script. The server writes its markup (with the nonce); in the browser the callbacks run as the script loads.
 *
 * @param props The source or inline code, the strategy, the key and the callbacks.
 * @returns The `<script>` element, or nothing when the script is written already or loads from the browser.
 * @throws TypeError for props that cannot produce a script (see {@link ScriptProps}).
 * @example
 * <Script src="/analytics.js" strategy="afterInteractive" onReady={() => track()} />
 * @since 1.0.0
 */
export function Script(props: ScriptProps): unknown {
  checkProps(props);
  const strategy = props.strategy ?? "afterInteractive";
  const key = props.id ?? props.src ?? `inline:${props.children ?? ""}`;
  if (isServer) {
    if (strategy === "lazyOnload" || !firstWrite(key)) return null;
    const nonce = props.nonce ?? tryGetRequestEvent()?.nonce;
    const attributes = {
      ...(props.id === undefined ? {} : { id: props.id }),
      ...(nonce === undefined ? {} : { nonce }),
    };
    if (props.src !== undefined) {
      return (
        <script
          {...attributes}
          src={props.src}
          async={strategy === "afterInteractive" ? true : undefined}
        />
      );
    }
    // The inline code is raw text: set as the element's HTML (the checks above keep it from ending the element).
    const inline = { ...attributes, dangerouslySetInnerHTML: { __html: props.children ?? "" } };
    return <script {...inline} />;
  }
  onMount(() => {
    const start = (): void => {
      if (props.src !== undefined) loadSource(props, props.src);
      else runInline(props);
    };
    if (strategy === "lazyOnload" && document.readyState !== "complete") {
      window.addEventListener("load", start, { once: true });
    } else {
      start();
    }
  });
  return null;
}
