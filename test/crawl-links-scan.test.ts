import { describe, expect, it } from "vitest";
import { internalLinks } from "../src/static/crawl";

/** The single regular expression the link scan replaced; kept here as the reference for the same answers. */
const REFERENCE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;

const PAGE = new URL("http://localhost/");

function referenceValues(html: string): string[] {
  return [...html.matchAll(REFERENCE)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** The values the scan reads, seen through `internalLinks` (one distinct page path per value). */
function scanned(html: string): string[] {
  return internalLinks(html, PAGE, PAGE.origin, "");
}

function expectedPaths(html: string): string[] {
  const found = new Set<string>();
  for (const value of referenceValues(html)) {
    const raw = value
      .trim()
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
    if (raw === "" || raw.startsWith("#") || !URL.canParse(raw, PAGE)) continue;
    const target = new URL(raw, PAGE);
    if (target.origin !== PAGE.origin) continue;
    let pathname = target.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    if (pathname === "/_dusk" || pathname.startsWith("/_dusk/")) continue;
    if (pathname.slice(pathname.lastIndexOf("/") + 1).includes(".")) continue;
    found.add(pathname);
  }
  return [...found].sort();
}

/** A small deterministic generator, so a failure names the same input on every machine. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const PIECES = [
  "<a ",
  "<a",
  "<A ",
  "<abbr ",
  "<ahref=",
  'href="/p1"',
  "href='/p2'",
  "href=/p3",
  "HREF = /p4",
  "href",
  "href=",
  '"',
  "'",
  ">",
  "</a>",
  " ",
  "\n",
  "x",
  "/q",
  "<b>",
  "data-href=/p5",
];

describe("the link scan answers as the regular expression it replaced did", () => {
  it("[DUSK-CRAWL-SCAN-01] on written cases: quoting, case, attributes before href, tags without a close", () => {
    const cases = [
      '<a href="/a">a</a>',
      "<a class=x href='/b'>b</a>",
      "<A HREF=/c>c</A>",
      '<a data-x="1" title=y\nhref = "/d">d</a>',
      '<a href="/e"><a href="/f">',
      "<abbr href=/no>x</abbr>",
      '<a id="1">x</a><a href="/g">g</a>',
      '<a hreflang="en" href="/h">h</a>',
      '<a title="a>b" href="/i">i</a>',
      "<a <a <a href=/j",
      '<a href="/k',
    ];
    for (const html of cases) expect(scanned(html)).toEqual(expectedPaths(html));
  });

  it("[DUSK-CRAWL-SCAN-02] on 4,000 random strings built from tag, quote and attribute pieces", () => {
    const next = lcg(7);
    for (let round = 0; round < 4_000; round += 1) {
      let html = "";
      const length = 1 + Math.floor(next() * 14);
      for (let index = 0; index < length; index += 1) {
        html += PIECES[Math.floor(next() * PIECES.length)] ?? "";
      }
      expect(scanned(html), JSON.stringify(html)).toEqual(expectedPaths(html));
    }
  });
});
