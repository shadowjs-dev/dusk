import type { BuildSummary, RouteFamily, RouteRow } from "./build-summary";
import { COMMANDS, type CommandSpec } from "./commands";

/**
 * The text the `dusk` bin prints, and the one place its wording lives: the help, the banners of `dev` and `start`, the
 * request lines, the log lines, the build summary, the keyboard help, and the failures. Nothing here says "Vite": Vite's
 * own log messages are reworded by {@link logLine}. An error from a Vite plugin keeps the plugin's name, because that is
 * the fact the author needs to find the cause.
 *
 * Every command speaks the same way: the same header (`dusk <command>` in the brand glyph and the version), the same `✓`,
 * `✗` and `warn` markers, the same durations (`34ms`, `1.2s`), and the same two-space indent for the body.
 *
 * Color follows the terminal: none when `NO_COLOR` is set, when the output is not a terminal, or on CI; `FORCE_COLOR`
 * turns it on. The glyphs (`✓ ✗ ○ ƒ ┌ ├ └`) are Unicode on every terminal that can draw them and ASCII (`+ x o f / | \`)
 * where it cannot (the Linux console, a legacy Windows console), so no one sees a box of missing characters. The width
 * of the terminal is read once, and the route table of `dusk build` gives up its optional columns before it wraps.
 *
 * @packageDocumentation
 */

/** What the output can do, from the environment and the stream. @since 1.0.0 */
export interface Terminal {
  /** Whether lines carry ANSI color codes. */
  readonly color: boolean;
  /** Whether a person is watching a terminal: keys, the clear-screen shortcut and the spinner work. */
  readonly interactive: boolean;
  /** Whether the glyphs are Unicode (`✓ ○ ┌`); false prints their ASCII forms. */
  readonly unicode: boolean;
  /** How many characters fit on a line, or undefined when the output is not a terminal (a pipe, a log file): no limit. */
  readonly columns: number | undefined;
}

/** What {@link terminalOf} reads besides the environment. @since 1.0.0 */
export interface TerminalFacts {
  /** `process.platform`. Defaults to the running platform. */
  readonly platform?: string;
  /** `process.stdout.columns`. */
  readonly columns?: number | undefined;
}

/**
 * The output of a command: the color, interaction and glyph rules, from the environment and whether stdout is a TTY.
 * @param env The environment.
 * @param isTTY Whether stdout is a terminal.
 * @param facts The platform and the width of the terminal.
 * @returns The rules.
 * @since 1.0.0
 */
export function terminalOf(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  facts: TerminalFacts = {},
): Terminal {
  const ci = set(env["CI"]) && env["CI"] !== "0" && env["CI"] !== "false";
  const forced = set(env["FORCE_COLOR"]) && env["FORCE_COLOR"] !== "0";
  const plain = set(env["NO_COLOR"]);
  const columns = facts.columns;
  return {
    color: forced || (!plain && isTTY && !ci),
    interactive: isTTY && !ci,
    unicode: canDrawUnicode(env, facts.platform ?? process.platform),
    columns: isTTY && columns !== undefined && columns > 0 ? columns : undefined,
  };
}

/**
 * Whether the terminal draws the glyphs: every terminal does but the Linux console and a Windows console that is neither
 * Windows Terminal, a terminal program (VS Code, ConEmu...) nor a `TERM`-aware shell (Git Bash, WSL).
 * @internal
 */
function canDrawUnicode(env: NodeJS.ProcessEnv, platform: string): boolean {
  if (env["TERM"] === "linux") return false;
  if (platform !== "win32") return true;
  return (
    set(env["WT_SESSION"]) ||
    set(env["TERM_PROGRAM"]) ||
    env["ConEmuANSI"] === "ON" ||
    (set(env["TERM"]) && env["TERM"] !== "dumb")
  );
}

/** The rules of the process's own stdout. @since 1.0.0 */
export function currentTerminal(): Terminal {
  return terminalOf(process.env, process.stdout.isTTY === true, {
    columns: process.stdout.columns,
  });
}

