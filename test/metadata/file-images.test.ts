import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HeadTag } from "@shadow-js/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileImage, FileImages, FileImagesHook } from "../../src/metadata/file-images";
import {
  type ChainRoute,
  chainHead,
  type ResolvedChain,
  resolveChain,
} from "../../src/metadata/resolve";
import { FILE_IMAGES_MODULE } from "../../src/vite/file-images";

/**
 * Static `opengraph-image` and `twitter-image` files in the chain: a route carries the hook the build made from the
 * images it found for its folder (`fileImages`; the hook is made by the very module text the build serves as
 * `virtual:dusk/file-images`, loaded here from a file), and the tags are the ones Next writes for its metadata image files, with the file's size,
 * type and alt text and the content hash on the URL. An image the layer sets itself (`openGraph.images`,
 * `twitter.images`) wins over the file of the same folder; the layer nearest the page wins over the ones above it.
 */

const NO_SEARCH = { search: {} } as const;
const BASE = "https://malaf.dev";

function png(path: string, overrides: Partial<FileImage> = {}): FileImage {
  return { path, hash: "a1b2c3d4", type: "image/png", width: 1200, height: 630, ...overrides };
}

let makeHook: (files: FileImages) => FileImagesHook;
let scratch: string;
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "dusk-file-images-module-"));
  const file = join(scratch, "file-images.mjs");
  writeFileSync(file, FILE_IMAGES_MODULE);
  const loaded: { default: typeof makeHook } = await import(pathToFileURL(file).href);
  makeHook = loaded.default;
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A route with only the given exports; `fileImages` is the data the build found, made into the hook as the tree does. */
function route(
  id: string,
  exports: Omit<Partial<ChainRoute>, "fileImages"> & { fileImages?: FileImages } = {},
): ChainRoute {
  const { fileImages, ...rest } = exports;
  return {
    id,
    params: {},
    loaderData: undefined,
    ...rest,
    ...(fileImages === undefined ? {} : { fileImages: makeHook(fileImages) }),
  };
}

function resolved(
  routes: readonly ChainRoute[],
  errors: unknown[] = [],
): ResolvedChain | Promise<ResolvedChain> {
  return resolveChain(routes, NO_SEARCH, (error) => errors.push(error));
}

function head(routes: readonly ChainRoute[], errors: unknown[] = []): HeadTag[] {
  const chain = resolved(routes, errors);
  if (chain instanceof Promise) throw new TypeError("expected a synchronous chain");
  return chainHead(chain).tags;
}

/** The `[property or name, content]` pairs of the meta tags whose key starts with a prefix, in document order. */
function pairs(tags: readonly HeadTag[], prefix: string): [string, string][] {
  const out: [string, string][] = [];
  for (const tag of tags) {
    if (tag.tag !== "meta") continue;
    const key = tag.props?.["property"] ?? tag.props?.["name"];
    const content = tag.props?.["content"];
    if (typeof key === "string" && typeof content === "string" && key.startsWith(prefix)) {
      out.push([key, content]);
    }
  }
  return out;
}

const root = route("/_layout", { metadata: { metadataBase: BASE } });

