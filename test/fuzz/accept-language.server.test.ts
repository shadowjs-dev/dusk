import {
  ACCEPT_LANGUAGE_LIMITS,
  matchLocale,
  negotiateLocale,
  parseAcceptLanguage,
} from "@shadow-js/i18n";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

/**
 * Property tests for `Accept-Language` parsing and locale negotiation (`parseAcceptLanguage`, `matchLocale`,
 * `negotiateLocale` from `@shadow-js/i18n`). Invariants: a hostile header never throws, the parsed list is bounded and
 * ordered by quality, negotiation only ever returns a supported locale (or `undefined`), and negotiation tries at most
 * `ACCEPT_LANGUAGE_LIMITS.maxEntries` tags.
 */

const SEED = { seed: 20261017, numRuns: 200 };

/** Any Unicode scalar value (surrogates excluded), as a string. */
const codePoint = fc
  .integer({ min: 0, max: 0x10ffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));

/** Pieces that look like a header: separators, weights, tags in several spellings, and extensions. */
const headerToken = fc.constantFrom(
  ",",
  ";",
  "=",
  " ",
  "\t",
  "*",
  "-",
  "_",
  "q",
  "q=",
  ";q=",
  "0",
  "1",
  "0.5",
  "1.5",
  "en",
  "EN_us",
  "fr-CH",
  "zh-Hant-TW",
  "i-klingon",
  "x-private",
  "-u-nu-arab",
  "ar-EG-u-nu-latn",
);

/** A header built from random code points, from header-like tokens, or both. */
const hostileHeader = fc.oneof(
  fc.array(codePoint, { maxLength: 200 }).map((parts) => parts.join("")),
  fc.array(fc.oneof(codePoint, headerToken), { maxLength: 80 }).map((parts) => parts.join("")),
);

/** Tags with no two spellings of one canonical form, so the supported list is unambiguous. */
const SUPPORTED_POOL = [
  "en",
  "fr",
  "de",
  "ja",
  "pt-BR",
  "zh-Hant-TW",
  "zh-Hans",
  "es-419",
  "en-US",
  "ar-EG",
  "it",
  "ko",
] as const;

const supportedList = fc.uniqueArray(fc.constantFrom(...SUPPORTED_POOL), {
  minLength: 1,
  maxLength: 6,
});

/** Requested tags in any spelling: valid, mixed case, with extensions, invalid, or hostile text. */
const requestedTag = fc.oneof(
  fc.constantFrom(
    ...SUPPORTED_POOL,
    "EN_us",
    "zh-hant-tw",
    "pt",
    "en-GB",
    "ar-EG-u-nu-latn",
    "x-foo",
    "*",
    "",
    "ko",
    "fr-CH",
  ),
  fc.array(codePoint, { maxLength: 24 }).map((parts) => parts.join("")),
);

/** Weights as they may appear after `q=`, with the expected numeric value (`undefined` for an invalid weight). */
const WEIGHT_VALUE: ReadonlyMap<string, number | undefined> = new Map([
  ["", 1],
  ["1", 1],
  ["1.0", 1],
  ["0.9", 0.9],
  ["0.5", 0.5],
  ["0.001", 0.001],
  ["0", 0],
  ["0.000", 0],
  ["1.5", undefined],
  ["abc", undefined],
]);

/** Letters for a distinct tag per index: three lowercase letters, all different up to 17576 indexes. */
function letters(index: number): string {
  return String.fromCharCode(
    97 + (index % 26),
    97 + (Math.floor(index / 26) % 26),
    97 + (Math.floor(index / 676) % 26),
  );
}

