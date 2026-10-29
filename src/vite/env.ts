import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  type AstNode,
  codeFrame,
  isNode,
  lineColumn,
  parseModule,
  walkTree,
} from "@shadow-js/router/vite";

/**
 * Environment variables in client code. The browser gets a variable when its name has a public prefix (`DUSK_PUBLIC_`
 * by default, plus the prefixes of `env.public` and Vite's `envPrefix`) or when it is declared in a `.env.public` file.
 * Reading any other name through `import.meta.env` or `process.env` is a mistake that would silently give `undefined` in
 * production, so the build rejects it. The reads that are checked: `X.NAME`, `X["NAME"]`, a destructuring of `X`, and a
 * read through a variable that holds `X` (an alias). A key that is not a literal cannot be checked, so it fails too.
 */

/**
 * Prefix of the variables the browser may read.
 *
 * @example
 * import { PUBLIC_ENV_PREFIX } from "@shadow-js/dusk/vite";
 * PUBLIC_ENV_PREFIX; // "DUSK_PUBLIC_"
 * @since 1.0.0
 */
export const PUBLIC_ENV_PREFIX = "DUSK_PUBLIC_";

const BUILT_IN = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);
/** `process.env.NODE_ENV` is defined for the browser by the bundler (libraries read it); it is not a secret. */
const PROCESS_BUILT_IN = new Set(["NODE_ENV"]);

/** An unexpected read of `import.meta.env` or `process.env` in client code. @since 1.0.0 */
export interface EnvViolation {
  /** The variable's name; empty when the key is not a string literal (`dynamic`). */
  readonly name: string;
  /** How the code reads it, for the message: `import.meta.env.NAME`, `process.env["NAME"]`, `import.meta.env[key]`. */
  readonly expression: string;
  /** True when the key is computed at run time, so the build cannot tell which variable it reads. */
  readonly dynamic: boolean;
  readonly line: number;
  readonly column: number;
  readonly frame: string;
}

/**
 * Prefixes the user configured, validated: a prefix that is empty or very short would expose
 * almost every variable.
 *
 * @param configured The value of Vite's `envPrefix`, if any.
 * @returns The prefixes to use, `DUSK_PUBLIC_` first.
 * @throws TypeError for an empty prefix, `*`, or one shorter than three characters.
 * @since 1.0.0
 * @example publicPrefixes("APP_"); // ["DUSK_PUBLIC_", "APP_"]
 */
export function publicPrefixes(configured: string | readonly string[] | undefined): string[] {
  const list =
    configured === undefined ? [] : typeof configured === "string" ? [configured] : [...configured];
  for (const prefix of list) {
    if (prefix === "*" || prefix.length < 3) {
      throw new TypeError(
        `[ENV_PREFIX_UNSAFE] envPrefix "${prefix}" would expose server variables to the browser; use a prefix of at least three characters such as "${PUBLIC_ENV_PREFIX}"`,
      );
    }
  }
  return [...new Set([PUBLIC_ENV_PREFIX, ...list])];
}

/** True for a name the browser may read: it has a public prefix, or it is declared in a `.env.public` file. */
function isPublicName(
  name: string,
  prefixes: readonly string[],
  declared: readonly string[],
): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix)) || declared.includes(name);
}

/**
 * Finds `import.meta.env.NAME` reads of names the browser does not get.
 *
 * @param code Module text (TypeScript and JSX allowed).
 * @param file File name, for the language.
 * @param prefixes Allowed prefixes, from {@link publicPrefixes}.
 * @param declared Names declared in `.env.public`, which the browser gets whatever their prefix.
 * @returns One entry per forbidden read, in source order.
 * @example
 * findForbiddenEnvReads("export const k = import.meta.env.API_KEY;", "a.ts", ["DUSK_PUBLIC_"]);
 * @since 1.0.0
 */
