import { createReadStream, type Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import { assertKnownOptions } from "../internal/known-options";
import { secureHeaderEntries } from "../server/secure-headers";
import type { AssetDecision } from "../server/types";
import { selectRange } from "../shared/byte-range";
import { pageKeyOf, type StaticPage } from "../shared/static-page";
import { type Compressor, type Encoding, isCompressible, negotiateEncoding } from "./compress";

/** Options of static file serving. @since 1.0.0 */
export interface StaticOptions {
  /** Directory to serve (the client build output). */
  readonly dir: string;
  /** URL prefix the directory is mounted at. Default `"/"`. */
  readonly prefix?: string;
  /**
   * Which files get `Cache-Control: public, max-age=31536000, immutable`. Receives the path
   * relative to `dir`. Default: files whose name carries a content hash (`app-3f9a1c2e.js`).
   */
  readonly immutable?: (relativePath: string) => boolean;
  /** The build's assets folder (Vite's `build.assetsDir`), used by the default `immutable` test. Default `"assets"`. */
  readonly assetsDir?: string;
  /** `Cache-Control` max-age of other files, in seconds. They always revalidate with an ETag. Default 0. */
  readonly maxAgeSeconds?: number;
  /** Name served for a directory request (`"index.html"` for a static site). Default: none. */
  readonly index?: string | false;
  /** Extensions tried for a path without one (`[".html"]` serves `/about` from `about.html`). */
  readonly extensions?: readonly string[];
  /** `"deny"` (default) never serves a path with a segment that starts with a dot, except the allowlisted `/.well-known/<name>` files. */
  readonly dotfiles?: "allow" | "deny";
  /** Use `.br` / `.zst` / `.gz` files next to the original when the client accepts them. Default `true`. */
  readonly precompressed?: boolean;
  /**
   * Names served from `/.well-known/<name>` as plain files (one name each, no subpaths). Any other dotted path, and
   * `.env*` in particular, stays denied. Default {@link WELL_KNOWN_NAMES}.
   */
  readonly wellKnown?: readonly string[];
  /**
   * The prerendered pages and how each is answered (see {@link StaticPage}). A `handler` page is never served from its
   * file: the request goes to the handler. A `static` page is served with its headers, and with the HSTS header when the
   * request came over https. Default: none.
   */
  readonly pages?: readonly StaticPage[];
}

/**
 * The `/.well-known/` names served by default: the security contact file, the app-association files of the two
 * mobile platforms, the password-change path and the OpenID discovery document. They must sit in `public/.well-known/`.
 */
export const WELL_KNOWN_NAMES: readonly string[] = [
  "security.txt",
  "assetlinks.json",
  "apple-app-site-association",
  "change-password",
  "openid-configuration",
];

/** Whether a request path is exactly `/.well-known/<name>` for a name in `names`. */
export function isAllowedWellKnown(segments: readonly string[], names: readonly string[]): boolean {
  return (
    segments.length === 2 && segments[0] === ".well-known" && names.includes(segments[1] ?? "")
  );
}

export { ifRangeMatches, parseRange, selectRange } from "../shared/byte-range";

/** What the static server needs from its host. @internal */
export interface StaticContext {
  /** Bounds dynamic compression. Omit for none. */
  readonly compressor: Compressor | undefined;
  /**
   * The handler's host check (`security.allowedHosts`), applied to the request before any path is looked at. A request
   * whose Host is refused is not answered here: the handler takes it and answers the same 400 it gives any refused host,
   * so a prerendered page, a public file and a hashed asset all look alike to a caller. Omit when the app has no host list.
   */
  readonly hostAllowed?: ((req: IncomingMessage) => boolean) | undefined;
  /**
   * The static-file gate of a handler that runs its middleware for files (`runMiddlewareForStaticFiles`, see
   * `Handler.gateAsset`). Asked once a file is found, before it is read: `serve` sends the file with the headers it
   * returns, `answer` ends the request with the response. Omit when the handler does not gate files.
   */
  readonly gate?: ((req: IncomingMessage) => Promise<AssetDecision>) | undefined;
  /** Sends the response the gate answered. Required with `gate`. */
  readonly answer?: ((response: Response) => Promise<void>) | undefined;
}

/** Content types by extension. Unknown extensions are served as binary. */
const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

const HASHED = /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
/** A font vendored from Google Fonts, named by the hash of its bytes (`fonts/google/<hex>.woff2`). */
const VENDORED_FONT = /(^|\/)fonts\/google\/[a-f0-9]{8,}\.(?:woff2?|ttf|otf)$/;

/**
 * The default `immutable` test: a name with a content hash segment of 8+ characters. A hash that
 * happens to contain no digit (about one in five bundler hashes is letters only) still counts when
 * the file sits under the build's assets folder (`assetsDir`, `assets` by default); elsewhere a digit
 * is required so ordinary words (`components.css`) are never treated as hashes. A font vendored under
 * `fonts/google/` is named by its content hash, so it is immutable too.
 *
 * @param relativePath The file's path under the client folder.
 * @param assetsDir The build's assets folder name (Vite's `build.assetsDir`).
 * @returns Whether the file may be cached for a year.
 * @since 1.0.0
 */
export function defaultImmutable(relativePath: string, assetsDir = "assets"): boolean {
  if (VENDORED_FONT.test(relativePath)) return true;
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const folders = relativePath.split("/").slice(0, -1);
  return HASHED.test(name) && (/\d/.test(name) || folders.includes(assetsDir));
}

/** Extensionless files that are JSON documents (the platform app-association and discovery files). */
const JSON_NAMES: ReadonlySet<string> = new Set([
  "apple-app-site-association",
  "openid-configuration",
]);

export function contentTypeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const extension = dot > slash ? path.slice(dot).toLowerCase() : "";
  if (extension === "" && JSON_NAMES.has(path.slice(slash + 1)))
    return "application/json; charset=utf-8";
  return MIME[extension] ?? "application/octet-stream";
}

