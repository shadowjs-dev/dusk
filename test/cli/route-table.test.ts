/**
 * The look of `dusk build` and the rules every command shares (`output.ts`): the route table with its symbols, branches
 * and legend, how it gives way on a narrow terminal, the colors of the sizes, the glyph sets, and the failure lines.
 *
 * - CLI-35 each kind of route has its symbol and a branch; the legend lists only the kinds the build has.
 * - CLI-36 on a narrow terminal the Middleware, Kind and Size columns go in that order, then a long path is cut at its
 *   start; no line of the table is wider than the terminal.
 * - CLI-37 the first load is green while light, yellow when it grows, red when heavy or over its budget.
 * - CLI-38 the glyphs are Unicode where the terminal can draw them and ASCII where it cannot; the width is only known on a terminal.
 * - CLI-39 durations read the same everywhere; a failure and a usage error carry the same marker.
 * - CLI-40 the Middleware column appears only when a route is covered; a table of thousands of routes keeps every row.
 */
import { describe, expect, it } from "vitest";
import type { BuildSummary, RouteFamily, RouteRow } from "../../src/cli/build-summary";
import {
  buildLines,
  durationText,
  failureLine,
  glyphsOf,
  mainHelp,
  stripAnsi,
  type Terminal,
  terminalOf,
  usageLine,
} from "../../src/cli/output";

const PLAIN: Terminal = { color: false, interactive: false, unicode: true, columns: undefined };
const ASCII: Terminal = { ...PLAIN, unicode: false };
const COLOR: Terminal = { ...PLAIN, color: true };

function row(path: string, family: RouteFamily, extra: Partial<RouteRow> = {}): RouteRow {
  return {
    path,
    family,
    kind: family === "api" ? "API" : family,
    bytes: family === "api" ? 0 : 50_000,
    ...(family === "api" ? {} : { size: 10_000 }),
    middleware: 0,
    ...extra,
  };
}

function summaryOf(routes: readonly RouteRow[]): BuildSummary {
  return {
    version: "1.0.0",
    steps: [],
    prerendered: 0,
    secretScan: { enabled: false, scanned: 0 },
    adapter: undefined,
    adapterLog: [],
    routes,
    shared: { bytes: 38_300, files: 2 },
    warnings: [],
    ms: 10,
  };
}

/** The lines of the table: from the header to the shared row. */
function tableOf(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => stripAnsi(line).trimStart().startsWith("Route"));
  const end = lines.findIndex((line) => line.includes("First Load JS shared by all"));
  return lines.slice(start, end + 1);
}

describe("dusk build: the route table", () => {
  const every: RouteFamily[] = ["static", "handler", "isr", "dynamic", "client", "api", "stream"];

  it("[CLI-35] each kind has its symbol; the first row opens the tree and the last closes it", () => {
    const lines = buildLines(summaryOf(every.map((family) => row(`/${family}`, family))), PLAIN);
    const rows = tableOf(lines).slice(1, -1);
    expect(rows.map((line) => line.trim().slice(0, 3))).toEqual([
      "┌ ○",
      "├ ●",
      "├ ◐",
      "├ ƒ",
      "├ ◇",
      "├ λ",
      "└ ≈",
    ]);
    expect(lines).toContain(
      "  ○ static  ● static (via handler)  ◐ ISR  ƒ dynamic  ◇ client  λ API  ≈ stream",
    );
  });

  it("[CLI-35] the legend lists only the kinds the build has; a single route is not an open branch", () => {
    const lines = buildLines(summaryOf([row("/", "dynamic")]), PLAIN);
    expect(lines).toContain("  ƒ dynamic");
    expect(lines.join("\n")).not.toContain("static");
    expect(tableOf(lines)[1]?.trim().startsWith("├ ƒ /")).toBe(true);
  });

  it("[CLI-38] without Unicode the symbols and branches are ASCII", () => {
    const lines = buildLines(summaryOf(every.map((family) => row(`/${family}`, family))), ASCII);
    expect(
      tableOf(lines)
        .slice(1, -1)
        .map((line) => line.trim().slice(0, 3)),
    ).toEqual([", o", "| *", "| ~", "| f", "| c", "| a", "\\ s"]);
    // Nothing outside ASCII is printed.
    for (const line of lines) expect(line).toMatch(/^[ -~]*$/);
  });

  it("[CLI-36] a narrow terminal drops Middleware, then Kind, then Size, and never a row", () => {
    const routes = [
      row("/", "static", { middleware: 2 }),
      row("/dashboard", "dynamic"),
      row("/api/env", "api"),
    ];
    const columnsOf = (width: number): string[] =>
      (tableOf(buildLines(summaryOf(routes), { ...PLAIN, columns: width }))[0] ?? "")
        .trim()
        .split(/\s{2,}/);
    expect(columnsOf(200)).toEqual(["Route", "Kind", "Size", "First Load JS", "Middleware"]);
    expect(columnsOf(60)).toEqual(["Route", "Kind", "Size", "First Load JS"]);
    expect(columnsOf(46)).toEqual(["Route", "Size", "First Load JS"]);
    expect(columnsOf(32)).toEqual(["Route", "First Load JS"]);
    for (const columns of [200, 60, 46, 32, 24]) {
      const table = tableOf(buildLines(summaryOf(routes), { ...PLAIN, columns }));
      expect(table).toHaveLength(routes.length + 2);
    }
  });

  it("[CLI-36] no line of the table is wider than the terminal; a long path keeps its end", () => {
    const long = `/${"section/".repeat(8)}final-page`;
    const routes = [row("/", "static"), row(long, "dynamic")];
    const lines = buildLines(summaryOf(routes), { ...PLAIN, columns: 40 });
    const table = tableOf(lines);
    for (const line of table.slice(0, -1)) expect(line.length).toBeLessThanOrEqual(40);
    expect(table.some((line) => line.includes("…") && line.includes("final-page"))).toBe(true);
  });

  it("[CLI-37] the first load is green while light, yellow when it grows and red when heavy or over its budget", () => {
    const ESC = String.fromCharCode(27);
    const toneOf = (bytes: number, extra: Partial<RouteRow> = {}): string | undefined => {
      const text = tableOf(
        buildLines(summaryOf([row("/p", "dynamic", { bytes, ...extra })]), COLOR),
      )[1];
      return ["32", "33", "31"].find((code) =>
        text?.includes(`${ESC}[${code}m${(bytes / 1000).toFixed(1)} kB`),
      );
    };
    expect(toneOf(60_000)).toBe("32");
    expect(toneOf(130_000)).toBe("33");
    expect(toneOf(180_000)).toBe("31");
    expect(toneOf(60_000, { overBudget: true })).toBe("31");
    // No color, no escape codes at all.
    expect(buildLines(summaryOf([row("/p", "dynamic")]), PLAIN).join("\n")).toBe(
      stripAnsi(buildLines(summaryOf([row("/p", "dynamic")]), PLAIN).join("\n")),
    );
  });

  it("[CLI-40] the Middleware column appears only when a route is covered", () => {
    const none = tableOf(buildLines(summaryOf([row("/", "static")]), PLAIN))[0];
    expect(none).not.toContain("Middleware");
    const some = tableOf(buildLines(summaryOf([row("/", "static", { middleware: 1 })]), PLAIN))[0];
    expect(some).toContain("Middleware");
  });

  it("[CLI-40] a table of thousands of routes keeps every row and aligns them", () => {
    const routes = Array.from({ length: 5000 }, (_, index) => row(`/page-${index}`, "static"));
    const table = tableOf(buildLines(summaryOf(routes), PLAIN));
    expect(table).toHaveLength(5002);
    const rows = table.slice(1, -1);
    // The First Load column starts at the same place in every row.
    const starts = new Set(rows.map((line) => line.indexOf("50.0 kB")));
    expect(starts.size).toBe(1);
  });
});

