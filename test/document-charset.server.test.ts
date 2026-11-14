import { describe, expect, it } from "vitest";
import { buildShell, type ShellInput } from "../src/server/document";

/**
 * The document declares its encoding in its own bytes: `<meta charset="utf-8">` is the first thing in `<head>`, so a
 * copy served without a charset in its Content-Type (a prerendered file on a static host) still decodes the non-ASCII
 * text the same way. Next.js emits `<meta charSet="utf-8" />` in every head (next.js `shared/lib/head.tsx:9`).
 */

const INPUT: ShellInput = {
  lang: "en",
  dir: undefined,
  rootId: "root",
  headHtml: "<title>Home</title>",
  extraHead: "",
  nonce: undefined,
  stylesheets: [],
  preloads: [],
  entry: undefined,
  payload: undefined,
};

describe("the document shell", () => {
  it("[CS-1] the head opens with the charset declaration, before any other head element", () => {
    const { prefix } = buildShell(INPUT);
    expect(prefix).toContain('<head><meta charset="utf-8">');
    expect(prefix.indexOf('<meta charset="utf-8">')).toBeLessThan(prefix.indexOf("<title>"));
  });

  it("[CS-2] a page with a charset in its head keeps one declaration, the shell's", () => {
    const { prefix } = buildShell({
      ...INPUT,
      headHtml: '<meta charset="utf-8"><title>Home</title>',
    });
    expect(prefix.match(/<meta charset=/g)?.length).toBe(1);
  });

  it("[CS-3] a charset declaration the head renderer marked with its own attribute still counts as the page's own", () => {
    const { prefix } = buildShell({
      ...INPUT,
      headHtml: '<meta data-shadow-head charset="utf-8"><title>Home</title>',
    });
    expect(prefix.match(/charset=/g)?.length).toBe(1);
    expect(prefix).toContain('<meta data-shadow-head charset="utf-8">');
  });

  it("[CS-4] the declaration is found whatever the attribute order, case or quoting, and in the extra head", () => {
    for (const head of [
      '<META CHARSET="utf-8">',
      "<meta charset='utf-8'>",
      '<meta data-a="x" charset = "utf-8" data-b>',
      '<meta\n  data-shadow-head\n  charset="utf-8"\n>',
    ]) {
      const { prefix } = buildShell({ ...INPUT, headHtml: head });
      expect(prefix.match(/charset\s*=/gi)?.length, head).toBe(1);
    }
    const extra = buildShell({ ...INPUT, extraHead: '<meta charset="utf-8">' });
    expect(extra.prefix.match(/charset=/g)?.length).toBe(1);
  });

  it("[CS-5] text that only mentions a charset does not count: a content-type value or another attribute keeps the shell's declaration", () => {
    for (const head of [
      '<meta http-equiv="content-type" content="text/html; charset=utf-8">',
      '<meta name="note" content="charset=latin1">',
      '<meta name="x-charset" content="a">',
    ]) {
      const { prefix } = buildShell({ ...INPUT, headHtml: head });
      expect(prefix, head).toContain('<head><meta charset="utf-8">');
    }
  });
});