export function findForbiddenEnvReads(
  code: string,
  file: string,
  prefixes: readonly string[],
  declared: readonly string[] = [],
): EnvViolation[] {
  if (!code.includes("import.meta.env") && !code.includes("process.env")) return [];
  const parsed = parseModule(code, file);
  const aliases = envAliases(parsed.program);
  const found: EnvViolation[] = [];
  const report = (node: AstNode, root: EnvRoot, key: EnvKey): void => {
    if (key.dynamic) {
      const text = key.node === undefined ? "" : code.slice(key.node.start, key.node.end);
      const { line, column } = lineColumn(code, node.start);
      found.push({
        name: "",
        expression: `${root}[${text}]`,
        dynamic: true,
        line,
        column,
        frame: codeFrame(code, node.start),
      });
      return;
    }
    if (ALLOWED[root].has(key.name) || isPublicName(key.name, prefixes, declared)) return;
    const { line, column } = lineColumn(code, node.start);
    found.push({
      name: key.name,
      expression: `${root}.${key.name}`,
      dynamic: false,
      line,
      column,
      frame: codeFrame(code, node.start),
    });
  };
  walkTree(parsed.program, (node) => {
    if (node.type === "MemberExpression") {
      const root = envRootOf(node["object"], aliases);
      if (root !== undefined)
        report(node, root, keyOf(node["property"], node["computed"] === true));
      return undefined;
    }
    if (node.type === "VariableDeclarator") {
      const root = envRootOf(node["init"], aliases);
      if (root !== undefined) reportPattern(node["id"], root, report);
      return undefined;
    }
    if (node.type === "AssignmentExpression" && node["operator"] === "=") {
      const root = envRootOf(node["right"], aliases);
      if (root !== undefined) reportPattern(node["left"], root, report);
    }
    return undefined;
  });
  return found;
}

/** Where an env object comes from: `import.meta.env` or `process.env`. */
type EnvRoot = "import.meta.env" | "process.env";

/** A key of an env read: a literal name, or the node of a key whose value is only known at run time. */
type EnvKey =
  | { readonly dynamic: false; readonly name: string }
  | { readonly dynamic: true; readonly node: AstNode | undefined };

/** The names each env object may be read with, beside the public ones. */
const ALLOWED: Record<EnvRoot, ReadonlySet<string>> = {
  "import.meta.env": BUILT_IN,
  "process.env": PROCESS_BUILT_IN,
};

/** Expression wrappers that do not change the value (TypeScript casts, optional chains, parentheses). */
const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

/** The expression under any wrappers. */
function unwrap(node: AstNode): AstNode {
  let current = node;
  for (;;) {
    const inner = current["expression"];
    if (!WRAPPERS.has(current.type) || !isNode(inner)) return current;
    current = inner;
  }
}

/**
 * The env object an expression denotes: `import.meta.env`, `process.env`, or a variable that holds one of them (found by
 * {@link envAliases}). Anything else is not an env object.
 */
function envRootOf(value: unknown, aliases: ReadonlyMap<string, EnvRoot>): EnvRoot | undefined {
  if (!isNode(value)) return undefined;
  const node = unwrap(value);
  if (node.type === "Identifier") {
    return typeof node["name"] === "string" ? aliases.get(node["name"]) : undefined;
  }
  if (node.type !== "MemberExpression" || node["computed"] === true) return undefined;
  const object = node["object"];
  const property = node["property"];
  if (!isNode(object) || !isNode(property) || property.type !== "Identifier") return undefined;
  if (property["name"] !== "env") return undefined;
  if (object.type === "MetaProperty") return "import.meta.env";
  if (object.type === "Identifier" && object["name"] === "process") return "process.env";
  return undefined;
}

/**
 * The variables that hold an env object: `const e = import.meta.env`, `let e; e = process.env`, and a variable assigned
 * from one of those (a chain). Names only, with no scope: a name that holds an env object anywhere is treated as one
 * everywhere in the module, which can only add a check, never remove one.
 */
function envAliases(program: AstNode): Map<string, EnvRoot> {
  const aliases = new Map<string, EnvRoot>();
  let changed = true;
  while (changed) {
    changed = false;
    walkTree(program, (node) => {
      let target: unknown;
      let value: unknown;
      if (node.type === "VariableDeclarator") {
        target = node["id"];
        value = node["init"];
      } else if (node.type === "AssignmentExpression" && node["operator"] === "=") {
        target = node["left"];
        value = node["right"];
      } else {
        return undefined;
      }
      if (!isNode(target) || target.type !== "Identifier" || typeof target["name"] !== "string") {
        return undefined;
      }
      const root = envRootOf(value, aliases);
      if (root !== undefined && aliases.get(target["name"]) !== root) {
        aliases.set(target["name"], root);
        changed = true;
      }
      return undefined;
    });
  }
  return aliases;
}

/**
 * The key of a member read (`X.NAME`, `X["NAME"]`, `X[`NAME`]`), or of a destructured property. A key that is not a
 * literal is `dynamic`, and its node is kept so the message can quote its source text.
 */
