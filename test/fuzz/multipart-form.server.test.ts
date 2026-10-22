import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/internal/http-error";
import { type FormLimitsOptions, readFormLimited } from "../../src/server/form";
import { DEFAULT_FORM_LIMITS } from "../../src/server/limits";

/**
 * Property tests for form bodies: `readFormLimited` (the caps on fields, files and text sizes, the media-type gate and
 * the parse error) and the record it returns through `formToObject` (repeated keys become arrays, hostile keys stay out
 * of the prototype). Invariants: a body at a cap is accepted and one unit over it is refused with the stable
 * `data.code`; a body of the wrong type is 415; a body that does not parse is 400; no key reaches `Object.prototype`.
 */

const SEED = { seed: 20261019, numRuns: 200 };
const FORM_URL = "https://example.test/form";
const encoder = new TextEncoder();

type Transport = "urlencoded" | "multipart";

/**
 * Any Unicode scalar value except CR and LF. The multipart encoder normalizes line breaks in string values, so a CR or LF
 * would change the byte count of a text field between the request and the parsed result.
 */
const codePoint = fc
  .integer({ min: 0, max: 0x10ffff })
  .filter((cp) => (cp < 0xd800 || cp > 0xdfff) && cp !== 0x0a && cp !== 0x0d)
  .map((cp) => String.fromCodePoint(cp));

/** Text of up to `max` code points, as a string. */
const text = (max: number): fc.Arbitrary<string> =>
  fc.array(codePoint, { maxLength: max }).map((parts) => parts.join(""));

/** A form request with text fields only, in either transport. */
function textForm(kind: Transport, entries: ReadonlyArray<readonly [string, string]>): Request {
  if (kind === "urlencoded") {
    return new Request(FORM_URL, {
      method: "POST",
      body: new URLSearchParams(entries.map(([name, value]) => [name, value])),
    });
  }
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return new Request(FORM_URL, { method: "POST", body: data });
}

/** A multipart request holding files and text, as a browser sends them. */
function multipartRequest(entries: ReadonlyArray<readonly [string, string | File]>): Request {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return new Request(FORM_URL, { method: "POST", body: data });
}

/** A file of `size` zero bytes. */
function file(size: number): File {
  return new File([new Uint8Array(size)], "upload.bin", { type: "application/octet-stream" });
}

/** The error a rejected read throws. Fails the test if the read resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return error as HttpError;
  }
  throw new Error("expected the read to reject, but it resolved");
}

/** Keys a prototype-pollution attack would use, mixed with an ordinary key. */
const HOSTILE_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
  "ok",
] as const;

