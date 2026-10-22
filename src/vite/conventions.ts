import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, posix } from "node:path";
import { isPrivatePattern } from "@shadow-js/router/core";
import {
  analyzeRouteModule,
  type ImageModuleExports,
  ModuleParseError,
  parseRouteFile,
  patternOf,
  type RouteModuleInfo,
  readImageExports,
} from "@shadow-js/router/vite";
import type { FileImage } from "../metadata/file-images";
import { checkedSize, type OgSize } from "../og/image-response";
import { readImageHeader } from "./image-header";

/**
 * File conventions: the files of the source folder that Dusk serves at the URLs crawlers and browsers ask for.
 * `src/sitemap.ts`, `src/robots.ts` and `src/manifest.ts` (code, answered by the helpers of `@shadow-js/dusk/server`),
 * and `src/icon.*`, `src/apple-icon.*`, `src/favicon.ico` (files, embedded and answered with their type). Each becomes an
 * API route of the app, so the server runtime, the adapters and the prerender treat it like any other route.
 *
 * Only the top level of `src` is read for these: a file inside `routes/` is a page, and a `sitemap` there would be one.
 * The social images are the exception. `opengraph-image` and `twitter-image` are found at the top of `src`, at the top of
 * `routes/` and in every route folder, as either a static file (`.png`, `.jpg`, `.jpeg` or `.gif`, with an optional
 * `<name>.alt.txt` beside it) or a module (`.ts`, `.tsx`, ...) whose default export draws the image with `ImageResponse`.
 * A module is served at its folder's URL plus its name (`/blog/:slug/opengraph-image`), with the params of the folder
 * (see {@link dynamicImage}). A module of the same folder wins over a static file of the same kind.
 * A convention that clashes with another route, or a second file for one convention, is a build error at scan.
 * @packageDocumentation
 */

/** The virtual module id prefix of a convention's wrapper. */
export const CONVENTION_PREFIX = "virtual:dusk/convention/";

/** Raised for a convention the build cannot serve (a clash, a duplicate, a file too large). @since 1.0.0 */
export class ConventionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConventionError";
  }
}

/** The API route a convention becomes: the same shape the router's scan gives an API file. @since 1.0.0 */
export interface ConventionEntry {
  readonly id: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly fullPath: string;
  readonly methods: readonly ["GET"];
  /** Conventions export no `matchFilters`, and their URLs are never private (the names are fixed). */
  readonly matchFilters: false;
  readonly private: false;
}

/**
 * A static `opengraph-image` or `twitter-image` file the scan found, with what the tags of its pages are built from.
 * @since 1.0.0
 */
export interface ConventionImage {
  readonly kind: "openGraph" | "twitter";
  /** The folder of the file relative to the routes folder, POSIX separators; empty for the root. */
  readonly folder: string;
  /** The absolute path of the image file. */
  readonly file: string;
  /** The data of the tag: the served path (without the mount base), the hash, the header's type and size, the alt. */
  readonly image: FileImage;
}

/** What {@link discoverConventions} found: the routes and the wrapper module source of each virtual id. @since 1.0.0 */
export interface ConventionScan {
  readonly entries: readonly ConventionEntry[];
  /** Wrapper module source by virtual id (without the `\0` the resolver adds). */
  readonly sources: ReadonlyMap<string, string>;
  /** The static metadata images, by folder and kind; the build gives each to the routes it applies to. */
  readonly images: readonly ConventionImage[];
}

const MODULE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
const MODULE_CONVENTIONS: Readonly<Record<string, { url: string; kind: string }>> = {
  sitemap: { url: "/sitemap.xml", kind: "sitemap" },
  robots: { url: "/robots.txt", kind: "robots" },
  manifest: { url: "/manifest.webmanifest", kind: "manifest" },
};
const STATIC_CONVENTIONS: Readonly<Record<string, { url: string; extensions: readonly string[] }>> =
  {
    icon: { url: "/icon", extensions: [".svg", ".png", ".ico", ".jpg", ".jpeg"] },
    "apple-icon": { url: "/apple-icon", extensions: [".png", ".jpg", ".jpeg"] },
    favicon: { url: "/favicon.ico", extensions: [".ico"] },
  };