function keyOf(key: unknown, computed: boolean): EnvKey {
  if (!isNode(key)) return { dynamic: true, node: undefined };
  if (key.type === "Identifier" && !computed && typeof key["name"] === "string") {
    return { dynamic: false, name: key["name"] };
  }
  if (key.type === "Literal" && typeof key["value"] === "string") {
    return { dynamic: false, name: key["value"] };
  }
  if (
    key.type === "TemplateLiteral" &&
    Array.isArray(key["expressions"]) &&
    key["expressions"].length === 0
  ) {
    const quasi = Array.isArray(key["quasis"]) ? key["quasis"][0] : undefined;
    const cooked = isNode(quasi) ? quasi["value"] : undefined;
    const text =
      typeof cooked === "object" && cooked !== null ? Reflect.get(cooked, "cooked") : undefined;
    if (typeof text === "string") return { dynamic: false, name: text };
  }
  return { dynamic: true, node: key };
}

/** Reports each key a destructuring pattern reads from an env object; a rest element reads no single name. */
function reportPattern(
  pattern: unknown,
  root: EnvRoot,
  report: (node: AstNode, root: EnvRoot, key: EnvKey) => void,
): void {
  if (!isNode(pattern) || pattern.type !== "ObjectPattern") return;
  const properties = pattern["properties"];
  if (!Array.isArray(properties)) return;
  for (const property of properties) {
    if (!isNode(property) || property.type !== "Property") continue;
    report(property, root, keyOf(property["key"], property["computed"] === true));
  }
}

/**
 * The env files of one mode, read for the build and for server code. See {@link readEnvFiles}.
 * @since 1.0.0
 */
export interface EnvFiles {
  /** The value of every name, from the files alone (the real environment is added by {@link resolvedValues}). */
  readonly values: Readonly<Record<string, string>>;
  /** For each name, the file that holds the value that wins. */
  readonly sources: Readonly<Record<string, string>>;
  /** For each name, every file that declares it, in precedence order (lowest first). */
  readonly declaredIn: Readonly<Record<string, readonly string[]>>;
  /** The names declared in a public file (`.env.public`, `.env.[mode].public`, `.env.public.local`), sorted. */
  readonly publicNames: readonly string[];
  /** The names declared only in server files (`.env`, `.env.[mode]`, `.env.local`, `.env.[mode].local`), sorted. */
  readonly serverNames: readonly string[];
}

/** One env file of the precedence list. */
interface EnvLayer {
  readonly file: string;
  /** True for the public files: every name they declare is public. */
  readonly isPublic: boolean;
}

/**
 * The env files of a mode, lowest precedence first. The order (later wins): `.env.public`, `.env.[mode].public`,
 * `.env`, `.env.[mode]`, `.env.local`, `.env.[mode].local`, `.env.public.local`. Then the real environment wins over all of
 * them (see {@link resolvedValues}). Note: this is not Vite's own order, which puts `.env.local` below `.env.[mode]`.
 */
function layersOf(mode: string): readonly EnvLayer[] {
  return [
    { file: ".env.public", isPublic: true },
    { file: `.env.${mode}.public`, isPublic: true },
    { file: ".env", isPublic: false },
    { file: `.env.${mode}`, isPublic: false },
    // Next.js skips `.env.local` in mode `test`, so a developer's local overrides never change a test run.
    ...(mode === "test" ? [] : [{ file: ".env.local", isPublic: false }]),
    { file: `.env.${mode}.local`, isPublic: false },
    { file: ".env.public.local", isPublic: true },
  ];
}

/** `${NAME}` references in a value, resolved against the variables read so far (then the real environment). */
function expandReferences(value: string, known: Readonly<Record<string, string>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    return known[name] ?? process.env[name] ?? "";
  });
}

/**
 * Reads the env files of a mode from a folder. Every key of every file is read; the files are layered in the order of
 * `layersOf`, later files winning, and `${NAME}` references are expanded. A name declared in a public file is public; a
 * name declared only in the other files is a server variable.
 *
 * @param mode Vite's mode (`development`, `production`, or a custom one).
 * @param envDir The folder of the env files; a missing file is skipped.
 * @returns The layered values with their sources and the public and server names.
 * @since 1.0.0
 * @example readEnvFiles("development", "/app").publicNames; // ["SITE_URL"]
 */