describe("file images: the tags of a static image", () => {
  it("[MD-FIL-01] an opengraph image writes og:image with its hash, type, width, height and alt", () => {
    const page = route("/", {
      fileImages: {
        openGraph: png("/opengraph-image.png", { alt: "A red bicycle against a wall" }),
      },
    });
    expect(pairs(head([root, page]), "og:image")).toEqual([
      ["og:image", "https://malaf.dev/opengraph-image.png?a1b2c3d4"],
      ["og:image:type", "image/png"],
      ["og:image:width", "1200"],
      ["og:image:height", "630"],
      ["og:image:alt", "A red bicycle against a wall"],
    ]);
  });

  it("[MD-FIL-02] without an alt file there is no og:image:alt", () => {
    const page = route("/", { fileImages: { openGraph: png("/opengraph-image.png") } });
    expect(pairs(head([root, page]), "og:image:alt")).toEqual([]);
  });

  it("[MD-FIL-03] a twitter image writes twitter:image with its alt, type, width and height, and no og:image", () => {
    const page = route("/", {
      fileImages: {
        twitter: png("/twitter-image.png", {
          alt: "Card art",
          type: "image/jpeg",
          width: 800,
          height: 418,
        }),
      },
    });
    const tags = head([root, page]);
    expect(pairs(tags, "twitter:image")).toEqual([
      ["twitter:image", "https://malaf.dev/twitter-image.png?a1b2c3d4"],
      ["twitter:image:alt", "Card art"],
      ["twitter:image:type", "image/jpeg"],
      ["twitter:image:width", "800"],
      ["twitter:image:height", "418"],
    ]);
    expect(pairs(tags, "og:image")).toEqual([]);
  });

  it("[MD-FIL-04] an opengraph image alone is the Twitter card's image too, with its alt, as Next's fallback does", () => {
    const page = route("/", {
      fileImages: { openGraph: png("/opengraph-image.png", { alt: "Shared" }) },
    });
    const tags = head([root, page]);
    expect(pairs(tags, "twitter:image")).toContainEqual(["twitter:image:alt", "Shared"]);
    expect(pairs(tags, "twitter:image")[0]).toEqual([
      "twitter:image",
      "https://malaf.dev/opengraph-image.png?a1b2c3d4",
    ]);
  });

  it("[MD-FIL-05] the other fields of the merged openGraph stay: the file adds the image and nothing else changes", () => {
    const layout = route("/_layout", {
      metadata: { metadataBase: BASE, openGraph: { title: "Malaf", siteName: "Malaf" } },
    });
    const page = route("/", { fileImages: { openGraph: png("/opengraph-image.png") } });
    const tags = head([layout, page]);
    expect(pairs(tags, "og:title")).toEqual([["og:title", "Malaf"]]);
    expect(pairs(tags, "og:site_name")).toEqual([["og:site_name", "Malaf"]]);
    expect(pairs(tags, "og:image")[0]).toEqual([
      "og:image",
      "https://malaf.dev/opengraph-image.png?a1b2c3d4",
    ]);
  });
});

describe("file images: what wins", () => {
  it("[MD-FIL-06] an image the layer sets itself wins over the file of its own folder", () => {
    const page = route("/", {
      metadata: { openGraph: { images: ["/own.png"] }, twitter: { images: ["/own-card.png"] } },
      fileImages: { openGraph: png("/opengraph-image.png"), twitter: png("/twitter-image.png") },
    });
    const tags = head([root, page]);
    expect(pairs(tags, "og:image")).toEqual([["og:image", "https://malaf.dev/own.png"]]);
    expect(pairs(tags, "twitter:image")).toEqual([
      ["twitter:image", "https://malaf.dev/own-card.png"],
    ]);
  });

  it("[MD-FIL-07] a layer that sets openGraph without images still gets the file's image (Next's rule)", () => {
    const page = route("/", {
      metadata: { openGraph: { title: "Docs" } },
      fileImages: { openGraph: png("/opengraph-image.png") },
    });
    const tags = head([root, page]);
    expect(pairs(tags, "og:title")).toEqual([["og:title", "Docs"]]);
    expect(pairs(tags, "og:image")[0]?.[1]).toBe("https://malaf.dev/opengraph-image.png?a1b2c3d4");
  });

  it("[MD-FIL-08] the file replaces the images the layers above set (a nested folder overrides the root)", () => {
    const layout = route("/_layout", {
      metadata: { metadataBase: BASE, openGraph: { images: ["/site.png"] } },
    });
    const blog = route("/blog/_layout", {
      fileImages: { openGraph: png("/blog/opengraph-image.png", { width: 1100 }) },
    });
    const tags = head([layout, blog]);
    expect(pairs(tags, "og:image")).toEqual([
      ["og:image", "https://malaf.dev/blog/opengraph-image.png?a1b2c3d4"],
      ["og:image:type", "image/png"],
      ["og:image:width", "1100"],
      ["og:image:height", "630"],
    ]);
  });

  it("[MD-FIL-09] the layer nearest the page wins when two layers carry an image", () => {
    const outer = route("/_layout", {
      metadata: { metadataBase: BASE },
      fileImages: { openGraph: png("/opengraph-image.png") },
    });
    const inner = route("/blog/_layout", {
      fileImages: { openGraph: png("/blog/opengraph-image.png") },
    });
    expect(pairs(head([outer, inner]), "og:image")[0]?.[1]).toBe(
      "https://malaf.dev/blog/opengraph-image.png?a1b2c3d4",
    );
    expect(pairs(head([inner, outer]), "og:image")[0]?.[1]).toBe(
      "https://malaf.dev/opengraph-image.png?a1b2c3d4",
    );
  });

  it("[MD-FIL-10] a route without static images leaves the merged metadata as it was", () => {
    const page = route("/", { metadata: { title: "Plain" } });
    expect(pairs(head([root, page]), "og:")).toEqual([]);
    expect(pairs(head([root, page]), "twitter:")).toEqual([]);
  });
});

