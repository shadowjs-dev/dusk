import { describe, expect, it } from "vitest";
import { searchRecord } from "../../src/metadata/feature";
import {
  type ChainRoute,
  chainHead,
  checkedHeaders,
  metaDescriptorTags,
  resolveChain,
} from "../../src/metadata/resolve";
import type { Metadata } from "../../src/metadata/types";

const NO_SEARCH = { search: {} } as const;

/** A route with only the given exports, and no params or data. */
function route(id: string, exports: Partial<ChainRoute> = {}): ChainRoute {
  return { id, params: {}, loaderData: undefined, ...exports };
}

describe("resolveChain: the request's pathname (Next's pathname of a page)", () => {
  it("[MD-RES-06] the pathname of the chain resolves a './' canonical inherited from the root layout", () => {
    const layout = route("root", {
      metadata: { metadataBase: "https://malaf.dev", alternates: { canonical: "./" } },
    });
    const page = route("sign-in", { metadata: { title: "Sign in" } });
    const chain = resolveChain(
      [layout, page],
      { search: {}, pathname: "/sign-in" },
      () => undefined,
    );
    expect(chainHead(chain as never).tags).toContainEqual({
      tag: "link",
      props: { rel: "canonical", href: "https://malaf.dev/sign-in" },
    });
  });
});

describe("resolveChain: layers and arguments", () => {
  it("[MD-RES-01] layers merge outermost first and the page's title is wrapped in the layout's template", () => {
    const chain = resolveChain(
      [
        route("root", {
          metadata: { title: { default: "Malaf", template: "%s · Malaf" }, description: "Root" },
        }),
        route("docs", { metadata: { title: "Docs" } }),
      ],
      NO_SEARCH,
      () => undefined,
    );
    expect(chain).not.toBeInstanceOf(Promise);
    if (chain instanceof Promise) return;
    expect(chain.metadata.title).toBe("Docs · Malaf");
    expect(chain.metadata.description).toBe("Root");
  });

  it("[MD-RES-02] generateMetadata gets params, the raw search, the loader data and the parent metadata", () => {
    const seen: unknown[] = [];
    const chain = resolveChain(
      [
        route("root", { metadata: { title: "Root", description: "d" } }),
        route("post", {
          params: { id: "42" },
          loaderData: { title: "Post 42" },
          generateMetadata: (args) => {
            seen.push(args.params, args.search, args.loaderData, args.parent.title);
            return {
              title: `${args.parent.title ?? ""} / ${(args.loaderData as { title: string }).title}`,
            };
          },
        }),
      ],
      { search: { q: ["a", "b"], page: "2" } },
      () => undefined,
    );
    if (chain instanceof Promise) throw new Error("expected a synchronous result");
    expect(seen).toEqual([
      { id: "42" },
      { q: ["a", "b"], page: "2" },
      { title: "Post 42" },
      "Root",
    ]);
    expect(chain.metadata.title).toBe("Root / Post 42");
    expect(chain.metadata.description).toBe("d");
  });

  it("[MD-RES-03] a route that exports both metadata and generateMetadata is reported, and its layer contributes nothing", () => {
    const errors: Array<{ error: unknown; id: string }> = [];
    const chain = resolveChain(
      [
        route("both", {
          metadata: { description: "static" },
          generateMetadata: () => ({ description: "dynamic" }),
        }),
      ],
      NO_SEARCH,
      (error, id) => errors.push({ error, id }),
    );
    if (chain instanceof Promise) throw new Error("expected a synchronous result");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe("both");
    expect(errors[0]?.error).toBeInstanceOf(TypeError);
    expect(chain.metadata.description).toBeUndefined();
  });

  it("[MD-RES-04] a generator that throws is reported with its route id; the other layers still apply", () => {
    const errors: Array<{ error: unknown; id: string }> = [];
    const boom = new Error("database down");
    const chain = resolveChain(
      [
        route("root", { metadata: { description: "kept" } }),
        route("page", {
          generateMetadata: () => {
            throw boom;
          },
        }),
      ],
      NO_SEARCH,
      (error, id) => errors.push({ error, id }),
    );
    if (chain instanceof Promise) throw new Error("expected a synchronous result");
    expect(errors).toEqual([{ error: boom, id: "page" }]);
    expect(chain.metadata.description).toBe("kept");
  });

  it("[MD-RES-05] a metadataBase that is not an absolute http(s) URL throws (configuration error)", () => {
    expect(() =>
      resolveChain(
        [route("root", { metadata: { metadataBase: "not a url" } })],
        NO_SEARCH,
        () => undefined,
      ),
    ).toThrow(TypeError);
  });
});

describe("resolveChain: async generators", () => {
  it("[MD-RES-10] a generator that returns a promise makes the whole walk a promise", async () => {
    const chain = resolveChain(
      [
        route("root", { metadata: { title: { default: "Malaf", template: "%s · Malaf" } } }),
        route("page", {
          generateMetadata: async () => ({ title: "Async" }),
        }),
      ],
      NO_SEARCH,
      () => undefined,
    );
    expect(chain).toBeInstanceOf(Promise);
    const resolved = await chain;
    expect(resolved.metadata.title).toBe("Async · Malaf");
  });

  it("[MD-RES-11] a rejected generator is reported and skipped, not thrown to the caller", async () => {
    const errors: unknown[] = [];
    const rejected = new Error("nope");
    const chain = resolveChain(
      [
        route("root", { metadata: { description: "kept" } }),
        route("page", { generateMetadata: () => Promise.reject(rejected) }),
        route("after", { metadata: { keywords: ["after"] } }),
      ],
      NO_SEARCH,
      (error) => errors.push(error),
    );
    const resolved = await chain;
    expect(errors).toEqual([rejected]);
    expect(resolved.metadata.description).toBe("kept");
    expect(resolved.metadata.keywords).toEqual(["after"]);
  });

  it("[MD-RES-12] a synchronous walk stays synchronous when no generator is a promise", () => {
    const chain = resolveChain(
      [
        route("root", { metadata: { title: "x" } }),
        route("page", { generateMetadata: () => ({ description: "y" }) }),
      ],
      NO_SEARCH,
      () => undefined,
    );
    expect(chain).not.toBeInstanceOf(Promise);
  });
});