export function readEnvFiles(mode: string, envDir: string): EnvFiles {
  // No prototype: a variable may be named `constructor` or `toString`, and a lookup must not find Object's member.
  const values: Record<string, string> = Object.create(null);
  const sources: Record<string, string> = Object.create(null);
  const declaredIn: Record<string, string[]> = Object.create(null);
  const publicNames = new Set<string>();
  const serverNames = new Set<string>();
  for (const layer of layersOf(mode)) {
    const path = join(envDir, layer.file);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const parsed = parseEnv(readFileSync(path, "utf8"));
    for (const name of Object.keys(parsed)) {
      const raw = parsed[name] ?? "";
      values[name] = expandReferences(raw, values);
      sources[name] = layer.file;
      const list = declaredIn[name] ?? [];
      list.push(layer.file);
      declaredIn[name] = list;
      (layer.isPublic ? publicNames : serverNames).add(name);
    }
  }
  return {
    values,
    sources,
    declaredIn,
    publicNames: [...publicNames].sort(),
    serverNames: [...serverNames].filter((name) => !publicNames.has(name)).sort(),
  };
}

/**
 * Refuses a name that is declared in a public file and also in a server file: its value would be public or not depending
 * on which file wins, so the build fails instead. A prefixed name is public whatever file declares it, so it never
 * conflicts.
 *
 * @param files The env files, from {@link readEnvFiles}.
 * @param prefixes The public prefixes.
 * @throws TypeError `[ENV_PUBLIC_CONFLICT]` naming the variable and its files, never a value.
 * @example
 * checkEnvFiles(readEnvFiles("development", "/app"), ["DUSK_PUBLIC_"]); // throws when a name is in .env.public and in .env
 * @since 1.0.0
 */
export function checkEnvFiles(files: EnvFiles, prefixes: readonly string[]): void {
  const conflicts = files.publicNames.filter(
    (name) =>
      !prefixes.some((prefix) => name.startsWith(prefix)) &&
      (files.declaredIn[name] ?? []).some((file) => !isPublicFile(file)),
  );
  if (conflicts.length === 0) return;
  const described = conflicts.map(
    (name) => `${name} (${(files.declaredIn[name] ?? []).join(", ")})`,
  );
  throw new TypeError(
    `[ENV_PUBLIC_CONFLICT] ${described.join("; ")}: a name declared in a public file (.env.public) and in a server file has an ambiguous visibility. Keep it in one file, or give the server value a different name.`,
  );
}

/** True for the file names of the public files. */
function isPublicFile(file: string): boolean {
  return file === ".env.public" || file === ".env.public.local" || file.endsWith(".public");
}

/**
 * The variables the build and the server see: the env files, overridden by the real environment. The real environment
 * always wins, as it does on a platform.
 *
 * @param files The env files, from {@link readEnvFiles}.
 * @param env The real environment. Default `process.env`.
 * @returns Every name with its value; `undefined` for a variable the environment sets to nothing.
 * @example
 * resolvedValues(readEnvFiles("development", "/app"), { PORT: "4000" }).PORT; // "4000", even when .env sets PORT
 * @since 1.0.0
 */
export function resolvedValues(
  files: EnvFiles,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...files.values };
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The names a browser may read among the given names: the prefixed ones and the ones declared in `.env.public`, sorted.
 *
 * @param names Every name of the build.
 * @param declared Names declared in `.env.public`.
 * @param prefixes The public prefixes.
 * @returns The public names, sorted and without duplicates.
 * @example
 * publicEnvNames(["SECRET", "SITE_URL", "DUSK_PUBLIC_KEY"], ["SITE_URL"], ["DUSK_PUBLIC_"]); // ["DUSK_PUBLIC_KEY", "SITE_URL"]
 * @since 1.0.0
 */
export function publicEnvNames(
  names: readonly string[],
  declared: readonly string[],
  prefixes: readonly string[],
): string[] {
  return [...new Set(names.filter((name) => isPublicName(name, prefixes, declared)))].sort();
}

/**
 * Reads the env files of a mode for server code: `.env.public`, `.env`, `.env.local` and their mode variants, layered as
 * described in {@link readEnvFiles}. Every key is returned, not only the public ones; the result is for `process.env` and
 * never reaches a client bundle on its own (the browser gets only the public names, and reading another one is the
 * `ENV_NOT_PUBLIC` build error).
 *
 * @param mode Vite's mode (`development`, `production`, or a custom one).
 * @param envDir The folder of the env files.
 * @returns The variables of the files. The real environment is not included.
 * @since 1.0.0
 * @example
 * loadServerEnv("development", "/app"); // { DATABASE_URL: "postgres://localhost/dev", ... }
 */
export function loadServerEnv(mode: string, envDir: string): Record<string, string> {
  return { ...readEnvFiles(mode, envDir).values };
}

