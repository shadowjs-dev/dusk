import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineFonts } from "../../src/vite/fonts";
import { expectedAverage, latinFont } from "./support/font-files";

/*
 * The defaults of `defineFonts({ google })`: the first declared subset is preloaded (only the subsets and weights asked
 * for are downloaded at all), the size-adjusted fallback is built from the vendored file, and Malaf's explicit options
 * (`preload: ["latin"]`, `fallback: []`, the variable axes) give the output they gave before the defaults changed. The
 * network is a stub that answers a Google-shaped stylesheet and the bytes of the test's choice.
 */

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SUBSETS = ["cyrillic", "latin-ext", "latin"] as const;

/** A stylesheet shaped like the CSS2 API's: a subset comment above each face, one file per subset. */
function css(family: string, weight: string, subsets: readonly string[] = SUBSETS): string {
  const slug = family.toLowerCase().replaceAll(" ", "");
  return subsets
    .map(
      (subset) =>
        `/* ${subset} */\n@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/${slug}/v1/${subset}.woff2) format('woff2');\n  unicode-range: U+0000-00FF;\n}`,
    )
    .join("\n");
}

const SANS = css("Instrument Sans", "400 700");

interface Setup {
  readonly root: string;
  readonly publicDir: string;
}

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "dusk-fonts-defaults-google-"));
  roots.push(root);
  return { root, publicDir: join(root, "public") };
}

const SERIF = css("Instrument Serif", "400");

/** The default stand-in bytes of a font file: different for every URL, so every face is vendored under its own name. */
const standIn = (url: string): string => `font bytes of ${url}`;

/** A fetch that answers the stylesheet of the family in the request and the given bytes for each file. */
function stub(bytes: (url: string) => Uint8Array<ArrayBuffer> | string = standIn) {
  return async (url: string): Promise<Response> => {
    if (url.startsWith("https://fonts.googleapis.com/")) {
      return new Response(url.includes("Instrument+Serif") ? SERIF : SANS, { status: 200 });
    }
    return new Response(bytes(url), { status: 200 });
  };
}

/** Where the face of a family's subset is served from, once vendored (the name is a hash of its bytes). */
function vendored(family: string, subset: string, bytes = standIn): string {
  const slug = family.toLowerCase().replaceAll(" ", "");
  const content = bytes(`https://fonts.gstatic.com/s/${slug}/v1/${subset}.woff2`);
  return `/fonts/google/${createHash("sha256").update(content).digest("hex").slice(0, 16)}.woff2`;
}

function hrefs(tags: readonly { readonly props?: Readonly<Record<string, unknown>> }[]): unknown[] {
  return tags.map((tag) => tag.props?.["href"]);
}

const SANS_FONT = { family: "Instrument Sans", axes: { wght: "400..700" } } as const;

describe("defineFonts defaults: Google preload", () => {
  it("[FNT-D20] with subsets declared and no preload option, only the first declared subset is preloaded", async () => {
    const { root, publicDir } = setup();
    const out = await defineFonts(
      { google: [{ ...SANS_FONT, subsets: ["latin", "latin-ext"] }] },
      { publicDir, root, fetch: stub() },
    );
    // Two faces are downloaded (the declared subsets); the Cyrillic one never is.
    expect(out.urls).toHaveLength(2);
    expect(hrefs(out.preloads)).toEqual([vendored("Instrument Sans", "latin")]);
  });

  it("[FNT-D21] with no subsets declared, the latin face is the one preloaded", async () => {
    const { root, publicDir } = setup();
    const out = await defineFonts({ google: [SANS_FONT] }, { publicDir, root, fetch: stub() });
    expect(out.urls).toHaveLength(3);
    expect(hrefs(out.preloads)).toEqual([vendored("Instrument Sans", "latin")]);
  });

  it("[FNT-D22] preload: false preloads nothing; an array of subsets preloads those subsets", async () => {
    const { root, publicDir } = setup();
    const off = await defineFonts(
      { google: [{ ...SANS_FONT, preload: false }] },
      { publicDir, root, fetch: stub() },
    );
    expect(off.preloads).toEqual([]);
    const some = await defineFonts(
      { google: [{ ...SANS_FONT, preload: ["cyrillic", "latin"] }] },
      { publicDir, root, fetch: stub() },
    );
    expect(hrefs(some.preloads)).toEqual([
      vendored("Instrument Sans", "cyrillic"),
      vendored("Instrument Sans", "latin"),
    ]);
  });

  it("[FNT-D23] a stylesheet without a latin face and no declared subsets preloads nothing (no guess)", async () => {
    const { root, publicDir } = setup();
    const noLatin = async (url: string): Promise<Response> =>
      url.startsWith("https://fonts.googleapis.com/")
        ? new Response(css("Instrument Sans", "400 700", ["cyrillic", "greek"]), { status: 200 })
        : new Response(standIn(url), { status: 200 });
    const out = await defineFonts({ google: [SANS_FONT] }, { publicDir, root, fetch: noLatin });
    expect(out.urls).toHaveLength(2);
    expect(out.preloads).toEqual([]);
  });
});

