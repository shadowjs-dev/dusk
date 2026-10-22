import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defineFonts } from "../../src/vite/fonts";
import { googleCssUrl, parseGoogleCss, sriOf } from "../../src/vite/google-fonts";

/**
 * Google Fonts at build time. The CSS is a recording of the real CSS2 API (fixtures/google/inter-ital-wght-400-700.css,
 * fetched once with a browser user agent); the font files are stand-in bytes, so the tests need no network. The
 * download, cache, vendor and lock rules are the real ones.
 */

const FIXTURE_CSS = readFileSync(
  join(import.meta.dirname, "fixtures", "google", "inter-ital-wght-400-700.css"),
  "utf8",
);
const INTER_URL =
  "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400..700;1,400..700&display=swap";
const INTER = { family: "Inter", italic: true, axes: { wght: "400..700" } } as const;

let root: string;
let publicDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dusk-google-"));
  publicDir = join(root, "public");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fetch that answers with the recorded CSS and deterministic stand-in font bytes; it counts the calls. */
function recorded(options: { css?: string; bytes?: (url: string) => string } = {}) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return new Response(options.css ?? FIXTURE_CSS, { status: 200 });
    }
    return new Response(options.bytes?.(url) ?? `font bytes of ${url}`, { status: 200 });
  });
  return { fetch, calls };
}

function failing(): (url: string) => Promise<Response> {
  return async () => {
    throw new TypeError("fetch failed: no route to host");
  };
}

describe("Google Fonts: the CSS2 request", () => {
  it("[GF-01] a family with italics and a weight range is the request the API serves (the recorded one)", () => {
    expect(googleCssUrl({ ...INTER })).toBe(INTER_URL);
  });

  it("[GF-02] static weights are one wght axis of values, sorted with the other axes", () => {
    expect(googleCssUrl({ family: "Instrument Sans", weights: [400, 700] })).toBe(
      "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;700&display=swap",
    );
    expect(
      googleCssUrl({
        family: "Roboto Flex",
        italic: true,
        weights: [400],
        axes: { wdth: "75..100" },
      }),
    ).toBe(
      "https://fonts.googleapis.com/css2?family=Roboto+Flex:ital,wdth,wght@0,75..100,400;1,75..100,400&display=swap",
    );
  });

  it("[GF-03] a family name that is not letters and spaces, an axis that is not four letters, and weights with an axis are refused", () => {
    expect(() => googleCssUrl({ family: "Inter&evil=1" })).toThrow(/letters, digits and spaces/);
    expect(() => googleCssUrl({ family: "Inter", axes: { wg: 400 } })).toThrow(/four letters/);
    expect(() => googleCssUrl({ family: "Inter", axes: { wght: "900..100x" } })).toThrow(/range/);
    expect(() => googleCssUrl({ family: "Inter", weights: [400], axes: { wght: 400 } })).toThrow(
      /use one of them/,
    );
  });
});

describe("Google Fonts: the recorded CSS", () => {
  it("[GF-04] the parser reads every face: subset, weight range, style, unicode-range and file", () => {
    const faces = parseGoogleCss(FIXTURE_CSS);
    expect(faces).toHaveLength(14);
    const latinNormal = faces.find((face) => face.subset === "latin" && face.style === "normal");
    expect(latinNormal?.weight).toBe("400 700");
    expect(latinNormal?.format).toBe("woff2");
    expect(latinNormal?.url.startsWith("https://fonts.gstatic.com/s/inter/")).toBe(true);
    expect(latinNormal?.unicodeRange).toMatch(/^U\+/);
    expect(faces.filter((face) => face.style === "italic")).toHaveLength(7);
  });

  it("[GF-05] a stylesheet that names a file on another host is refused, and no file is fetched from it", () => {
    const hostile = FIXTURE_CSS.replace(
      "https://fonts.gstatic.com/s/inter/v20/",
      "https://attacker.example/inter/",
    );
    expect(() => parseGoogleCss(hostile)).toThrow(
      /refused a font file from https:\/\/attacker\.example/,
    );
  });
});