/**
 * The names of the env files that exist for a mode, in the order they are read (the later ones win). The dev server and
 * the start command print them, so the output says which files the variables came from.
 *
 * @param mode The mode: `development`, `production`, `test` ...
 * @param envDir The folder of the env files.
 * @returns File names such as `.env.local`, without the folder.
 * @since 1.0.0
 * @example loadedEnvFiles("development", "/app"); // [".env", ".env.local"] when those two exist
 */
export function loadedEnvFiles(mode: string, envDir: string): string[] {
  return layersOf(mode)
    .map((layer) => layer.file)
    .filter((file) => {
      const path = join(envDir, file);
      return existsSync(path) && statSync(path).isFile();
    });
}

/**
 * Puts variables from the env files into `process.env`, for server code that reads
 * `process.env.NAME` (the same way production does, where the platform sets them). A variable that
 * is already set is left alone, so a value given on the command line or by the platform wins over
 * a file; `NODE_ENV` is never taken from a file.
 *
 * @param values The variables, from {@link loadServerEnv}.
 * @param target The environment to fill. Default `process.env`.
 * @returns The names that were set, sorted.
 * @since 1.0.0
 * @example
 * applyServerEnv(loadServerEnv("development", root)); // ["DATABASE_URL"]
 */
export function applyServerEnv(
  values: Readonly<Record<string, string>>,
  target: Record<string, string | undefined> = process.env,
): string[] {
  const applied: string[] = [];
  const written = writtenBy(target);
  for (const [name, value] of Object.entries(values)) {
    if (KEPT_BY_VITE.has(name) || target[name] !== undefined) continue;
    target[name] = value;
    written.set(name, value);
    applied.push(name);
  }
  return applied.sort();
}

/**
 * The variables {@link applyServerEnv} wrote, per target. The record is kept on the global registry under a
 * `Symbol.for` key, not in this module: a `vite.config.ts` that imports Dusk relatively is bundled again on every
 * restart, so a second copy of this module must be able to take back what the first one wrote.
 */
const WRITTEN = Symbol.for("@shadow-js/dusk/env-written");

function writtenBy(target: object): Map<string, string> {
  const host = globalThis as unknown as { [WRITTEN]?: WeakMap<object, Map<string, string>> };
  let records = host[WRITTEN];
  if (records === undefined) {
    records = new WeakMap<object, Map<string, string>>();
    host[WRITTEN] = records;
  }
  let record = records.get(target);
  if (record === undefined) {
    record = new Map<string, string>();
    records.set(target, record);
  }
  return record;
}

/**
 * Takes back the variables {@link applyServerEnv} wrote into `target`. Only a variable that still holds the value dusk
 * wrote is removed: a value the real environment or the code set since is kept. The dev server calls it when it resolves
 * the configuration, so a restart reads the env files again and no value from the previous start outlives its file
 * (Vite's own `loadEnv` reads `process.env` too).
 *
 * @param target The environment to clean. Default `process.env`.
 * @returns The names that were removed, sorted.
 * @since 1.0.0
 * @example
 * releaseServerEnv(); // ["NEXT_PUBLIC_SITE_NAME"] after a `.env` change and a restart
 */
export function releaseServerEnv(
  target: Record<string, string | undefined> = process.env,
): string[] {
  const written = writtenBy(target);
  const released: string[] = [];
  for (const [name, value] of written) {
    if (target[name] !== value) continue;
    delete target[name];
    released.push(name);
  }
  written.clear();
  return released.sort();
}

/** Variables the env files may not change: the mode is Vite's to set, not a file's. */
const KEPT_BY_VITE = new Set(["NODE_ENV"]);

/**
 * Words that make a name read like a credential. A public name that contains one gets a note from
 * {@link credentialNameWarnings} unless `env.public.allow` lists it; the build fails only on a secret-looking value.
 */
const CREDENTIAL_NAME = /SECRET|TOKEN|PASSWORD|PASS|KEY|DATABASE_URL|DSN|PRIVATE|CREDENTIAL/i;
/** Server-only variables that look like credentials or connection strings (for the bundle scan). */
const SERVER_SECRET_NAME = /SECRET|PASSWORD|PRIVATE|TOKEN|CREDENTIAL|KEY|DATABASE|DSN|COOKIE/i;
/** A shorter value is too common to find in a bundle by accident; it is not checked. */
const MIN_SECRET_LENGTH = 8;
/**
 * A server variable whose name does not look like a secret is checked too (a nondescript name can hold a credential), but
 * only for a value this long: `production`, a port or a region name never matches.
 */
