import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type JsonDocument, type JsonWarning, jsonFailure, jsonSuccess, writeJson } from "./json";
import { currentTerminal, glyphsOf, headerLine, out, paint, type Terminal } from "./output";
import { duskApiOf } from "./serving";
import { duskVersion } from "./version";

/**
 * `dusk doctor`: checks the project in the working folder and says what to fix. Each check is independent, reports
 * `ok`, `warn` or `fail` with a one-line fix, and never prints a value from an env file. The exit code is 1 when any
 * check fails and 0 otherwise (warnings do not fail). `--json` prints the JSON contract and nothing else on stdout: the
 * checks in `data`, each `warn` check in `warnings`, and `DUSK_DOCTOR_FAILED` as the error when a check failed.
 *
 * @packageDocumentation
 */

/** The outcome of one check. @since 1.0.0 */
export type DoctorStatus = "ok" | "warn" | "fail";

/** One check of the report. @since 1.0.0 */
export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message: string;
  /** What to do about a `warn` or a `fail`. */
  readonly fix?: string;
}

/** The report of `dusk doctor`. @since 1.0.0 */
export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

const MIN_NODE = [22, 12] as const;
const CONFIG_NAMES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const PUBLIC_PREFIXES = ["DUSK_PUBLIC_", "NEXT_PUBLIC_"];
const SECRET_WORDS = ["SECRET", "PRIVATE", "TOKEN", "PASSWORD"];
const NESTED_SCAN_LIMIT = 4000;

/**
 * Checks the Node version against the minimum Dusk supports (22.12).
 * @param version The version string, such as `process.versions.node`.
 * @returns The check.
 * @since 1.0.0
 */
export function checkNodeVersion(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return supported
    ? { id: "node", status: "ok", message: `Node ${version}` }
    : {
        id: "node",
        status: "fail",
        message: `Node ${version} is older than ${MIN_NODE[0]}.${MIN_NODE[1]}`,
        fix: `Install Node ${MIN_NODE[0]}.${MIN_NODE[1]} or later (an LTS release).`,
      };
}

function configFileOf(root: string): string | undefined {
  return CONFIG_NAMES.find((name) => existsSync(join(root, name)));
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]?.trim() || "unknown error";
}

interface ConfigResult {
  readonly check: DoctorCheck;
  readonly adapter: DoctorCheck;
  readonly srcDir: string;
}

async function checkConfig(root: string): Promise<ConfigResult> {
  const fallback = join(root, "src");
  const file = configFileOf(root);
  const adapterSkipped: DoctorCheck = {
    id: "adapter",
    status: "warn",
    message: "not checked because the config did not load",
  };
  if (file === undefined) {
    return {
      check: {
        id: "config",
        status: "fail",
        message: "no vite.config file in this folder",
        fix: "Create vite.config.ts with the dusk() plugin from @shadow-js/dusk/vite.",
      },
      adapter: adapterSkipped,
      srcDir: fallback,
    };
  }
  try {
    const vite = await import("vite");
    const config = await vite.resolveConfig({ root, logLevel: "silent" }, "build", "production");
    const api = duskApiOf(config.plugins);
    if (api === undefined) {
      return {
        check: {
          id: "config",
          status: "fail",
          message: `${file} loads but has no dusk() plugin`,
          fix: "Add dusk() from @shadow-js/dusk/vite to the plugins of the config.",
        },
        adapter: adapterSkipped,
        srcDir: fallback,
      };
    }
    const adapter: DoctorCheck =
      api.adapterName === undefined
        ? {
            id: "adapter",
            status: "warn",
            message: "dusk() has no adapter: the build makes bundles but no deployable output",
            fix: "Pass an adapter, for example dusk({ adapter: node() }) from @shadow-js/dusk/node.",
          }
        : { id: "adapter", status: "ok", message: `adapter ${api.adapterName}` };
    return {
      check: { id: "config", status: "ok", message: `${file} loads` },
      adapter,
      srcDir: api.layout?.srcDir ?? fallback,
    };
  } catch (error) {
    return {
      check: {
        id: "config",
        status: "fail",
        message: `${file} does not load: ${firstLine(error)}`,
        fix: `Run the config on its own (node ${file}) and fix the first error; check that every package it imports is installed.`,
      },
      adapter: adapterSkipped,
      srcDir: fallback,
    };
  }
}

function checkRoutes(srcDir: string): DoctorCheck {
  const dir = join(srcDir, "routes");
  const present = existsSync(dir) && statSync(dir).isDirectory();
  return present
    ? { id: "routes", status: "ok", message: `${dir} exists` }
    : {
        id: "routes",
        status: "fail",
        message: `no routes folder at ${dir}`,
        fix: "Create src/routes with at least src/routes/index.tsx.",
      };
}

/** The variable names in an env file; values are never read into the result. */
function namesInEnvFile(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

function checkEnv(root: string): DoctorCheck {
  const offenders = new Set<string>();
  let files = 0;
  for (const entry of readdirSync(root)) {
    if (!/^\.env(\..+)?$/.test(entry) || /\.(example|sample|template)$/.test(entry)) continue;
    files += 1;
    for (const name of namesInEnvFile(readFileSync(join(root, entry), "utf8"))) {
      const upper = name.toUpperCase();
      const isPublic = PUBLIC_PREFIXES.some((prefix) => upper.startsWith(prefix));
      if (isPublic && SECRET_WORDS.some((word) => upper.includes(word))) offenders.add(name);
    }
  }
  if (offenders.size > 0) {
    const list = [...offenders].sort().join(", ");
    return {
      id: "env",
      status: "fail",
      message: `public variables that look like secrets: ${list}`,
      fix: "Variables with a public prefix are sent to every browser. Rename a secret without the prefix and read it on the server only.",
    };
  }
  return {
    id: "env",
    status: "ok",
    message:
      files === 0 ? "no env files" : `${files} env file(s), no public variable looks like a secret`,
  };
}

function checkLockfile(root: string): DoctorCheck {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const found = LOCKFILES.find((name) => existsSync(join(dir, name)));
    if (found !== undefined) return { id: "lockfile", status: "ok", message: found };
    if (dirname(dir) === dir) break;
  }
  return {
    id: "lockfile",
    status: "warn",
    message: "no lockfile found",
    fix: "Commit the lockfile of your package manager so installs are repeatable.",
  };
}