/** The glyphs of the output, in the Unicode or the ASCII form. @since 1.0.0 */
export interface Glyphs {
  readonly brand: string;
  readonly ok: string;
  readonly fail: string;
  readonly warn: string;
  readonly bullet: string;
  readonly ellipsis: string;
  /** The branches of the route table: the first row, a middle row, the last row. */
  readonly first: string;
  readonly middle: string;
  readonly last: string;
  readonly kinds: Readonly<Record<RouteFamily, string>>;
  /** The frames of the spinner. */
  readonly spinner: readonly string[];
}

const UNICODE_GLYPHS: Glyphs = {
  brand: "◆",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  bullet: "-",
  ellipsis: "…",
  first: "┌",
  middle: "├",
  last: "└",
  kinds: {
    static: "○",
    handler: "●",
    isr: "◐",
    dynamic: "ƒ",
    client: "◇",
    api: "λ",
    stream: "≈",
  },
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII_GLYPHS: Glyphs = {
  brand: "*",
  ok: "+",
  fail: "x",
  warn: "!",
  bullet: "-",
  ellipsis: "...",
  first: ",",
  middle: "|",
  last: "\\",
  kinds: { static: "o", handler: "*", isr: "~", dynamic: "f", client: "c", api: "a", stream: "s" },
  spinner: ["-", "\\", "|", "/"],
};

/**
 * The glyph set of a terminal.
 * @param term The output's rules.
 * @returns The glyphs.
 * @since 1.0.0
 */
export function glyphsOf(term: Terminal): Glyphs {
  return term.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

function set(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

const ESC = String.fromCharCode(27);
const TONES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

/** One color of the output. @since 1.0.0 */
export type Tone = keyof typeof TONES;

/**
 * Wraps text in a color when the terminal takes color; otherwise returns the text unchanged.
 * @param term The output's rules.
 * @param tone The color.
 * @param text The text.
 * @returns The text, colored or plain.
 * @since 1.0.0
 */
export function paint(term: Terminal, tone: Tone, text: string): string {
  if (!term.color) return text;
  const [open, close] = TONES[tone];
  return `${ESC}[${open}m${text}${ESC}[${close}m`;
}

const ANSI: RegExp = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** The text without color codes (Vite's messages carry their own). @since 1.0.0 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** The sequence that clears a terminal (the `c` shortcut). @since 1.0.0 */
export const CLEAR_SCREEN: string = `${ESC}[2J${ESC}[3J${ESC}[H`;

/** Writes a line to stdout. @since 1.0.0 */
export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/** Writes a line to stderr. @since 1.0.0 */
export function err(line = ""): void {
  process.stderr.write(`${line}\n`);
}

/** The time of day of a log line: `HH:MM:SS`, 24 hours. @since 1.0.0 */
export function clockOf(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * A duration in milliseconds, as every line of the bin shows it: `34ms` below a second, `1.2s` above.
 * @param ms The duration.
 * @returns The text.
 * @since 1.0.0
 */
export function durationText(ms: number): string {
  return ms < 999.5 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Bytes as kilobytes of 1000 bytes, one decimal: `72.4 kB`. @since 1.0.0 */
export function kilobytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

// ---- banners -----------------------------------------------------------------------------------

/** The facts a banner shows. @since 1.0.0 */
export interface BannerFacts {
  readonly version: string;
  readonly mode: "development" | "production";
  /** The local addresses the server answers on. */
  readonly local: readonly string[];
  /** The network addresses, when the server listens on the network. Empty when it does not. */
  readonly network: readonly string[];
  /** What to read when the server is not on the network (the flag or variable that exposes it). */
  readonly networkHint: string;
  /** The env files the variables came from, by name. */
  readonly environments: readonly string[];
  /** The adapter of the build, when there is one. */
  readonly adapter: string | undefined;
  /** How long the start took. */
  readonly readyMs: number;
}

/**
 * The banner of `dusk dev` and `dusk start`: the version and mode, the addresses, the env files, the adapter, and how
 * long the start took.
 * @param facts What the banner shows.
 * @param term The output's rules.
 * @returns The lines, without a trailing newline.
 * @since 1.0.0
 */
export function bannerLines(facts: BannerFacts, term: Terminal): string[] {
  const glyphs = glyphsOf(term);
  // A row without a name continues the list above it (a second address).
  const row = (name: string, value: string): string =>
    `  ${glyphs.bullet} ${paint(term, "dim", (name === "" ? "" : `${name}:`).padEnd(14))}${value}`;
  const [first = "", ...rest] = facts.local;
  const lines = [
    headerLine(term, `${facts.version} (${facts.mode})`),
    row("Local", first),
    ...rest.map((url) => row("", url)),
  ];
  if (facts.network.length === 0) {
    lines.push(row("Network", `not exposed (${facts.networkHint})`));
  } else {
    const [firstNetwork = "", ...more] = facts.network;
    lines.push(row("Network", firstNetwork), ...more.map((url) => row("", url)));
  }
  lines.push(
    row("Environments", facts.environments.length === 0 ? "none" : facts.environments.join(", ")),
    row("Adapter", facts.adapter ?? "none"),
    "",
    `${paint(term, "green", glyphs.ok)} Ready in ${durationText(facts.readyMs)}`,
  );
  return lines;
}

/**
 * The first line of every command: the brand glyph, the name and what follows (`◆ Dusk 1.0.0 (production)`).
 * @param term The output's rules.
 * @param detail What follows the name: the version and the mode.
 * @returns The line.
 * @since 1.0.0
 */
export function headerLine(term: Terminal, detail: string): string {
  return `${paint(term, "cyan", glyphsOf(term).brand)} ${paint(term, "bold", `Dusk ${detail}`)}`;
}

// ---- requests and logs --------------------------------------------------------------------------

/** A request at least this slow (in milliseconds) is marked in the request line. @since 1.0.0 */
export const SLOW_MS = 1000;

/** A request the server answered. `ms` is the time it took. @since 1.0.0 */
export interface RequestFacts {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
}

/** The line of a request the server answered: `GET /dashboard 200 in 34ms`. @since 1.0.0 */
export function requestLine(request: RequestFacts, term: Terminal): string {
  const tone: Tone =
    request.status >= 500
      ? "red"
      : request.status >= 400
        ? "yellow"
        : request.status >= 300
          ? "cyan"
          : "green";
  // A request that took a second or more stands out; the rest keep the time quiet.
  const time = paint(
    term,
    request.ms >= SLOW_MS ? "yellow" : "dim",
    `in ${durationText(request.ms)}`,
  );
  return `${request.method} ${request.path} ${paint(term, tone, String(request.status))} ${time}`;
}

/** One log message of the dev server or the start command, as Vite's logger hands it over. @since 1.0.0 */
export interface LogFacts {
  readonly timestamp: boolean;
  /** `--verbose`: the events that are quiet by default (hot updates, page reloads) are shown. */
  readonly verbose: boolean;
  readonly now: Date;
}

/** Vite's own events that are quiet unless `--verbose`. @internal */
const QUIET = /^(?:hmr update|page reload|bundling for page reload|trigger page reload)\b/;
/** Vite's notice that it moved to the next free port: the banner says where the server is instead. @internal */
const PORT_SEARCH = /^Port \d+ is in use, trying another one\.\.\./;
/** A file change that restarts the dev server (Vite's words, with the file name). @internal */
const RESTART = /^(?:.*\/)?([^/]+) changed, restarting server\.\.\./;
const CONFIG_FILE = /^vite\.config\.[cm]?[jt]s$/;

/**
 * The text of one log message, or undefined when it is quiet. Vite's `[vite]` tag becomes `[dusk]`, its restart and
 * optimizer notices are worded for Dusk, and any other mention of Vite in an info or warning becomes Dusk. The stack
 * frames of an error keep their paths (they are facts), and the plugin names of an error are not reworded.
 * @param kind The log level.
 * @param message The message.
 * @param facts Whether the message is timestamped, and whether the output is verbose.
 * @param term The output's rules.
 * @returns The line to print, or undefined.
 * @since 1.0.0
 */
export function logLine(
  kind: "info" | "warn" | "error",
  message: string,
  facts: LogFacts,
  term: Terminal,
): string | undefined {
  const plain = stripAnsi(message);
  if (kind === "info" && !facts.verbose && QUIET.test(plain)) return undefined;
  if (kind === "info" && PORT_SEARCH.test(plain)) return undefined;
  const text = reword(plain, kind);
  const stamp = facts.timestamp ? `${clockOf(facts.now)} [dusk] ` : "";
  if (kind === "warn") {
    // The bundler's warnings start with their own "warning:": the label already says it.
    const body = text.replace(/^warning:\s*/i, "");
    return `${stamp}${paint(term, "yellow", "warn")} ${body}`;
  }
  return `${stamp}${text}`;
}

function reword(text: string, kind: "info" | "warn" | "error"): string {
  let out = text.replaceAll("[vite]", "[dusk]");
  out = out.replace(/vite config has changed/g, "config has changed");
  out = out.replace(RESTART, (_match, file: string) =>
    CONFIG_FILE.test(file)
      ? "Config changed, restarting the dev server."
      : `${file} changed, restarting the dev server.`,
  );
  if (kind === "error") return out;
  // A Vite name that is a word of the text (not a path such as `node_modules/vite/`, not `vite.config.ts`, and not a
  // plugin's name such as `vite:import-analysis`, which the author needs to find the plugin): the brand of the output.
  return out.replace(
    /(?<![\w./\\-])[Vv]ite(?![\w\-/\\:]|\.(?:config|dev|[cm]?[jt]sx?|json)\b)/g,
    "Dusk",
  );
}

/** The one line that tells a person at a terminal that the keys work. @since 1.0.0 */
export function shortcutHint(term: Terminal): string {
  return paint(term, "dim", "  press h to show the keyboard shortcuts");
}

/** The line a shortcut prints when it starts an action (`restart`, `open`). @since 1.0.0 */
export function actionLine(term: Terminal, text: string): string {
  return paint(term, "dim", text);
}

/** The line printed when a stop signal arrives: the server finishes the requests in flight, then exits. @since 1.0.0 */
export function stoppingLine(signal: string, what: string): string {
  return `Stopping the ${what} (${signal}): finishing requests in flight.`;
}

/** The last line of a clean stop. @since 1.0.0 */
export const STOPPED_LINE = "Stopped.";

/** The line printed on a second stop signal, which exits at once. @since 1.0.0 */
export const FORCED_LINE = "Second signal: exiting without waiting.";

/** The keyboard shortcuts of `dusk dev`, as the help of the `h` key lists them. @since 1.0.0 */
export function shortcutLines(term: Terminal): string[] {
  return [
    paint(term, "bold", "Shortcuts"),
    "  press r to restart the server",
    "  press o to open the app in the browser",
    "  press c to clear the console",
    "  press q to stop the server",
    "  press h to show this help",
  ];
}

// ---- build summary -----------------------------------------------------------------------------

/** The folder the build writes (relative to the app). @internal */
const BUILD_OUTPUT = "dist";

const STEP_LABEL = {
  client: "Compiled client",
  server: "Compiled server",
  prerender: "Prerendered",
  "secret-scan": "Secret scan",
} as const;

/** The body of every command is indented under its header. @internal */
const INDENT = "  ";
/** The space between two columns of the route table. @internal */
const GAP = 2;
/** The widest first load (gzip bytes) that is shown as light, and the widest that is shown as heavy. @internal */
const LIGHT_BYTES = 100_000;
const HEAVY_BYTES = 170_000;

const FAMILY_WORDS: Readonly<Record<RouteFamily, string>> = {
  static: "static",
  handler: "static (via handler)",
  isr: "ISR",
  dynamic: "dynamic",
  client: "client",
  api: "API",
  stream: "stream",
};

const FAMILY_ORDER: readonly RouteFamily[] = [
  "static",
  "handler",
  "isr",
  "dynamic",
  "client",
  "api",
  "stream",
];

const FAMILY_TONE: Readonly<Record<RouteFamily, Tone>> = {
  static: "green",
  handler: "green",
  isr: "cyan",
  dynamic: "magenta",
  client: "dim",
  api: "cyan",
  stream: "cyan",
};

/** The color of a size: quiet while light, yellow when it grows, red when heavy or over its budget. @internal */
function sizeTone(bytes: number | undefined, over: boolean): Tone {
  if (over) return "red";
  if (bytes === undefined || bytes === 0) return "dim";
  if (bytes <= LIGHT_BYTES) return "green";
  return bytes <= HEAVY_BYTES ? "yellow" : "red";
}

function sizeText(bytes: number | undefined): string {
  return bytes === undefined ? "n/a" : bytes === 0 ? "-" : kilobytes(bytes);
}

/** `text` cut to `max` characters with the ellipsis at the start: the end of a path is what tells two paths apart. @internal */
function tail(text: string, max: number, ellipsis: string): string {
  if (text.length <= max) return text;
  return `${ellipsis}${text.slice(text.length - Math.max(1, max - ellipsis.length))}`;
}

function cell(text: string, width: number, tone?: Tone, term?: Terminal): string {
  const pad = " ".repeat(Math.max(0, width - text.length));
  return `${tone === undefined || term === undefined ? text : paint(term, tone, text)}${pad}`;
}

/**
 * The route table: a branch and a symbol for each route, its kind in words, the JavaScript only that page loads, the
 * first load (shared part included), and the middleware that covers it; then the shared row and a legend of the
 * symbols in use. When the terminal is narrow the Middleware, Kind and Size columns go in that order (the symbol still says
 * the kind and the legend explains it), and last a long path is cut at its start.
 * @internal
 */
function routeTableLines(summary: BuildSummary, term: Terminal): string[] {
  const glyphs = glyphsOf(term);
  const rows = summary.routes;
  const branch = (index: number): string =>
    rows.length === 1
      ? glyphs.middle
      : index === 0
        ? glyphs.first
        : index === rows.length - 1
          ? glyphs.last
          : glyphs.middle;
  const show = { kind: true, size: true, middleware: rows.some((row) => row.middleware > 0) };
  // A page with no JavaScript (an API route) has no size at all; a page over its budget carries the warning mark.
  const ownText = (row: RouteRow): string => (row.bytes === 0 ? "-" : sizeText(row.size));
  const firstText = (row: RouteRow): string =>
    row.overBudget === true ? `${sizeText(row.bytes)} ${glyphs.warn}` : sizeText(row.bytes);
  const widths = {
    route: Math.max("Route".length, ...rows.map((row) => 4 + row.path.length)),
    kind: Math.max("Kind".length, ...rows.map((row) => row.kind.length)),
    size: Math.max("Size".length, ...rows.map((row) => ownText(row).length)),
    first: Math.max("First Load JS".length, ...rows.map((row) => firstText(row).length)),
    middleware: "Middleware".length,
  };
  const total = (): number =>
    INDENT.length +
    widths.route +
    (show.kind ? GAP + widths.kind : 0) +
    (show.size ? GAP + widths.size : 0) +
    GAP +
    widths.first +
    (show.middleware ? GAP + widths.middleware : 0);
  const limit = term.columns;
  if (limit !== undefined) {
    for (const column of ["middleware", "kind", "size"] as const) {
      if (total() > limit) show[column] = false;
    }
    if (total() > limit) widths.route = Math.max(12, widths.route - (total() - limit));
  }
  const gap = " ".repeat(GAP);
  const header = [
    cell("Route", widths.route),
    ...(show.kind ? [cell("Kind", widths.kind)] : []),
    ...(show.size ? [cell("Size", widths.size)] : []),
    cell("First Load JS", widths.first),
    ...(show.middleware ? ["Middleware"] : []),
  ];
  const lines = [INDENT + paint(term, "dim", header.join(gap).trimEnd())];
  rows.forEach((row: RouteRow, index) => {
    const symbol = glyphs.kinds[row.family];
    const path = tail(row.path, widths.route - 4, glyphs.ellipsis);
    const route = `${branch(index)} ${paint(term, FAMILY_TONE[row.family], symbol)} ${path}`;
    const routeCell = route + " ".repeat(Math.max(0, widths.route - (4 + path.length)));
    const over = row.overBudget === true;
    const cells = [
      routeCell,
      ...(show.kind ? [cell(row.kind, widths.kind, FAMILY_TONE[row.family], term)] : []),
      ...(show.size ? [cell(ownText(row), widths.size, "dim", term)] : []),
      cell(firstText(row), widths.first, sizeTone(row.bytes, over), term),
      ...(show.middleware ? [row.middleware === 0 ? "-" : String(row.middleware)] : []),
    ];
    lines.push(INDENT + cells.join(gap).trimEnd());
  });
  const shared = summary.shared.bytes === undefined ? "n/a" : kilobytes(summary.shared.bytes);
  const files = summary.shared.files === 1 ? "1 file" : `${summary.shared.files} files`;
  const label = "+ First Load JS shared by all";
  const before =
    widths.route + (show.kind ? GAP + widths.kind : 0) + (show.size ? GAP + widths.size : 0) + GAP;
  lines.push(
    `${INDENT}${paint(term, "dim", label)}${" ".repeat(Math.max(GAP, before - label.length))}${paint(term, sizeTone(summary.shared.bytes, false), shared)} ${paint(term, "dim", `(${files})`)}`,
  );
  lines.push("", ...legendLines(rows, term));
  return lines;
}

/** The symbols the table uses, with their words, wrapped to the width of the terminal. @internal */
function legendLines(rows: readonly RouteRow[], term: Terminal): string[] {
  const glyphs = glyphsOf(term);
  const present = FAMILY_ORDER.filter((family) => rows.some((row) => row.family === family));
  const entries = present.map((family) => ({
    plain: `${glyphs.kinds[family]} ${FAMILY_WORDS[family]}`,
    painted: `${paint(term, FAMILY_TONE[family], glyphs.kinds[family])} ${paint(term, "dim", FAMILY_WORDS[family])}`,
  }));
  const lines: string[] = [];
  let line = "";
  let width = 0;
  const room = (term.columns ?? Number.POSITIVE_INFINITY) - INDENT.length;
  for (const entry of entries) {
    const need = (width === 0 ? 0 : GAP) + entry.plain.length;
    if (width > 0 && width + need > room) {
      lines.push(INDENT + line);
      line = "";
      width = 0;
    }
    line += (width === 0 ? "" : " ".repeat(GAP)) + entry.painted;
    width += (width === 0 ? 0 : GAP) + entry.plain.length;
  }
  if (line !== "") lines.push(INDENT + line);
  return lines;
}

/**
 * The summary of `dusk build`: the phases, the route table with the first-load JavaScript of each page, the shared
 * chunks, the budget warnings, and the total time.
 * @param summary What the build did.
 * @param term The output's rules.
 * @returns The lines, without a trailing newline.
 * @since 1.0.0
 */
export function buildLines(summary: BuildSummary, term: Terminal): string[] {
  const glyphs = glyphsOf(term);
  const lines: string[] = [headerLine(term, `${summary.version} (production)`), ""];
  // Each phase: a name, what it wrote, how long it took. The columns are as wide as their longest entry.
  const phases: { name: string; detail: string; ms: number; extra: readonly string[] }[] = [];
  for (const entry of summary.steps) {
    if (entry.name === "client" || entry.name === "server") {
      phases.push({
        name: STEP_LABEL[entry.name],
        detail: `${BUILD_OUTPUT}/${entry.name}`,
        ms: entry.ms,
        extra: [],
      });
    } else if (entry.name === "prerender") {
      const pages = summary.prerendered === 1 ? "1 page" : `${summary.prerendered} pages`;
      phases.push({
        name: `${STEP_LABEL.prerender} ${pages}`,
        detail: "",
        ms: entry.ms,
        extra: [],
      });
    } else if (entry.name === "secret-scan") {
      const detail = summary.secretScan.enabled
        ? `no secrets in ${summary.secretScan.scanned} text files`
        : "off (build.secretScan is false)";
      phases.push({ name: STEP_LABEL["secret-scan"], detail, ms: entry.ms, extra: [] });
    } else if (summary.adapter !== undefined) {
      // Without an adapter there is no adapter step: the build has nothing to write for a platform.
      phases.push({
        name: `${summary.adapter.name} adapter`,
        detail: summary.adapter.outDir,
        ms: entry.ms,
        extra: summary.adapterLog,
      });
    }
  }
  const nameWidth = Math.max(0, ...phases.map((phase) => phase.name.length)) + 2;
  const detailWidth = Math.max(0, ...phases.map((phase) => phase.detail.length)) + 2;
  const timeWidth = Math.max(0, ...phases.map((phase) => durationText(phase.ms).length));
  for (const phase of phases) {
    lines.push(
      `${INDENT}${paint(term, "green", glyphs.ok)} ${phase.name.padEnd(nameWidth)}${phase.detail.padEnd(detailWidth)}${paint(term, "dim", durationText(phase.ms).padStart(timeWidth))}`,
    );
    for (const message of phase.extra)
      lines.push(`${INDENT}  ${" ".repeat(nameWidth)}${paint(term, "dim", message)}`);
  }
  if (summary.routes.length > 0) lines.push("", ...routeTableLines(summary, term));
  for (const warning of summary.warnings) {
    lines.push("", `${INDENT}${paint(term, "yellow", `${glyphs.warn} warn`)} ${warning}`);
  }
  lines.push(
    "",
    `${paint(term, "green", glyphs.ok)} Built in ${durationText(summary.ms)}, output in ${BUILD_OUTPUT}/`,
  );
  if (summary.adapter?.name === "node") {
    lines.push(
      `${INDENT}${paint(term, "dim", "Serve it with `dusk start`, or run `node dist/node/server.mjs`.")}`,
    );
  }
  return lines;
}

// ---- failures and usage ------------------------------------------------------------------------

/** A failure line: the failure marker, the command, then the message. @since 1.0.0 */
export function failureLine(scope: string, message: string, term: Terminal): string {
  return `${paint(term, "red", glyphsOf(term).fail)} ${scope}: ${message}`;
}

/** The line that names a refused command line (exit 2). @since 1.0.0 */
export function usageLine(scope: string, message: string, term: Terminal): string {
  return `${paint(term, "red", glyphsOf(term).fail)} ${scope}: ${message}`;
}

// ---- help --------------------------------------------------------------------------------------

const COLUMN = 18;

function optionLines(command: CommandSpec): string[] {
  return command.options.map((option) => `  ${option.flag.padEnd(COLUMN)}${option.text}`);
}

/**
 * The help of the whole bin: the commands, the global options, and a few examples.
 * @param version The version of the package.
 * @param term The output's rules.
 * @returns The text, ending with a newline.
 * @since 1.0.0
 */
export function mainHelp(version: string, term: Terminal = PLAIN_TERMINAL): string {
  const commands = COMMANDS.filter((command) => command.name !== "preview");
  const title = (text: string): string => paint(term, "bold", text);
  const lines = [
    `${headerLine(term, version)}: the full-stack ShadowJS framework.`,
    "",
    `${title("Usage")}: dusk <command> [options]`,
    "",
    title("Commands:"),
    ...commands.map((command) => `  ${command.name.padEnd(COLUMN)}${command.summary}`),
    `  ${"preview".padEnd(COLUMN)}The same as dusk start.`,
    "",
    title("Options:"),
    `  ${"-h, --help".padEnd(COLUMN)}Show this help. After a command: show that command's options.`,
    `  ${"-v, --version".padEnd(COLUMN)}Print the version.`,
    `  ${"--json".padEnd(COLUMN)}Print JSON on stdout instead of words: every command takes it (JSON Lines for dev and start).`,
    "",
    title("Examples:"),
    "  dusk dev --open               Develop with hot reload and open the browser.",
    "  dusk build                    Build for production and print the route table.",
    "  dusk build --json             Print the build summary as JSON (for CI).",
    "  dusk doctor --json | jq -r '.warnings[].message'   List the warnings of the project.",
    "  dusk start --port 8080 --log  Serve the build on port 8080 and log each request.",
    "",
    "Configuration: dusk.config.ts holds the Dusk settings; the app's config file lists dusk() among its plugins.",
    "Run `dusk <command> --help` for the options of a command.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The help of one command.
 * @param command The command.
 * @param term The output's rules.
 * @returns The text, ending with a newline.
 * @since 1.0.0
 */
export function commandHelp(command: CommandSpec, term: Terminal = PLAIN_TERMINAL): string {
  const title = (text: string): string => paint(term, "bold", text);
  const operand = "shells" in command ? " <shell>" : "";
  const lines = [
    `${title("Usage")}: dusk ${command.name}${operand} [options]`,
    "",
    command.summary,
    "",
    title("Options:"),
    ...optionLines(command),
    ...(command.examples.length === 0
      ? []
      : ["", title("Examples:"), ...command.examples.map((example) => `  ${example}`)]),
  ];
  return `${lines.join("\n")}\n`;
}

/** The rules the help uses when it is not given any: no color, Unicode glyphs. @internal */
const PLAIN_TERMINAL: Terminal = {
  color: false,
  interactive: false,
  unicode: true,
  columns: undefined,
};