const MIN_PLAIN_LENGTH = 16;
/**
 * Variables the machine or the CI provider sets (package metadata, repository and deployment facts). Their values are
 * public facts an app may print on purpose (its own name, repository or commit), so a name that does not look like a
 * secret and starts like this is not scanned. A name that looks like a secret (`GITHUB_TOKEN`) is always scanned.
 */
const AMBIENT_NAME =
  /^(?:npm_|NPM_|GITHUB_|GITLAB_|CI_|VERCEL_|NETLIFY|CF_PAGES|RUNNER_|XPC_|LC_|__)/;
/**
 * Vercel's copies of its system variables under the public prefix of each framework it supports (`NEXT_PUBLIC_VERCEL_URL`,
 * `VITE_VERCEL_ENV`, ...). The project setting "Automatically expose System Environment Variables" is on by default and writes
 * them into every build; they are public by contract, and Vite puts the `VITE_` copy into `import.meta.env`, so their values
 * appear in the browser output of every Dusk app built on Vercel. Treated like the ambient variables: not scanned unless the
 * name looks like a secret.
 */
const PLATFORM_PUBLIC_COPY =
  /^(?:NEXT_PUBLIC_|PUBLIC_|VITE_|REACT_APP_|GATSBY_|NUXT_PUBLIC_|VUE_APP_|EXPO_PUBLIC_|STORYBOOK_|PLASMO_PUBLIC_)VERCEL_/;

/**
 * The variables a browser may read: the public names, sorted.
 *
 * @example
 * publicEnvValues({ DUSK_PUBLIC_API: "a", SECRET: "b" }, ["DUSK_PUBLIC_"]); // { DUSK_PUBLIC_API: "a" }
 * @since 1.0.0
 */
export function publicEnvValues(
  values: Readonly<Record<string, string | undefined>>,
  prefixes: readonly string[],
  declared: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(values).sort()) {
    const value = values[name];
    if (value !== undefined && isPublicName(name, prefixes, declared)) out[name] = value;
  }
  return out;
}

/**
 * The `define` entries of the client bundle for `process.env`: each public variable as a literal
 * (`process.env.NAME`, so unused branches are removed), and the whole `process.env` as an object of
 * the public variables only. A secret never appears: only public names are defined.
 *
 * @param values The variables (from the env files and the environment).
 * @param prefixes The public prefixes (see `publicPrefixes`).
 * @param declared Names declared in `.env.public`.
 * @returns Vite `define` entries, keys and JSON values.
 * @since 1.0.0
 * @example clientProcessEnvDefines({ NEXT_PUBLIC_URL: "https://x" }, ["NEXT_PUBLIC_"]);
 */
export function clientProcessEnvDefines(
  values: Readonly<Record<string, string | undefined>>,
  prefixes: readonly string[],
  declared: readonly string[] = [],
): Record<string, string> {
  const pub = publicEnvValues(values, prefixes, declared);
  return {
    "process.env": JSON.stringify(pub),
    ...clientPublicEnvDefines(values, prefixes, declared),
  };
}

/**
 * The client defines of the public variables by name: `process.env.NAME` in the client code becomes the value (the
 * same literal in every chunk). Vite replaces a bare `process.env` with an empty object in the browser, so without these
 * a read of a public name is `undefined` in any chunk that loads before, or without, a runtime shim. They carry public
 * names only, so no secret reaches the browser, and they need no global `process`. Always on, with or without
 * `processEnv` (which adds the whole object).
 *
 * @param values The variables (from the env files and the environment).
 * @param prefixes The public prefixes (see `publicPrefixes`).
 * @param declared Names declared in `.env.public`.
 * @returns Vite `define` entries keyed `process.env.NAME`.
 * @since 1.0.0
 * @example clientPublicEnvDefines({ NEXT_PUBLIC_URL: "https://x", SECRET: "s" }, ["NEXT_PUBLIC_"]);
 */
export function clientPublicEnvDefines(
  values: Readonly<Record<string, string | undefined>>,
  prefixes: readonly string[],
  declared: readonly string[] = [],
): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [name, value] of Object.entries(publicEnvValues(values, prefixes, declared))) {
    defines[`process.env.${name}`] = JSON.stringify(value);
  }
  return defines;
}

