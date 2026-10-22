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
});
