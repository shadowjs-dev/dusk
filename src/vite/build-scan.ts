import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { findSecretLeaks } from "./env";

/**
 * The audit of the build output. Everything under `dist/client` is public: the bundles, the prerendered pages, the files
 * copied from `public/` and, when the app asks for them, the source maps. This module looks in every text file of that
 * folder for two things and never repeats what it found:
 *
 * - the value of a server variable (see `findSecretLeaks`), and
 * - the shape of a common credential (an AWS key id, a Stripe or Clerk secret key, a GitHub, Slack or Google token, a
 *   webhook signing secret, a private key).
 *
 * Build time only (Node): nothing in the client or the server bundle imports it.
 */

/** A credential shape. `body` (capture group 1) is the part that must not be a placeholder. */
interface SecretPattern {
  /** The name shown in the build error. */
  readonly rule: string;
  readonly regex: RegExp;
}

/** `(?<![0-9A-Za-z])`: not in the middle of a longer base64 or hex run, where the same letters are chance. */
const EDGE = "(?<![0-9A-Za-z])";

/** The formats, in the order they are reported. Each regex has one capture group: the secret part. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { rule: "AWS access key id", regex: new RegExp(`${EDGE}AKIA([0-9A-Z]{16})(?![0-9A-Za-z])`, "g") },
  { rule: "Stripe or Clerk secret key", regex: /\b(?:sk|rk)_(?:live|test)_([0-9A-Za-z]{16,})/g },
  { rule: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_([0-9A-Za-z]{36})/g },
  { rule: "GitHub fine-grained token", regex: /\bgithub_pat_([0-9A-Za-z_]{22,})/g },
  { rule: "Slack token", regex: /\bxox[abprs]-([0-9A-Za-z-]{10,})/g },
  { rule: "Google API key", regex: new RegExp(`${EDGE}AIza([0-9A-Za-z_-]{35})`, "g") },
  { rule: "webhook signing secret", regex: /\bwhsec_([A-Za-z0-9+/=]{20,})/g },
  {
    // A library that parses PEM names the header too; a key is the header followed by its base64 body (written with real
    // or escaped line breaks inside a string).
    rule: "private key",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?:\\r|\\n|[\r\n \t])*([A-Za-z0-9+/]{40,})/g,
  },
];

/** An allowed value shorter than this is not removed from the output text before the shape scan. */
const MIN_ALLOWED_LENGTH = 8;

/** A body with fewer different characters than this is a placeholder (`xxxxxxxx`, `00000000`). */
const MIN_DISTINCT_CHARS = 4;

/** True for the sample values of vendor documentation and for filler such as `xxxxxxxx`. */
function isPlaceholder(body: string): boolean {
  return new Set(body).size < MIN_DISTINCT_CHARS || /example$/i.test(body);
}

/**
 * The credential formats found in a text. A placeholder (`sk_test_xxxxxxxx`, the `...EXAMPLE` keys of vendor docs), a
 * publishable key (`pk_`), a token that is too short and a PEM header with no key body after it are not credentials.
 *
 * @param text The text of one output file.
 * @returns The names of the rules that matched, once each, in a fixed order. Never the matched text.
 * @since 1.0.0
 * @example findSecretPatterns('key = "AKIAJ3KDLQ8W5ZXN7B2M"'); // ["AWS access key id"]
 */
export function findSecretPatterns(text: string): string[] {
  const found: string[] = [];
  for (const { rule, regex } of SECRET_PATTERNS) {
    for (const match of text.matchAll(regex)) {
      if (isPlaceholder(match[1] ?? "")) continue;
      found.push(rule);
      break;
    }
  }
  return found;
}

/**
 * Shapes a public value must not have beyond the credential formats: a password inside a URL and a JWT (a session or a
 * signed token). The capture group is the part that must not be a placeholder.
 */
const DUSK_PUBLIC_VALUE_RULES: readonly SecretPattern[] = [
  { rule: "credentials in a URL", regex: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s/@]+)@/gi },
  { rule: "JWT", regex: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g },
];

