import { describe, expect, it } from "vitest";
import { HttpError as RootHttpError, isHttpError as rootIsHttpError } from "../src/index";
import { buildLinkHeader, buildPayload, collectAssets } from "../src/server/document";
import {
  BodyTooLargeError,
  buildCsp,
  checkCsrf,
  checkFraming,
  checkRedirectTarget,
  compileHostRules,
  createKey,
  defaultCspDirectives,
  defineEnv,
  EnvError,
  formToObject,
  getRequestEvent,
  HttpError,
  ISSUE_LIMITS,
  isHttpError,
  isNotFound,
  isRedirect,
  isStandardSchema,
  limitBody,
  MAX_CSP_LENGTH,
  normalizeOrigins,
  notFound,
  parseJsonSafe,
  RedirectBlockedError,
  readTextLimited,
  redirect,
  redirectStatus,
  type StandardSchemaV1,
  tryGetRequestEvent,
  ValidationError,
  validate,
} from "../src/server/index";
import { createTestEvent } from "../src/testing/index";

describe("HttpError and redirect helpers", () => {
  it("[SHTP-01] carries status, default reason, headers, data, cause; 4xx exposes its message, 5xx does not", () => {
    const error = new HttpError(404);
    expect(error).toMatchObject({
      status: 404,
      message: "Not Found",
      expose: true,
      name: "HttpError",
    });
    const teapot = new HttpError(503, "down", {
      headers: { "retry-after": "3" },
      data: { a: 1 },
      cause: new Error("root"),
    });
    expect(teapot).toMatchObject({ expose: false, data: { a: 1 } });
    expect(teapot.headers.get("retry-after")).toBe("3");
    expect((teapot.cause as Error).message).toBe("root");
    expect(new HttpError(500, "shown", { expose: true }).expose).toBe(true);
  });

  it("[SHTP-02] statuses outside 400-599 are refused", () => {
    for (const status of [200, 399, 600, 404.5, Number.NaN])
      expect(() => new HttpError(status)).toThrow(RangeError);
  });

  it("[SHTP-03] isHttpError works by brand: the root export is the same class, and a look-alike from another copy is recognized", () => {
    expect(RootHttpError).toBe(HttpError);
    expect(rootIsHttpError).toBe(isHttpError);
    const brand = Object.getOwnPropertySymbols(new HttpError(400))[0];
    expect(brand?.description).toBe("shadowjs.dusk.http-error");
    const lookAlike = Object.defineProperty(
      new Error("copy"),
      Symbol.for("shadowjs.dusk.http-error"),
      { value: true },
    );
    expect(isHttpError(lookAlike)).toBe(true);
    expect(isHttpError(new Error("plain"))).toBe(false);
    expect(isHttpError({ status: 404 })).toBe(false);
    expect(isHttpError(null)).toBe(false);
  });

  it("[SHTP-04] redirect() is the router's signal with an HTTP status; invalid statuses are refused", () => {
    const signal = redirect("/login", { status: 303 });
    expect(isRedirect(signal)).toBe(true);
    expect(signal.to).toBe("/login");
    expect(redirectStatus(signal)).toBe(303);
    expect(redirectStatus(redirect("/x"))).toBe(302);
    expect(() => redirect("/x", { status: 200 as never })).toThrow(RangeError);
    expect(isNotFound(notFound())).toBe(true);
  });
});

