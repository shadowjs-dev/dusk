import { describe, expect, it } from "vitest";
import { checkBundle } from "../../src/adapter/checks";
import type { Adapter } from "../../src/adapter/types";
import { cloudflare } from "../../src/cloudflare/index";

/**
 * The Cloudflare adapter is an edge runtime (`edge: true`) that also turns on `nodejs_compat`. Under `nodejs_compat`
 * Workers runs the Node built-ins it supports, so the bundle check allows exactly those (the adapter lists them) and
 * refuses every other built-in by name. An edge adapter without a list still refuses all of them.
 */

const bundle = (code: string) => [{ file: "dist/server/entry.js", code }];
type Checked = Pick<Adapter, "name" | "edge" | "bundling" | "supportedBuiltins">;
const specifiersOf = (code: string, adapter: Checked = cloudflare()) =>
  checkBundle(adapter, bundle(code)).map((problem) => problem.specifier);
const EDGE_ONLY: Checked = { name: "edge-only", edge: true, bundling: "all" };
const NODE: Checked = { name: "node", edge: false, bundling: "all" };

describe("cloudflare: the built-ins nodejs_compat runs", () => {
  it("[CFB-1] the supported built-ins are allowed, with or without the node: prefix", () => {
    const supported = [
      "assert",
      "async_hooks",
      "buffer",
      "crypto",
      "diagnostics_channel",
      "events",
      "http",
      "https",
      "net",
      "path",
      "process",
      "punycode",
      "querystring",
      "stream",
      "string_decoder",
      "timers",
      "url",
      "util",
      "zlib",
      "console",
      "dns",
      "module",
      "os",
      "perf_hooks",
      "tls",
    ];
    const withPrefix = supported.map((name) => `import "node:${name}";`).join("\n");
    const bare = supported.map((name) => `import "${name}";`).join("\n");
    expect(specifiersOf(withPrefix)).toEqual([]);
    expect(specifiersOf(bare)).toEqual([]);
    // "test" is a built-in only with the prefix (`node:test`): the bare name is an ordinary package.
    expect(specifiersOf('import "node:test";')).toEqual([]);
  });

  it("[CFB-2] the built-ins Workers does not run are refused by name, with the node: prefix", () => {
    const refused = [
      "child_process",
      "cluster",
      "dgram",
      "domain",
      "http2",
      "inspector",
      "readline",
      "repl",
      "sqlite",
      "trace_events",
      "tty",
      "v8",
      "vm",
      "wasi",
      "worker_threads",
    ];
    const code = refused.map((name) => `import "node:${name}";`).join("\n");
    expect(specifiersOf(code)).toEqual(refused.map((name) => `node:${name}`));
  });

  it("[CFB-8] node:fs is refused by name: the Workers filesystem holds /bundle and /tmp only, so a package file read by path fails at run time", () => {
    expect(
      specifiersOf('import { readFileSync } from "node:fs";\nexport { readFileSync };'),
    ).toEqual(["node:fs"]);
    expect(specifiersOf('import "fs/promises";')).toEqual(["fs/promises"]);
  });

  it("[CFB-3] a refused built-in is refused without the prefix too (the bare name is the same module)", () => {
    expect(specifiersOf('import { spawn } from "child_process";\nexport { spawn };')).toEqual([
      "child_process",
    ]);
  });

  it("[CFB-4] a built-in that is not in the list and not a supported one is refused, and the message names the platform's list", () => {
    const problems = checkBundle(cloudflare(), bundle('import "node:child_process";'));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('"node:child_process"');
    expect(problems[0]?.message).toContain("cloudflare");
    expect(problems[0]?.message).toContain("runs only the Node built-ins it supports");
  });

  it("[CFB-5] an edge adapter that lists no built-ins still refuses all of them (the rule the other edge runtimes keep)", () => {
    expect(specifiersOf('import "node:crypto";', EDGE_ONLY)).toEqual(["node:crypto"]);
    expect(specifiersOf('import "crypto";', EDGE_ONLY)).toEqual(["crypto"]);
  });

  it("[CFB-6] the adapter's list names only Node built-ins, and it is not empty", () => {
    const list = cloudflare().supportedBuiltins ?? [];
    expect(list.length).toBeGreaterThan(20);
    expect(list).toContain("crypto");
    expect(list).toContain("async_hooks");
    expect(list).not.toContain("child_process");
    expect(list).not.toContain("worker_threads");
    for (const name of list) {
      expect(specifiersOf(`import "node:${name}";`, cloudflare())).toEqual([]);
    }
  });

  it("[CFB-7] the Node.js runtime adapters are unchanged: every built-in is allowed there", () => {
    expect(specifiersOf('import "node:child_process";', NODE)).toEqual([]);
  });
});