function versionOf(packageDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function checkDuplicates(root: string): DoctorCheck {
  const modules = join(root, "node_modules");
  const seen = new Map<string, Set<string>>();
  let scanned = 0;
  const record = (scopeDir: string): void => {
    if (!existsSync(scopeDir)) return;
    for (const name of readdirSync(scopeDir)) {
      const version = versionOf(join(scopeDir, name));
      if (version === undefined) continue;
      const key = `@shadow-js/${name}`;
      const set = seen.get(key) ?? new Set<string>();
      set.add(version);
      seen.set(key, set);
    }
  };
  record(join(modules, "@shadow-js"));
  if (existsSync(modules)) {
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith(".") || scanned > NESTED_SCAN_LIMIT) continue;
      scanned += 1;
      const scoped = entry.startsWith("@") ? readdirSafe(join(modules, entry)) : [];
      const packages = entry.startsWith("@") ? scoped.map((name) => join(entry, name)) : [entry];
      for (const relative of packages) {
        scanned += 1;
        record(join(modules, relative, "node_modules", "@shadow-js"));
      }
    }
  }
  const duplicated = [...seen].filter(([, versions]) => versions.size > 1);
  if (duplicated.length === 0) {
    return { id: "duplicates", status: "ok", message: "one version of each @shadow-js package" };
  }
  const list = duplicated
    .map(([name, versions]) => `${name} (${[...versions].sort().join(", ")})`)
    .join(", ");
  return {
    id: "duplicates",
    status: "warn",
    message: `more than one version installed: ${list}`,
    fix: "Make every @shadow-js package use one version (they release together), then reinstall; two copies of core break reactivity.",
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Runs every check against a project folder.
 * @param root The project root.
 * @param nodeVersion The Node version to check (default: the running one).
 * @returns The report.
 * @since 1.0.0
 */
export async function diagnose(
  root: string,
  nodeVersion: string = process.versions.node,
): Promise<DoctorReport> {
  const config = await checkConfig(root);
  const checks: DoctorCheck[] = [
    checkNodeVersion(nodeVersion),
    config.check,
    checkRoutes(config.srcDir),
    checkEnv(root),
    config.adapter,
    checkLockfile(root),
    checkDuplicates(root),
  ];
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

function reportLines(report: DoctorReport, term: Terminal): string[] {
  const glyphs = glyphsOf(term);
  const tones = { ok: "green", warn: "yellow", fail: "red" } as const;
  const marks = { ok: glyphs.ok, warn: glyphs.warn, fail: glyphs.fail } as const;
  const lines = [headerLine(term, `${duskVersion()} (doctor)`), ""];
  for (const check of report.checks) {
    lines.push(
      `${paint(term, tones[check.status], marks[check.status])} ${check.id.padEnd(11)}${check.message}`,
    );
    if (check.fix !== undefined) lines.push(`    ${paint(term, "dim", check.fix)}`);
  }
  const failed = report.checks.filter((check) => check.status === "fail").length;
  const warned = report.checks.filter((check) => check.status === "warn").length;
  lines.push(
    "",
    failed > 0
      ? `${paint(term, "red", glyphs.fail)} ${failed} failed, ${warned} warning(s)`
      : `${paint(term, "green", glyphs.ok)} no failures, ${warned} warning(s)`,
  );
  return lines;
}

/**
 * The JSON document of a report: the checks in `data`, the `warn` checks as warnings (the code is
 * `DUSK_DOCTOR_` and the check's id in capitals), and the error `DUSK_DOCTOR_FAILED` when a check failed.
 * @param report The report.
 * @returns The document; `ok` is the report's.
 * @since 1.0.0
 */
export function doctorDocument(report: DoctorReport): JsonDocument<object> {
  const data = { checks: report.checks };
  const warnings: JsonWarning[] = report.checks
    .filter((check) => check.status === "warn")
    .map((check) => ({ code: `DUSK_DOCTOR_${check.id.toUpperCase()}`, message: check.message }));
  if (report.ok) return jsonSuccess("dusk doctor", data, warnings);
  const failed = report.checks.filter((check) => check.status === "fail");
  return jsonFailure(
    "dusk doctor",
    {
      code: "DUSK_DOCTOR_FAILED",
      message: `${failed.length} check(s) failed: ${failed.map((check) => check.id).join(", ")}`,
    },
    { data, warnings },
  );
}

/**
 * Runs `dusk doctor` in the working folder and prints the report.
 * @param flags The parsed flags (`--json`).
 * @returns 0 when no check failed, 1 otherwise.
 * @since 1.0.0
 */
export async function runDoctor(flags: { readonly json: boolean }): Promise<number> {
  const report = await diagnose(process.cwd());
  if (flags.json) writeJson(doctorDocument(report));
  else for (const line of reportLines(report, currentTerminal())) out(line);
  return report.ok ? 0 : 1;
}
