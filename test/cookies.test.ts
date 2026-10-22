import { describe, expect, it } from "vitest";
import {
  COOKIE_LIMITS,
  createCookieSigner,
  parseCookies,
  serializeCookie,
} from "../src/server/index";
import { createTestCookieJar } from "../src/testing/index";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("cookie parsing", () => {
  it("[SCKY-01] reads pairs, decodes values, strips quotes and keeps the first of a repeated name", () => {
    const jar = parseCookies('a=1; b=hello%20world; c="quoted"; a=2; d=%E2%9C%93');
    expect([...jar]).toEqual([
      ["a", "1"],
      ["b", "hello world"],
      ["c", "quoted"],
      ["d", "✓"],
    ]);
  });

  it("[SCKY-02] invalid names, bare words and malformed escapes are skipped or kept literally, never thrown", () => {
    const jar = parseCookies("bad name=1; =x; novalue; ok=%E0%A4%A; also=%zz");
    expect(jar.get("ok")).toBeDefined();
    expect(jar.get("also")).toBe("%zz");
    expect(jar.has("bad name")).toBe(false);
    expect(jar.has("novalue")).toBe(false);
  });

  it("[SCKY-03] a cookie named __proto__ is data, not a prototype", () => {
    const jar = parseCookies("__proto__=polluted; constructor=x");
    expect(jar.get("__proto__")).toBe("polluted");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("[SCKY-04] bound: at most 50 cookies are read, and a header over 8 KiB is ignored", () => {
    const many = Array.from({ length: 80 }, (_unused, n) => `c${String(n)}=v`).join("; ");
    expect(parseCookies(many).size).toBe(COOKIE_LIMITS.maxCookies);
    expect(parseCookies(`a=${"x".repeat(COOKIE_LIMITS.maxHeaderLength)}`).size).toBe(0);
    expect(parseCookies(null).size).toBe(0);
  });
});

describe("cookie serializing", () => {
  it("[SCKY-10] defaults are HttpOnly; Secure; SameSite=Lax; Path=/", () => {
    expect(serializeCookie("a", "b")).toBe("a=b; Path=/; HttpOnly; Secure; SameSite=Lax");
  });

  it("[SCKY-11] every attribute is written; values are percent-encoded", () => {
    const text = serializeCookie("a", "x y;z", {
      domain: "example.com",
      path: "/app",
      maxAge: 60,
      expires: new Date(0),
      httpOnly: false,
      sameSite: "none",
      partitioned: true,
    });
    expect(text).toBe(
      "a=x%20y%3Bz; Path=/app; Domain=example.com; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=None; Partitioned",
    );
  });

  it("[SCKY-12] names, domains and paths that could inject an attribute or a header are rejected", () => {
    for (const name of ["a b", "a;b", "a=b", "a\r\nSet-Cookie: x", "", "é"])
      expect(() => serializeCookie(name, "v")).toThrow(TypeError);
    for (const domain of ["a.com; Path=/", "a b.com", "-bad.com", "a.com\r\n"])
      expect(() => serializeCookie("a", "v", { domain })).toThrow(/domain/);
    for (const path of ["app", "/a;b", "/a\r\n", "/a b"])
      expect(() => serializeCookie("a", "v", { path })).toThrow(/path/);
    expect(() => serializeCookie("a", "v", { maxAge: 1.5 })).toThrow(/integer/);
    expect(() => serializeCookie("a", "v", { expires: new Date(Number.NaN) })).toThrow(/date/);
  });

  it("[SCKY-13] prefix rules: __Host- needs Secure, Path=/ and no Domain; __Secure- needs Secure; SameSite=None needs Secure", () => {
    expect(serializeCookie("__Host-a", "v")).toContain("Secure");
    expect(() => serializeCookie("__Host-a", "v", { secure: false })).toThrow(/__Host-/);
    expect(() => serializeCookie("__Host-a", "v", { path: "/x" })).toThrow(/__Host-/);
    expect(() => serializeCookie("__Host-a", "v", { domain: "a.com" })).toThrow(/__Host-/);
    expect(() => serializeCookie("__Secure-a", "v", { secure: false })).toThrow(/__Secure-/);
    expect(() => serializeCookie("a", "v", { sameSite: "none", secure: false })).toThrow(
      /SameSite=None/,
    );
  });

  it("[SCKY-14] bound: a cookie over 4096 bytes is refused", () => {
    expect(() => serializeCookie("a", "x".repeat(COOKIE_LIMITS.maxNameValueLength))).toThrow(
      /COOKIE_TOO_LARGE/,
    );
    expect(serializeCookie("a", "x".repeat(100))).toContain("a=");
  });
});

describe("signed cookies", () => {
  it("[SCKY-20] a signed value verifies and is bound to its name", async () => {
    const signer = createCookieSigner([SECRET]);
    const signed = await signer.sign("sid", "abc");
    expect(await signer.unsign("sid", signed)).toBe("abc");
    expect(await signer.unsign("other", signed)).toBeUndefined();
  });

  it("[SCKY-21] tampering with the value, the signature or its encoding is detected", async () => {
    const signer = createCookieSigner([SECRET]);
    const signed = await signer.sign("sid", "abc");
    const dot = signed.lastIndexOf(".");
    const sig = signed.slice(dot + 1);
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    for (const bad of [
      `abd${signed.slice(3)}`,
      `${signed.slice(0, dot)}.${flipped}`,
      `${signed.slice(0, dot)}.`,
      signed.slice(0, dot),
      `${signed}x`,
      `abc.${"A".repeat(43)}`,
      "",
      ".",
      "a.b.c",
      `abc.${sig}%%%`,
    ]) {
      expect(await signer.unsign("sid", bad), bad).toBeUndefined();
    }
  });

  it("[SCKY-22] a value containing dots is handled (the signature is the last segment)", async () => {
    const signer = createCookieSigner([SECRET]);
    const signed = await signer.sign("v", "a.b.c");
    expect(await signer.unsign("v", signed)).toBe("a.b.c");
  });

  it("[SCKY-23] rotation: the first secret signs, every secret verifies", async () => {
    const old = "o".repeat(40);
    const fresh = "n".repeat(40);
    const oldSigned = await createCookieSigner([old]).sign("sid", "x");
    expect(await createCookieSigner([fresh, old]).unsign("sid", oldSigned)).toBe("x");
    expect(await createCookieSigner([fresh]).unsign("sid", oldSigned)).toBeUndefined();
    const newSigned = await createCookieSigner([fresh, old]).sign("sid", "y");
    expect(await createCookieSigner([fresh]).unsign("sid", newSigned)).toBe("y");
  });

  it("[SCKY-24] missing and weak secrets are refused with a code", () => {
    expect(() => createCookieSigner([])).toThrow(/COOKIE_SECRET_MISSING/);
    expect(() => createCookieSigner(["too short"])).toThrow(/COOKIE_SECRET_WEAK/);
  });
});

describe("test cookie jar", () => {
  const url = new URL("https://app.test/a/b");

  it("[SCKY-30] stores, sends by path and domain, honors Max-Age and Expires, and removes on expiry", () => {
    let now = 1_000_000;
    const jar = createTestCookieJar(() => now);
    jar.ingest(url, [
      "a=1; Path=/a; Max-Age=10",
      "b=2; Path=/",
      "c=3; Domain=app.test; Path=/",
      "d=4; Path=/other",
    ]);
    expect(jar.header(url)).toBe("a=1; b=2; c=3");
    expect(jar.header(new URL("https://sub.app.test/"))).toBe("c=3");
    now += 11_000;
    expect(jar.header(url)).toBe("b=2; c=3");
    jar.ingest(url, ["b=; Max-Age=0"]);
    expect(jar.get("b", url)).toBeUndefined();
  });

  it("[SCKY-31] Secure cookies are refused over http (localhost excepted) and a foreign Domain is refused", () => {
    const jar = createTestCookieJar();
    jar.ingest(new URL("http://app.test/"), ["s=1; Secure"]);
    expect(jar.all()).toHaveLength(0);
    jar.ingest(new URL("http://localhost/"), ["s=1; Secure"]);
    expect(jar.all()).toHaveLength(1);
    jar.ingest(url, ["x=1; Domain=evil.test"]);
    expect(jar.get("x", url)).toBeUndefined();
  });
});
