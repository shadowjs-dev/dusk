import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeFetch } from "../../src/adapter/native";
import { staticPagesOf } from "../../src/adapter/static-pages";
import type { Handler } from "../../src/server/types";
import { validateRouting } from "../../src/shared/routing-config";
import { readEntryStatic } from "../../src/vite/entry-static-options";

/**
 * B2: the build decides how each prerendered page is answered from the entry's options too (`src/entry-server.ts`
 * is merged over `dusk.config.ts` at run time). The entry is read, never run. A value the build cannot evaluate
 * makes every page handler-rendered, and a value that cannot change a static page's answer is not read at all.
 */

describe("the entry's options that decide a static page", () => {
  it("[ESO-1] an entry with no options export and no default export sets nothing", () => {
    expect(readEntryStatic(`export const prerender = true;`)).toEqual({
      options: {},
      reason: undefined,
    });
  });

  it("[ESO-2] an empty default export sets nothing", () => {
    expect(readEntryStatic(`export default {};`)).toEqual({ options: {}, reason: undefined });
  });

  it("[ESO-3] an empty middleware array runs nothing", () => {
    expect(readEntryStatic(`export const options = { middleware: [] };`).reason).toBeUndefined();
    expect(readEntryStatic(`export const options = { middleware: null };`).reason).toBeUndefined();
  });

  it("[ESO-4] a non-empty global middleware makes every page handler-rendered (named in the reason)", () => {
    const reading = readEntryStatic(
      `import { host } from "./host"; export const options = { middleware: [host] };`,
    );
    expect(reading.reason).toMatch(/global middleware/);
  });

  it("[ESO-5] a middleware array the build cannot read (a call, an import) is not assumed empty", () => {
    expect(
      readEntryStatic(`export const options = { middleware: makeChain() };`).reason,
    ).toBeDefined();
    expect(
      readEntryStatic(`import chain from "./chain"; export const options = { middleware: chain };`)
        .reason,
    ).toBeDefined();
  });

  it("[ESO-6] a middleware array named through a variable is read through it", () => {
    const reading = readEntryStatic(
      `const chain = [(event, next) => next()]; export const options = { middleware: chain };`,
    );
    expect(reading.reason).toMatch(/global middleware/);
  });

  it("[ESO-7] literal security headers, csp and routing are read as data", () => {
    const reading = readEntryStatic(
      [
        "export const options = {",
        '  security: { headers: { frameOptions: "DENY" }, csp: { useDefaults: true, directives: { "img-src": ["data:"] } } },',
        '  routing: { headers: [{ source: "/x", headers: { "x-a": "1" } }] },',
        '  trustedOrigins: ["https://partner.example"],',
        "};",
      ].join("\n"),
    );
    expect(reading.reason).toBeUndefined();
    expect(reading.options.security).toEqual({
      headers: { frameOptions: "DENY" },
      csp: { useDefaults: true, directives: { "img-src": ["data:"] } },
    });
    expect(reading.options.routing).toEqual({
      headers: [{ source: "/x", headers: { "x-a": "1" } }],
    });
    expect(reading.options.trustedOrigins).toEqual(["https://partner.example"]);
  });

  it("[ESO-8] a security header or csp the build cannot evaluate makes every page handler-rendered", () => {
    expect(
      readEntryStatic(`export const options = { security: { headers: buildHeaders() } };`).reason,
    ).toBeDefined();
    expect(
      readEntryStatic(
        `export const options = { security: { csp: { directives: { "script-src": [process.env.SRC] } } } };`,
      ).reason,
    ).toBeDefined();
  });

  it("[ESO-9] a spread in security or in the options may bring a header, so it is not read", () => {
    expect(
      readEntryStatic(`import s from "./s"; export const options = { security: { ...s } };`).reason,
    ).toBeDefined();
    expect(
      readEntryStatic(`import s from "./s"; export const options = { ...s, security: {} };`).reason,
    ).toBeDefined();
  });

  it("[ESO-10] security keys that never change a static answer (secrets) are not read and do not block; a literal host list is read for the platform routes only", () => {
    const reading = readEntryStatic(
      [
        "export const options = {",
        "  security: {",
        "    cookieSecrets: [process.env.COOKIE_SECRET],",
        '    allowedHosts: ["example.com"],',
        "  },",
        "};",
      ].join("\n"),
    );
    expect(reading).toEqual({
      options: { security: {} },
      reason: undefined,
      hosts: ["example.com"],
      hostsReason: undefined,
    });
  });

  it("[ESO-13] a host list the build cannot read sets hostsReason, not the page reason: the pages stay files", () => {
    const reading = readEntryStatic(
      `export const options = { security: { allowedHosts: hostsFromEnv() } };`,
    );
    expect(reading.reason).toBeUndefined();
    expect(reading.hostsReason).toMatch(/security\.allowedHosts to a value the build cannot read/);
    expect(reading.options.security).toEqual({});
  });

  it("[ESO-11] routing the build cannot evaluate (a call inside it) makes every page handler-rendered", () => {
    expect(
      readEntryStatic(`export const options = { routing: { redirects: loadRedirects() } };`).reason,
    ).toBeDefined();
  });

  it("[ESO-12] the options exported under an alias, or only as the default export, are read", () => {
    const aliased = readEntryStatic(
      `const settings = { security: { headers: { frameOptions: "DENY" } } }; export { settings as options };`,
    );
    expect(aliased.options.security).toEqual({ headers: { frameOptions: "DENY" } });
    const dflt = readEntryStatic(
      `export default { security: { headers: { frameOptions: "SAMEORIGIN" } } };`,
    );
    expect(dflt.options.security).toEqual({ headers: { frameOptions: "SAMEORIGIN" } });
  });

  it("[ESO-13] a header object named through a variable (shorthand) is read through it", () => {
    const reading = readEntryStatic(
      `const headers = { frameOptions: "DENY" }; export const options = { security: { headers } };`,
    );
    expect(reading.options.security).toEqual({ headers: { frameOptions: "DENY" } });
  });

  it("[ESO-14] options that are not an object literal, a computed key, or a re-export are not read", () => {
    expect(readEntryStatic(`export const options = makeOptions();`).reason).toBeDefined();
    expect(readEntryStatic(`export default makeOptions();`).reason).toBeDefined();
    expect(
      readEntryStatic(
        `const name = "security"; export const options = { [name]: { headers: {} } };`,
      ).reason,
    ).toBeDefined();
    // A literal computed key is the same key, so it is read like a plain one.
    expect(readEntryStatic(`export const options = { ["security"]: {} };`).reason).toBeUndefined();
    expect(readEntryStatic(`export { options } from "./other";`).reason).toBeDefined();
    expect(readEntryStatic(`export * from "./more";`).reason).toBeDefined();
  });

  it("[ESO-15] a value that refers to itself is not followed forever", () => {
    expect(
      readEntryStatic(`const a = { b: a }; export const options = { security: { headers: a } };`)
        .reason,
    ).toBeDefined();
  });
});

