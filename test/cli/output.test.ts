/**
 * The text of the `dusk` bin (`output.ts`): the banners, the request lines, the log lines Vite's logger hands over, the
 * build summary, the help, and the color rules. Nothing here starts a server.
 *
 * - CLI-18 the dev banner and the start banner: the version and mode, the addresses, the env files, the adapter, and the time.
 * - CLI-19 the color rules: NO_COLOR, FORCE_COLOR, CI, and a stream that is not a terminal are plain.
 * - CLI-20 a message of Vite's logger is worded for Dusk: the tag, the restart and the optimizer notices, and a
 *   stray "Vite" in text; an error keeps the stack frames and the plugin names; quiet events need --verbose.
 * - CLI-21 the request line: method, path, status (colored by class) and the time; no query string is ever printed.
 * - CLI-22 the build summary: the phases, the route table, the shared row, the budget warnings, the time.
 * - CLI-23 no line of the bin's own text says "vite" (the help, the banners, the summary, the shortcuts).
 */
import { describe, expect, it } from "vitest";
import type { BuildSummary } from "../../src/cli/build-summary";
import { COMMANDS } from "../../src/cli/commands";
import {
  bannerLines,
  buildLines,
  commandHelp,
  kilobytes,
  logLine,
  mainHelp,
  paint,
  requestLine,
  shortcutLines,
  stripAnsi,
  type Terminal,
  terminalOf,
} from "../../src/cli/output";

const PLAIN: Terminal = { color: false, interactive: false, unicode: true, columns: undefined };
const COLOR: Terminal = { color: true, interactive: true, unicode: true, columns: undefined };
const NOW = new Date(2026, 9, 10, 5, 22, 19);

describe("dusk output: banners", () => {
  it("[CLI-18] the dev banner names the version, mode, addresses, env files, adapter and start time", () => {
    const lines = bannerLines(
      {
        version: "0.0.0",
        mode: "development",
        local: ["http://localhost:3000/"],
        network: [],
        networkHint: "pass --host to listen on the network",
        environments: [".env", ".env.local"],
        adapter: undefined,
        readyMs: 345.4,
      },
      PLAIN,
    );
    expect(lines).toEqual([
      "◆ Dusk 0.0.0 (development)",
      "  - Local:        http://localhost:3000/",
      "  - Network:      not exposed (pass --host to listen on the network)",
      "  - Environments: .env, .env.local",
      "  - Adapter:      none",
      "",
      "✓ Ready in 345ms",
    ]);
  });

  it("[CLI-18] the start banner lists the network addresses when the server listens on the network", () => {
    const lines = bannerLines(
      {
        version: "0.0.0",
        mode: "production",
        local: ["http://127.0.0.1:3000/"],
        network: ["http://192.168.1.4:3000/", "http://10.0.0.2:3000/"],
        networkHint: "set HOST",
        environments: [],
        adapter: "node",
        readyMs: 21,
      },
      PLAIN,
    );
    expect(lines).toEqual([
      "◆ Dusk 0.0.0 (production)",
      "  - Local:        http://127.0.0.1:3000/",
      "  - Network:      http://192.168.1.4:3000/",
      `  - ${" ".repeat(14)}http://10.0.0.2:3000/`,
      "  - Environments: none",
      "  - Adapter:      node",
      "",
      "✓ Ready in 21ms",
    ]);
  });

  it("[CLI-19] color follows NO_COLOR, FORCE_COLOR, CI and whether stdout is a terminal", () => {
    const rules = (color: boolean, interactive: boolean): Terminal => ({
      color,
      interactive,
      unicode: true,
      columns: undefined,
    });
    expect(terminalOf({}, true)).toEqual(rules(true, true));
    expect(terminalOf({}, false)).toEqual(rules(false, false));
    expect(terminalOf({ NO_COLOR: "1" }, true)).toEqual(rules(false, true));
    expect(terminalOf({ FORCE_COLOR: "1" }, false)).toEqual(rules(true, false));
    expect(terminalOf({ FORCE_COLOR: "0" }, false)).toEqual(rules(false, false));
    // CI: plain, and no keys (nobody is at the terminal).
    expect(terminalOf({ CI: "true" }, true)).toEqual(rules(false, false));
    expect(paint(PLAIN, "green", "ok")).toBe("ok");
    expect(stripAnsi(paint(COLOR, "green", "ok"))).toBe("ok");
    expect(paint(COLOR, "green", "ok")).not.toBe("ok");
  });
});