/**
 * The client defines of the public variables for `import.meta.env`: `import.meta.env.NAME` becomes the value, whatever file
 * declared it. Vite reads its own `import.meta.env` from the files of its own order; these defines make the public values
 * the ones of {@link resolvedValues}, so `import.meta.env`, `process.env` and the whole-object read agree.
 *
 * @param values The variables (from the env files and the environment).
 * @param prefixes The public prefixes.
 * @param declared Names declared in `.env.public`.
 * @returns Vite `define` entries keyed `import.meta.env.NAME`.
 * @example
 * clientImportMetaEnvDefines({ DUSK_PUBLIC_URL: "https://x", SECRET: "s" }, ["DUSK_PUBLIC_"]);
 * // { "import.meta.env.DUSK_PUBLIC_URL": "\"https://x\"" }
 * @since 1.0.0
 */
export function clientImportMetaEnvDefines(
  values: Readonly<Record<string, string | undefined>>,
  prefixes: readonly string[],
  declared: readonly string[] = [],
): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [name, value] of Object.entries(publicEnvValues(values, prefixes, declared))) {
    defines[`import.meta.env.${name}`] = JSON.stringify(value);
  }
  return defines;
}

/**
 * Public names that read like credentials (see `CREDENTIAL_NAME`). The build refuses them unless they are allowed (see
 * {@link credentialNameWarnings}); this function only lists them.
 *
 * @param names The variable names.
 * @param prefixes The public prefixes.
 * @param declared Names declared in `.env.public`.
 * @returns The credential-named public names, sorted.
 * @example
 * secretLikePublicNames(["DUSK_PUBLIC_API_KEY", "DUSK_PUBLIC_NAME"], ["DUSK_PUBLIC_"]); // ["DUSK_PUBLIC_API_KEY"]
 * @since 1.0.0
 */
export function secretLikePublicNames(
  names: readonly string[],
  prefixes: readonly string[],
  declared: readonly string[] = [],
): string[] {
  return names
    .filter((name) => isPublicName(name, prefixes, declared) && CREDENTIAL_NAME.test(name))
    .sort();
}

/**
 * Notes for a public name that reads like a credential (`SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `KEY`, `DATABASE_URL`,
 * `DSN`, `PRIVATE`, `CREDENTIAL`) and is not in `env.public.allow`. A name alone never fails the build: publishable
 * keys (a Clerk publishable key, for one) legitimately contain `KEY`. Only a secret-looking value fails the build, which
 * is checked separately (`[ENV_PUBLIC_VALUE]`). The note names the variable, never a value.
 *
 * @param publicNames The public names of the build (prefixed or declared in `.env.public`).
 * @param allow The names of `env.public.allow`: public on purpose, so no note.
 * @returns One warning line per variable, sorted; empty when there is nothing to say.
 * @since 1.0.0
 * @example credentialNameWarnings(["DUSK_PUBLIC_API_TOKEN"], []); // one warning line
 */
export function credentialNameWarnings(
  publicNames: readonly string[],
  allow: readonly string[],
): string[] {
  return publicNames
    .filter((name) => CREDENTIAL_NAME.test(name) && !allow.includes(name))
    .sort()
    .map(
      (name) =>
        `[ENV_PUBLIC_NAME] ${name} has a credential-like name, so it is public by its prefix. If it holds a secret, the build fails on its value (ENV_PUBLIC_VALUE). If it is public on purpose, list ${name} in env.public.allow to silence this note.`,
    );
}

/** The prefix of Next.js's public variables. */
const NEXT_PUBLIC_PREFIX = "NEXT_PUBLIC_";

/**
 * Notes about the Next.js public prefix (`NEXT_PUBLIC_`). Dusk does not read that prefix as public unless the app adds it
 * to `env.public.prefixes`, so such a variable stays on the server. When the app did add it, one note recommends the
 * Dusk prefix (`DUSK_PUBLIC_`). Nothing fails: the names are never an error. The notes name variables, never values.
 *
 * @param names Every name of the build (the env files and the environment).
 * @param prefixes The public prefixes (see `publicPrefixes`).
 * @returns The note lines, sorted; empty when nothing applies.
 * @since 1.0.0
 * @example nextPublicNotes(["NEXT_PUBLIC_SITE"], ["DUSK_PUBLIC_", "NEXT_PUBLIC_"]); // one recommendation line
 */
export function nextPublicNotes(names: readonly string[], prefixes: readonly string[]): string[] {
  if (!prefixes.includes(NEXT_PUBLIC_PREFIX)) return [];
  return names
    .filter((name) => name.startsWith(NEXT_PUBLIC_PREFIX))
    .sort()
    .map(
      (name) =>
        `[ENV_NEXT_PUBLIC] ${name} keeps the Next.js prefix because env.public.prefixes lists it. Dusk's own prefix is DUSK_PUBLIC_: rename it to DUSK_PUBLIC_${name.slice(NEXT_PUBLIC_PREFIX.length)} when you can.`,
    );
}