describe("an entry that changes its options after declaring them", () => {
  it("[ESO-18] an assignment to the options object, or to a sub-object of it, is a reason (the literal would be wrong)", () => {
    expect(
      readEntryStatic(`export const options = {}; options.middleware = [(event, next) => next()];`)
        .reason,
    ).toBeDefined();
    expect(
      readEntryStatic(
        `const security = { headers: { frameOptions: "DENY" } }; export const options = { security }; security.csp = {};`,
      ).reason,
    ).toBeDefined();
    expect(
      readEntryStatic(`export const options = {}; options["security"] = { csp: {} };`).reason,
    ).toBeDefined();
  });

  it("[ESO-19] a call that receives the options object, or a delete on it, is a reason", () => {
    expect(
      readEntryStatic(
        `export const options = {}; Object.assign(options, { middleware: [(e, n) => n()] });`,
      ).reason,
    ).toBeDefined();
    expect(
      readEntryStatic(`export const options = { routing: {} }; delete options.routing;`).reason,
    ).toBeDefined();
  });

  it("[ESO-20] changing an unrelated value (a counter, a string) leaves the options readable", () => {
    const reading = readEntryStatic(
      `let count = 0; count += 1; export const options = { security: { headers: { frameOptions: "DENY" } } };`,
    );
    expect(reading.reason).toBeUndefined();
    expect(reading.options.security).toEqual({ headers: { frameOptions: "DENY" } });
  });
});

describe("a page decision with a whole-app reason", () => {
  const routing = validateRouting({}, {});
  const page = { path: "/", html: "<p>home</p>", routeMiddleware: false };

  it("[ESO-16] a whole-app reason makes every prerendered page handler-rendered, whatever its path", () => {
    const [answer] = staticPagesOf(
      { routing, pages: [page], wholeApp: "a global middleware of src/entry-server.ts runs" },
      true,
    );
    expect(answer?.mode).toBe("handler");
    expect(answer?.reason).toBe("a global middleware of src/entry-server.ts runs");
    expect(answer?.headers).toEqual([]);
  });

  it("[ESO-17] without a whole-app reason the same page is a static file", () => {
    const [answer] = staticPagesOf({ routing, pages: [page] }, true);
    expect(answer?.mode).toBe("static");
  });
});

describe("the Bun and Deno static responder follows the decision", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("[ESO-21] a page the entry's global middleware reaches is answered by the handler, not read from its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-native-decision-"));
    made.push(dir);
    mkdirSync(join(dir, "about"));
    writeFileSync(join(dir, "about", "index.html"), "<p>about file</p>");
    const handled: string[] = [];
    const handler = {
      fetch: async (request: Request) => {
        handled.push(new URL(request.url).pathname);
        return new Response("from the handler", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    } as unknown as Handler;
    const pages = staticPagesOf(
      {
        routing: validateRouting({}, {}),
        wholeApp:
          "src/entry-server.ts sets a global middleware (options.middleware), which runs for every request",
        pages: [{ path: "/about", html: "<p>about file</p>", routeMiddleware: false }],
      },
      true,
    );
    const fetchFn = createNativeFetch(handler, {
      static: dir,
      compress: false,
      onError: () => undefined,
      pages,
    });
    const answer = await fetchFn(new Request("http://localhost/about"), undefined);
    expect(await answer.text()).toBe("from the handler");
    expect(handled).toEqual(["/about"]);
  });
});