describe("dusk output: the rules every command shares", () => {
  it("[CLI-38] Unicode glyphs everywhere but the Linux console and a legacy Windows console", () => {
    const unicode = (env: NodeJS.ProcessEnv, platform: string): boolean =>
      terminalOf(env, true, { platform }).unicode;
    expect(unicode({}, "darwin")).toBe(true);
    expect(unicode({}, "linux")).toBe(true);
    expect(unicode({ TERM: "linux" }, "linux")).toBe(false);
    expect(unicode({}, "win32")).toBe(false);
    expect(unicode({ WT_SESSION: "abc" }, "win32")).toBe(true);
    expect(unicode({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
    expect(unicode({ TERM: "xterm-256color" }, "win32")).toBe(true);
    expect(unicode({ TERM: "dumb" }, "win32")).toBe(false);
    expect(glyphsOf({ ...PLAIN, unicode: false }).ok).toBe("+");
  });

  it("[CLI-38] the width is known only on a terminal", () => {
    expect(terminalOf({}, true, { columns: 100 }).columns).toBe(100);
    expect(terminalOf({}, false, { columns: 100 }).columns).toBeUndefined();
    expect(terminalOf({}, true, { columns: 0 }).columns).toBeUndefined();
    expect(terminalOf({}, true).columns).toBeUndefined();
  });

  it("[CLI-39] durations are milliseconds below a second and seconds above", () => {
    expect(durationText(0.4)).toBe("0ms");
    expect(durationText(345.4)).toBe("345ms");
    expect(durationText(999.4)).toBe("999ms");
    expect(durationText(999.5)).toBe("1.0s");
    expect(durationText(1742)).toBe("1.7s");
    expect(durationText(62_000)).toBe("62.0s");
  });

  it("[CLI-39] a failure and a usage error carry the same marker and name the command", () => {
    expect(failureLine("dusk build", "the build wrote no manifest.", PLAIN)).toBe(
      "✗ dusk build: the build wrote no manifest.",
    );
    expect(usageLine("dusk", 'unknown command "x"', ASCII)).toBe('x dusk: unknown command "x"');
    expect(failureLine("dusk dev", "boom", COLOR)).toBe("\u001b[31m✗\u001b[39m dusk dev: boom");
  });

  it("[CLI-39] the help has examples and the same header as every command", () => {
    const help = mainHelp("1.0.0");
    expect(help.startsWith("◆ Dusk 1.0.0: the full-stack ShadowJS framework.")).toBe(true);
    expect(help).toContain("Examples:");
    expect(help).toContain("dusk build --json");
  });
});
