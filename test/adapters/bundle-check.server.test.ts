import { describe, expect, it } from "vitest";
import { assertBundle, checkBundle } from "../../src/adapter/checks";

/**
 * The platform check reads the server bundle's real imports (a parser, not a text search): a comment or a string that
 * spells an import is not an import, a Node built-in is allowed on the Node.js runtime with or without `node:`, and a
 * bare package that the bundle leaves external fails with the module and the chunk that names it.
 */

const NODE_ALL = { name: "vercel", edge: false, bundling: "all" } as const;
const EDGE_ALL = { name: "vercel", edge: true, bundling: "all" } as const;

describe("bundle check: real imports, not text", () => {
  it("[BCHK-01] a comment that quotes an import is not an import (the Convex pagination comment)", () => {
    const code = [
      '// changed from "CanLoadMore" to "LoadingMore"',
      '/* import x from "zod"; require("left-pad") */',
      "export const state = 1;",
    ].join("\n");
    expect(checkBundle(NODE_ALL, [{ file: "dist/server/chunks/paging-1.js", code }])).toEqual([]);
  });

  it("[BCHK-02] a string or template that spells an import is not an import", () => {
    const code = [
      'const text = \'from "CanLoadMore" and import x from "zod"\';',
      "const more = `require(\"left-pad\") import('zod')`;",
      "export { text, more };",
    ].join("\n");
    expect(checkBundle(NODE_ALL, [{ file: "dist/server/entry.js", code }])).toEqual([]);
  });

  it("[BCHK-03] a Node built-in is allowed on the Node.js runtime, with or without the node: prefix", () => {
    const code = [
      'import { createHash } from "crypto";',
      'import fs from "fs/promises";',
      'import { Readable } from "node:stream";',
      'const { randomUUID } = require("crypto");',
      "export { createHash, fs, Readable, randomUUID };",
    ].join("\n");
    expect(checkBundle(NODE_ALL, [{ file: "dist/server/entry.js", code }])).toEqual([]);
  });

  it("[BCHK-04] an edge runtime refuses every built-in, whichever spelling it uses", () => {
    const code = 'import { createHash } from "crypto";\nimport { Readable } from "node:stream";\n';
    const problems = checkBundle(EDGE_ALL, [{ file: "dist/server/entry.js", code }]);
    expect(problems.map((problem) => problem.specifier)).toEqual(["crypto", "node:stream"]);
  });

  it("[BCHK-05] a real bare import the bundle left external fails, naming the module and the importing chunk", () => {
    const files = [
      {
        file: "dist/server/chunks/billing-7f3a.js",
        code: 'import { missing } from "left-pad-missing";\nexport const x = missing;\n',
      },
    ];
    const problems = checkBundle(NODE_ALL, files);
    expect(problems).toEqual([
      expect.objectContaining({
        file: "dist/server/chunks/billing-7f3a.js",
        specifier: "left-pad-missing",
      }),
    ]);
    expect(() => assertBundle(NODE_ALL, files)).toThrow(
      /\[ADAPTER_BUNDLE\] vercel[\s\S]*dist\/server\/chunks\/billing-7f3a\.js: [\s\S]*"left-pad-missing"/,
    );
  });

  it("[BCHK-06] re-exports and literal dynamic imports count; a computed import() and import.meta do not", () => {
    const code = [
      'export { a } from "left-pad-one";',
      'export * from "left-pad-two";',
      'const late = import("left-pad-three");',
      "const name = pick();",
      "const computed = import(name);",
      "const url = import.meta.url;",
    ].join("\n");
    const problems = checkBundle(NODE_ALL, [{ file: "dist/server/entry.js", code }]);
    expect(problems.map((problem) => problem.specifier).sort()).toEqual([
      "left-pad-one",
      "left-pad-three",
      "left-pad-two",
    ]);
  });

  it("[BCHK-07] a file that is not JavaScript is reported, not skipped", () => {
    const problems = checkBundle(NODE_ALL, [
      { file: "dist/server/chunks/broken.js", code: "export const = ;" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe("dist/server/chunks/broken.js");
    expect(problems[0]?.message).toMatch(/could not be parsed/);
  });

  it("[BCHK-08] a require call of a bare package is still refused on a self-contained bundle", () => {
    const code = 'const left = require("left-pad");\nmodule.exports = left;\n';
    expect(
      checkBundle(NODE_ALL, [{ file: "dist/server/entry.js", code }]).map(
        (problem) => problem.specifier,
      ),
    ).toEqual(["left-pad"]);
  });
});