/**
 * The declaration file of the public names. `ImportMetaEnv` gets a readonly string for each public name (the build inlines
 * `import.meta.env`, so a write has no effect). `NodeJS.ProcessEnv` gets an optional, writable string instead: that is
 * Node's own type (`[key: string]: string | undefined`), so a test or a script may assign or `delete` a public name, as
 * the runtime allows. Names only; no value is written.
 *
 * @param names The public names.
 * @returns The source of the `.d.ts` file. Names that are not identifiers are skipped.
 * @since 1.0.0
 * @example publicEnvTypesSource(["SITE_URL"]); // ImportMetaEnv: readonly SITE_URL: string; ProcessEnv: SITE_URL?: string;
 */
export function publicEnvTypesSource(names: readonly string[]): string {
  const identifiers = [...new Set(names)]
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
  const importMetaFields = identifiers.map((name) => `readonly ${name}: string;`);
  const processEnvFields = identifiers.map((name) => `${name}?: string;`);
  return [
    "// Generated by @shadow-js/dusk from .env.public and the DUSK_PUBLIC_ variables. Names only, no values.",
    "// dusk dev and dusk build rewrite this file; do not edit it.",
    "export {};",
    "",
    "declare global {",
    "  interface ImportMetaEnv {",
    ...importMetaFields.map((field) => `    ${field}`),
    "  }",
    "  namespace NodeJS {",
    "    interface ProcessEnv {",
    ...processEnvFields.map((field) => `      ${field}`),
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** An http(s) URL with no credentials and no query: public by nature (a canonical link, an API origin). */
function isPlainUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const parsed = new URL(value);
  return (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === ""
  );
}

/**
 * The server variables whose value appears as a string literal in the text of a built client file. The build fails on a
 * hit, so a value cannot reach the browser through a define, an import or a file in `public/`.
 *
 * A variable whose name looks like a secret (`SECRET`, `TOKEN`, `KEY`, `DATABASE` ...) is checked from 8 characters. Any
 * other server variable is checked from 16 characters, unless its value is a plain URL (no credentials, no query), is
 * also the value of a public variable, or its name is one the machine or the CI provider sets (`npm_*`, `GITHUB_*` ...).
 * A literal is the value in double quotes, single quotes or backticks, in its JSON form, or as the escaped quotes inside a
 * source map.
 *
 * @param code The text of one client file.
 * @param values The variables (from the env files and the environment).
 * @param prefixes The public prefixes; a public variable is never a leak.
 * @param ignore Values that are public on purpose (the deployment id, which the client carries).
 * @param declared Names declared in `.env.public`; they are public too.
 * @returns The names whose value was found, sorted. Never the values.
 * @since 1.0.0
 * @example findSecretLeaks('const k = "sk_live_0123456789";', { STRIPE_SECRET_KEY: "sk_live_0123456789" }, ["DUSK_PUBLIC_"]);
 */
export function findSecretLeaks(
  code: string,
  values: Readonly<Record<string, string | undefined>>,
  prefixes: readonly string[],
  ignore: ReadonlySet<string> = new Set(),
  declared: readonly string[] = [],
): string[] {
  const leaks: string[] = [];
  const publicValues = new Set(Object.values(publicEnvValues(values, prefixes, declared)));
  for (const name of Object.keys(values).sort()) {
    if (isPublicName(name, prefixes, declared)) continue;
    const value = values[name];
    if (value === undefined || ignore.has(value)) continue;
    const secretLike = SERVER_SECRET_NAME.test(name);
    if (value.length < (secretLike ? MIN_SECRET_LENGTH : MIN_PLAIN_LENGTH)) continue;
    if (
      !secretLike &&
      (AMBIENT_NAME.test(name) ||
        PLATFORM_PUBLIC_COPY.test(name) ||
        publicValues.has(value) ||
        isPlainUrl(value))
    ) {
      continue;
    }
    // A value is a leak when it is written as a string literal: how a constant is inlined. A bare substring
    // match would flag a common digit run in unrelated code.
    const literals = [
      `"${value}"`,
      `'${value}'`,
      `\`${value}\``,
      JSON.stringify(value),
      `\\"${value}\\"`,
    ];
    if (literals.some((literal) => code.includes(literal))) leaks.push(name);
  }
  return leaks;
}
