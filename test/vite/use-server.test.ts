import { describe, expect, it } from "vitest";
import { fnId } from "../../src/vite/ids";
import {
  ServerFnError,
  type ServerFnIssueCode,
  type ServerFnTransformResult,
  transformServerFns,
} from "../../src/vite/server-fn";

const ROOT = "/app";
const FILE = "/app/src/actions.tsx";

function run(code: string, target: "client" | "server"): ServerFnTransformResult {
  const result = transformServerFns({ code, file: FILE, root: ROOT, target });
  if (result === null) throw new Error("no server function found");
  return result;
}

function failure(code: string, target: "client" | "server" = "client"): ServerFnError {
  try {
    transformServerFns({ code, file: FILE, root: ROOT, target });
  } catch (error) {
    if (error instanceof ServerFnError) return error;
    throw error;
  }
  throw new Error("expected a ServerFnError");
}

const id = (name: string): string => fnId("src/actions.tsx", name);
const stub = (name: string): string =>
  `$$serverFnStub(${JSON.stringify(id(name))}, { method: "POST", form: false, base: "", batch: true, singleFlight: false })`;
const CLIENT_IMPORT = `import { serverFnStub as $$serverFnStub } from "@shadow-js/dusk/client";\n`;
const SERVER_IMPORT = `import { bindServerFn as $$bindServerFn, serverFn as $$serverFn } from "@shadow-js/dusk/server";\n`;
/** A registered definition as the server output writes it: bound to the id the client stub uses. */
const bound = (name: string, definition: string): string =>
  `$$bindServerFn(${definition}, ${JSON.stringify(id(name))}, "")`;

describe('file-level "use server"', () => {
  const code = [
    `"use server";`,
    `import { db } from "./db";`,
    `export async function add(x) { return db.add(x); }`,
    `export const del = async (id) => db.del(id);`,
    `async function hidden() {}`,
    `export { hidden as secret };`,
    `export default async function () { return 1; }`,
    `export type Row = { id: string };`,
    ``,
  ].join("\n");

  it("[SUS-01] client: one stub per export and nothing else", () => {
    const result = run(code, "client");
    expect(result.code).toBe(
      [
        CLIENT_IMPORT.trimEnd(),
        `export const add = ${stub("add")};`,
        `export const del = ${stub("del")};`,
        `export const secret = ${stub("secret")};`,
        `export default ${stub("default")};`,
        ``,
      ].join("\n"),
    );
    expect(result.fns.map((fn) => [fn.exportName, fn.origin])).toEqual([
      ["add", "directive-file"],
      ["del", "directive-file"],
      ["secret", "directive-file"],
      ["default", "directive-file"],
    ]);
    expect(result.code).not.toContain("db");
  });

  it("[SUS-02] server: the functions stay, each export is a registered definition", () => {
    const result = run(code, "server");
    expect(result.code).toBe(
      [
        SERVER_IMPORT.trimEnd(),
        ``,
        `import { db } from "./db";`,
        `async function add(x) { return db.add(x); }`,
        `const del = async (id) => db.del(id);`,
        `async function hidden() {}`,
        ``,
        `const $$default_fn = async function () { return 1; };`,
        `export type Row = { id: string };`,
        ``,
        `const $$def_add = ${bound("add", '$$serverFn({ method: "POST" }, add)')};`,
        `export { $$def_add as add };`,
        `const $$def_del = ${bound("del", '$$serverFn({ method: "POST" }, del)')};`,
        `export { $$def_del as del };`,
        `const $$def_secret = ${bound("secret", '$$serverFn({ method: "POST" }, hidden)')};`,
        `export { $$def_secret as secret };`,
        `const $$def_default = ${bound("default", '$$serverFn({ method: "POST" }, $$default_fn)')};`,
        `export { $$def_default as default };`,
        ``,
      ].join("\n"),
    );
  });

  it.each<[string, string, ServerFnIssueCode]>([
    ["a value export", `"use server";\nexport const x = 1;\n`, "SERVER_FN_DIRECTIVE_EXPORT"],
    ["a sync function", `"use server";\nexport function f() {}\n`, "SERVER_FN_NOT_ASYNC"],
    ["a sync arrow", `"use server";\nexport const f = () => 1;\n`, "SERVER_FN_NOT_ASYNC"],
    ["a generator", `"use server";\nexport async function* f() {}\n`, "SERVER_FN_NOT_ASYNC"],
    ["export *", `"use server";\nexport * from "./other";\n`, "SERVER_FN_DIRECTIVE_EXPORT"],
    ["a re-export", `"use server";\nexport { a } from "./other";\n`, "SERVER_FN_DIRECTIVE_EXPORT"],
    ["an export of a class", `"use server";\nexport class C {}\n`, "SERVER_FN_DIRECTIVE_EXPORT"],
    ["a non-function default", `"use server";\nexport default 42;\n`, "SERVER_FN_DIRECTIVE_EXPORT"],
    [
      "a listed value",
      `"use server";\nconst v = 1;\nexport { v };\n`,
      "SERVER_FN_DIRECTIVE_EXPORT",
    ],
  ])("[SUS-03] %s is rejected", (_name, source, expected) => {
    expect(failure(source).code).toBe(expected);
  });
});

