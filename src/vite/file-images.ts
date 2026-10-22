import type { FileImage, FileImages } from "../metadata/file-images";
import { ConventionError, type ConventionImage } from "./conventions";

/**
 * Gives the static `opengraph-image` and `twitter-image` files of the convention scan to the routes they apply to, and
 * writes them into the generated route tree, where both the server and the browser read them. Build time only (Node).
 * The code that adds them to a route's metadata is a virtual module (`FILE_IMAGES_ID`) that only an app with such files
 * imports.
 *
 * Next puts a segment's image files in that segment's metadata, and the segments of a page are merged outermost first, so
 * the folder nearest the page wins. The routes here are files, and a folder without a `_layout` is not a layer of the
 * chain. So each image goes to one route per chain: the first route of the chain that lives inside the image's folder
 * (the folder's own layout when it has one). The nearest folder with an image of the kind decides which image a route
 * would carry; the route carries it only when it is the first of its chain inside that folder.
 */

/**
 * The id of the virtual module that holds the code which adds the images to the metadata of a route.
 * @since 1.0.0
 */
export const FILE_IMAGES_ID = "virtual:dusk/file-images";

/** The name the generated route tree gives to the default export of {@link FILE_IMAGES_ID}. */
const HOOK = "__duskFileImages";

/**
 * The source of {@link FILE_IMAGES_ID}: a default export that takes a route's images and returns the hook the metadata
 * chain calls (`FileImagesHook`, see `metadata/file-images.ts`). It is plain JavaScript in a string so that only an app
 * with such files imports it: the metadata code every app ships has no part of it. Its behavior is tested by loading this
 * very text (test/metadata/file-images.test.ts).
 *
 * The rule is Next's for metadata image files: a block whose `images` the route's own metadata set stays as set, any other
 * block gets the file's image as its only image. The dynamic segments of the image's folder are filled from the route's
 * params (an optional one without a value is left out, a required one without a value is reported through `onError`).
 * @since 1.0.0
 */
export const FILE_IMAGES_MODULE = `const fill = (path, params, id) => {
  if (!path.includes(":")) return path;
  const parts = [];
  for (const part of path.split("/").slice(1)) {
    if (part.charAt(0) !== ":") {
      parts.push(part);
      continue;
    }
    const optional = part.endsWith("?");
    const value = params[part.slice(1, optional ? -1 : undefined)];
    if (value === undefined || value === "") {
      if (optional) continue;
      throw new RangeError('route "' + id + '": the metadata image ' + path + " needs a value for every param of its folder.");
    }
    parts.push(encodeURIComponent(value));
  }
  return "/" + parts.join("/");
};
const setsImages = (block) => typeof block === "object" && block !== null && Object.hasOwn(block, "images");
export default (files) => (merged, own, params, id, onError) => {
  const metadata = { ...merged.metadata };
  try {
    for (const key of ["openGraph", "twitter"]) {
      const image = files[key];
      if (image === undefined || setsImages(own[key])) continue;
      const descriptor = { url: fill(image.path, params, id) + "?" + image.hash, type: image.type, width: image.width, height: image.height };
      if (image.alt !== undefined) descriptor.alt = image.alt;
      metadata[key] = { ...metadata[key], images: [descriptor] };
    }
  } catch (error) {
    onError(error, id);
    return merged;
  }
  return { ...merged, metadata };
};
`;

/**
 * The part of a route entry this module reads (the router's `RouteEntry` has it).
 * @since 1.0.0
 */
export interface ImageRouteEntry {
  readonly id: string;
  /** The file relative to the routes folder, POSIX separators. */
  readonly file: string;
  readonly parentId: string | undefined;
}

/**
 * The folder a route file stands for in the image rules. That is its own folder, except for a page whose file is named
 * after a segment: `blog/[slug].tsx` is the segment `blog/[slug]` (the page at it), so it takes the image of that folder,
 * as Next gives the page of a segment the image of the segment's folder. An index, a layout and a template stand for
 * their folder.
 */
function segmentOf(file: string): string {
  const slash = file.lastIndexOf("/");
  const folder = slash === -1 ? "" : file.slice(0, slash);
  const name = file.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (stem === "index" || stem === "_layout" || stem === "_template") return folder;
  return folder === "" ? stem : `${folder}/${stem}`;
}

