import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkRedirectTarget,
  RedirectBlockedError,
  type RedirectPolicy,
  resolveRedirectTarget,
} from "../../src/server/redirect-target";

/**
 * Property tests for redirect target validation (open redirect and host allowlist).
 * Invariants: no unexpected error type, a string or a RedirectBlockedError for every input, no control
 * characters in an allowed target, no off-origin absolute target, and idempotent output.
 */

const SEED = { seed: 20261014, numRuns: 300 };

const POLICY: RedirectPolicy = {
  origin: "https://app.example",
  trustedOrigins: new Set(["https://cdn.example", "http://static.example:8080"]),
};

const ALLOWED_ORIGINS = new Set([POLICY.origin, ...POLICY.trustedOrigins]);

const ADVERSARIAL = [
  "//evil.example",
  "///evil.example",
  "/\\evil.example",
  "\\\\evil.example",
  "/%5cevil.example",
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "http:evil.example",
  "https:evil.example",
  "https://user:pass@app.example/",
  "https://app.example@evil.example/",
  "https://evil.example\\@app.example/",
  "http://app.example.evil.example/",
  " //evil.example",
  "//evil.example ",
  "/ok\r\nSet-Cookie: x=1",
  "/ok\u0000//evil.example",
  "/\u0009/evil.example",
  "https://cdn.example/a.js",
  "http://static.example:8080/x",
  "http://static.example/x",
  "/",
  "/login?next=/home",
];

/** A target built from adversarial pieces and arbitrary text, so the generator covers both. */
const targetArb = fc.oneof(
  fc.constantFrom(...ADVERSARIAL),
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.webUrl(),
  fc
    .tuple(fc.constantFrom("/", "//", "/\\", "\\"), fc.string({ unit: "grapheme", maxLength: 20 }))
    .map(([a, b]) => a + b),
);

function originOf(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  return new URL(value).origin;
}

describe("redirect target validation", () => {
  it("[FUZZ-REDIR-01] every input gives a string or RedirectBlockedError, never another throw", () => {
    fc.assert(
      fc.property(targetArb, (target) => {
        const result = checkRedirectTarget(target, POLICY);
        expect(typeof result === "string" || result instanceof RedirectBlockedError).toBe(true);
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-02] resolveRedirectTarget throws only RedirectBlockedError", () => {
    fc.assert(
      fc.property(targetArb, (target) => {
        try {
          const value = resolveRedirectTarget(target, POLICY);
          expect(typeof value).toBe("string");
        } catch (error) {
          expect(error).toBeInstanceOf(RedirectBlockedError);
          expect((error as RedirectBlockedError).code).toBe("REDIRECT_TARGET_BLOCKED");
        }
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-03] an allowed target never contains a control character or a backslash", () => {
    fc.assert(
      fc.property(targetArb, (target) => {
        const result = checkRedirectTarget(target, POLICY);
        if (typeof result !== "string") return;
        expect(result).not.toMatch(/[\u0000-\u001f\u007f\\]/);
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-04] a control character anywhere in the target is always refused", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 20 }),
        fc.integer({ min: 0, max: 31 }),
        fc.string({ unit: "grapheme", maxLength: 20 }),
        (head, code, tail) => {
          const target = `/${head}${String.fromCharCode(code)}${tail}`;
          expect(checkRedirectTarget(target, POLICY)).toBeInstanceOf(RedirectBlockedError);
        },
      ),
      SEED,
    );
  });

  it("[FUZZ-REDIR-05] a protocol-relative target is refused for every host", () => {
    fc.assert(
      fc.property(fc.domain(), fc.webPath(), (host, path) => {
        expect(checkRedirectTarget(`//${host}${path}`, POLICY)).toBeInstanceOf(
          RedirectBlockedError,
        );
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-06] an absolute allowed result has an allowed origin, http(s), and no user info", () => {
    fc.assert(
      fc.property(targetArb, (target) => {
        const result = checkRedirectTarget(target, POLICY);
        if (typeof result !== "string") return;
        const origin = originOf(result);
        if (origin === undefined) return;
        expect(ALLOWED_ORIGINS.has(origin)).toBe(true);
        const url = new URL(result);
        expect(url.protocol === "http:" || url.protocol === "https:").toBe(true);
        expect(url.username).toBe("");
        expect(url.password).toBe("");
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-07] an absolute target on an arbitrary host is refused unless its origin is allowed", () => {
    fc.assert(
      fc.property(fc.webUrl(), (target) => {
        const result = checkRedirectTarget(target, POLICY);
        const origin = new URL(target).origin;
        if (ALLOWED_ORIGINS.has(origin)) {
          expect(typeof result).toBe("string");
        } else {
          expect(result).toBeInstanceOf(RedirectBlockedError);
        }
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-08] allowed output is idempotent: checking the result again returns the same value", () => {
    fc.assert(
      fc.property(targetArb, (target) => {
        const first = checkRedirectTarget(target, POLICY);
        if (typeof first !== "string") return;
        expect(checkRedirectTarget(first, POLICY)).toBe(first);
      }),
      SEED,
    );
  });

  it("[FUZZ-REDIR-09] a same-site path target is returned unchanged", () => {
    fc.assert(
      fc.property(fc.webPath(), (path) => {
        const target = path.startsWith("//") || path.includes("\\") ? `/x${path}` : path;
        if (/[\u0000-\u001f\u007f\\]/.test(target)) return;
        if (target.startsWith("/")) {
          expect(checkRedirectTarget(target, POLICY)).toBe(target);
        }
      }),
      SEED,
    );
  });
});
