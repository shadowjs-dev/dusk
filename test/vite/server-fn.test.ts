import { describe, expect, it } from "vitest";
import { fnId } from "../../src/vite/ids";
import {
  ServerFnError,
  type ServerFnIssueCode,
  type ServerFnTransformResult,
  transformServerFns,
} from "../../src/vite/server-fn";

const ROOT = "/app";
const FILE = "/app/src/x.ts";

function run(
  code: string,
  target: "client" | "server" | "analyze",
  file = FILE,
  base = "",
): ServerFnTransformResult {
  const result = transformServerFns({ code, file, root: ROOT, target, base });
  if (result === null) throw new Error("no server function found");
  return result;
}

function failure(code: string, target: "client" | "server" = "client", file = FILE): ServerFnError {
  try {
    transformServerFns({ code, file, root: ROOT, target });
  } catch (error) {
    if (error instanceof ServerFnError) return error;
    throw error;
  }
  throw new Error("expected a ServerFnError");
}

const stub = (id: string, method = "POST", form = false, base = ""): string =>
  `$$serverFnStub(${JSON.stringify(id)}, { method: ${JSON.stringify(method)}, form: ${form}, base: ${JSON.stringify(base)}, batch: true, singleFlight: false })`;
const CLIENT_IMPORT = `import { serverFnStub as $$serverFnStub } from "@shadow-js/dusk/client";\n`;