/** True when `folder` is `container` or inside it. */
function isInside(folder: string, container: string): boolean {
  return container === "" || folder === container || folder.startsWith(`${container}/`);
}

/** The path of a tag's URL: static segments percent-encoded, the `:param` segments left for the hook to fill. */
function encodedPath(path: string): string {
  return path
    .split("/")
    .map((part) => (part.startsWith(":") ? part : encodeURIComponent(part)))
    .join("/");
}

/**
 * The static images that each route carries.
 *
 * @param images The images the convention scan found.
 * @param entries The routes of the scan (pages and layouts).
 * @param base The mount base without a trailing slash (`""` or `/app`), put in front of every image path.
 * @returns The images by route id; a route that carries none is absent.
 * @since 1.0.0
 * @example
 * attachFileImages(scan.images, routeScan.entries, "").get("/_layout")?.openGraph?.path; // "/opengraph-image.png"
 */
export function attachFileImages(
  images: readonly ConventionImage[],
  entries: readonly ImageRouteEntry[],
  base: string,
): Map<string, FileImages> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const out = new Map<string, FileImages>();
  for (const entry of entries) {
    // The chain from the outermost route to this one. The parent links form a tree; the bound keeps a corrupt scan finite.
    const chain: ImageRouteEntry[] = [];
    for (
      let at: ImageRouteEntry | undefined = entry;
      at !== undefined && chain.length <= entries.length;
      at = at.parentId === undefined ? undefined : byId.get(at.parentId)
    ) {
      chain.unshift(at);
    }
    const folder = segmentOf(entry.file);
    let carried: { openGraph?: FileImage; twitter?: FileImage } | undefined;
    for (const kind of ["openGraph", "twitter"] as const) {
      let nearest: ConventionImage | undefined;
      for (const candidate of images) {
        if (candidate.kind !== kind || !isInside(folder, candidate.folder)) continue;
        if (nearest === undefined || candidate.folder.length > nearest.folder.length)
          nearest = candidate;
      }
      if (nearest === undefined) continue;
      const holder = nearest.folder;
      const owner = chain.find((item) => isInside(segmentOf(item.file), holder));
      if (owner?.id !== entry.id) continue;
      carried = {
        ...carried,
        [kind]: { ...nearest.image, path: `${base}${encodedPath(nearest.image.path)}` },
      };
    }
    if (carried !== undefined) out.set(entry.id, carried);
  }
  return out;
}

/** The line the generator writes right after the opening of each route: its id. */
const ID_LINE = /^ {2}id: ("(?:[^"\\]|\\.)*"),$/gm;

/**
 * Writes the static images into the text of the generated route tree: each route that carries some gets a
 * `fileImages` property in its definition, right after its `id`, made by the default export of
 * {@link FILE_IMAGES_ID} (imported on the first line). The tree on disk is left as the generator wrote it (the file is
 * only changed in the module graph), so editors and `tsc` see the plain tree.
 *
 * @param code The text of the generated route tree.
 * @param attached The images by route id (see {@link attachFileImages}).
 * @returns The text with the property added; the code itself when there is nothing to add.
 * @throws ConventionError when a route that carries images is not found in the text (the generator's format changed).
 * @since 1.0.0
 */
export function injectFileImages(code: string, attached: ReadonlyMap<string, FileImages>): string {
  if (attached.size === 0) return code;
  const seen = new Set<string>();
  const out = code.replace(ID_LINE, (line, quoted: string) => {
    let id: unknown;
    try {
      id = JSON.parse(quoted);
    } catch (error) {
      throw new ConventionError(`the route tree has an id that is not a string: ${quoted}.`, {
        cause: error,
      });
    }
    const files = typeof id === "string" ? attached.get(id) : undefined;
    if (typeof id !== "string" || files === undefined) return line;
    seen.add(id);
    return `${line}\n  fileImages: ${HOOK}(${JSON.stringify(files)}),`;
  });
  const missing = [...attached.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new ConventionError(
      `the route tree has no definition for ${missing.map((id) => JSON.stringify(id)).join(", ")}, so its metadata image cannot be attached.`,
    );
  }
  return `import ${HOOK} from ${JSON.stringify(FILE_IMAGES_ID)};\n${out}`;
}