describe("Google Fonts: resolved at build time", () => {
  it("[GF-06] the Latin faces become @font-face rules over vendored files, preloaded, with the variable and a lock", async () => {
    const { fetch, calls } = recorded();
    const out = await defineFonts(
      { google: [{ ...INTER, variable: "--font-sans", subsets: ["latin"], preload: ["latin"] }] },
      { publicDir, root, fetch },
    );
    expect(calls[0]).toBe(INTER_URL);
    const faces = (out.css.match(/@font-face/g) ?? []).length;
    expect(faces).toBe(2);
    expect(out.css).toMatch(/url\("?\/fonts\/google\//);
    expect(out.css).not.toContain("fonts.gstatic.com");
    expect(out.css).toContain("font-style: italic");
    expect(out.variables["--font-sans"]).toContain('"Inter"');
    expect(out.preloads).toHaveLength(2);
    expect(
      out.urls.every((url) => url.startsWith("/fonts/google/") && url.endsWith(".woff2")),
    ).toBe(true);
    for (const url of out.urls) expect(existsSync(join(publicDir, url.slice(1)))).toBe(true);
    const lock = JSON.parse(readFileSync(join(root, "fonts.lock.json"), "utf8")) as {
      version: number;
      fonts: Record<string, { css: string; files: Record<string, string> }>;
    };
    expect(lock.version).toBe(1);
    expect(lock.fonts[INTER_URL]?.css).toBe(sriOf(FIXTURE_CSS));
    // Only the Latin faces were asked for: one normal and one italic file.
    expect(Object.keys(lock.fonts[INTER_URL]?.files ?? {})).toHaveLength(2);
  });

  it("[GF-07] the same input gives the same stylesheet and the same lock: builds are deterministic", async () => {
    const first = await defineFonts(
      { google: [{ ...INTER, subsets: ["latin"] }] },
      { publicDir, root, fetch: recorded().fetch },
    );
    const lockBefore = readFileSync(join(root, "fonts.lock.json"), "utf8");
    const second = await defineFonts(
      { google: [{ ...INTER, subsets: ["latin"] }] },
      { publicDir, root, fetch: recorded().fetch },
    );
    expect(second.css).toBe(first.css);
    expect(second.urls).toEqual(first.urls);
    expect(readFileSync(join(root, "fonts.lock.json"), "utf8")).toBe(lockBefore);
  });

  it("[GF-08] offline, the cache and the lock are enough: no request leaves the build", async () => {
    const online = await defineFonts(
      { google: [{ ...INTER, subsets: ["latin"] }] },
      { publicDir, root, fetch: recorded().fetch },
    );
    const { fetch, calls } = recorded();
    const offline = await defineFonts(
      { google: [{ ...INTER, subsets: ["latin"] }] },
      { publicDir, root, fetch, offline: true },
    );
    expect(calls).toHaveLength(0);
    expect(offline.css).toBe(online.css);
  });

  it("[GF-09] a failed network falls back to the cache and the lock, and gives the same answer", async () => {
    const online = await defineFonts(
      { google: [{ ...INTER, subsets: ["latin"] }] },
      { publicDir, root, fetch: recorded().fetch },
    );
    const fallback = await defineFonts(
      { google: [{ ...INTER, subsets: ["latin"] }] },
      { publicDir, root, fetch: failing() },
    );
    expect(fallback.css).toBe(online.css);
  });

  it("[GF-10] with no network and no cached copy the build fails, naming the family and what to do", async () => {
    const empty = mkdtempSync(join(tmpdir(), "dusk-google-empty-"));
    try {
      await expect(
        defineFonts(
          { google: [{ ...INTER }] },
          { publicDir: join(empty, "public"), root: empty, fetch: failing() },
        ),
      ).rejects.toThrow(/cannot load the Google Fonts CSS for Inter.*no cached or locked copy/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("[GF-11] a file that differs from the lock fails the build (frozen or not); updateLock: true accepts it and updates the lock", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "dusk-google-frozen-"));
    try {
      const pub = join(isolated, "public");
      await defineFonts(
        { google: [{ ...INTER, subsets: ["latin"] }] },
        { publicDir: pub, root: isolated, fetch: recorded().fetch },
      );
      const changed = recorded({ bytes: (url) => `changed ${url}` });
      await expect(
        defineFonts(
          { google: [{ ...INTER, subsets: ["latin"] }] },
          { publicDir: pub, root: isolated, fetch: changed.fetch, frozen: true },
        ),
      ).rejects.toThrow(/changed; update fonts.lock.json/);
      // Since the PASS 2 audit (SEC2-ASSET-110) an unfrozen build refuses too: the bytes behind a versioned URL changed.
      await expect(
        defineFonts(
          { google: [{ ...INTER, subsets: ["latin"] }] },
          { publicDir: pub, root: isolated, fetch: changed.fetch },
        ),
      ).rejects.toThrow(/changed; update fonts.lock.json/);
      await defineFonts(
        { google: [{ ...INTER, subsets: ["latin"] }] },
        { publicDir: pub, root: isolated, fetch: changed.fetch, updateLock: true },
      );
      // The lock now records the changed bytes of the first latin file (the one the reviewed build wrote).
      const firstFile =
        parseGoogleCss(FIXTURE_CSS).find((face) => face.subset === "latin")?.url ?? "";
      const lock = readFileSync(join(isolated, "fonts.lock.json"), "utf8");
      expect(lock).toContain(sriOf(`changed ${firstFile}`));
      expect(lock).not.toContain(sriOf(`font bytes of ${firstFile}`));
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("[GF-12] a tampered cached file is not used offline: the build names the missing copy", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "dusk-google-tamper-"));
    try {
      const pub = join(isolated, "public");
      await defineFonts(
        { google: [{ ...INTER, subsets: ["latin"] }] },
        { publicDir: pub, root: isolated, fetch: recorded().fetch },
      );
      const cacheDir = join(isolated, "node_modules", ".cache", "dusk", "fonts");
      for (const name of readdirSync(cacheDir)) {
        if (name.endsWith(".bin")) writeFileSync(join(cacheDir, name), "tampered");
      }
      await expect(
        defineFonts(
          { google: [{ ...INTER, subsets: ["latin"] }] },
          { publicDir: pub, root: isolated, offline: true },
        ),
      ).rejects.toThrow(/no copy of a Inter \(latin\) font file/);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("[GF-13] an unknown subset is an error; local families sit in the same stylesheet as Google ones", async () => {
    await expect(
      defineFonts(
        { google: [{ ...INTER, subsets: ["klingon"] }] },
        { publicDir, root, fetch: recorded().fetch },
      ),
    ).rejects.toThrow(/no face of Inter matches the subsets klingon/);
    writeFileSync(join(publicDir, "mono.woff2"), "mono bytes");
    const out = await defineFonts(
      {
        google: [{ ...INTER, subsets: ["latin"] }],
        local: {
          mono: { family: "Mono Local", variable: "--font-mono", files: [{ file: "mono.woff2" }] },
        },
      },
      { publicDir, root, fetch: recorded().fetch },
    );
    expect(out.css).toContain('font-family: "Mono Local"');
    expect(out.css).toContain('font-family: "Inter"');
    expect(out.variables["--font-mono"]).toContain('"Mono Local"');
  });
});
