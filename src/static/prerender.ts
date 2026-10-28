import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { safeSegments } from "../node/static-files";
import { allowedHostsOf, choosePrerenderOrigin, hostRejectionMessage } from "../server/hosts";
import type { DuskHandler, Handler } from "../server/types";
import {
  crawlPolicyOf,
  describeFailures,
  internalLinks,
  type PrerenderFailure,
  reasonOf,
  runCrawl,
} from "./crawl";

/** Options of {@link prerender}. @since 1.0.0 */
export interface PrerenderOptions {
  /** The handler that renders every page; the same one that serves production. */
  readonly handler: Handler;
  /** Directory the files are written to. */
  readonly outDir: string;
  /** Paths to render (`"/"`, `"/posts/1"`), or a function that lists them. */
  readonly paths: readonly string[] | (() => readonly string[] | Promise<readonly string[]>);
  /**
   * Origin the handler is told it is served from. Default `"http://localhost"`, or, when the
   * handler's `security.allowedHosts` does not list `localhost`, the first plain host it lists. A
   * request the handler refuses because of the host fails with a message naming `allowedHosts`.
   */
  readonly origin?: string;
  /** `"directory"` writes `/about` as `about/index.html` (default); `"file"` as `about.html`. */
  readonly format?: "directory" | "file";
  /** Pages rendered at once. Default 4. */
  readonly concurrency?: number;
  /** Most pages one run renders. Default 10 000; more is an error. */
  readonly maxPages?: number;
  /** Largest page in bytes. Default 16 MiB. */
  readonly maxPageBytes?: number;
  /** Time one page may take, in milliseconds. Default 30 000. */
  readonly pageTimeoutMs?: number;
  /** Statuses that are written. Default `[200]`. Others fail the run, naming the path. */
  readonly allowStatus?: readonly number[];
  /** What to do with a redirect: `"error"` (default) fails; `"html"` writes a meta-refresh page. */
  readonly onRedirect?: "error" | "html";
  /**
   * File name of the single-page-app shell (the document without route content), for hosts that
   * serve it as the fallback. Default `"200.html"`; `false` skips it. Needs a handler from
   * `createHandler` (it has `renderShell`).
   */
  readonly shell?: string | false;
  /**
   * Path rendered for `404.html` (it should match no route). Default `"/__shadow_not_found__"`;
   * `false` skips the file. A 404 answer is expected here.
   */
  readonly notFoundPath?: string | false;
  /** Headers added to every request, for example `accept-language`. */
  readonly headers?: HeadersInit;
  /**
   * Follows the internal links of the rendered HTML pages: `true` for three hops and 500 added pages,
   * or `{ depth, limit }` (depth at least 1, limit at least 0). Links to other origins, fragments,
   * files (a last segment with a dot) and `/_dusk` are not followed. Off by default.
   */
  readonly crawlLinks?: boolean | { readonly depth?: number; readonly limit?: number };
  /** Keeps a path (listed or found by the crawl) out when it returns false. */
  readonly filter?: (path: string) => boolean;
  /** Attempts after a path that threw or answered 5xx. Default 0. */
  readonly retry?: number;
  /** Called after each page is written. */
  readonly onSuccess?: (page: PrerenderedPage) => void | Promise<void>;
  /** Called for each path that did not render, listed or found, before the run fails. */
  readonly onError?: (failure: PrerenderFailure) => void | Promise<void>;
}

/** One file written. @since 1.0.0 */
export interface PrerenderedPage {
  readonly path: string;
  readonly file: string;
  readonly status: number;
  readonly bytes: number;
}

/** Result of {@link prerender}. @since 1.0.0 */
export interface PrerenderResult {
  readonly pages: readonly PrerenderedPage[];
  /** Absolute path of the SPA shell, if written. */
  readonly shell: string | undefined;
  /** Absolute path of `404.html`, if written. */
  readonly notFound: string | undefined;
}

/**
 * Thrown for a path that cannot be rendered to a file, or a page that did not render.
 *
 * @example
 * try { await prerender(options); } catch (error) { if (error instanceof PrerenderError) console.log(error.code); }
 * @since 1.0.0
 */
export class PrerenderError extends Error {
  readonly code: string;

  /** @param code A code such as `PRERENDER_NON_OK`. @param message What happened. */
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PrerenderError";
    this.code = code;
  }
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_BYTES = 255;
const encoder = new TextEncoder();

/**
 * Maps a URL path to the file it is written to, relative to the output directory. The path is
 * decoded and checked like a request path: no `.`/`..` segments, no control characters or
 * backslashes, segments up to 255 bytes, total up to 1024 characters.
 *
 * @param path The URL path (no query, no fragment).
 * @param format Directory or file layout for HTML pages.
 * @param contentType The page's content type; a file-like path with a non-HTML type keeps its name.
 * @returns The relative file path with `/` separators.
 * @throws PrerenderError `PRERENDER_PATH_REJECTED` for a path that cannot be written safely.
 * @example
 * outputFileFor("/about", "directory", "text/html"); // "about/index.html"
 * outputFileFor("/feed.xml", "directory", "application/xml"); // "feed.xml"
 * @since 1.0.0
 */