const MIME: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};
/** The static social images: the file name (without extension) and the metadata block each one fills. */
const IMAGE_CONVENTIONS: readonly {
  readonly base: string;
  readonly kind: ConventionImage["kind"];
}[] = [
  { base: "opengraph-image", kind: "openGraph" },
  { base: "twitter-image", kind: "twitter" },
];
const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".gif"];
/** Folders of the routes folder that never hold route files (colocation, dependencies). */
const SKIPPED_FOLDER = /^(?:[.-]|node_modules$)/;
const MAX_STATIC_BYTES = 256 * 1024;
const GENERATE_SITEMAPS = /export\s+(?:async\s+)?(?:function|const)\s+generateSitemaps\b/;

/** The import of a convention's module, as the wrapper writes it. */
function importOf(absolutePath: string): string {
  return JSON.stringify(posix.normalize(absolutePath.split("\\").join("/")));
}

/** The wrapper of a code convention: the helper that answers it, around the file's default export. */
function moduleWrapper(kind: string, file: string): string {
  const from = importOf(file);
  switch (kind) {
    case "sitemap":
      return `import { sitemapRoute } from "@shadow-js/dusk/server";\nimport build from ${from};\nexport const GET = sitemapRoute(build);\n`;
    case "robots":
      return `import { robotsRoute } from "@shadow-js/dusk/server";\nimport build from ${from};\nexport const GET = robotsRoute(build);\n`;
    case "manifest":
      return `import { manifestRoute } from "@shadow-js/dusk/server";\nimport build from ${from};\nexport const GET = manifestRoute(build);\n`;
    case "sitemap-index":
      return [
        'import { sitemapIndexRoute } from "@shadow-js/dusk/server";',
        `import * as module from ${from};`,
        "export const GET = sitemapIndexRoute(async (event) =>",
        "  (await module.generateSitemaps(event)).map((item) => ({",
        '    url: new URL("/sitemap/" + encodeURIComponent(String(item.id)) + ".xml", event.url.origin),',
        "  })),",
        ");",
        "",
      ].join("\n");
    case "sitemap-id":
      return [
        'import { HttpError, sitemapRoute } from "@shadow-js/dusk/server";',
        `import * as module from ${from};`,
        "export const GET = sitemapRoute((event) => {",
        '  const raw = String(event.params["id"] ?? "");',
        '  if (!raw.endsWith(".xml")) throw new HttpError(404, "Not Found");',
        "  return module.default({ id: raw.slice(0, -4) }, event);",
        "});",
        "",
      ].join("\n");
    case "image":
      return [
        'import { ImageResponse } from "@shadow-js/dusk/og";',
        `import * as module from ${from};`,
        // The file exports its size, its fonts and the resvg WASM it draws with (see ImageResponse); none is required here.
        "export const GET = async (event) => new ImageResponse(await module.default(event), {",
        "  ...module.size,",
        "  fonts: module.fonts,",
        "  resvgWasm: module.resvgWasm,",
        "});",
        "",
      ].join("\n");
    default:
      throw new ConventionError(`unknown convention kind ${JSON.stringify(kind)} (${file}).`);
  }
}

/** The wrapper of a static file: its bytes, embedded, with their type. */
function staticWrapper(bytes: Uint8Array, type: string): string {
  const encoded = Buffer.from(bytes).toString("base64");
  return [
    `const bytes = Uint8Array.from(atob(${JSON.stringify(encoded)}), (character) => character.charCodeAt(0));`,
    "export const GET = () => new Response(bytes.slice(), {",
    `  headers: { "content-type": ${JSON.stringify(type)}, "cache-control": "public, max-age=86400" },`,
    "});",
    "",
  ].join("\n");
}