describe("[FUZZ-LANG] Accept-Language parsing and locale negotiation", () => {
  it("[FUZZ-LANG-01] any header parses to a bounded list, and negotiation returns only a supported locale or undefined", () => {
    fc.assert(
      fc.property(hostileHeader, supportedList, (header, supported) => {
        const tags = parseAcceptLanguage(header);
        expect(tags.length).toBeLessThanOrEqual(ACCEPT_LANGUAGE_LIMITS.maxEntries);
        const hit = negotiateLocale(tags, supported);
        expect(hit === undefined || supported.includes(hit)).toBe(true);
      }),
      SEED,
    );
  });

  it("[FUZZ-LANG-02] parsed tags are ordered by quality, invalid or zero weights are dropped, and ties keep header order", () => {
    const entries = fc.uniqueArray(
      fc.tuple(
        fc.constantFrom(
          "en",
          "fr",
          "de",
          "ja",
          "pt-BR",
          "zh-Hant-TW",
          "es-419",
          "en-US",
          "it",
          "ko",
        ),
        fc.constantFrom(...WEIGHT_VALUE.keys()),
      ),
      { selector: ([tag]) => tag, maxLength: 10 },
    );
    fc.assert(
      fc.property(entries, (list) => {
        const header = list.map(([tag, q]) => (q === "" ? tag : `${tag};q=${q}`)).join(", ");
        const weighted: { tag: string; q: number; index: number }[] = [];
        list.forEach(([tag, q], index) => {
          const weight = WEIGHT_VALUE.get(q);
          if (weight !== undefined && weight > 0) weighted.push({ tag, q: weight, index });
        });
        const expected = weighted
          .sort((a, b) => b.q - a.q || a.index - b.index)
          .map((entry) => entry.tag);
        expect(parseAcceptLanguage(header)).toEqual(expected);
      }),
      SEED,
    );
  });

  it("[FUZZ-LANG-03] a header keeps at most maxEntries tags, the first ones in order, and a header over maxLength is ignored", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 120 }), (count) => {
        const tags = Array.from({ length: count }, (_, index) => letters(index));
        const header = tags.join(", ");
        expect(header.length).toBeLessThanOrEqual(ACCEPT_LANGUAGE_LIMITS.maxLength);
        expect(parseAcceptLanguage(header)).toEqual(
          tags.slice(0, ACCEPT_LANGUAGE_LIMITS.maxEntries),
        );
      }),
      SEED,
    );
    // Boundary: a header of exactly maxLength is parsed, one character more is ignored.
    const atLimit = `${"en,".repeat(339)}ja-JP  `;
    expect(atLimit.length).toBe(ACCEPT_LANGUAGE_LIMITS.maxLength);
    expect(parseAcceptLanguage(atLimit)).toEqual(["en", "ja-JP"]);
    expect(parseAcceptLanguage(`${atLimit}x`)).toEqual([]);
  });

  it("[FUZZ-LANG-04] negotiation tries at most maxEntries tags", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), (skipped) => {
        const requested = [...Array.from({ length: skipped }, () => "ko"), "ja"];
        const expected = skipped + 1 <= ACCEPT_LANGUAGE_LIMITS.maxEntries ? "ja" : undefined;
        expect(negotiateLocale(requested, ["ja"])).toBe(expected);
      }),
      SEED,
    );
  });

  it("[FUZZ-LANG-05] negotiation is the first requested tag that matches, as matchLocale decides it", () => {
    fc.assert(
      fc.property(
        fc.array(requestedTag, { maxLength: 8 }),
        supportedList,
        (requested, supported) => {
          const expected = requested
            .map((tag) => matchLocale(tag, supported))
            .find((hit) => hit !== undefined);
          expect(negotiateLocale(requested, supported)).toBe(expected);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-LANG-06] matching ignores the case of a tag: upper, lower and original case give the same locale", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "en",
          "fr",
          "de",
          "ja",
          "pt-BR",
          "zh-Hant-TW",
          "es-419",
          "en-US",
          "ar-EG",
          "it",
          "ko",
        ),
        supportedList,
        (tag, supported) => {
          const expected = matchLocale(tag, supported);
          expect(matchLocale(tag.toUpperCase(), supported)).toBe(expected);
          expect(matchLocale(tag.toLowerCase(), supported)).toBe(expected);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-LANG-07] matchLocale on any text returns a supported locale or undefined, and the empty tag never matches", () => {
    fc.assert(
      fc.property(
        fc.array(codePoint, { maxLength: 300 }).map((parts) => parts.join("")),
        supportedList,
        (tag, supported) => {
          const hit = matchLocale(tag, supported);
          expect(hit === undefined || supported.includes(hit)).toBe(true);
        },
      ),
      SEED,
    );
    expect(matchLocale("", ["en", "fr"])).toBeUndefined();
  });

  it("[FUZZ-LANG-08] a missing header parses to an empty list and negotiates to undefined", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(negotiateLocale([], ["en"])).toBeUndefined();
  });

  it("[FUZZ-LANG-09] adversarial separators and near-miss weights parse without hanging", () => {
    const adversarial = [
      "-".repeat(900),
      "a-".repeat(480),
      "en;q=0.".repeat(120),
      ";".repeat(500),
      "=".repeat(500),
      `en;q=${"0".repeat(900)}`,
      `en;${"q=1.".repeat(200)}`,
      "*,".repeat(400),
    ];
    for (const header of adversarial) {
      const started = Date.now();
      const tags = parseAcceptLanguage(header);
      expect(tags.length).toBeLessThanOrEqual(ACCEPT_LANGUAGE_LIMITS.maxEntries);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});