export function outputFileFor(
  path: string,
  format: "directory" | "file",
  contentType: string,
): string {
  if (!path.startsWith("/") || path.length > MAX_PATH_LENGTH || /[?#]/.test(path)) {
    throw new PrerenderError(
      "PRERENDER_PATH_REJECTED",
      `${JSON.stringify(path.slice(0, 80))} is not a valid path.`,
    );
  }
  const segments = safeSegments(path);
  if (
    segments === undefined ||
    segments.some((segment) => encoder.encode(segment).byteLength > MAX_SEGMENT_BYTES)
  ) {
    throw new PrerenderError(
      "PRERENDER_PATH_REJECTED",
      `${JSON.stringify(path.slice(0, 80))} cannot be written safely.`,
    );
  }
  const html = contentType.toLowerCase().startsWith("text/html");
  const last = segments[segments.length - 1];
  if (segments.length === 0) return "index.html";
  if (!html && last !== undefined && last.includes(".")) return segments.join("/");
  if (last?.toLowerCase().endsWith(".html")) return segments.join("/");
  return format === "directory" ? `${segments.join("/")}/index.html` : `${segments.join("/")}.html`;
}

/** The markup of a meta-refresh page for a redirect. Only same-site paths are accepted. */
function redirectPage(location: string): string {
  const escaped = location.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Redirecting</title><link rel="canonical" href="${escaped}"><meta http-equiv="refresh" content="0;url=${escaped}"></head><body><a href="${escaped}">Redirecting</a></body></html>`;
}

/** Reads a body completely, failing if it exceeds `max` bytes. */
async function readBounded(response: Response, max: number, path: string): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new PrerenderError("PRERENDER_PAGE_TOO_LARGE", `${path} is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Whether a handler offers `renderShell`. */
function hasShell(handler: Handler): handler is DuskHandler {
  return typeof Reflect.get(handler, "renderShell") === "function";
}

/**
 * Renders pages to static files with the production handler. Each path is requested like a
 * browser would (a `GET` with an origin), the response must be an allowed status, and the body is
 * written under `outDir`. Paths are validated, output files are checked to stay inside `outDir`,
 * two paths may not map to one file, and page count, size and time are bounded.
 *
 * @param options What to render and where to write it.
 * @returns The files written.
 * @throws PrerenderError `PRERENDER_PATH_REJECTED`, `PRERENDER_PATH_CONFLICT`, `PRERENDER_MAX_PAGES`,
 *   `PRERENDER_NON_OK`, `PRERENDER_REDIRECT`, `PRERENDER_PAGE_TOO_LARGE`.
 * @example
 * await prerender({ handler, outDir: "dist/static", paths: ["/", "/about", "/posts/1"] });
 * @since 1.0.0
 */
export async function prerender(options: PrerenderOptions): Promise<PrerenderResult> {
  const hosts = allowedHostsOf(options.handler);
  const chosen = choosePrerenderOrigin(hosts, options.origin);
  if (!chosen.ok) throw new PrerenderError("PRERENDER_HOST", chosen.message);
  const origin = new URL(chosen.origin).origin;
  /** "<what> answered 400: the host ... is not in security.allowedHosts ..." or a plain sentence. */
  const answered = (what: string, status: number): string => {
    const why = status === 400 ? hostRejectionMessage(hosts, origin) : undefined;
    return why === undefined ? `${what} answered ${status}.` : `${what} answered ${status}: ${why}`;
  };
  const format = options.format ?? "directory";
  const outRoot = resolve(options.outDir);
  const maxPages = options.maxPages ?? 10_000;
  const maxBytes = options.maxPageBytes ?? 16 * 1024 * 1024;
  const timeout = options.pageTimeoutMs ?? 30_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const allowed = new Set(options.allowStatus ?? [200]);
  const listed = typeof options.paths === "function" ? await options.paths() : options.paths;
  const paths = [...new Set(listed)];
  if (paths.length > maxPages) {
    throw new PrerenderError(
      "PRERENDER_MAX_PAGES",
      `${paths.length} pages exceed the limit of ${maxPages}.`,
    );
  }

  const written = new Map<string, string>();
  const pages: PrerenderedPage[] = [];

  const write = async (relative: string, body: Uint8Array | string): Promise<string> => {
    const file = resolve(outRoot, relative);
    if (!file.startsWith(outRoot + sep)) {
      throw new PrerenderError(
        "PRERENDER_PATH_REJECTED",
        `${relative} resolves outside the output directory.`,
      );
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    return file;
  };

  const fetchPath = async (path: string): Promise<Response> => {
    const request = new Request(new URL(path, origin), {
      headers: new Headers(options.headers),
      signal: AbortSignal.timeout(timeout),
    });
    return options.handler.fetch(request, { clientAddress: "127.0.0.1" });
  };

  /**
   * Two paths must never write the same file. Names are compared without case on every platform: macOS and
   * Windows file systems ignore case, so `/About` and `/about` would overwrite each other there, and the same
   * project must not build differently on Linux.
   */
  const claim = (relative: string, path: string): void => {
    const key = relative.toLowerCase();
    const owner = written.get(key);
    if (owner !== undefined && owner !== path) {
      throw new PrerenderError(
        "PRERENDER_PATH_CONFLICT",
        `${path} and ${owner} both write ${relative} (file names are compared without case).`,
      );
    }
    written.set(key, path);
  };

  // Validate every listed path before rendering anything, so a bad list fails fast and writes nothing.
  for (const path of paths) claim(outputFileFor(path, format, "text/html"), path);

  const crawl = crawlPolicyOf(options.crawlLinks);
  const onSuccess = options.onSuccess;
  /** One attempt at a path: the links of its page when it rendered, or why it did not. */
  const renderOnce = async (
    path: string,
  ): Promise<
    | { readonly links: readonly string[] }
    | { readonly retryable: boolean; readonly error: PrerenderError }
  > => {
    let response: Response;
    try {
      response = await fetchPath(path);
    } catch (error) {
      return {
        retryable: true,
        error: new PrerenderError(
          "PRERENDER_NON_OK",
          `${path} failed to render: ${reasonOf(error)}`,
        ),
      };
    }
    const type = response.headers.get("content-type") ?? "";
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      if ((options.onRedirect ?? "error") === "error") {
        return {
          retryable: false,
          error: new PrerenderError("PRERENDER_REDIRECT", `${path} redirects to ${location}.`),
        };
      }
      const target = new URL(location, new URL(path, origin));
      if (target.origin !== origin) {
        return {
          retryable: false,
          error: new PrerenderError("PRERENDER_REDIRECT", `${path} redirects to another origin.`),
        };
      }
      const relative = outputFileFor(path, format, "text/html");
      claim(relative, path);
      const file = await write(
        relative,
        redirectPage(`${target.pathname}${target.search}${target.hash}`),
      );
      const page: PrerenderedPage = { path, file, status: response.status, bytes: 0 };
      pages.push(page);
      await onSuccess?.(page);
      return { links: [] };
    }
    if (!allowed.has(response.status)) {
      await response.body?.cancel();
      return {
        retryable: response.status >= 500,
        error: new PrerenderError("PRERENDER_NON_OK", answered(path, response.status)),
      };
    }
    const relative = outputFileFor(path, format, type);
    claim(relative, path);
    const body = await readBounded(response, maxBytes, path);
    const file = await write(relative, body);
    const page: PrerenderedPage = { path, file, status: response.status, bytes: body.byteLength };
    pages.push(page);
    await onSuccess?.(page);
    const links =
      crawl === undefined || !type.toLowerCase().includes("html")
        ? []
        : internalLinks(new TextDecoder().decode(body), new URL(path, origin), origin, "");
    return { links };
  };

  const retries = options.retry ?? 0;
  const render = async (path: string): Promise<readonly string[]> => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await renderOnce(path);
      if ("links" in result) return result.links;
      if (!result.retryable || attempt >= retries) throw result.error;
    }
  };

  const onError = options.onError;
  const failures = await runCrawl({
    paths,
    concurrency,
    crawl,
    filter: options.filter,
    render,
    onFailure:
      onError === undefined
        ? undefined
        : async (failure) => {
            await onError(failure);
          },
  });
  const first = failures[0];
  if (first !== undefined && failures.length === 1 && first.error instanceof PrerenderError) {
    throw first.error;
  }
  if (failures.length > 0) {
    throw new PrerenderError(
      "PRERENDER_NON_OK",
      describeFailures(
        failures,
        "Fix the page, remove its path from paths, skip it with filter, or allow its status with allowStatus.",
      ),
    );
  }

  let shellFile: string | undefined;
  if (options.shell !== false && hasShell(options.handler)) {
    const response = await options.handler.renderShell(new Request(new URL("/", origin)));
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PrerenderError("PRERENDER_NON_OK", answered("the SPA shell", response.status));
    }
    const body = await readBounded(response, maxBytes, "(shell)");
    shellFile = await write(options.shell ?? "200.html", body);
  }
  let notFoundFile: string | undefined;
  if (options.notFoundPath !== false) {
    const path = options.notFoundPath ?? "/__shadow_not_found__";
    const response = await fetchPath(path);
    if (response.status === 404) {
      notFoundFile = await write("404.html", await readBounded(response, maxBytes, path));
    } else {
      await response.body?.cancel();
    }
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  return { pages, shell: shellFile, notFound: notFoundFile };
}
