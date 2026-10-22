import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Structural checks of the output each platform reads, written from the platforms' documented
 * formats. They report every problem they find (an empty list is a pass). They do not talk to the
 * platforms: what a platform accepts is verified by running what can be run (see the other tests).
 */

/** Every file below a folder, relative to it, with `/` separators. */
export function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(dir, path).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string, problems: string[]): Record<string, unknown> | undefined {
  if (!existsSync(file)) {
    problems.push(`${file}: missing`);
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObject(value)) {
      problems.push(`${file}: the top level must be an object`);
      return undefined;
    }
    return value;
  } catch (error) {
    problems.push(`${file}: not JSON (${(error as Error).message})`);
    return undefined;
  }
}

/**
 * Vercel Build Output API, version 3 (`.vercel/output`):
 * - `config.json`: `version` is 3; `routes` is an array; a route is `{ handle: "filesystem" }` or
 *   `{ src, dest?, status?, headers?, continue?, check? }` with `src` a string; a `dest` that names a
 *   function must match a `functions/<name>.func` folder; the filesystem handler comes before the
 *   catch-all route that sends requests to the function.
 * - `static/` holds the files served from the CDN.
 * - `functions/<name>.func/.vc-config.json`: `runtime` is `nodejs<major>.x` (with `handler` naming a
 *   file in the folder and `launcherType: "Nodejs"`) or `edge` (with `entrypoint` naming a file);
 *   optional `supportsResponseStreaming` is a boolean and `maxDuration` an integer from 1 to 900.
 * - a function folder that is JavaScript needs a `package.json` with `"type": "module"` when its
 *   entry is ESM.
 *
 * @param outputDir The `.vercel/output` folder.
 * @returns Every problem found; empty when the output matches.
 */
export function checkVercelOutput(outputDir: string): string[] {
  const problems: string[] = [];
  const config = readJson(join(outputDir, "config.json"), problems);
  if (config !== undefined) {
    if (config["version"] !== 3)
      problems.push(`config.json: version must be 3 (got ${String(config["version"])})`);
    const routes: unknown = config["routes"];
    if (!Array.isArray(routes)) {
      problems.push("config.json: routes must be an array");
    } else {
      const functions = new Set(
        readdirSync(join(outputDir, "functions"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.endsWith(".func"))
          .map((entry) => entry.name.slice(0, -".func".length)),
      );
      let sawFilesystem = false;
      let sawCatchAll = false;
      routes.forEach((route: unknown, index) => {
        if (!isObject(route)) {
          problems.push(`config.json: routes[${index}] must be an object`);
          return;
        }
        if (route["handle"] === "filesystem") {
          sawFilesystem = true;
          return;
        }
        if (typeof route["src"] !== "string") {
          problems.push(
            `config.json: routes[${index}] needs a string src (or handle: "filesystem")`,
          );
          return;
        }
        const dest = route["dest"];
        if (typeof dest === "string" && dest.startsWith("/")) {
          const name = dest.slice(1);
          if (!functions.has(name))
            problems.push(
              `config.json: routes[${index}] sends to ${dest}, which has no functions/${name}.func`,
            );
          // A conditional catch-all (a `missing` host condition: the foreign-Host route) may come before the filesystem:
          // that is the point of it. Only the unconditional catch-all is checked against the filesystem order.
          const conditional = route["has"] !== undefined || route["missing"] !== undefined;
          if (route["src"] === "/(.*)" || route["src"] === "^/(.*)$") {
            if (!conditional) {
              if (!sawFilesystem)
                problems.push(
                  "config.json: the function route comes before the filesystem handler",
                );
              sawCatchAll = true;
            }
          }
        }
      });
      if (!sawCatchAll)
        problems.push("config.json: no catch-all route sends requests to a function");
    }
  }
  if (!existsSync(join(outputDir, "static"))) problems.push("static/: missing");
  const funcs = existsSync(join(outputDir, "functions"))
    ? readdirSync(join(outputDir, "functions")).filter((name) => name.endsWith(".func"))
    : [];
  if (funcs.length === 0) problems.push("functions/: no .func folder");
  for (const name of funcs) {
    const folder = join(outputDir, "functions", name);
    const vc = readJson(join(folder, ".vc-config.json"), problems);
    if (vc === undefined) continue;
    const runtime = vc["runtime"];
    if (runtime === "edge") {
      const entry = vc["entrypoint"];
      if (typeof entry !== "string" || !existsSync(join(folder, entry)))
        problems.push(`${name}: edge entrypoint is missing`);
    } else if (typeof runtime === "string" && /^nodejs\d+\.x$/.test(runtime)) {
      const handler = vc["handler"];
      if (typeof handler !== "string" || !existsSync(join(folder, handler)))
        problems.push(`${name}: handler is missing`);
      if (vc["launcherType"] !== "Nodejs") problems.push(`${name}: launcherType must be "Nodejs"`);
    } else {
      problems.push(`${name}: runtime ${JSON.stringify(runtime)} is not nodejs<major>.x or edge`);
    }
    if (
      vc["supportsResponseStreaming"] !== undefined &&
      typeof vc["supportsResponseStreaming"] !== "boolean"
    ) {
      problems.push(`${name}: supportsResponseStreaming must be a boolean`);
    }
    const max = vc["maxDuration"];
    if (
      max !== undefined &&
      (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 900)
    ) {
      problems.push(`${name}: maxDuration must be an integer from 1 to 900`);
    }
    const pkg = readJson(join(folder, "package.json"), []);
    if (pkg === undefined || pkg["type"] !== "module")
      problems.push(`${name}: package.json needs "type": "module"`);
  }
  return problems;
}

/**
 * The subset of TOML the Netlify adapter writes: `[section]` headers, `key = "string"` and
 * `key = ["..."]`, `#` comments. Returns sections of string values.
 */
export function parseTomlSubset(text: string): {
  sections: Record<string, Record<string, string>>;
  problems: string[];
} {
  const sections: Record<string, Record<string, string>> = { "": {} };
  const problems: string[] = [];
  let current = "";
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const header = /^\[([A-Za-z_][A-Za-z0-9_.-]*)\]$/.exec(line);
    if (header !== null) {
      current = header[1] ?? "";
      sections[current] ??= {};
      return;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(".*")$/.exec(line);
    if (pair === null) {
      problems.push(`line ${index + 1}: not a supported TOML line: ${line}`);
      return;
    }
    const value: unknown = JSON.parse(pair[2] ?? '""');
    if (typeof value === "string") {
      let section = sections[current];
      if (section === undefined) {
        section = {};
        sections[current] = section;
      }
      section[pair[1] ?? ""] = value;
    }
  });
  return { sections, problems };
}