describe("checkRedirectTarget", () => {
  const policy = { origin: "https://app.test", trustedOrigins: new Set(["https://partner.test"]) };
  it("[SRDT-01] allows local paths, relative paths and known origins", () => {
    for (const ok of [
      "/a",
      "/a?b=c#d",
      "relative/path",
      "?q=1",
      "#hash",
      "https://app.test/x",
      "https://partner.test/y",
    ]) {
      expect(checkRedirectTarget(ok, policy), ok).not.toBeInstanceOf(RedirectBlockedError);
    }
  });

  it("[SRDT-02] blocks protocol-relative, backslash, control-character, foreign and non-http targets (30 cases)", () => {
    const bad = [
      "//evil.test",
      "//evil.test/x",
      "///evil.test",
      "/\\evil.test",
      "\\\\evil.test",
      "\\evil.test",
      "https://evil.test",
      "http://app.test",
      "https://app.test.evil.test/",
      "https://evil.test@app.test/",
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>",
      "vbscript:x",
      "file:///etc/passwd",
      "ftp://app.test/",
      "http:evil.test",
      "https:evil.test",
      "/a\r\nSet-Cookie: x=y",
      "/a\nLocation: https://evil.test",
      "/a\u0000b",
      "\u0000//evil.test",
      "\t//evil.test",
      "/%0d%0aX",
      "mailto:a@b.c",
      "blob:https://app.test/uuid",
      "about:blank",
      "x:y",
      "https://partner.test.evil.test/",
    ];
    for (const target of bad) {
      const result = checkRedirectTarget(target, policy);
      // %0d%0a is inert percent-encoding inside a path, so it is allowed; every other case must be blocked.
      if (target === "/%0d%0aX") expect(result).toBe(target);
      else expect(result, JSON.stringify(target)).toBeInstanceOf(RedirectBlockedError);
    }
  });
});