describe("dusk output: Vite's messages in Dusk's words", () => {
  const facts = { timestamp: false, verbose: false, now: NOW };

  it("[CLI-20] the tag and the optimizer and restart notices are Dusk's; an unrelated Vite word becomes Dusk", () => {
    expect(logLine("info", "[vite] hello", facts, PLAIN)).toBe("[dusk] hello");
    expect(
      logLine("info", "Re-optimizing dependencies because vite config has changed", facts, PLAIN),
    ).toBe("Re-optimizing dependencies because config has changed");
    expect(logLine("info", "vite.config.ts changed, restarting server...", facts, PLAIN)).toBe(
      "Config changed, restarting the dev server.",
    );
    expect(logLine("info", "routes.tsx changed, restarting server...", facts, PLAIN)).toBe(
      "routes.tsx changed, restarting the dev server.",
    );
    expect(logLine("info", "Vite's cache is stale", facts, PLAIN)).toBe("Dusk's cache is stale");
    expect(
      logLine(
        "warn",
        "The import cannot be analyzed by Vite. See https://vite.dev/guide.",
        facts,
        PLAIN,
      ),
    ).toBe("warn The import cannot be analyzed by Dusk. See https://vite.dev/guide.");
    // A path is a fact, not a brand: it keeps its name.
    expect(logLine("info", "reading /app/node_modules/vite/dist/index.js", facts, PLAIN)).toBe(
      "reading /app/node_modules/vite/dist/index.js",
    );
  });

  it("[CLI-20] quiet events are hidden unless --verbose; the port search line is always hidden", () => {
    expect(logLine("info", "hmr update /src/app.tsx", facts, PLAIN)).toBeUndefined();
    expect(logLine("info", "page reload /src/app.tsx", facts, PLAIN)).toBeUndefined();
    expect(logLine("info", "hmr update /src/app.tsx", { ...facts, verbose: true }, PLAIN)).toBe(
      "hmr update /src/app.tsx",
    );
    expect(
      logLine("info", "Port 3000 is in use, trying another one...", facts, PLAIN),
    ).toBeUndefined();
    expect(logLine("warn", "Port 3000 is in use, trying another one...", facts, PLAIN)).toBe(
      "warn Port 3000 is in use, trying another one...",
    );
  });

  it("[CLI-20] a timestamped line carries the time and the Dusk tag; a warning carries its label once", () => {
    expect(
      logLine("info", "page reload /x", { ...facts, timestamp: true, verbose: true }, PLAIN),
    ).toBe("05:22:19 [dusk] page reload /x");
    expect(
      logLine(
        "warn",
        "warning: unused import in src/app.tsx",
        { ...facts, timestamp: true },
        PLAIN,
      ),
    ).toBe("05:22:19 [dusk] warn unused import in src/app.tsx");
  });

  it("[CLI-20] an error keeps its stack frames and the plugin name the author needs", () => {
    const error = [
      "Failed to load src/routes/x.tsx",
      "Plugin: vite:import-analysis",
      "    at load (/app/node_modules/vite/dist/node/chunks/node.js:10:3)",
    ].join("\n");
    expect(logLine("error", error, facts, PLAIN)).toBe(error);
    expect(logLine("error", "[vite] transform failed", facts, PLAIN)).toBe(
      "[dusk] transform failed",
    );
  });
});

describe("dusk output: request lines", () => {
  it("[CLI-21] the line names the method, the path, the status and the time", () => {
    expect(requestLine({ method: "GET", path: "/dashboard", status: 200, ms: 33.6 }, PLAIN)).toBe(
      "GET /dashboard 200 in 34ms",
    );
    expect(requestLine({ method: "POST", path: "/api/v1/files", status: 500, ms: 2 }, PLAIN)).toBe(
      "POST /api/v1/files 500 in 2ms",
    );
  });

  it("[CLI-21] a request of a second or more shows its time in seconds and in yellow; a quick one is dim", () => {
    expect(requestLine({ method: "GET", path: "/", status: 200, ms: 1234 }, PLAIN)).toBe(
      "GET / 200 in 1.2s",
    );
    expect(requestLine({ method: "GET", path: "/", status: 200, ms: 1000 }, COLOR)).toContain(
      "\u001b[33min 1.0s\u001b[39m",
    );
    expect(requestLine({ method: "GET", path: "/", status: 200, ms: 999 }, COLOR)).toContain(
      "\u001b[2min 999ms\u001b[22m",
    );
  });

  it("[CLI-21] the status is colored by its class", () => {
    const color = (status: number): string =>
      requestLine({ method: "GET", path: "/", status, ms: 1 }, COLOR);
    expect(color(200)).toContain("\u001b[32m200\u001b[39m");
    expect(color(301)).toContain("\u001b[36m301\u001b[39m");
    expect(color(404)).toContain("\u001b[33m404\u001b[39m");
    expect(color(503)).toContain("\u001b[31m503\u001b[39m");
  });
});

