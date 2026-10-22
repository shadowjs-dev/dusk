import { describe, expect, it } from "vitest";
import type { HandlerOptions } from "../../src/server/types";
import { optionConflictMessage, optionConflicts } from "../../src/vite/option-conflicts";

/**
 * The entry file's options are read statically (the file is transpiled JavaScript; nothing runs). A leaf key set in
 * both the file (`dusk.config.ts`, as handler options) and the entry (`src/entry-server.ts`) with a different value is
 * a conflict: the entry wins, and the message names the leaf.
 */
const FILE: Partial<HandlerOptions> = {
  security: {
    allowedHosts: ["example.com"],
    headers: { frameOptions: "DENY" },
    csp: false,
    nonce: true,
  },
  trustedOrigins: ["https://partner.example"],
};

describe("option conflicts between dusk.config.ts and the entry", () => {
  it("[OCF-1] the same leaf key with different literal values is one conflict, named by its leaf path", () => {
    const entry = `export const options = { security: { headers: { frameOptions: "SAMEORIGIN" } } };`;
    expect(optionConflicts(FILE, entry)).toEqual([
      {
        path: "security.headers.frameOptions",
        fileValue: '"DENY"',
        entryValue: '"SAMEORIGIN"',
      },
    ]);
  });

  it("[OCF-2] the same value on both sides is not a conflict", () => {
    const entry = `export const options = { security: { headers: { frameOptions: "DENY" }, nonce: true } };`;
    expect(optionConflicts(FILE, entry)).toEqual([]);
  });

  it("[OCF-3] an array with the same items is not a conflict; a different array is one, named at the array", () => {
    expect(
      optionConflicts(
        FILE,
        `export const options = { security: { allowedHosts: ["example.com"] } };`,
      ),
    ).toEqual([]);
    expect(
      optionConflicts(
        FILE,
        `export const options = { security: { allowedHosts: ["app.example"] } };`,
      ),
    ).toEqual([
      {
        path: "security.allowedHosts",
        fileValue: '["example.com"]',
        entryValue: '["app.example"]',
      },
    ]);
  });

  it("[OCF-4] an entry object over a file value of false is a conflict at the file's leaf (the csp is replaced)", () => {
    const entry = `export const options = { security: { csp: { directives: { "default-src": ["'self'"] } } } };`;
    expect(optionConflicts(FILE, entry)).toEqual([
      {
        path: "security.csp",
        fileValue: "false",
        entryValue: "an object",
      },
    ]);
  });

  it("[OCF-5] a file object replaced by a literal in the entry is a conflict at that path", () => {
    const entry = `export const options = { security: { headers: false } };`;
    expect(optionConflicts(FILE, entry)).toEqual([
      { path: "security.headers", fileValue: "an object", entryValue: "false" },
    ]);
  });

  it("[OCF-6] a value the file does not set is not a conflict (the entry only adds)", () => {
    const entry = `export const options = { security: { cookieSecrets: ["x".repeat(40)] }, images: { maxWidth: 1 } };`;
    expect(optionConflicts(FILE, entry)).toEqual([]);
  });

  it("[OCF-7] a value the entry computes (a call, a variable it cannot read) is not compared", () => {
    const entry = [
      "const secret = process.env.CSP_MODE;",
      "export const options = { security: { headers: makeHeaders(), nonce: secret } };",
    ].join("\n");
    expect(optionConflicts(FILE, entry)).toEqual([]);
  });

  it("[OCF-8] an object bound to a top-level constant is read through its name", () => {
    const entry = [
      'const security = { headers: { frameOptions: "SAMEORIGIN" } };',
      "export const options = { security };",
    ].join("\n");
    expect(optionConflicts(FILE, entry)).toEqual([
      {
        path: "security.headers.frameOptions",
        fileValue: '"DENY"',
        entryValue: '"SAMEORIGIN"',
      },
    ]);
  });

  it("[OCF-9] `options` wins over the default export, so only the named export is compared", () => {
    const entry = [
      'export const options = { security: { headers: { frameOptions: "DENY" } } };',
      'export default { security: { headers: { frameOptions: "SAMEORIGIN" } } };',
    ].join("\n");
    expect(optionConflicts(FILE, entry)).toEqual([]);
  });

  it("[OCF-10] a default export is compared when there is no options export", () => {
    const entry = 'export default { security: { headers: { frameOptions: "SAMEORIGIN" } } };';
    expect(optionConflicts(FILE, entry)).toHaveLength(1);
  });

  it("[OCF-11] an entry that names the options under another name (export { x as options }) is read", () => {
    const entry = [
      'const mine = { security: { headers: { frameOptions: "SAMEORIGIN" } } };',
      "export { mine as options };",
    ].join("\n");
    expect(optionConflicts(FILE, entry)).toHaveLength(1);
  });

  it("[OCF-12] no file config, or no entry options, gives no conflicts", () => {
    expect(optionConflicts(undefined, "export const options = { dev: true };")).toEqual([]);
    expect(optionConflicts(FILE, "export const nothing = 1;")).toEqual([]);
  });

  it("[OCF-13] a spread in the entry is skipped (its keys are unknown); the explicit keys beside it are still compared", () => {
    const entry = [
      "const base = {};",
      'export const options = { ...base, security: { headers: { frameOptions: "SAMEORIGIN" } } };',
    ].join("\n");
    expect(optionConflicts(FILE, entry)).toHaveLength(1);
  });

  it("[OCF-14] the message names the leaf, both values, and that the entry wins", () => {
    const [conflict] = optionConflicts(
      FILE,
      'export const options = { security: { headers: { frameOptions: "SAMEORIGIN" } } };',
    );
    expect(conflict).toBeDefined();
    if (conflict === undefined) return;
    const message = optionConflictMessage(conflict, "src/entry-server.ts");
    expect(message).toContain("security.headers.frameOptions");
    expect(message).toContain('"DENY"');
    expect(message).toContain('"SAMEORIGIN"');
    expect(message).toMatch(/entry-server.*wins|wins.*entry/);
  });

  it("[OCF-15] a deeply nested entry object is walked without recursion: a conflict at the bottom is found", () => {
    // The parser has its own nesting limit (it refuses far deeper input with a SyntaxError); 200 levels parse, and the
    // walk over them must not depend on the call stack.
    const depth = 200;
    let entryNested = "{ leaf: 2 }";
    let fileNested: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < depth; level += 1) {
      entryNested = `{ next: ${entryNested} }`;
      fileNested = { next: fileNested };
    }
    const entry = `export const options = { security: ${entryNested} };`;
    const conflicts = optionConflicts({ security: fileNested }, entry);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.path.split(".")).toHaveLength(depth + 2);
    expect(conflicts[0]?.fileValue).toBe("1");
  });
});