/**
 * The shapes found in a value that is public by its name (`.env.public`, a `DUSK_PUBLIC_` variable): every credential
 * format of {@link findSecretPatterns}, plus a password inside a URL and a JWT. Placeholders are not findings.
 *
 * @param value The value of one public variable. It is never echoed back by the build.
 * @returns The rule names that matched, in a fixed order. Never the matched text.
 * @since 1.0.0
 * @example publicValueFindings("sk_live_0123456789abcdefghij"); // ["Stripe or Clerk secret key"]
 */
export function publicValueFindings(value: string): string[] {
  const found = findSecretPatterns(value);
  for (const { rule, regex } of DUSK_PUBLIC_VALUE_RULES) {
    for (const match of value.matchAll(regex)) {
      if (isPlaceholder(match[1] ?? "")) continue;
      found.push(rule);
      break;
    }
  }
  return found;
}

/** What one file holds. @since 1.0.0 */
export interface OutputFinding {
  /** The file, relative to the scanned folder, with `/` separators. */
  readonly file: string;
  /** Server variables whose value is in the file. Names only. */
  readonly names: readonly string[];
  /** Credential rules that matched. Names only. */
  readonly rules: readonly string[];
}

/** What the scan knows about the build. @since 1.0.0 */
export interface SecretScanContext {
  /** The variables of the env files and the environment. */
  readonly values: Readonly<Record<string, string | undefined>>;
  /** The public prefixes; their variables are meant for the browser. */
  readonly prefixes: readonly string[];
  /** Names declared in `.env.public`: public by name, whatever their prefix. */
  readonly declared?: readonly string[];
  /**
   * Values of the names listed in `env.public.allow`: public on purpose, so a credential shape that is exactly one of
   * them is not a finding. Shorter values are ignored (a short value would blank out unrelated text).
   */
  readonly allowed?: ReadonlySet<string>;
  /** Values that are public on purpose (the deployment id, which the client carries). */
  readonly ignore?: ReadonlySet<string>;
}

/**
 * Looks for secrets in the text of one output file.
 *
 * @param text The text of the file.
 * @param file The name to report.
 * @param context The variables and prefixes of the build.
 * @returns The finding, or `undefined` when the file is clean.
 * @since 1.0.0
 * @example scanOutputText('"abc"', "a.js", { values: {}, prefixes: ["DUSK_PUBLIC_"] }); // undefined
 */
export function scanOutputText(
  text: string,
  file: string,
  context: SecretScanContext,
): OutputFinding | undefined {
  const names = findSecretLeaks(
    text,
    context.values,
    context.prefixes,
    context.ignore,
    context.declared ?? [],
  );
  let scanned = text;
  for (const value of context.allowed ?? []) {
    if (value.length >= MIN_ALLOWED_LENGTH) scanned = scanned.split(value).join("");
  }
  const rules = findSecretPatterns(scanned);
  return names.length === 0 && rules.length === 0 ? undefined : { file, names, rules };
}

/**
 * What the walk reads. A folder with more entries, or a text file larger than this, fails the scan (`[BUILD_SCAN_LIMIT]`):
 * a file the scan does not read is a file that may hold a secret, so the build stops rather than pass it.
 */
export interface ScanLimits {
  /** Entries (files and folders) looked at. Default 20000. */
  readonly maxFiles?: number;
  /** Largest file read, in bytes. Default 64 MiB. */
  readonly maxFileBytes?: number;
}