describe("resolveChain: viewport, links, meta and headers", () => {
  it("[MD-RES-20] viewport and generateViewport merge by field, and generateViewport gets the search", async () => {
    const chain = resolveChain(
      [
        route("root", { viewport: { width: "device-width", initialScale: 1, themeColor: "#000" } }),
        route("page", {
          generateViewport: (args) => ({ initialScale: args.search["zoom"] === "2" ? 2 : 1 }),
        }),
      ],
      { search: { zoom: "2" } },
      () => undefined,
    );
    const resolved = await chain;
    expect(resolved.viewport).toEqual({
      width: "device-width",
      initialScale: 2,
      themeColor: "#000",
    });
    expect(chainHead(resolved).tags).toContainEqual({
      tag: "meta",
      props: { name: "viewport", content: "width=device-width, initial-scale=2" },
    });
  });

  it("[MD-RES-21] links export: a static list or a function, concatenated outermost first, with HTML attribute names", () => {
    const chain = resolveChain(
      [
        route("root", { links: [{ rel: "preconnect", href: "https://fonts.example" }] }),
        route("page", {
          links: () => [
            {
              rel: "preload",
              href: "/p.woff2",
              as: "font",
              crossOrigin: "anonymous",
              hrefLang: "en",
            },
          ],
          params: { id: "1" },
        }),
      ],
      NO_SEARCH,
      () => undefined,
    );
    if (chain instanceof Promise) throw new Error("expected a synchronous result");
    expect(chainHead(chain).tags).toEqual([
      { tag: "link", props: { rel: "preconnect", href: "https://fonts.example" } },
      {
        tag: "link",
        props: {
          rel: "preload",
          href: "/p.woff2",
          as: "font",
          crossorigin: "anonymous",
          hreflang: "en",
        },
      },
    ]);
  });

  it("[MD-RES-22] meta export: title, charSet, name, property, http-equiv and tagName link descriptors", () => {
    const tags = metaDescriptorTags([
      { title: "Doc" },
      { charSet: "utf-8" },
      { name: "description", content: "d" },
      { property: "og:title", content: "t" },
      { httpEquiv: "refresh", content: "60" },
      { tagName: "link", rel: "icon", href: "/i.png", hrefLang: "en" },
    ]);
    expect(tags).toEqual([
      { tag: "title", children: "Doc" },
      { tag: "meta", props: { charset: "utf-8" } },
      { tag: "meta", props: { name: "description", content: "d" } },
      { tag: "meta", props: { property: "og:title", content: "t" } },
      { tag: "meta", props: { "http-equiv": "refresh", content: "60" } },
      { tag: "link", props: { rel: "icon", href: "/i.png", hreflang: "en" } },
    ]);
  });

  it("[MD-RES-23] headers export: a static object or a function; inner layers override outer ones; names are lower-cased", async () => {
    const chain = await resolveChain(
      [
        route("root", {
          headers: { "Cache-Control": "public, max-age=60", "X-Frame-Options": "DENY" },
        }),
        route("page", {
          headers: ({ parentHeaders }) => ({
            "cache-control": "no-store",
            "x-seen": String(parentHeaders["x-frame-options"]),
          }),
        }),
      ],
      NO_SEARCH,
      () => undefined,
    );
    expect(chain.headers).toEqual({
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "x-seen": "DENY",
    });
  });

  it("[MD-RES-24] a header name or value that could split a response is refused and reported", () => {
    const errors: unknown[] = [];
    const chain = resolveChain(
      [route("bad", { headers: { "x bad": "v", "x-ok": "line\r\nSet-Cookie: x=1" } })],
      NO_SEARCH,
      (error) => errors.push(error),
    );
    if (chain instanceof Promise) throw new Error("expected a synchronous result");
    expect(chain.headers).toEqual({});
    expect(errors).toHaveLength(1);
    expect(() => checkedHeaders({ "x-ok": "fine value" }, "r")).not.toThrow();
    expect(() => checkedHeaders({ "x-ok": "a\u0000b" }, "r")).toThrow(TypeError);
  });
});

describe("request search", () => {
  it("[MD-RES-30] the search record keeps one value per key and makes a repeated key a list", () => {
    expect(searchRecord("?a=1&b=2&a=3")).toEqual({ a: ["1", "3"], b: "2" });
    expect(searchRecord("")).toEqual({});
    expect(searchRecord(new URLSearchParams("x=%20y"))).toEqual({ x: " y" });
  });

  it("[MD-RES-31] metadata objects are typed: the title union accepts the three forms only", () => {
    const forms: Metadata[] = [
      { title: "a" },
      { title: { default: "b" } },
      { title: { absolute: "c", template: null } },
      { title: null },
    ];
    expect(forms).toHaveLength(4);
  });
});