/** The result of looking a URL up: a file, nothing, or a request to refuse. */
type Lookup =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly relative: string;
      readonly stats: Stats;
    }
  | { readonly kind: "none" }
  | { readonly kind: "bad" };

/**
 * Decodes a request path into safe segments. Everything that could leave the directory is
 * rejected, whatever the encoding: `..` and `.` segments after decoding (so `%2e%2e`, `..%2f`),
 * NUL and other control characters, backslashes, and malformed escapes. Double-encoded input is
 * decoded once only, so `%252e%252e` stays a harmless literal name.
 *
 * @param pathname The request path without query.
 * @returns The segments, or `undefined` when the path must be refused.
 * @example
 * safeSegments("/a/%2e%2e/b"); // undefined
 * safeSegments("/css/app.css"); // ["css", "app.css"]
 * @since 1.0.0
 */
export function safeSegments(pathname: string): string[] | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is a bad request, not a file name: refuse it.
    return undefined;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return undefined;
  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  return segments;
}

/** A static file server for one directory. @internal */
export interface StaticServer {
  /** Answers the request if it is for a file; returns `false` to let the handler take it. */
  handle(req: IncomingMessage, res: ServerResponse, context: StaticContext): Promise<boolean>;
}

/** The file extension of a precompressed copy for each content coding. */
const SIBLINGS: Readonly<Record<Encoding, string>> = { br: ".br", zstd: ".zst", gzip: ".gz" };

/** The weak entity tag of a file. */
function etagOf(stats: Stats, suffix: string): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}${suffix}"`;
}