describe("dusk output: build summary", () => {
  const summary: BuildSummary = {
    version: "1.0.0",
    steps: [
      { name: "client", ms: 1200 },
      { name: "server", ms: 900 },
      { name: "prerender", ms: 300 },
      { name: "secret-scan", ms: 40 },
      { name: "adapter", ms: 5 },
    ],
    prerendered: 2,
    secretScan: { enabled: true, scanned: 14 },
    adapter: { name: "node", outDir: "dist/node" },
    adapterLog: ["wrote dist/node/server.mjs (start with: node dist/node/server.mjs)"],
    routes: [
      {
        path: "/",
        family: "static",
        kind: "static (file)",
        bytes: 72_400,
        size: 33_600,
        middleware: 0,
      },
      {
        path: "/dashboard",
        family: "dynamic",
        kind: "dynamic",
        bytes: 118_000,
        size: 53_200,
        middleware: 1,
        overBudget: true,
      },
      { path: "/api/env", family: "api", kind: "API", bytes: 0, middleware: 0 },
    ],
    shared: { bytes: 64_800, files: 2 },
    warnings: [
      "/dashboard loads 118.0 kB of JavaScript first, over its budget of 100.0 kB (build.budgets in dusk.config.ts).",
    ],
    ms: 2500,
  };

  it("[CLI-22] the summary lists the phases, the route table, the shared row, the legend, the warnings and the time", () => {
    expect(buildLines(summary, PLAIN)).toEqual([
      "◆ Dusk 1.0.0 (production)",
      "",
      "  ✓ Compiled client      dist/client                   1.2s",
      "  ✓ Compiled server      dist/server                  900ms",
      "  ✓ Prerendered 2 pages                               300ms",
      "  ✓ Secret scan          no secrets in 14 text files   40ms",
      "  ✓ node adapter         dist/node                      5ms",
      "                         wrote dist/node/server.mjs (start with: node dist/node/server.mjs)",
      "",
      "  Route           Kind           Size     First Load JS  Middleware",
      "  ┌ ○ /           static (file)  33.6 kB  72.4 kB        -",
      "  ├ ƒ /dashboard  dynamic        53.2 kB  118.0 kB ⚠     1",
      "  └ λ /api/env    API            -        -              -",
      "  + First Load JS shared by all           64.8 kB (2 files)",
      "",
      "  ○ static  ƒ dynamic  λ API",
      "",
      "  ⚠ warn /dashboard loads 118.0 kB of JavaScript first, over its budget of 100.0 kB (build.budgets in dusk.config.ts).",
      "",
      "✓ Built in 2.5s, output in dist/",
      "  Serve it with `dusk start`, or run `node dist/node/server.mjs`.",
    ]);
  });

  it("[CLI-22] an app without an adapter has no adapter step; a disabled secret scan says so", () => {
    const lines = buildLines(
      {
        ...summary,
        adapter: undefined,
        adapterLog: [],
        steps: [{ name: "secret-scan", ms: 3 }],
        secretScan: { enabled: false, scanned: 0 },
        routes: [],
        warnings: [],
      },
      PLAIN,
    );
    expect(lines.join("\n")).toContain("off (build.secretScan is false)");
    expect(lines.join("\n")).not.toContain("adapter");
    expect(lines.join("\n")).not.toContain("Route");
  });

  it("[CLI-22] kilobytes are decimal (1000 bytes) with one decimal place", () => {
    expect(kilobytes(72_400)).toBe("72.4 kB");
    expect(kilobytes(999)).toBe("1.0 kB");
  });
});

describe("dusk output: no Vite wording in the bin's own text", () => {
  it("[CLI-23] the help, the shortcuts and the banners never say vite", () => {
    const help = [
      mainHelp("0.0.0"),
      ...COMMANDS.map((command) => commandHelp(command)),
      shortcutLines(PLAIN).join("\n"),
      bannerLines(
        {
          version: "0.0.0",
          mode: "development",
          local: ["http://localhost:3000/"],
          network: [],
          networkHint: "pass --host",
          environments: [".env"],
          adapter: "node",
          readyMs: 1,
        },
        PLAIN,
      ).join("\n"),
    ].join("\n");
    expect(help).not.toMatch(/vite/i);
  });
});