/** The result of {@link scanBuildOutput}. @since 1.0.0 */
export interface OutputScan {
  /** One entry per file that holds something, in path order. */
  readonly findings: readonly OutputFinding[];
  /** Text files that were read. */
  readonly scanned: number;
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** A NUL byte in the first bytes of a file means it is not text. */
const SNIFF_BYTES = 8192;
/** Formats that are never text; they are not read at all. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".m4a",
  ".webm",
  ".ogg",
  ".wav",
  ".mov",
  ".pdf",
  ".zip",
  ".gz",
  ".br",
  ".tgz",
  ".wasm",
]);

/**
 * Reads the text files below a folder and reports what they hold. Every file is read except the known binary formats and
 * any file with a NUL byte in its first bytes; symbolic links are not followed; the walk is iterative and bounded.
 *
 * @param dir The folder to scan (the client output).
 * @param context The variables and prefixes of the build.
 * @param limits Overrides for the bounds (tests).
 * @returns The files with findings and the number of text files read.
 * @throws Error `[BUILD_SCAN_LIMIT]` when the folder has more entries than `maxFiles`, or a text file is larger than
 *   `maxFileBytes`: the build stops rather than pass a file it did not read. The message names the file or the count,
 *   never a content.
 * @since 1.0.0
 * @example await scanBuildOutput("dist/client", { values: process.env, prefixes: ["DUSK_PUBLIC_"] });
 */
export async function scanBuildOutput(
  dir: string,
  context: SecretScanContext,
  limits: ScanLimits = {},
): Promise<OutputScan> {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const findings: OutputFinding[] = [];
  let scanned = 0;
  let seen = 0;
  const pending: Array<{ path: string; name: string }> = [{ path: dir, name: "" }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const entries = (await readdir(next.path, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      seen += 1;
      if (seen > maxFiles) {
        throw new Error(
          `${BUILD_SCAN_LIMIT} the client output holds more than ${maxFiles} entries, so the secret scan cannot read all of it and the build stops. Remove the files that do not belong in the output, or set build.secretScan to false in dusk.config.ts.`,
        );
      }
      const name = next.name === "" ? entry.name : `${next.name}/${entry.name}`;
      const path = join(next.path, entry.name);
      if (entry.isDirectory()) {
        pending.push({ path, name });
        continue;
      }
      if (!entry.isFile()) continue;
      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if ((await stat(path)).size > maxFileBytes) {
        throw new Error(
          `${BUILD_SCAN_LIMIT} ${name} in the client output is larger than ${maxFileBytes} bytes, so the secret scan cannot read it and the build stops. Move it out of the client output, or set build.secretScan to false in dusk.config.ts.`,
        );
      }
      const bytes = await readFile(path);
      if (bytes.subarray(0, SNIFF_BYTES).includes(0)) continue;
      scanned += 1;
      const finding = scanOutputText(bytes.toString("utf8"), name, context);
      if (finding !== undefined) findings.push(finding);
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { findings, scanned };
}

/** The code of a build that stops because the scan is over a bound. */
const BUILD_SCAN_LIMIT = "[BUILD_SCAN_LIMIT]";

/** How many files the error message names before it says "and N more". */
const MAX_FILES_IN_MESSAGE = 10;

/**
 * The build error for findings: one line per kind, naming the files, the variables and the rules, never a value.
 *
 * @param findings The files with findings (at least one).
 * @returns The message, with the codes `[ENV_SECRET_EXPOSED]` and `[BUILD_SECRET_PATTERN]`.
 * @since 1.0.0
 * @example secretScanMessage([{ file: "a.txt", names: [], rules: ["private key"] }]);
 */
export function secretScanMessage(findings: readonly OutputFinding[]): string {
  const lines: string[] = [];
  const envFiles = findings.filter((finding) => finding.names.length > 0);
  for (const finding of envFiles.slice(0, MAX_FILES_IN_MESSAGE)) {
    lines.push(
      `[ENV_SECRET_EXPOSED] ${finding.names.join(", ")} ${finding.names.length === 1 ? "is a server variable" : "are server variables"} whose value appears in the client file ${finding.file}. Read it only on the server; a browser variable needs a public prefix (env.public.prefixes).`,
    );
  }
  if (envFiles.length > MAX_FILES_IN_MESSAGE) {
    lines.push(`[ENV_SECRET_EXPOSED] and ${envFiles.length - MAX_FILES_IN_MESSAGE} more files.`);
  }
  const patternFiles = findings.filter((finding) => finding.rules.length > 0);
  for (const finding of patternFiles.slice(0, MAX_FILES_IN_MESSAGE)) {
    lines.push(
      `[BUILD_SECRET_PATTERN] ${finding.file} in the client output holds what looks like a credential (${finding.rules.join(", ")}). Everything in the client output is public: remove it from the source or from public/.`,
    );
  }
  if (patternFiles.length > MAX_FILES_IN_MESSAGE) {
    lines.push(
      `[BUILD_SECRET_PATTERN] and ${patternFiles.length - MAX_FILES_IN_MESSAGE} more files.`,
    );
  }
  lines.push(
    "If it is not a secret, set build.secretScan to false in dusk.config.ts; a secret in the browser output is then your responsibility.",
  );
  return lines.join("\n");
}