describe('function-level "use server"', () => {
  const code = [
    `import { db } from "./db";`,
    `import { render } from "./render";`,
    `export async function action(x) { "use server"; return db.save(x); }`,
    `export function Comp() {`,
    `  async function save(v) { "use server"; return db.put(v); }`,
    `  const other = async (v) => { "use server"; return db.other(v); };`,
    `  return render(save, other);`,
    `}`,
    ``,
  ].join("\n");

  it("[SUS-10] client: exported functions and inline functions both become stubs, server code is gone", () => {
    const result = run(code, "client");
    expect(result.code).toBe(
      [
        CLIENT_IMPORT.trimEnd(),
        `import { render } from "./render";`,
        `export const action = ${stub("action")};`,
        `export function Comp() {`,
        `  const save = ${stub("$$server_0")};`,
        `  const other = ${stub("$$server_1")};`,
        `  return render(save, other);`,
        `}`,
        ``,
      ].join("\n"),
    );
    expect(result.code).not.toContain("db");
  });

  it("[SUS-11] server: inline functions are hoisted to exports named $$server_n, before their statement", () => {
    const result = run(code, "server");
    expect(result.code).toBe(
      [
        SERVER_IMPORT.trimEnd(),
        `import { db } from "./db";`,
        `import { render } from "./render";`,
        `async function action(x) { "use server"; return db.save(x); }`,
        `export const $$server_0 = ${bound("$$server_0", '$$serverFn({ method: "POST" }, async function save(v) { "use server"; return db.put(v); })')};`,
        `export const $$server_1 = ${bound("$$server_1", '$$serverFn({ method: "POST" }, async (v) => { "use server"; return db.other(v); })')};`,
        `export function Comp() {`,
        `  const save = $$server_0;`,
        `  const other = $$server_1;`,
        `  return render(save, other);`,
        `}`,
        ``,
        `const $$def_action = ${bound("action", '$$serverFn({ method: "POST" }, action)')};`,
        `export { $$def_action as action };`,
        ``,
      ].join("\n"),
    );
    expect(result.fns.map((fn) => fn.exportName)).toEqual(["action", "$$server_0", "$$server_1"]);
  });

  it("[SUS-12] a function used at module level is defined before the statement that uses it", () => {
    const source = [
      `import { db } from "./db";`,
      `export const handlers = [async (x) => { "use server"; return db.run(x); }];`,
      `export const first = handlers[0];`,
      ``,
    ].join("\n");
    const server = run(source, "server");
    const hoistAt = server.code.indexOf("export const $$server_0");
    const useAt = server.code.indexOf("export const handlers");
    expect(hoistAt).toBeGreaterThan(-1);
    expect(hoistAt).toBeLessThan(useAt);
    expect(server.code).toContain("export const handlers = [$$server_0];");
  });

  it("[SUS-13] ordinals follow source order and ignore other functions", () => {
    const a = run(
      `export function A() { return async () => { "use server"; return 1; }; }\nexport function B() { return async () => { "use server"; return 2; }; }\n`,
      "client",
    );
    const b = run(
      `export function helper() { return async () => 1; }\nexport function A() { return async () => { "use server"; return 1; }; }\nexport function B() { return async () => { "use server"; return 2; }; }\n`,
      "client",
    );
    expect(a.fns.map((fn) => fn.id)).toEqual([id("$$server_0"), id("$$server_1")]);
    expect(b.fns.map((fn) => fn.id)).toEqual(a.fns.map((fn) => fn.id));
    const shifted = run(
      `export function Z() { return async () => { "use server"; return 0; }; }\nexport function A() { return async () => { "use server"; return 1; }; }\n`,
      "client",
    );
    expect(shifted.fns.map((fn) => fn.exportName)).toEqual(["$$server_0", "$$server_1"]);
  });

  it("[SUS-14] a module-level value used only by the removed body is pruned, one used elsewhere stays", () => {
    const source = [
      `import { db } from "./db";`,
      `const onlyBody = db.table("a");`,
      `const both = db.table("b");`,
      `export const view = () => both;`,
      `export async function run() { "use server"; return [onlyBody, both]; }`,
      ``,
    ].join("\n");
    const client = run(source, "client").code;
    expect(client).not.toContain("onlyBody");
    expect(client).toContain(`const both = db.table("b");`);
    expect(client).toContain(`import { db } from "./db";`);
  });

  it.each<[string, string, ServerFnIssueCode]>([
    [
      "a class method",
      `export class C { async m() { "use server"; return 1; } }\n`,
      "SERVER_FN_DIRECTIVE_MISPLACED",
    ],
    [
      "an object method",
      `export const o = { async m() { "use server"; return 1; } };\n`,
      "SERVER_FN_DIRECTIVE_MISPLACED",
    ],
    [
      "a getter",
      `export const o = { get g() { "use server"; return 1; } };\n`,
      "SERVER_FN_DIRECTIVE_MISPLACED",
    ],
    [
      "a class field arrow",
      `export class C { f = async () => { "use server"; return 1; }; }\n`,
      "SERVER_FN_DIRECTIVE_MISPLACED",
    ],
    [
      "a sync function",
      `export function f() { return () => { "use server"; return 1; }; }\n`,
      "SERVER_FN_NOT_ASYNC",
    ],
    [
      "a generator",
      `export function f() { return async function* () { "use server"; }; }\n`,
      "SERVER_FN_NOT_ASYNC",
    ],
  ])("[SUS-15] %s is rejected", (_name, source, expected) => {
    expect(failure(source).code).toBe(expected);
  });

  it("[SUS-16] a directive that is not the first statement is not a directive", () => {
    expect(
      transformServerFns({
        code: `export function f() { return async () => { const a = 1; "use server"; return a; }; }\n`,
        file: FILE,
        root: ROOT,
        target: "client",
      }),
    ).toBeNull();
  });

  it("[SUS-17] an inner function inside a hoisted one is part of it", () => {
    const result = run(
      `export function f() { return async (v) => { "use server"; const inner = async () => { "use server"; }; return inner; }; }\n`,
      "client",
    );
    expect(result.fns).toHaveLength(1);
  });
});