describe("serverFn() calls: client output", () => {
  it("[SFN-01] replaces the call with a stub, drops the handler and everything only it needed", () => {
    const code = [
      `import { serverFn } from "@shadow-js/dusk/server";`,
      `import { db } from "./db.server";`,
      `import { z } from "zod";`,
      `import { format } from "./format";`,
      ``,
      `const Input = z.object({ id: z.string() });`,
      `const secret = db.secret();`,
      ``,
      `export const getPost = serverFn({ method: "GET", input: Input }, async ({ id }) => db.get(id, secret));`,
      `export function label(post) { return format(post); }`,
      ``,
    ].join("\n");
    const result = run(code, "client");
    const id = fnId("src/x.ts", "getPost");
    expect(result.code).toBe(
      `${CLIENT_IMPORT}import { format } from "./format";\n\n\n${[
        `export const getPost = ${stub(id, "GET")};`,
        `export function label(post) { return format(post); }`,
        ``,
      ].join("\n")}`,
    );
    expect(result.fns).toEqual([
      {
        exportName: "getPost",
        id,
        method: "GET",
        form: false,
        batch: true,
        singleFlight: false,
        origin: "serverFn",
        line: 9,
      },
    ]);
    expect(result.code).not.toContain("db");
    expect(result.code).not.toContain("zod");
    expect(result.code).not.toContain("secret");
  });

  it("[SFN-02] keeps what the rest of the module still uses, and what was unused before", () => {
    const code = [
      `import { serverFn } from "@shadow-js/dusk/server";`,
      `import { shared } from "./shared";`,
      `import { unusedBefore } from "./unused";`,
      `export const a = serverFn({}, async () => shared());`,
      `export const b = () => shared();`,
      ``,
    ].join("\n");
    const result = run(code, "client");
    expect(result.code).toContain(`import { shared } from "./shared";`);
    expect(result.code).toContain(`import { unusedBefore } from "./unused";`);
    expect(result.code).toContain("export const b = () => shared();");
  });

  it("[SFN-03] method, form and base are static facts in the stub", () => {
    const code = `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({ method: "GET", form: true }, async () => 1);\n`;
    const result = run(code, "client", FILE, "/app");
    expect(result.code).toContain(stub(fnId("src/x.ts", "f"), "GET", true, "/app"));
  });

  it("[SFN-04] default export, aliased import, namespace import, export lists and TS wrappers", () => {
    const code = [
      `import { serverFn as sf } from "@shadow-js/dusk/server";`,
      `import * as server from "@shadow-js/dusk/server";`,
      `export default sf({}, async () => 1);`,
      `export const viaNs = server.serverFn({ method: "GET" }, async () => 2);`,
      `const local = sf({}, async () => 3) as unknown;`,
      `const other = sf<string>({}, async () => 4) satisfies unknown;`,
      `export { local, other as renamed };`,
      ``,
    ].join("\n");
    const result = run(code, "client");
    expect(result.fns.map((fn) => [fn.exportName, fn.method])).toEqual([
      ["default", "POST"],
      ["viaNs", "GET"],
      ["local", "POST"],
      ["renamed", "POST"],
    ]);
    expect(result.code.match(/\$\$serverFnStub\(/g)?.length).toBe(4);
    expect(result.code).not.toContain("server.serverFn");
    expect(result.code).not.toContain("sf(");
    expect(result.code).not.toContain("@shadow-js/dusk/server");
  });

  it("[SFN-05] a local function named serverFn, or imported from elsewhere, is left alone", () => {
    const own = `function serverFn(a, b) { return b; }\nexport const f = serverFn({}, () => 1);\n`;
    expect(transformServerFns({ code: own, file: FILE, root: ROOT, target: "client" })).toBeNull();
    const foreign = `import { serverFn } from "other-lib";\nexport const f = serverFn({}, () => 1);\n`;
    expect(
      transformServerFns({ code: foreign, file: FILE, root: ROOT, target: "client" }),
    ).toBeNull();
    const shadowed = [
      `import { serverFn } from "@shadow-js/dusk/server";`,
      `export const real = serverFn({}, async () => 1);`,
      `export function f(serverFn) { return serverFn({}, () => 1); }`,
      ``,
    ].join("\n");
    const result = run(shadowed, "client");
    expect(result.fns.map((fn) => fn.exportName)).toEqual(["real"]);
    expect(result.code).toContain("return serverFn({}, () => 1);");
  });

  it("[SFN-06] the stub id equals fnId of the file and export, whatever the machine", () => {
    const code = `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({}, async () => 1);\n`;
    const a = run(code, "client", "/home/a/proj/src/x.ts").fns[0]?.id;
    const first = transformServerFns({
      code,
      file: "/home/a/proj/src/x.ts",
      root: "/home/a/proj",
      target: "client",
    });
    const second = transformServerFns({
      code,
      file: "/other/place/src/x.ts",
      root: "/other/place",
      target: "client",
    });
    expect(a).toBeDefined();
    expect(first?.fns[0]?.id).toBe(second?.fns[0]?.id);
    expect(first?.fns[0]?.id).toBe(fnId("src/x.ts", "f"));
  });

  it("[SFN-07] the source map covers the output", () => {
    const code = `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({}, async () => 1);\nexport const g = 1;\n`;
    const result = run(code, "client");
    expect(result.map?.sources).toEqual([FILE]);
    expect(result.map?.mappings.length).toBeGreaterThan(0);
  });
});

describe("serverFn() calls: server output and errors", () => {
  it("[SFN-10] the server keeps the module as written, with each serverFn() call bound to its id and base", () => {
    const code = `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({}, async () => 1);\n`;
    const result = run(code, "server", FILE, "/app");
    const id = fnId("src/x.ts", "f");
    expect(result.changed).toBe(true);
    expect(result.code).toBe(
      `import { bindServerFn as $$bindServerFn } from "@shadow-js/dusk/server";\nimport { serverFn } from "@shadow-js/dusk/server";\nexport const f = $$bindServerFn(serverFn({}, async () => 1), ${JSON.stringify(id)}, "/app");\n`,
    );
    expect(result.fns).toHaveLength(1);
    expect(result.map?.sources).toEqual([FILE]);
  });

  it("[SFN-14] every form of exported serverFn() gets bound: default, listed, aliased, wrapped in `as`", () => {
    const code = [
      `import { serverFn } from "@shadow-js/dusk/server";`,
      `export default serverFn({}, async () => 0);`,
      `const local = serverFn({ form: true }, async () => 1);`,
      `export { local, local as alias };`,
      `export const typed = serverFn({}, async () => 2) as unknown as () => Promise<number>;`,
      ``,
    ].join("\n");
    const result = run(code, "server");
    const bound = [...result.code.matchAll(/\$\$bindServerFn\(/g)];
    // default, local (once, although it is exported under two names), typed: three calls.
    expect(bound).toHaveLength(3);
    expect(result.code).toContain(`, ${JSON.stringify(fnId("src/x.ts", "default"))}, "")`);
    expect(result.code).toContain(`, ${JSON.stringify(fnId("src/x.ts", "local"))}, "")`);
    expect(result.code).toContain(`, ${JSON.stringify(fnId("src/x.ts", "typed"))}, "")`);
  });

  it("[SFN-11] analyze lists the functions without editing", () => {
    const code = `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({ method: "GET" }, async () => 1);\n`;
    const result = run(code, "analyze");
    expect(result.changed).toBe(false);
    expect(result.fns[0]).toMatchObject({ exportName: "f", method: "GET" });
  });

  it.each<[string, string, ServerFnIssueCode]>([
    [
      "not exported",
      `import { serverFn } from "@shadow-js/dusk/server";\nconst f = serverFn({}, async () => 1);\nexport const g = 1;\n`,
      "SERVER_FN_NOT_EXPORTED",
    ],
    [
      "nested in a function",
      `import { serverFn } from "@shadow-js/dusk/server";\nexport function make() { return serverFn({}, async () => 1); }\n`,
      "SERVER_FN_NOT_EXPORTED",
    ],
    [
      "destructured",
      `import { serverFn } from "@shadow-js/dusk/server";\nexport const { a } = serverFn({}, async () => 1);\n`,
      "SERVER_FN_NOT_EXPORTED",
    ],
    [
      "dynamic method",
      `import { serverFn } from "@shadow-js/dusk/server";\nconst m = "GET";\nexport const f = serverFn({ method: m }, async () => 1);\n`,
      "SERVER_FN_OPTIONS_NOT_STATIC",
    ],
    [
      "unknown method literal",
      `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({ method: "PUT" }, async () => 1);\n`,
      "SERVER_FN_OPTIONS_NOT_STATIC",
    ],
    [
      "options in a variable",
      `import { serverFn } from "@shadow-js/dusk/server";\nconst o = {};\nexport const f = serverFn(o, async () => 1);\n`,
      "SERVER_FN_OPTIONS_NOT_STATIC",
    ],
    [
      "spread in options",
      `import { serverFn } from "@shadow-js/dusk/server";\nconst o = {};\nexport const f = serverFn({ ...o }, async () => 1);\n`,
      "SERVER_FN_OPTIONS_NOT_STATIC",
    ],
    [
      "dynamic form flag",
      `import { serverFn } from "@shadow-js/dusk/server";\nexport const f = serverFn({ form: !!globalThis }, async () => 1);\n`,
      "SERVER_FN_OPTIONS_NOT_STATIC",
    ],
  ])("[SFN-12] %s is a build error with position", (_name, code, expected) => {
    const error = failure(code);
    expect(error.code).toBe(expected);
    expect(error.line).toBeGreaterThan(1);
    expect(error.frame).toContain("^");
    expect(error.message).toContain(expected);
    expect(error.message).toContain(FILE);
  });

  it("[SFN-13] different files and different exports never share an id", () => {
    expect(fnId("a.ts", "x")).not.toBe(fnId("a.ts", "y"));
    expect(fnId("a.ts", "x")).not.toBe(fnId("b.ts", "x"));
  });
});

describe("fnId", () => {
  it("[SFN-20] is 22 base64url characters, stable, and path-separator and normalization independent", () => {
    const id = fnId("src/server/posts.ts", "getPost");
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fnId("src\\server\\posts.ts", "getPost")).toBe(id);
    expect(fnId("./src/server/posts.ts", "getPost")).toBe(id);
    expect(fnId("src/café.ts", "x")).toBe(fnId("src/café.ts", "x"));
    expect(fnId("src/server/posts.ts", "getPosts")).not.toBe(id);
    // Golden: the id of this export must never change between releases.
    expect(id).toBe("dMuA6QYP2f_muI1NT-2l_A");
  });
});