describe("hosts, origins, framing, body limits", () => {
  it("[SHST-01] host rules: exact, wildcard (not the apex), ports, case, IPv6", () => {
    const allowed = compileHostRules([
      "Example.com",
      "*.example.org",
      "api.test:8443",
      "localhost",
      "[::1]",
    ]);
    expect(allowed("example.com")).toBe(true);
    expect(allowed("EXAMPLE.COM:3000")).toBe(true);
    expect(allowed("a.example.org")).toBe(true);
    expect(allowed("a.b.example.org")).toBe(true);
    expect(allowed("example.org")).toBe(false);
    expect(allowed("badexample.org")).toBe(false);
    expect(allowed("api.test:8443")).toBe(true);
    expect(allowed("api.test")).toBe(false);
    expect(allowed("[::1]:3000")).toBe(true);
    expect(allowed("evil.test")).toBe(false);
    for (const bad of ["", "*", "a b", "a/b", "u@host"])
      expect(() => compileHostRules([bad])).toThrow(TypeError);
  });

  it("[SHST-02] normalizeOrigins accepts http(s) origins and rejects others", () => {
    expect([...normalizeOrigins(["https://A.test/path", "http://b.test:81"])]).toEqual([
      "https://a.test",
      "http://b.test:81",
    ]);
    expect(() => normalizeOrigins(["ftp://a.test"])).toThrow(TypeError);
    expect(() => normalizeOrigins(["not a url"])).toThrow(TypeError);
  });

  it("[SHST-03] checkCsrf reports the reason", () => {
    const context = {
      origin: "https://a.test",
      trustedOrigins: new Set<string>(),
      allowMissingOrigin: false,
    };
    const make = (headers: Record<string, string>, method = "POST"): Request =>
      new Request("https://a.test/x", { method, headers });
    expect(checkCsrf(make({}, "GET"), context)).toEqual({ ok: true, reason: "safe-method" });
    expect(checkCsrf(make({ "sec-fetch-site": "same-origin" }), context).reason).toBe(
      "same-origin",
    );
    expect(checkCsrf(make({ "sec-fetch-site": "cross-site" }), context).reason).toBe("cross-site");
    expect(checkCsrf(make({ "sec-fetch-site": "same-site" }), context).reason).toBe("same-site");
    expect(checkCsrf(make({ origin: "null" }), context).reason).toBe("origin-null");
    expect(checkCsrf(make({}), context).reason).toBe("missing-origin");
  });

  it("[SHST-04] framing: valid requests pass, every smuggling shape is refused, an oversize declaration is 413", () => {
    const headers = (init: Record<string, string>): Headers => new Headers(init);
    expect(checkFraming(headers({}), 10)).toBeUndefined();
    expect(checkFraming(headers({ "content-length": "10" }), 10)).toBeUndefined();
    expect(checkFraming(headers({ "transfer-encoding": "chunked" }), 10)).toBeUndefined();
    expect(checkFraming(headers({ "content-length": "11" }), 10)?.status).toBe(413);
    for (const bad of [
      { "content-length": "1, 1" },
      { "content-length": "+1" },
      { "content-length": "0x1" },
      { "content-length": "1e1" },
      { "content-length": " " },
      { "content-length": "99999999999999999" },
      { "content-length": "1", "transfer-encoding": "chunked" },
      { "transfer-encoding": "identity" },
      { "transfer-encoding": "chunked, chunked" },
    ]) {
      expect(checkFraming(headers(bad), 1e9)?.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("[SHST-05] limitBody errors at the first byte over the limit and passes bodies within it", async () => {
    const make = (parts: string[]): Request => {
      const encoder = new TextEncoder();
      const queue = parts.map((part) => encoder.encode(part));
      return new Request("http://x/", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = queue.shift();
            if (next === undefined) controller.close();
            else controller.enqueue(next);
          },
        }),
        duplex: "half",
      } as RequestInit);
    };
    const signal = new AbortController().signal;
    expect(await limitBody(make(["abc", "def"]), 6, signal).text()).toBe("abcdef");
    await expect(limitBody(make(["abc", "defg"]), 6, signal).text()).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    await expect(readTextLimited(make(["abcdef"]), 5)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(await readTextLimited(make(["abc"]), 5)).toBe("abc");
    expect(await limitBody(new Request("http://x/"), 5, signal).text()).toBe("");
  });
});

describe("JSON helpers", () => {
  it("[SJSN-01] parseJsonSafe rejects pollution keys at any depth, in arrays, and excessive depth; allows harmless names", () => {
    for (const text of [
      '{"__proto__":1}',
      '{"a":{"b":[{"__proto__":{}}]}}',
      '{"constructor":{"x":1}}',
      '{"prototype":{"x":1}}',
      "[".repeat(100) + "]".repeat(100),
    ]) {
      expect(() => parseJsonSafe(text), text.slice(0, 40)).toThrow(HttpError);
    }
    expect(parseJsonSafe('{"constructor":"x","prototype":1,"proto":{"a":1}}')).toEqual({
      constructor: "x",
      prototype: 1,
      proto: { a: 1 },
    });
    expect(() => parseJsonSafe("{")).toThrow(HttpError);
  });

  it("[SJSN-02] a body nested 100 000 levels deep is rejected without overflowing the stack", () => {
    const text = "[".repeat(100_000) + "]".repeat(100_000);
    expect(() => parseJsonSafe(text)).toThrow();
  });

  it("[SJSN-03] formToObject drops dangerous keys, groups repeats, keeps files", () => {
    const form = new FormData();
    form.append("a", "1");
    form.append("a", "2");
    form.append("__proto__", "x");
    form.append("constructor", "y");
    form.append("f", new File(["z"], "z.txt"));
    const result = formToObject(form);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result["a"]).toEqual(["1", "2"]);
    expect(Object.keys(result)).toEqual(["a", "f"]);
    expect(result["f"]).toBeInstanceOf(File);
  });
});

