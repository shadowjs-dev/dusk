import type { HydrationData, HydrationMatch } from "@shadow-js/router";
import { serializeHydrationData } from "@shadow-js/router";
import { escape as escapeHtml, ssrAttribute } from "@shadow-js/web/server";
import { FLASH_ELEMENT_ID } from "../shared/action";
import type { DuskRuntimeManifest } from "./types";

/** Id of the element that carries the router's hydration data. @since 1.0.0 */
export const ROUTER_PAYLOAD_ID = "__shadow_router";

const SAFE_URL = /^(?:\/(?!\/)|https?:\/\/)[^\s"'<>\\`]*$/;
const MAX_LINKS = 16;
const MAX_LINK_HEADER = 4096;

/** A resource the page loads, resolved to a URL. @internal */
export interface AssetLink {
  readonly href: string;
  readonly rel: "modulepreload" | "stylesheet" | "preload";
  readonly as?: "style" | "font" | "script" | "image";
}

/** Resolves a manifest asset path against the asset base. Unsafe values give `undefined`. */
function resolveAsset(path: string, base: string): string | undefined {
  if (path === "") return undefined;
  const joined = /^(?:\/|https?:\/\/)/.test(path)
    ? path
    : `${base.endsWith("/") ? base : `${base}/`}${path}`;
  return SAFE_URL.test(joined) ? joined : undefined;
}

function linkFor(href: string): AssetLink {
  const pathname = href.split(/[?#]/, 1)[0] ?? href;
  if (pathname.endsWith(".css")) return { href, rel: "preload", as: "style" };
  if (/\.(?:woff2?|ttf|otf)$/.test(pathname)) return { href, rel: "preload", as: "font" };
  return { href, rel: "modulepreload" };
}

/**
 * The assets a page needs: the entry, the stylesheets, and the preloads of the matched routes.
 * Duplicates and unsafe URLs are dropped.
 *
 * @param assets The manifest's asset section.
 * @param routeIds Ids of the matched routes.
 * @returns The stylesheets and the preload links, in load order.
 * @internal
 */
export function collectAssets(
  assets: DuskRuntimeManifest["assets"],
  routeIds: readonly string[],
): {
  readonly entry: string | undefined;
  readonly stylesheets: string[];
  readonly preloads: AssetLink[];
} {
  const entry = resolveAsset(assets.entry, assets.base);
  const stylesheets = [...new Set(assets.css.map((css) => resolveAsset(css, assets.base)))].filter(
    (href): href is string => href !== undefined,
  );
  const seen = new Set<string>([...(entry === undefined ? [] : [entry]), ...stylesheets]);
  const preloads: AssetLink[] = [];
  for (const id of routeIds) {
    const listed = Object.hasOwn(assets.preloads, id) ? assets.preloads[id] : undefined;
    for (const path of listed ?? []) {
      const href = resolveAsset(path, assets.base);
      if (href === undefined || seen.has(href)) continue;
      seen.add(href);
      const link = linkFor(href);
      // Route CSS must apply to the server markup before the route's JavaScript loads.
      if (link.as === "style") stylesheets.push(href);
      else preloads.push(link);
    }
  }
  return { entry, stylesheets, preloads };
}

/**
 * The `Link` response header for the assets: the entry and the preloads, so the browser starts
 * fetching before it has parsed the document. Bounded to 16 entries and 4 KiB.
 *
 * @param entry The entry script URL.
 * @param stylesheets Stylesheet URLs.
 * @param preloads Route preloads.
 * @returns The header value, or `undefined` when there is nothing to send.
 * @internal
 */
export function buildLinkHeader(
  entry: string | undefined,
  stylesheets: readonly string[],
  preloads: readonly AssetLink[],
): string | undefined {
  const links: AssetLink[] = [
    ...stylesheets.map((href): AssetLink => ({ href, rel: "preload", as: "style" })),
    ...(entry === undefined ? [] : [{ href: entry, rel: "modulepreload" } as const]),
    ...preloads,
  ];
  const parts: string[] = [];
  let length = 0;
  for (const link of links.slice(0, MAX_LINKS)) {
    const part = `<${link.href}>; rel=${link.rel}${link.as === undefined ? "" : `; as=${link.as}`}${link.as === "font" ? "; crossorigin" : ""}`;
    if (length + part.length + 2 > MAX_LINK_HEADER) break;
    parts.push(part);
    length += part.length + 2;
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Serializes hydration data for the page, dropping what does not fit: a match whose loader data
 * cannot be written as JSON, and matches beyond `maxBytes`. The client loads a dropped match
 * itself, so the page still works.
 *
 * @param data The router's dehydrated state.
 * @param maxBytes Size budget for the script content.
 * @returns The script text and the ids that were dropped.
 * @internal
 */
export function buildPayload(
  data: HydrationData,
  maxBytes: number,
): {
  readonly text: string;
  readonly dropped: readonly string[];
  readonly errors: readonly unknown[];
} {
  const kept: HydrationMatch[] = [];
  const dropped: string[] = [];
  const errors: unknown[] = [];
  let used = serializeHydrationData({ version: 1, matches: [] }).length;
  for (const match of data.matches) {
    let size: number;
    try {
      size = serializeHydrationData({ version: 1, matches: [match] }).length;
    } catch (error) {
      errors.push(error);
      dropped.push(match.id);
      continue;
    }
    if (used + size > maxBytes) {
      dropped.push(match.id);
      continue;
    }
    used += size;
    kept.push(match);
  }
  return { text: serializeHydrationData({ version: 1, matches: kept }), dropped, errors };
}

/** Inputs of the document shell. @internal */
export interface ShellInput {
  readonly lang: string;
  readonly dir: "ltr" | "rtl" | "auto" | undefined;
  readonly rootId: string;
  /** Runtime URL policy inherited by the browser router, including custom server entries. */
  readonly trailingSlash?: "never" | "always" | "preserve";
  /** `class` of `<body>` (see `DocumentOptions.bodyClass`). */
  readonly bodyClass?: string | undefined;
  /** Markup of the head tags the render collected (`createServerHead().html()`). */
  readonly headHtml: string;
  readonly extraHead: string;
  readonly nonce: string | undefined;
  readonly stylesheets: readonly string[];
  readonly preloads: readonly AssetLink[];
  readonly entry: string | undefined;
  readonly payload: string | undefined;
  /** Serialized flash payload of the page (a submission outcome or a `setFlash` value), read once by the browser. */
  readonly flash?: string | undefined;
  /** Markup of the portals the render produced (`ServerPortals.html()`), emitted at the end of the body. */
  readonly portals?: string;
  /** JSON-LD texts (already escaped by `jsonLdText`), one `<script type="application/ld+json">` each. */
  readonly jsonLd?: readonly string[];
}

/**
 * The document around the app markup: everything up to and including the opening of the root
 * element, and everything after it. The app markup (or a stream of it) goes between them.
 *
 * @param input Language, head, assets and payload.
 * @returns The two halves.
 * @internal
 */
export function buildShell(input: ShellInput): {
  readonly prefix: string;
  readonly suffix: string;
} {
  const nonceAttribute = input.nonce === undefined ? "" : ssrAttribute("nonce", input.nonce);
  const links =
    input.stylesheets
      .map((href) => `<link rel="stylesheet"${ssrAttribute("href", href)}>`)
      .join("") +
    input.preloads
      .map(
        (link) =>
          `<link rel="${link.rel}"${ssrAttribute("href", link.href)}${link.as === undefined ? "" : ` as="${link.as}"`}${link.as === "font" ? " crossorigin" : ""}>`,
      )
      .join("");
  const payload =
    input.payload === undefined
      ? ""
      : `<script type="application/json" id="${ROUTER_PAYLOAD_ID}">${input.payload}</script>`;
  const flash =
    input.flash === undefined
      ? ""
      : `<script type="application/json" id="${FLASH_ELEMENT_ID}">${input.flash}</script>`;
  const entry =
    input.entry === undefined
      ? ""
      : `<script type="module"${ssrAttribute("src", input.entry)}${nonceAttribute}></script>`;
  // Structured data is a script, which the head registry refuses: it takes the nonce here instead. The mark
  // lets the client find and replace these scripts after hydration (see `metadata/feature.ts`).
  const jsonLd = (input.jsonLd ?? [])
    .map(
      (text) =>
        `<script type="application/ld+json" data-shadow-jsonld${nonceAttribute}>${text}</script>`,
    )
    .join("");
  const dir = input.dir === undefined ? "" : ` dir="${input.dir}"`;
  // The declaration is the first head element, so a copy served with no charset in its Content-Type still decodes
  // the same way (a prerendered file on a static host). A head that already declares one keeps its own, once.
  const charset = /<meta\s+charset=/i.test(input.headHtml) ? "" : '<meta charset="utf-8">';
  const trailingSlash =
    input.trailingSlash === undefined || input.trailingSlash === "never"
      ? ""
      : ssrAttribute("data-dusk-trailing-slash", input.trailingSlash);
  const prefix =
    `<!doctype html><html lang="${escapeHtml(input.lang)}"${dir}><head>` +
    charset +
    input.headHtml +
    jsonLd +
    links +
    input.extraHead +
    payload +
    flash +
    entry +
    `</head><body${input.bodyClass === undefined ? "" : ssrAttribute("class", input.bodyClass)}><div id="${escapeHtml(input.rootId)}"${trailingSlash}>`;
  return { prefix, suffix: `</div>${input.portals ?? ""}</body></html>` };
}