describe("[FUZZ-FORM] form body limits and parsing", () => {
  it("[FUZZ-FORM-01] a urlencoded form at the maxFields cap is accepted; one entry more is a 413 FORM_TOO_MANY_FIELDS", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        async (count, cap) => {
          const pairs = Array.from({ length: count }, (_, index) => [`k${index}`, "v"] as const);
          const read = readFormLimited(textForm("urlencoded", pairs), { maxFields: cap });
          if (count <= cap) {
            await expect(read).resolves.toBeDefined();
          } else {
            const error = await rejectionOf(read);
            expect(error.status).toBe(413);
            expect(error.data).toEqual({ code: "FORM_TOO_MANY_FIELDS" });
          }
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-02] the default maxFields cap takes 1000 fields and refuses 1001", async () => {
    const pairs = (count: number) =>
      Array.from({ length: count }, (_, index) => [`k${index}`, "v"] as const);
    await expect(readFormLimited(textForm("urlencoded", pairs(1000)))).resolves.toBeDefined();
    const error = await rejectionOf(readFormLimited(textForm("urlencoded", pairs(1001))));
    expect(error.status).toBe(413);
    expect(error.data).toEqual({ code: "FORM_TOO_MANY_FIELDS" });
  });

  it("[FUZZ-FORM-03] a multipart form at the maxFileCount cap is accepted; one file more is a 413 FORM_TOO_MANY_FILES", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        async (count, cap) => {
          const entries = Array.from(
            { length: count },
            (_, index) => [`f${index}`, file(1)] as const,
          );
          const read = readFormLimited(multipartRequest(entries), {
            maxFileCount: cap,
            maxFields: 100,
          });
          if (count <= cap) {
            await expect(read).resolves.toBeDefined();
          } else {
            const error = await rejectionOf(read);
            expect(error.status).toBe(413);
            expect(error.data).toEqual({ code: "FORM_TOO_MANY_FILES" });
          }
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-04] a file at the maxFileBytes cap is accepted; one byte more is a 413 FORM_FILE_TOO_LARGE", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 64 }),
        fc.integer({ min: 0, max: 64 }),
        async (size, cap) => {
          const read = readFormLimited(multipartRequest([["upload", file(size)]]), {
            maxFileBytes: cap,
          });
          if (size <= cap) {
            await expect(read).resolves.toBeDefined();
          } else {
            const error = await rejectionOf(read);
            expect(error.status).toBe(413);
            expect(error.data).toEqual({ code: "FORM_FILE_TOO_LARGE" });
          }
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-05] a text field at the maxFieldBytes cap is accepted, counted in UTF-8 bytes; one byte more is a 413 FORM_FIELD_TOO_LARGE", async () => {
    await fc.assert(
      fc.asyncProperty(
        text(40),
        fc.integer({ min: 0, max: 160 }),
        fc.constantFrom<Transport>("urlencoded", "multipart"),
        async (value, cap, kind) => {
          const bytes = encoder.encode(value).byteLength;
          const read = readFormLimited(textForm(kind, [["note", value]]), { maxFieldBytes: cap });
          if (bytes <= cap) {
            await expect(read).resolves.toBeDefined();
          } else {
            const error = await rejectionOf(read);
            expect(error.status).toBe(413);
            expect(error.data).toEqual({ code: "FORM_FIELD_TOO_LARGE" });
          }
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-06] text fields at the maxTotalFieldBytes cap are accepted; a total one byte more is a 413 FORM_FIELDS_TOO_LARGE", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(text(20), { maxLength: 6 }),
        fc.integer({ min: 0, max: 400 }),
        fc.constantFrom<Transport>("urlencoded", "multipart"),
        async (values, cap, kind) => {
          const total = values.reduce((sum, value) => sum + encoder.encode(value).byteLength, 0);
          const entries = values.map((value, index) => [`t${index}`, value] as const);
          const read = readFormLimited(textForm(kind, entries), { maxTotalFieldBytes: cap });
          if (total <= cap) {
            await expect(read).resolves.toBeDefined();
          } else {
            const error = await rejectionOf(read);
            expect(error.status).toBe(413);
            expect(error.data).toEqual({ code: "FORM_FIELDS_TOO_LARGE" });
          }
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-07] a body that is not a form type is a 415; the form types are accepted in any case, with parameters", async () => {
    const wrong = [
      "text/plain",
      "application/json",
      "application/xml",
      "application/octet-stream",
      "multipart/mixed; boundary=x",
      "multipart/form-data-extra",
    ];
    const accepted = [
      "application/x-www-form-urlencoded",
      "APPLICATION/X-WWW-FORM-URLENCODED; charset=utf-8",
      "  application/x-www-form-urlencoded  ",
    ];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...wrong), async (type) => {
        const request = new Request(FORM_URL, {
          method: "POST",
          headers: { "content-type": type },
          body: "a=1",
        });
        const error = await rejectionOf(readFormLimited(request));
        expect(error.status).toBe(415);
        expect(error.message).toBe("Expected a form body");
      }),
      SEED,
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...accepted), async (type) => {
        const request = new Request(FORM_URL, {
          method: "POST",
          headers: { "content-type": type },
          body: "a=1",
        });
        await expect(readFormLimited(request)).resolves.toEqual({ a: "1" });
      }),
      SEED,
    );
  });

  it("[FUZZ-FORM-08] a multipart body that does not parse is a 400 Invalid form body, never a 500", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), async (body) => {
        // The boundary below never occurs in the text, so no part can parse.
        const request = new Request(FORM_URL, {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=FUZZ-NEVER-PRESENT" },
          body,
        });
        const error = await rejectionOf(readFormLimited(request));
        expect(error.status).toBe(400);
        expect(error.message).toBe("Invalid form body");
      }),
      SEED,
    );
    const noBoundary = new Request(FORM_URL, {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n',
    });
    expect((await rejectionOf(readFormLimited(noBoundary))).status).toBe(400);
  });

  it("[FUZZ-FORM-09] a key that repeats is an array of its values in order; a key that appears once is a string", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom("a", "b", "tag"), text(8)), { maxLength: 20 }),
        fc.constantFrom<Transport>("urlencoded", "multipart"),
        async (list, kind) => {
          const grouped = new Map<string, string[]>();
          for (const [key, value] of list) grouped.set(key, [...(grouped.get(key) ?? []), value]);
          const expected: Record<string, string | string[]> = {};
          for (const [key, values] of grouped)
            expected[key] = values.length === 1 ? (values[0] as string) : values;
          const out = await readFormLimited(textForm(kind, list));
          expect(out).toEqual(expected);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-10] hostile keys never reach Object.prototype: the result has no prototype and no __proto__, constructor or prototype key", async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(...HOSTILE_KEYS), text(6)), { maxLength: 12 }),
        fc.constantFrom<Transport>("urlencoded", "multipart"),
        async (list, kind) => {
          const out = await readFormLimited(textForm(kind, list));
          expect(Object.getPrototypeOf(out)).toBe(null);
          expect(Object.keys(out)).not.toContain("__proto__");
          expect(Object.keys(out)).not.toContain("constructor");
          expect(Object.keys(out)).not.toContain("prototype");
          expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
          expect(({} as Record<string, unknown>)["ok"]).toBeUndefined();
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-11] a field name that holds U+FFFD (bytes that were not UTF-8) is a 400 Invalid form field name, not merged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 6 }).map((parts) => parts.join("")),
        fc.constantFrom("%FF", "%FE", "%C3"),
        async (prefix, bad) => {
          const request = new Request(FORM_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `${prefix}${bad}=v`,
          });
          const error = await rejectionOf(readFormLimited(request));
          expect(error.status).toBe(400);
          expect(error.message).toBe("Invalid form field name");
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-FORM-12] a default text field of 64 KiB is refused one byte over, with no caps given", async () => {
    const atCap = "x".repeat(64 * 1024);
    await expect(readFormLimited(textForm("urlencoded", [["note", atCap]]))).resolves.toBeDefined();
    const error = await rejectionOf(
      readFormLimited(textForm("urlencoded", [["note", `${atCap}x`]])),
    );
    expect(error.status).toBe(413);
    expect(error.data).toEqual({ code: "FORM_FIELD_TOO_LARGE" });
  });

  it("[FUZZ-FORM-13] an explicit undefined maxFields keeps the default field-count cap", async () => {
    // Minimal repro: a 1001-field form must be refused by the default maxFields (1000). Passing `maxFields: undefined`
    // overwrites the default in the caps spread (form.ts `...limits` after `...DEFAULT_FORM_LIMITS`), so the cap is
    // `undefined` and `entries > undefined` is always false. The form resolves instead of a 413.
    const pairs = Array.from({ length: 1001 }, (_, index) => [`k${index}`, "v"] as const);
    const options = { maxFields: undefined } as unknown as FormLimitsOptions;
    const error = await rejectionOf(readFormLimited(textForm("urlencoded", pairs), options));
    expect(error.status).toBe(413);
  });

  it("[FUZZ-FORM-14] an explicit undefined maxFieldBytes keeps the default text-field size cap", async () => {
    // Same mechanism as FUZZ-FORM-13: `maxFieldBytes: undefined` replaces the 64 KiB default, and `size > undefined`
    // is always false. A 70 KiB text field resolves instead of a 413 FORM_FIELD_TOO_LARGE.
    const big = "x".repeat(70 * 1024);
    const options = { maxFieldBytes: undefined } as unknown as FormLimitsOptions;
    const error = await rejectionOf(
      readFormLimited(textForm("urlencoded", [["note", big]]), options),
    );
    expect(error.status).toBe(413);
  });
});

describe("[FUZZ-FORM] structure of the form caps", () => {
  it("[FUZZ-FORM-15] the caps are the documented defaults: 1000 fields, 20 files, 10 MiB a file, 64 KiB a field, 1 MiB in total", () => {
    expect(DEFAULT_FORM_LIMITS).toEqual({
      maxFields: 1000,
      maxFileCount: 20,
      maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 64 * 1024,
      maxTotalFieldBytes: 1024 * 1024,
    });
    expect(Object.isFrozen(DEFAULT_FORM_LIMITS)).toBe(true);
  });
});