describe('"use server": closure capture', () => {
  // Each case is a function with the directive inside `wrap`; `captured` is what it reads from there.
  const cases: [string, string, string[]][] = [
    [
      "a parameter of the enclosing function",
      `function f(userId) { return async () => { "use server"; return userId; }; }`,
      ["userId"],
    ],
    [
      "a let in a loop",
      `function f(items) { for (let i = 0; i < 3; i++) { items.push(async () => { "use server"; return i; }); } }`,
      ["i"],
    ],
    [
      "a destructured prop",
      `function f({ user }) { return async () => { "use server"; return user.id; }; }`,
      ["user"],
    ],
    [
      "a catch parameter",
      `function f() { try {} catch (error) { return async () => { "use server"; return error; }; } }`,
      ["error"],
    ],
    [
      "a const of the enclosing function",
      `function f() { const token = 1; return async () => { "use server"; return token; }; }`,
      ["token"],
    ],
    [
      "the enclosing function's own name",
      `const outer = function self() { return async () => { "use server"; return self; }; };`,
      ["self"],
    ],
    [
      "an enclosing arrow's parameter",
      `const f = (a) => (b) => async () => { "use server"; return a + b; };`,
      ["a", "b"],
    ],
    [
      "a for-of variable",
      `function f(list) { for (const item of list) { return async () => { "use server"; return item; }; } }`,
      ["item"],
    ],
    [
      "a class name inside the class",
      `class K { static make() { return async () => { "use server"; return K; }; } }`,
      ["K"],
    ],
    [
      "a name from an enclosing block",
      `function f() { { const inner = 1; return async () => { "use server"; return inner; }; } }`,
      ["inner"],
    ],
    [
      "this in an arrow",
      `class K { make() { return async () => { "use server"; return this.x; }; } }`,
      ["this"],
    ],
    [
      "a default parameter value",
      `function f(a = 1) { return async () => { "use server"; return a; }; }`,
      ["a"],
    ],
    [
      "a hoisted var",
      `function f() { return async () => { "use server"; return v; }; var v = 1; }`,
      ["v"],
    ],
  ];

  it.each(cases)("[SUS-20] captures %s", (_name, source, names) => {
    const error = failure(`${source}\nexport { };\n`);
    expect(error.code).toBe("SERVER_FN_CLOSURE_CAPTURE");
    for (const name of names) expect(error.message).toContain(name);
  });

  const accepted: [string, string][] = [
    [
      "a module-level const",
      `const T = 1;\nexport function f() { return async () => { "use server"; return T; }; }`,
    ],
    [
      "a module-level function",
      `function helper() {}\nexport function f() { return async () => { "use server"; return helper(); }; }`,
    ],
    [
      "an import",
      `import { db } from "./db";\nexport function f() { return async () => { "use server"; return db; }; }`,
    ],
    [
      "a global",
      `export function f() { return async () => { "use server"; return fetch("/x"); }; }`,
    ],
    [
      "a shadowed name",
      `export function f(userId) { return async (userId) => { "use server"; return userId; }; }`,
    ],
    [
      "its own parameters and locals",
      `export function f() { return async (a, { b }, ...rest) => { "use server"; const c = a + b; return [c, rest]; }; }`,
    ],
    [
      "its own name",
      `export function f() { return async function loop(n) { "use server"; return n ? loop(n - 1) : 0; }; }`,
    ],
    [
      "a nested function's own local",
      `export function f() { return async () => { "use server"; const g = () => { const z = 1; return z; }; return g(); }; }`,
    ],
    [
      "a type parameter",
      `export function f<T>() { return async (x: T) => { "use server"; return x; }; }`,
    ],
    [
      "a type-only reference to an enclosing name",
      `export function f() { type Local = string; return async (x: Local) => { "use server"; return x; }; }`,
    ],
    [
      "this in a regular function",
      `export function f() { return async function () { "use server"; return this; }; }`,
    ],
  ];

  it.each(accepted)("[SUS-21] allows %s", (_name, source) => {
    const result = transformServerFns({
      code: `${source}\n`,
      file: FILE,
      root: ROOT,
      target: "client",
    });
    expect(result?.fns).toHaveLength(1);
  });
});