describe("file images: the URL", () => {
  it("[MD-FIL-11] the params of the route fill the dynamic segments of the folder (encoded)", () => {
    const page = route("/blog/:slug", {
      params: { slug: "a b" },
      fileImages: { openGraph: png("/blog/:slug/opengraph-image.png") },
    });
    expect(pairs(head([root, page]), "og:image")[0]?.[1]).toBe(
      "https://malaf.dev/blog/a%20b/opengraph-image.png?a1b2c3d4",
    );
  });

  it("[MD-FIL-12] an optional segment that has no value is left out", () => {
    const page = route("/", { fileImages: { twitter: png("/:lang?/twitter-image.png") } });
    expect(pairs(head([root, page]), "twitter:image")[0]?.[1]).toBe(
      "https://malaf.dev/twitter-image.png?a1b2c3d4",
    );
  });

  it("[MD-FIL-13] a required param that is missing is reported with the route, and the layer writes no image", () => {
    const errors: unknown[] = [];
    const page = route("/blog/:slug", {
      fileImages: { openGraph: png("/blog/:slug/opengraph-image.png") },
    });
    expect(pairs(head([root, page], errors), "og:image")).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/slug/);
  });

  it("[MD-FIL-14] without a metadataBase the URL is the path and the hash", () => {
    const page = route("/", { fileImages: { openGraph: png("/opengraph-image.png") } });
    expect(pairs(head([page]), "og:image")[0]?.[1]).toBe("/opengraph-image.png?a1b2c3d4");
  });
});

describe("file images: a dynamic image module", () => {
  it("[MD-FIL-17] a dynamic image's tags point at the page's own URL, with the module's literal size, type and alt", () => {
    const page = route("/shop/:slug", {
      params: { slug: "cafe" },
      fileImages: {
        openGraph: png("/shop/:slug/opengraph-image", {
          hash: "0f0e0d0c",
          width: 600,
          height: 315,
          alt: "Shop card",
        }),
      },
    });
    const tags = head([root, page]);
    expect(pairs(tags, "og:image")).toEqual([
      ["og:image", "https://malaf.dev/shop/cafe/opengraph-image?0f0e0d0c"],
      ["og:image:type", "image/png"],
      ["og:image:width", "600"],
      ["og:image:height", "315"],
      ["og:image:alt", "Shop card"],
    ]);
  });

  it("[MD-FIL-18] a dynamic image without an alt text writes no alt tag, and its default size is still written", () => {
    const page = route("/shop/:slug", {
      params: { slug: "cafe" },
      fileImages: { twitter: png("/shop/:slug/twitter-image", { hash: "11223344" }) },
    });
    const tags = head([root, page]);
    expect(pairs(tags, "twitter:image:alt")).toEqual([]);
    expect(pairs(tags, "twitter:image")[0]?.[1]).toBe(
      "https://malaf.dev/shop/cafe/twitter-image?11223344",
    );
    expect(pairs(tags, "twitter:image:width")[0]?.[1]).toBe("1200");
  });
});

describe("file images: with generators", () => {
  it("[MD-FIL-15] a generateMetadata that returns a promise still gets the file image added", async () => {
    const page = route("/", {
      generateMetadata: async () => ({ openGraph: { title: "Async" } }),
      fileImages: { openGraph: png("/opengraph-image.png") },
    });
    const chain = await resolved([root, page]);
    const tags = chainHead(chain).tags;
    expect(pairs(tags, "og:title")).toEqual([["og:title", "Async"]]);
    expect(pairs(tags, "og:image")[0]?.[1]).toBe("https://malaf.dev/opengraph-image.png?a1b2c3d4");
  });

  it("[MD-FIL-16] a generateMetadata that sets images wins over the file, and one that throws contributes nothing, file image included", () => {
    const own = route("/", {
      generateMetadata: () => ({ openGraph: { images: ["/generated.png"] } }),
      fileImages: { openGraph: png("/opengraph-image.png") },
    });
    expect(pairs(head([root, own]), "og:image")).toEqual([
      ["og:image", "https://malaf.dev/generated.png"],
    ]);
    const errors: unknown[] = [];
    const failing = route("/", {
      generateMetadata: () => {
        throw new Error("boom");
      },
      fileImages: { openGraph: png("/opengraph-image.png") },
    });
    // The layer's own function failed: it is reported and the layer adds nothing, as for any other export.
    expect(pairs(head([root, failing], errors), "og:image")).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