describe("defineFonts defaults: Google fallback", () => {
  const font = () => latinFont();

  it("[FNT-D24] the fallback face is built by default from the vendored file's metrics, measured against Arial", async () => {
    const { root, publicDir } = setup();
    const out = await defineFonts(
      { google: [{ ...SANS_FONT, variable: "--font-sans" }] },
      { publicDir, root, fetch: stub(font) },
    );
    expect(out.css).toContain('font-family: "Instrument Sans fallback"; src: local("Arial");');
    expect(out.variables["--font-sans"]).toBe(
      '"Instrument Sans", "Instrument Sans fallback", sans-serif',
    );
    const arial = 934.5116279069767 / 2048;
    const sizeAdjust = Number(/size-adjust: ([\d.]+)%/.exec(out.css)?.[1]);
    expect(sizeAdjust).toBeCloseTo((expectedAverage() / 1000 / arial) * 100, 1);
  });

  it("[FNT-D25] fallbackFace: false turns it off; a name picks the system font", async () => {
    const { root, publicDir } = setup();
    const off = await defineFonts(
      { google: [{ ...SANS_FONT, fallbackFace: false }] },
      { publicDir, root, fetch: stub(font) },
    );
    expect(off.css).not.toContain("fallback");
    const times = await defineFonts(
      { google: [{ ...SANS_FONT, fallbackFace: "Times New Roman" }] },
      { publicDir, root, fetch: stub(font) },
    );
    expect(times.css).toContain('src: local("Times New Roman")');
  });

  it("[FNT-D26] a serif generic in the fallback stack builds the fallback from Times New Roman", async () => {
    const { root, publicDir } = setup();
    const out = await defineFonts(
      { google: [{ ...SANS_FONT, fallback: ["Georgia", "serif"] }] },
      { publicDir, root, fetch: stub(font) },
    );
    expect(out.css).toContain('src: local("Times New Roman")');
  });

  it("[FNT-D26b] files that are not readable fonts give no fallback face and no error", async () => {
    const { root, publicDir } = setup();
    const out = await defineFonts({ google: [SANS_FONT] }, { publicDir, root, fetch: stub() });
    expect(out.css).not.toContain("fallback");
  });
});

describe("defineFonts defaults: Malaf's explicit config keeps its output", () => {
  /** The shape of `Malafv2/scripts/build-fonts.mjs`: explicit axes, `preload: ["latin"]`, `fallback: []`, variables. */
  const MALAF = [
    {
      family: "Instrument Sans",
      variable: "--font-sans",
      axes: { wght: "400..700", wdth: "75..100" },
      preload: ["latin"],
      fallback: [],
    },
    {
      family: "Instrument Serif",
      variable: "--font-serif",
      weights: [400],
      italic: true,
      preload: ["latin"],
      fallback: [],
    },
  ] as const;

  async function build(bytes: (url: string) => Uint8Array<ArrayBuffer> | string, optOut = false) {
    const { root, publicDir } = setup();
    return defineFonts(
      { google: MALAF.map((font) => (optOut ? { ...font, fallbackFace: false as const } : font)) },
      { publicDir, root, fetch: stub(bytes) },
    );
  }

  it("[FNT-D27] the preloads are the latin files only, one per family, exactly as the explicit option said", async () => {
    const out = await build(standIn);
    // Two families times three subsets are downloaded; the latin face of each is preloaded.
    expect(out.urls).toHaveLength(6);
    expect(hrefs(out.preloads)).toEqual([
      vendored("Instrument Sans", "latin"),
      vendored("Instrument Serif", "latin"),
    ]);
    // Their files are not readable fonts here, so no fallback face is added, as before the defaults changed.
    expect(out.css).not.toContain("fallback");
    expect(out.variables).toEqual({
      "--font-sans": '"Instrument Sans"',
      "--font-serif": '"Instrument Serif"',
    });
  });

  it("[FNT-D28] fallback: [] keeps the stack to the web font and, with fallbackFace: false, the stylesheet has no fallback face", async () => {
    const out = await build(() => latinFont(), true);
    expect(out.variables).toEqual({
      "--font-sans": '"Instrument Sans"',
      "--font-serif": '"Instrument Serif"',
    });
    expect(out.css).not.toContain("fallback");
    expect(out.classes["google:Instrument Sans"]).toEqual({
      className: "__dusk_font_google-instrument-sans",
      variableClass: "__dusk_var_google-instrument-sans",
    });
  });

  it("[FNT-D29] without the opt-out the same config adds the fallback face to the stack, and the preloads do not change", async () => {
    const plain = await build(() => latinFont(), true);
    const withFallback = await build(() => latinFont());
    expect(hrefs(withFallback.preloads)).toEqual(hrefs(plain.preloads));
    expect(withFallback.urls).toEqual(plain.urls);
    expect(withFallback.variables["--font-sans"]).toBe(
      '"Instrument Sans", "Instrument Sans fallback"',
    );
  });
});