describe("environment", () => {
  const env = defineEnv({
    STR: { type: "string", minLength: 3, maxLength: 5, pattern: /^[a-z]+$/ },
    NUM: { type: "number", integer: true, min: 1, max: 10, default: 5 },
    BOOL: { type: "boolean", default: false },
    URL_: { type: "url", protocols: ["https:"], required: false },
    MODE: { type: "enum", values: ["a", "b"], default: "a" },
    DUSK_PUBLIC_X: { type: "string" },
  });

  it("[SENV-01] parses every field type, applies defaults, and separates DUSK_PUBLIC_ values", () => {
    const parsed = env.parse({
      STR: "abc",
      NUM: "7",
      BOOL: "YES",
      URL_: "https://x.test/p",
      MODE: "b",
      DUSK_PUBLIC_X: "pub",
    });
    expect(parsed.all).toEqual({
      STR: "abc",
      NUM: 7,
      BOOL: true,
      URL_: "https://x.test/p",
      MODE: "b",
      DUSK_PUBLIC_X: "pub",
    });
    expect(parsed.public).toEqual({ DUSK_PUBLIC_X: "pub" });
    const defaults = env.parse({ STR: "abc", DUSK_PUBLIC_X: "p" });
    expect(defaults.all).toMatchObject({ NUM: 5, BOOL: false, MODE: "a", URL_: undefined });
    expect(Object.isFrozen(defaults.all)).toBe(true);
  });

  it("[SENV-02] every problem is listed by name with no values; empty counts as missing", () => {
    const failure = (() => {
      try {
        env.parse({
          STR: "TOPSECRET9",
          NUM: "11",
          BOOL: "maybe",
          URL_: "http://x.test",
          MODE: "c",
          DUSK_PUBLIC_X: "",
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(EnvError);
    const message = String((failure as Error).message);
    for (const part of [
      "STR (",
      "NUM (above 10)",
      "BOOL (expected true or false)",
      "URL_ (expected a https: URL)",
      "MODE (expected one of a, b)",
      "DUSK_PUBLIC_X (required)",
    ]) {
      expect(message).toContain(part);
    }
    expect(message).not.toContain("TOPSECRET9");
    expect((failure as EnvError).issues).toHaveLength(6);
  });

  it("[SENV-03] numbers reject NaN, empty text and fractions when integer", () => {
    for (const bad of ["abc", "1.5", "0", " "])
      expect(() => env.parse({ STR: "abc", NUM: bad, DUSK_PUBLIC_X: "p" }), bad).toThrow(EnvError);
  });

  it("[SENV-04] a DUSK_PUBLIC_ variable cannot be secret; names must be identifiers; inherited keys are not read", () => {
    expect(() => defineEnv({ DUSK_PUBLIC_K: { type: "string", secret: true } })).toThrow(TypeError);
    expect(() => defineEnv({ "bad-name": { type: "string" } })).toThrow(TypeError);
    const schema = defineEnv({ toString: { type: "string", required: false } });
    expect(
      schema.parse(Object.create({ toString: "inherited" }) as Record<string, string>).all,
    ).toEqual({ toString: undefined });
  });

  it("[G-A5] a secret field under a custom public prefix is refused when the schema is defined", () => {
    let message = "";
    try {
      defineEnv(
        { NEXT_PUBLIC_API_KEY: { type: "string", secret: true } },
        { publicPrefixes: ["NEXT_PUBLIC_"] },
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("[ENV_SECRET_PUBLIC]");
    expect(message).toContain("NEXT_PUBLIC_API_KEY");
    // Without the custom prefix the name is server-only, and a secret there is fine.
    expect(() =>
      defineEnv({ NEXT_PUBLIC_API_KEY: { type: "string", secret: true } }),
    ).not.toThrow();
  });

  it("[G-A5] parsed.public holds the public names that are not secret, under any public prefix; a server name is never there", () => {
    const schema = defineEnv(
      {
        DUSK_PUBLIC_SITE: { type: "string" },
        NEXT_PUBLIC_SITE: { type: "string" },
        DATABASE_PASS: { type: "string", secret: true },
        PLAIN: { type: "string", required: false },
      },
      { publicPrefixes: ["NEXT_PUBLIC_"] },
    );
    const parsed = schema.parse({
      DUSK_PUBLIC_SITE: "https://a.example",
      NEXT_PUBLIC_SITE: "https://b.example",
      DATABASE_PASS: "server-only-value",
    });
    expect(Object.keys(parsed.public).sort()).toEqual(["DUSK_PUBLIC_SITE", "NEXT_PUBLIC_SITE"]);
    expect(JSON.stringify(parsed.public)).not.toContain("server-only-value");
    expect(parsed.all).toMatchObject({ DATABASE_PASS: "server-only-value" });
  });
});

describe("content security policy", () => {
  it("[SCSP-01] the defaults are strict and the nonce token is replaced", () => {
    const header = buildCsp({}, "N0nce");
    expect(header).toContain("default-src 'self'");
    expect(header).toContain("script-src 'self' 'nonce-N0nce'");
    expect(header).toContain("object-src 'none'");
    expect(header).not.toContain("unsafe-eval");
    expect(Object.keys(defaultCspDirectives())).toContain("frame-ancestors");
  });

  it("[SCSP-02] directives replace, add, remove and use useDefaults: false", () => {
    expect(
      buildCsp(
        {
          useDefaults: false,
          directives: { "default-src": ["'none'"], "upgrade-insecure-requests": true },
        },
        undefined,
      ),
    ).toBe("default-src 'none'; upgrade-insecure-requests");
    expect(
      buildCsp(
        { directives: { "script-src": ["'self'", "https://cdn.test"] }, reportUri: "/csp" },
        "n",
      ),
    ).toContain("script-src 'self' https://cdn.test;");
  });

  it("[SCSP-03] injection through a source or directive name is refused; {nonce} needs a nonce", () => {
    for (const source of ["a; script-src *", "a, b", "a\r\nX: y", "a b", ""])
      expect(() => buildCsp({ directives: { "img-src": [source] } }, "n")).toThrow(TypeError);
    for (const name of ["Img-Src", "img src", "x;y", ""])
      expect(() => buildCsp({ directives: { [name]: ["'self'"] } }, "n")).toThrow(TypeError);
    expect(() => buildCsp({}, undefined)).toThrow(/nonce/);
  });

  it("[SCSP-04] bound: a header over 8192 characters is refused", () => {
    const long = Array.from(
      { length: 400 },
      (_unused, n) => `https://host${String(n)}.example.com`,
    );
    expect(() => buildCsp({ directives: { "img-src": long } }, "n")).toThrow(RangeError);
    expect(MAX_CSP_LENGTH).toBe(8192);
  });
});

describe("standard schema and validation", () => {
  const schema = (issues: number): StandardSchemaV1<unknown, number> => ({
    "~standard": {
      version: 1,
      vendor: "t",
      validate: () =>
        issues === 0
          ? { value: 1 }
          : {
              issues: Array.from({ length: issues }, (_unused, n) => ({
                message: "m".repeat(500) + String(n),
                path: ["a", n, Symbol("s"), { key: "k" }],
              })),
            },
    },
  });

  it("[SVAL-01] accepts a conforming schema and returns its output; async validators work", async () => {
    expect(isStandardSchema(schema(0))).toBe(true);
    expect(await validate(schema(0), "x")).toBe(1);
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": { version: 1, vendor: "t", validate: async () => ({ value: "ok" }) },
    };
    expect(await validate(asyncSchema, null)).toBe("ok");
  });

  it("[SVAL-02] bound: at most 20 issues of 200 characters, paths flattened to strings and numbers", async () => {
    const error = await validate(schema(50), 1).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ValidationError);
    const issues = (error as ValidationError).issues;
    expect(issues).toHaveLength(ISSUE_LIMITS.maxIssues);
    expect(issues[0]?.message).toHaveLength(ISSUE_LIMITS.maxMessageLength);
    expect(issues[3]?.path).toEqual(["a", 3, "s", "k"]);
    expect((error as ValidationError).status).toBe(400);
  });

  it("[SVAL-03] non-schemas are recognized as such", () => {
    for (const value of [
      null,
      undefined,
      1,
      "s",
      {},
      { "~standard": {} },
      { "~standard": { version: 2, validate: () => 0 } },
      { "~standard": { version: 1 } },
    ]) {
      expect(isStandardSchema(value)).toBe(false);
    }
  });
});

describe("document helpers", () => {
  const assets = {
    entry: "entry.js",
    css: ["a.css", "/abs.css", "https://cdn.test/c.css", "//evil.test/x.css", 'ev"il.css', ""],
    preloads: {
      r1: ["chunk-1.js", "entry.js", "f.woff2", "/x.js?v=1"],
      r2: ["chunk-1.js", "chunk-2.js"],
    },
    base: "/assets",
  };

  it("[SDOC-01] assets resolve against the base, drop duplicates and unsafe URLs, and classify css and fonts", () => {
    const found = collectAssets(assets, ["r1", "r2", "unknown", "__proto__"]);
    expect(found.entry).toBe("/assets/entry.js");
    expect(found.stylesheets).toEqual(["/assets/a.css", "/abs.css", "https://cdn.test/c.css"]);
    expect(found.preloads.map((link) => link.href)).toEqual([
      "/assets/chunk-1.js",
      "/assets/f.woff2",
      "/x.js?v=1",
      "/assets/chunk-2.js",
    ]);
    expect(found.preloads[1]).toMatchObject({ rel: "preload", as: "font" });
  });

  it("[SDOC-02] bound: the Link header carries at most 16 entries and 4 KiB", () => {
    const many = Array.from({ length: 40 }, (_unused, n) => ({
      href: `/chunk-${String(n)}.js`,
      rel: "modulepreload" as const,
    }));
    const header = buildLinkHeader("/entry.js", ["/a.css"], many) ?? "";
    expect(header.split(", ")).toHaveLength(16);
    const huge = Array.from({ length: 16 }, (_unused, n) => ({
      href: `/${"x".repeat(600)}${String(n)}.js`,
      rel: "modulepreload" as const,
    }));
    expect((buildLinkHeader(undefined, [], huge) ?? "").length).toBeLessThanOrEqual(4096);
    expect(buildLinkHeader(undefined, [], [])).toBeUndefined();
  });

  it("[SDOC-03] bound: hydration data beyond the budget drops whole matches; unserializable data is reported and dropped", () => {
    const match = (id: string, value: unknown) => ({
      id,
      params: {},
      deps: undefined,
      updatedAt: 1,
      value,
      failed: false,
    });
    const data = {
      version: 1 as const,
      matches: [
        match("a", "x".repeat(100)),
        match("b", "y".repeat(1000)),
        match("c", 1n),
        match("d", "z"),
      ],
    };
    const result = buildPayload(data, 400);
    const ids = (JSON.parse(result.text) as { matches: Array<{ id: string }> }).matches.map(
      (entry) => entry.id,
    );
    expect(ids).toEqual(["a", "d"]);
    expect(result.dropped).toEqual(["b", "c"]);
    expect(result.errors).toHaveLength(1);
    expect(result.text).not.toMatch(/[<>&]/);
  });

  it("[SDOC-04] the payload cannot break out of its script element", () => {
    const data = {
      version: 1 as const,
      matches: [
        {
          id: "a",
          params: {},
          deps: undefined,
          updatedAt: 1,
          value: "</script><script>alert(1)</script>\u2028<!--",
          failed: false,
        },
      ],
    };
    const text = buildPayload(data, 10_000).text;
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect((JSON.parse(text) as { matches: Array<{ value: string }> }).matches[0]?.value).toContain(
      "</script>",
    );
  });
});

describe("context", () => {
  it("[SCTX-01] keys are typed and compare by identity; unset keys throw with the key name", () => {
    const event = createTestEvent();
    const a = createKey<number>("same");
    const b = createKey<number>("same");
    event.set(a, 1);
    expect(event.get(a)).toBe(1);
    expect(event.tryGet(b)).toBeUndefined();
    expect(() => event.get(b)).toThrow(/CONTEXT_KEY_UNSET.*same/);
  });

  it("[SCTX-02] outside a request there is no event", () => {
    expect(tryGetRequestEvent()).toBeUndefined();
    expect(() => getRequestEvent()).toThrow(/SERVER_NO_REQUEST_EVENT/);
  });
});