/** Whether any entity tag of an `If-None-Match` list matches (weak comparison). */
function noneMatch(header: string, etag: string): boolean {
  const strip = (tag: string): string => tag.trim().replace(/^W\//, "");
  return (
    header.trim() === "*" || header.split(",").some((candidate) => strip(candidate) === strip(etag))
  );
}

const STATIC_OPTIONS: ReadonlySet<string> = new Set([
  "dir",
  "prefix",
  "immutable",
  "maxAgeSeconds",
  "index",
  "extensions",
  "dotfiles",
  "precompressed",
  "wellKnown",
  "assetsDir",
  "pages",
]);

/**
 * Creates the static server of a directory. Paths are resolved under the directory only: the
 * decoded path is checked for traversal, the resolved path must stay below the directory's real
 * path (so a symlink cannot lead out), dotfiles are refused, and only GET and HEAD are answered.
 * Responses carry validators (ETag, Last-Modified), honor conditional and range requests,
 * negotiate precompressed siblings or compress on the fly, and cache hashed files for a year.
 *
 * @param options What to serve.
 * @returns The server.
 * @internal
 */
export function createStaticServer(options: StaticOptions): StaticServer {
  assertKnownOptions("serve({ static })", options, STATIC_OPTIONS);
  const root = resolve(options.dir);
  const prefix = (options.prefix ?? "/").replace(/\/+$/, "");
  const assetsDir = options.assetsDir ?? "assets";
  const immutable = options.immutable ?? ((path: string) => defaultImmutable(path, assetsDir));
  const maxAge = options.maxAgeSeconds ?? 0;
  const index = options.index ?? false;
  const extensions = options.extensions ?? [];
  const allowDotfiles = options.dotfiles === "allow";
  const wellKnown = options.wellKnown ?? WELL_KNOWN_NAMES;
  const precompressed = options.precompressed !== false;
  let realRoot: Promise<string> | undefined;

  const inside = (path: string, base: string): boolean =>
    path === base || path.startsWith(base + sep);

  // The prerendered pages by path. A request names its page when its path, below the mount prefix, decodes to one.
  const pageOf = (pathname: string): StaticPage | undefined => {
    if (pageMap.size === 0) return undefined;
    if (prefix !== "" && pathname !== prefix && !pathname.startsWith(`${prefix}/`))
      return undefined;
    const app = prefix === "" ? pathname : pathname.slice(prefix.length) || "/";
    let decoded: string;
    try {
      decoded = decodeURIComponent(app);
    } catch {
      return undefined;
    }
    return pageMap.get(pageKeyOf(decoded));
  };
  const pageMap = new Map((options.pages ?? []).map((page) => [page.path, page] as const));

  const lookup = async (pathname: string): Promise<Lookup> => {
    if (prefix !== "" && pathname !== prefix && !pathname.startsWith(`${prefix}/`))
      return { kind: "none" };
    const segments = safeSegments(prefix === "" ? pathname : pathname.slice(prefix.length));
    if (segments === undefined) return { kind: "bad" };
    if (
      !allowDotfiles &&
      segments.some((segment) => segment.startsWith(".")) &&
      !isAllowedWellKnown(segments, wellKnown)
    )
      return { kind: "none" };
    realRoot ??= realpath(root);
    // Any failure to resolve the root (missing, unreadable) means there are no static files here, so
    // the request falls through to the handler. The failure is not reported: `StaticOptions` has no
    // reporter and `serve()` does not catch errors from this path, so a misconfigured root is a silent
    // fall-through today. Reporting it needs a reporter passed in from `serve()`.
    const base = await realRoot.catch(() => undefined);
    if (base === undefined) return { kind: "none" };
    const candidates = [segments.join("/")];
    if (index !== false) candidates.push([...segments, index].join("/"));
    // "/" + ".html" would be the hidden file ".html": clean-URL extensions need a name.
    if (segments.length > 0)
      for (const extension of extensions) candidates.push(`${segments.join("/")}${extension}`);
    for (const relative of candidates) {
      if (relative === "" || relative.endsWith("/")) continue;
      const path = resolve(root, relative);
      if (!inside(path, root)) return { kind: "bad" };
      let real: string;
      let stats: Stats;
      try {
        real = await realpath(path);
        stats = await stat(real);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG")
          continue;
        throw error;
      }
      // A symlink may point anywhere; the real path must still be inside the real root.
      if (!inside(real, base)) return { kind: "none" };
      if (stats.isFile()) return { kind: "file", path: real, relative, stats };
    }
    return { kind: "none" };
  };

  return {
    async handle(req, res, context) {
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") return false;
      // The host decides before the disk is touched: a refused Host gets the handler's answer for any path.
      if (context.hostAllowed !== undefined && !context.hostAllowed(req)) return false;
      const target = req.url ?? "";
      if (!target.startsWith("/")) return false;
      const cut = target.search(/[?#]/);
      const pathname = cut === -1 ? target : target.slice(0, cut);
      const page = pageOf(pathname);
      if (page?.mode === "handler") return false;
      const found = await lookup(pathname);
      if (found.kind === "none") return false;
      if (found.kind === "bad") {
        res.writeHead(400, {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        res.end("Bad Request");
        return true;
      }
      // The middleware of a gated handler decides first; a refusal is sent, and the file's headers come from its pass.
      let extra: Headers | undefined;
      if (context.gate !== undefined) {
        const decision = await context.gate(req);
        if (decision.kind === "answer") {
          if (context.answer === undefined)
            throw new TypeError("static: a gate needs an answer sender.");
          await context.answer(decision.response);
          return true;
        }
        extra = decision.headers;
      }
      await send(req, res, found, context, page, extra);
      return true;
    },
  };

  async function send(
    req: IncomingMessage,
    res: ServerResponse,
    file: Extract<Lookup, { kind: "file" }>,
    context: StaticContext,
    page: StaticPage | undefined,
    extra: Headers | undefined,
  ): Promise<void> {
    const head = (req.method ?? "GET") === "HEAD";
    const type = contentTypeOf(file.relative);
    const accept =
      typeof req.headers["accept-encoding"] === "string"
        ? req.headers["accept-encoding"]
        : undefined;
    const compressible = context.compressor?.compressible ?? isCompressible;
    const encoding = compressible(type) ? negotiateEncoding(accept) : undefined;

    // A precompressed sibling wins over compressing on the fly.
    let source = {
      path: file.path,
      stats: file.stats,
      encoding: undefined as Encoding | undefined,
    };
    if (precompressed && encoding !== undefined) {
      const suffix = SIBLINGS[encoding];
      try {
        const sibling = await stat(file.path + suffix);
        if (sibling.isFile()) source = { path: file.path + suffix, stats: sibling, encoding };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }

    const etag = etagOf(file.stats, source.encoding === undefined ? "" : `-${source.encoding}`);
    const headers: Record<string, string | string[]> = {
      "content-type": type,
      "x-content-type-options": "nosniff",
      etag,
      "last-modified": file.stats.mtime.toUTCString(),
      "accept-ranges": "bytes",
      "cache-control": immutable(file.relative)
        ? "public, max-age=31536000, immutable"
        : `public, max-age=${maxAge}, must-revalidate`,
    };
    // A prerendered page is an HTML document like any other: it gets the handler's default framing and referrer
    // headers too (no HSTS: that depends on the scheme the handler knows and this server does not).
    for (const [name, value] of secureHeaderEntries(undefined, false)) {
      if (headers[name] === undefined) headers[name] = value;
    }
    // The app's policy for this page (its security headers, nonce-free CSP and header rules), which wins over the defaults.
    if (page?.mode === "static") {
      for (const [name, value] of page.headers) headers[name] = value;
      if (Reflect.get(req.socket, "encrypted") === true) {
        for (const [name, value] of page.httpsHeaders) headers[name] = value;
      }
    }
    // The headers the gate's middleware set go out last: they win over the defaults and the page's policy.
    if (extra !== undefined) {
      for (const [name, value] of extra) if (name !== "set-cookie") headers[name] = value;
      const cookies = extra.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies;
    }
    if (compressible(type)) headers["vary"] = "Accept-Encoding";
    if (source.encoding !== undefined) headers["content-encoding"] = source.encoding;

    // A file with no precompressed copy is compressed on the fly when it is big enough: that copy has a tag of its own, and
    // a client that was sent it asks with it, so the 304 check below knows both tags.
    const compressor = context.compressor;
    const dynamicTag =
      compressor !== undefined &&
      encoding !== undefined &&
      source.encoding === undefined &&
      file.stats.size >= compressor.minBytes
        ? etagOf(file.stats, `-${encoding}`)
        : undefined;

    // Conditional requests: If-None-Match wins over If-Modified-Since.
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModifiedSince = req.headers["if-modified-since"];
    const matched =
      typeof ifNoneMatch === "string"
        ? [dynamicTag, etag].find((tag) => tag !== undefined && noneMatch(ifNoneMatch, tag))
        : undefined;
    const notModified =
      typeof ifNoneMatch === "string"
        ? matched !== undefined
        : typeof ifModifiedSince === "string" &&
          Math.floor(file.stats.mtimeMs / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000);
    if (notModified) {
      if (matched !== undefined) headers["etag"] = matched;
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const size = source.stats.size;
    // Ranges apply to the identity representation only.
    let range: { start: number; end: number } | undefined;
    const selected =
      source.encoding === undefined
        ? selectRange(
            req.headers.range,
            typeof req.headers["if-range"] === "string" ? req.headers["if-range"] : undefined,
            etag,
            file.stats.mtimeMs,
            size,
            Date.now(),
          )
        : null;
    if (selected === "unsatisfiable") {
      res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    if (selected !== null) range = selected;

    // Compress on the fly when nothing precompressed exists, within the concurrency bound.
    const dynamic =
      compressor !== undefined &&
      dynamicTag !== undefined &&
      encoding !== undefined &&
      range === undefined
        ? compressor.open(encoding)
        : undefined;

    if (range !== undefined) {
      headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
      headers["content-length"] = String(range.end - range.start + 1);
      res.writeHead(206, headers);
    } else if (dynamic !== undefined && encoding !== undefined) {
      headers["content-encoding"] = encoding;
      headers["etag"] = dynamicTag ?? etag;
      delete headers["accept-ranges"];
      res.writeHead(200, headers);
    } else {
      headers["content-length"] = String(size);
      res.writeHead(200, headers);
    }
    if (head) {
      dynamic?.release();
      res.end();
      return;
    }
    const reader = createReadStream(
      source.path,
      range === undefined ? {} : { start: range.start, end: range.end },
    );
    await new Promise<void>((done) => {
      const finish = (): void => {
        dynamic?.release();
        done();
      };
      if (dynamic === undefined) pipeline(reader, res, finish);
      else pipeline(reader, dynamic.stream, res, finish);
    });
  }
}