/**
 * The Netlify output folder: `netlify.toml` names a publish folder that exists and a functions (or
 * edge functions) folder that holds `render.mjs` with a default export and `config.path = "/*"`;
 * `client/_headers` and `client/_redirects` are well formed.
 *
 * @param folder The `dist/netlify` folder.
 * @param target `functions` or `edge`.
 * @returns Every problem found.
 */
export function checkNetlifyOutput(folder: string, target: "functions" | "edge"): string[] {
  const problems: string[] = [];
  const file = join(folder, "netlify.toml");
  if (!existsSync(file)) return ["netlify.toml: missing"];
  const { sections, problems: syntax } = parseTomlSubset(readFileSync(file, "utf8"));
  problems.push(...syntax.map((problem) => `netlify.toml: ${problem}`));
  const publish = sections["build"]?.["publish"];
  if (publish === undefined || !existsSync(join(folder, publish)))
    problems.push(`netlify.toml: build.publish "${publish ?? ""}" is not a folder`);
  const dirKey =
    target === "edge"
      ? sections["build"]?.["edge_functions"]
      : sections["functions"]?.["directory"];
  if (dirKey === undefined)
    problems.push(
      `netlify.toml: no ${target === "edge" ? "build.edge_functions" : "functions.directory"}`,
    );
  else {
    const entry = join(folder, dirKey, "render.mjs");
    if (!existsSync(entry)) problems.push(`${dirKey}/render.mjs is missing`);
    else {
      const code = readFileSync(entry, "utf8");
      if (!/export default /.test(code)) problems.push("render.mjs has no default export");
      if (!/export const config = \{ path: "\/\*"(?:,| \})/.test(code))
        problems.push('render.mjs does not export config = { path: "/*", ... }');
    }
  }
  const headers = join(folder, "client", "_headers");
  if (!existsSync(headers)) problems.push("client/_headers: missing");
  else {
    let path = "";
    readFileSync(headers, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.trim() === "" || line.startsWith("#")) return;
        if (/^\s/.test(line)) {
          if (path === "")
            problems.push(`client/_headers line ${index + 1}: a header with no path`);
          if (!/^\s+[A-Za-z][A-Za-z-]*: .+$/.test(line))
            problems.push(`client/_headers line ${index + 1}: not "Name: value"`);
        } else {
          path = line.trim();
          if (!path.startsWith("/"))
            problems.push(`client/_headers line ${index + 1}: a path must start with /`);
        }
      });
  }
  const redirects = join(folder, "client", "_redirects");
  if (!existsSync(redirects)) problems.push("client/_redirects: missing");
  else {
    readFileSync(redirects, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.trim() === "" || line.startsWith("#")) return;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2 || parts.length > 3)
          problems.push(`client/_redirects line ${index + 1}: "from to [status]" expected`);
        if (parts[2] !== undefined && !/^(301|302|303|307|308|200|404|410)$/.test(parts[2])) {
          problems.push(
            `client/_redirects line ${index + 1}: status ${parts[2]} is not one Netlify accepts here`,
          );
        }
      });
  }
  return problems;
}