/** Lists the files of the top level of `srcDir` that are conventions, sorted by name. */
function filesOf(srcDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(srcDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.sort().filter((name) => statSync(join(srcDir, name)).isFile());
}

/** The names of the files directly inside a folder, sorted; a folder that does not exist has none. */
function fileNamesIn(folder: string): string[] {
  let found: Dirent[];
  try {
    found = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return found
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .sort();
}

/** True for the name of a file that belongs to an image convention (`opengraph-image.png`, `twitter-image.alt.txt`, ...). */
function isImageConventionFile(name: string): boolean {
  return IMAGE_CONVENTIONS.some(({ base }) => name.startsWith(`${base}.`));
}

/**
 * The route folders under the routes folder that hold a file of an image convention, sorted, as POSIX paths relative to
 * it, each with the names of its files (sorted). One walk reads every folder once and keeps only these: a build of ten
 * thousand routes has about as many folders and nearly none has an image. The folders of one depth are read together, so
 * the file system works on them in parallel (reading them one by one took five times as long on ten thousand folders).
 * The walk is iterative (the depth of the folders is the user's), and it does not follow links.
 */
async function imageFolders(
  routesDir: string,
): Promise<Array<{ folder: string; names: string[] }>> {
  const out: Array<{ folder: string; names: string[] }> = [];
  let level: string[] = [""];
  while (level.length > 0) {
    const listings = await Promise.all(
      level.map(async (folder) => {
        try {
          return { folder, found: await readdir(join(routesDir, folder), { withFileTypes: true }) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { folder, found: [] };
          throw error;
        }
      }),
    );
    const deeper: string[] = [];
    for (const { folder, found } of listings) {
      const names: string[] = [];
      let hasImage = false;
      for (const item of found) {
        if (item.isDirectory()) {
          if (!SKIPPED_FOLDER.test(item.name))
            deeper.push(folder === "" ? item.name : `${folder}/${item.name}`);
        } else if (item.isFile()) {
          names.push(item.name);
          if (isImageConventionFile(item.name)) hasImage = true;
        }
      }
      // The root of the routes folder is handled with the top of `src`, not as a folder of its own.
      if (hasImage && folder !== "") out.push({ folder, names: names.sort() });
    }
    level = deeper;
  }
  return out.sort((left, right) =>
    left.folder < right.folder ? -1 : left.folder > right.folder ? 1 : 0,
  );
}

/** The URL path of a route folder as the router names it: params as `:name`, groups left out; empty for the root. */
function folderUrl(folder: string, file: string): string {
  if (folder === "") return "";
  // Parse the folder as if a page lived in it: the router's grammar says what each folder name means.
  const parsed = parseRouteFile(`${folder}/index.tsx`);
  if (parsed.status === "invalid") throw new ConventionError(`${file}: ${parsed.message}.`);
  if (parsed.status === "ignored") return "";
  const pattern = patternOf(parsed.dirs);
  return pattern === "/" ? "" : pattern;
}

/** The text of the `.alt.txt` file next to an image, trimmed; undefined when there is none or it is blank. */
function altTextOf(names: readonly string[], dir: string, base: string): string | undefined {
  const name = `${base}.alt.txt`;
  if (!names.includes(name)) return undefined;
  const text = readFileSync(join(dir, name), "utf8").trim();
  return text === "" ? undefined : text;
}

/** The size and type a dynamic image answers with when its exports do not say (the runtime defaults of ImageResponse). */
const DYNAMIC_DEFAULT_SIZE: OgSize = { width: 1200, height: 630 };
const DYNAMIC_TYPE = "image/png";

/**
 * The size a dynamic image's literal `size` export gives, checked the way ImageResponse checks it at run time, so the
 * build refuses what the response would refuse.
 */
function literalSize(size: OgSize, file: string): OgSize {
  try {
    return checkedSize(size.width, size.height);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ConventionError(`${file}: the size export is not drawable. ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * The image a dynamic `opengraph-image` or `twitter-image` module gives the pages of its folder. The module is an API
 * route at the folder's URL plus its name (`/blog/:slug/opengraph-image`), and the module must export a default function
 * that returns the tree (see `ImageResponse`), not HTTP handlers. Its tag reads the literal `alt`, `size` and
 * `contentType` exports: a literal `size` gives the tag its width and height, a literal `alt` its alt text. An export the
 * build cannot read (a call, a variable, a re-export) takes the runtime default: 1200 by 630, `image/png`, no alt text.
 * A literal `contentType` other than `image/png` is refused, because ImageResponse always answers a PNG.
 *
 * @throws ConventionError for a module without a default export, with HTTP handlers, with `generateImageMetadata`
 *   (not supported: one image per folder), with a size out of range or a content type other than PNG, or at a private URL.
 * @since 1.0.0
 */
function dynamicImage(
  kind: ConventionImage["kind"],
  base: string,
  folder: string,
  file: string,
  add: (convention: string, file: string, url: string, source: string) => void,
): ConventionImage {
  const bytes = readFileSync(file);
  const text = bytes.toString("utf8");
  let info: RouteModuleInfo;
  let facts: ImageModuleExports;
  try {
    info = analyzeRouteModule(text, file);
    facts = readImageExports(text, file);
  } catch (error) {
    if (error instanceof ModuleParseError)
      throw new ConventionError(error.message, { cause: error });
    throw error;
  }
  if (!info.hasDefault) {
    throw new ConventionError(
      `${file} has no default export; a ${base} module exports a default function that returns the image's tree (see ImageResponse).`,
    );
  }
  if (info.methods.length > 0 || info.defaultApi !== undefined) {
    throw new ConventionError(
      `${file} exports HTTP method handlers; a ${base} module is an image: its default export returns the tree, and the build answers it with an ImageResponse.`,
    );
  }
  if (info.exports.includes("generateImageMetadata")) {
    throw new ConventionError(
      `${file} exports generateImageMetadata, which Dusk does not support: write one ${base} module per folder.`,
    );
  }
  if (facts.contentType.state === "literal" && facts.contentType.value !== DYNAMIC_TYPE) {
    throw new ConventionError(
      `${file} exports contentType ${JSON.stringify(facts.contentType.value)}; an ImageResponse is always image/png, so write "image/png" or leave the export out.`,
    );
  }
  const size =
    facts.size.state === "literal" ? literalSize(facts.size.value, file) : DYNAMIC_DEFAULT_SIZE;
  const alt = facts.alt.state === "literal" ? facts.alt.value.trim() : "";
  const path = `${folderUrl(folder, file)}/${base}`;
  if (isPrivatePattern(path)) {
    throw new ConventionError(
      `${file} sits in a private route folder (a name starting with _): a private route is never served, so it cannot carry a ${base} image.`,
    );
  }
  add(base, file, path, moduleWrapper("image", file));
  return {
    kind,
    folder,
    file,
    image: {
      path,
      // The hash of the module's bytes: the tag's URL changes when the module does, as the static files' URLs do.
      hash: createHash("sha256").update(bytes).digest("hex").slice(0, 8),
      type: DYNAMIC_TYPE,
      width: size.width,
      height: size.height,
      ...(alt === "" ? {} : { alt }),
    },
  };
}

/**
 * Finds the static `opengraph-image` and `twitter-image` files of the root (the top of `src` and the top of `routes/`
 * count as one folder) and of every route folder, and adds the route each one is served at. A module of the same name in
 * the same folder (`opengraph-image.tsx`, ...) wins: the static file of that kind is then neither served nor described,
 * whatever the order of the file names. Two modules, or two static files, of one kind in one folder are an error.
 */
async function discoverImages(
  srcDir: string,
  routesDir: string,
  add: (convention: string, file: string, url: string, source: string) => void,
): Promise<ConventionImage[]> {
  const found: ConventionImage[] = [];
  // The root is two folders on disk: the top of `src` (where the other conventions live) and the top of `routes`.
  const folders = [
    {
      folder: "",
      listed: [srcDir, routesDir].map((dir) => ({ dir, names: fileNamesIn(dir) })),
    },
    ...(await imageFolders(routesDir)).map(({ folder, names }) => ({
      folder,
      listed: [{ dir: join(routesDir, ...folder.split("/")), names }],
    })),
  ];
  for (const { folder, listed } of folders) {
    for (const { base, kind } of IMAGE_CONVENTIONS) {
      const modules = listed.flatMap(({ dir, names }) =>
        names
          .filter((name) => MODULE_EXTENSIONS.some((extension) => name === `${base}${extension}`))
          .map((name) => join(dir, name)),
      );
      const [module, otherModule] = modules;
      if (otherModule !== undefined) {
        throw new ConventionError(
          `two files define the ${base} convention: ${module} and ${otherModule}.`,
        );
      }
      if (module !== undefined) {
        found.push(dynamicImage(kind, base, folder, module, add));
        continue;
      }
      const candidates = listed.flatMap(({ dir, names }) =>
        names
          .filter((name) => IMAGE_EXTENSIONS.some((extension) => name === `${base}${extension}`))
          .map((name) => ({ dir, names, name })),
      );
      const [first, second] = candidates;
      if (first === undefined) continue;
      if (second !== undefined) {
        throw new ConventionError(
          `two files define the ${base} convention: ${join(first.dir, first.name)} and ${join(second.dir, second.name)}.`,
        );
      }
      const file = join(first.dir, first.name);
      const bytes = readFileSync(file);
      if (bytes.byteLength > MAX_STATIC_BYTES) {
        throw new ConventionError(
          `${file} is ${bytes.byteLength} bytes; a ${base} file is embedded and must be 256 KiB or less.`,
        );
      }
      const header = readImageHeader(bytes);
      if (!header.ok) {
        throw new ConventionError(`${file} cannot be used as a ${base} image: ${header.reason}.`);
      }
      const path = `${folderUrl(folder, file)}/${first.name}`;
      if (isPrivatePattern(path)) {
        throw new ConventionError(
          `${file} sits in a private route folder (a name starting with _): a private route is never served, so it cannot carry a ${base} image.`,
        );
      }
      add(base, file, path, staticWrapper(new Uint8Array(bytes), header.type));
      const alt = altTextOf(first.names, first.dir, base);
      found.push({
        kind,
        folder,
        file,
        image: {
          path,
          // Short on purpose: it only has to change when the bytes do (the URL of the tag carries it).
          hash: createHash("sha256").update(bytes).digest("hex").slice(0, 8),
          type: header.type,
          width: header.width,
          height: header.height,
          ...(alt === undefined ? {} : { alt }),
        },
      });
    }
  }
  return found;
}

/**
 * Finds the conventions of the source folder and the API routes they become.
 *
 * @param srcDir The absolute source folder (`src`).
 * @param existing The API routes the router already has (their `fullPath`): a convention may not clash with one.
 * @param routesDir The absolute routes folder, searched for static `opengraph-image` and `twitter-image` files
 *   (default `<srcDir>/routes`).
 * @returns The routes, the wrapper modules and the static metadata images.
 * @throws ConventionError for two files of one convention, a URL two routes want, a static file over 256 KiB, or an
 *   image whose header cannot be read.
 * @since 1.0.0
 * @example (await discoverConventions("/app/src", [])).entries.map((entry) => entry.fullPath); // ["/sitemap.xml", "/robots.txt"]
 */
export async function discoverConventions(
  srcDir: string,
  existing: readonly { readonly fullPath: string }[],
  routesDir: string = join(srcDir, "routes"),
): Promise<ConventionScan> {
  const seen = new Map<string, string>();
  const entries: ConventionEntry[] = [];
  const sources = new Map<string, string>();
  const images: ConventionImage[] = [];
  const taken = new Set(existing.map((route) => route.fullPath));
  const add = (convention: string, file: string, url: string, source: string): void => {
    if (taken.has(url)) {
      throw new ConventionError(
        `${convention} (${file}) is served at ${url}, which another route already answers. Remove one of them.`,
      );
    }
    taken.add(url);
    const id = `${CONVENTION_PREFIX}${entries.length}`;
    sources.set(id, source);
    entries.push({
      // Unique per URL (two routes can share a convention: the sitemap index and its per-id sitemap).
      id: `convention:${url}`,
      file,
      absolutePath: id,
      fullPath: url,
      methods: ["GET"],
      matchFilters: false,
      private: false,
    });
  };
  for (const name of filesOf(srcDir)) {
    const extension = extname(name);
    const base = name.slice(0, name.length - extension.length);
    const file = join(srcDir, name);
    const claim = seen.get(base);
    if (MODULE_CONVENTIONS[base] !== undefined && MODULE_EXTENSIONS.includes(extension)) {
      if (claim !== undefined)
        throw new ConventionError(`two files define the ${base} convention: ${claim} and ${file}.`);
      seen.set(base, file);
      const { url, kind } = MODULE_CONVENTIONS[base] ?? { url: "", kind: "" };
      const code = readFileSync(file, "utf8");
      if (base === "sitemap" && GENERATE_SITEMAPS.test(code)) {
        // generateSitemaps: an index at /sitemap.xml and one sitemap per id at /sitemap/<id>.xml.
        add("sitemap", file, url, moduleWrapper("sitemap-index", file));
        add("sitemap", file, "/sitemap/:id", moduleWrapper("sitemap-id", file));
      } else {
        add(base, file, url, moduleWrapper(kind, file));
      }
      continue;
    }
    const statics = STATIC_CONVENTIONS[base];
    if (statics?.extensions.includes(extension)) {
      if (claim !== undefined)
        throw new ConventionError(`two files define the ${base} convention: ${claim} and ${file}.`);
      seen.set(base, file);
      const bytes = readFileSync(file);
      if (bytes.byteLength > MAX_STATIC_BYTES) {
        throw new ConventionError(
          `${file} is ${bytes.byteLength} bytes; a ${base} file is embedded and must be 256 KiB or less.`,
        );
      }
      add(
        base,
        file,
        statics.url,
        staticWrapper(new Uint8Array(bytes), MIME[extension] ?? "application/octet-stream"),
      );
    }
  }
  images.push(...(await discoverImages(srcDir, routesDir, add)));
  return { entries, sources, images };
}
