import { dirname, join, relative, resolve, sep } from "node:path";
import { writeBuildMarker } from "./build-dir";
import { summarizeBuild } from "./build-summary";
import { CliError, markBuildFailure } from "./errors";
import { jsonFailure, jsonSuccess, jsonTerminal, writeJson } from "./json";
import { duskLogger } from "./logger";
import { readBuildManifest } from "./manifest";
import { buildLines, currentTerminal, out } from "./output";
import type { RunFlags } from "./parse";
import { duskApiOf } from "./serving";
import { startSpinner } from "./spinner";
import { duskVersion } from "./version";

/**
 * `dusk build`: the app's production build through Vite's builder, the same `buildApp` that `vite build --app` runs. The
 * plugin writes `dist/client`, `dist/server`, `dist/dusk-manifest.json` and the adapter's output. The output is Dusk's
 * summary: the phases, the route table with each page's first-load JavaScript, the budget warnings, and the time. A
 * spinner shows the work on a terminal; `--json` prints the JSON contract instead (the summary in `data`, the budget
 * warnings in `warnings`) and nothing else on stdout.
 *
 * @packageDocumentation
 */

/** The output folder of the build, relative to the app (the plugin's default `outDir`). @internal */
export const BUILD_DIR = "dist";

/**
 * The folder the build wrote to: the parent of the client build's output folder (the plugin writes `<outDir>/client` and
 * `<outDir>/server`), so an app that sets `dusk({ outDir })` is read from where its build went, not from `dist`.
 *
 * @param config The resolved Vite config of the builder.
 * @returns The absolute output folder.
 * @example buildDirOf({ root: "/app", environments: { client: { build: { outDir: "/app/out/client" } } } }); // "/app/out"
 * @internal
 * @since 1.0.0
 */
export function buildDirOf(config: {
  readonly root: string;
  readonly environments: Readonly<Record<string, { readonly build: { readonly outDir: string } }>>;
}): string {
  const client = config.environments["client"]?.build.outDir;
  return client === undefined
    ? join(config.root, BUILD_DIR)
    : dirname(resolve(config.root, client));
}

/**
 * The build folder as the summary names it: relative to the app, with `/` separators.
 *
 * @param root The app's folder.
 * @param dir The absolute build folder.
 * @returns For example `dist` or `build/out`.
 * @example buildDirLabel("/app", "/app/build/out"); // "build/out"
 * @internal
 * @since 1.0.0
 */
export function buildDirLabel(root: string, dir: string): string {
  return relative(root, dir).split(sep).join("/");
}

/**
 * Builds the app in the working folder and prints the summary.
 * @param flags The parsed flags (`--json`).
 * @returns 0 after a build, or 1 under `--json` when `build.budgets.enforce` is set and a page is over its budget. A failed
 * build throws (the caller prints it and exits 1).
 * @throws CliError when the build wrote no manifest, or when `build.budgets.enforce` is set and a page is over its budget.
 * @since 1.0.0
 */
export async function runBuild(flags: Pick<RunFlags, "json">): Promise<number> {
  const root = process.cwd();
  const version = duskVersion();
  const started = performance.now();
  const term = flags.json ? jsonTerminal() : currentTerminal();
  // A person at a terminal watches a spinner; a script reading JSON, a pipe and CI see no frames.
  const spinner = flags.json ? undefined : startSpinner(term, "Building for production");
  try {
    const vite = await import("vite");
    let builder: Awaited<ReturnType<typeof vite.createBuilder>>;
    try {
      // Vite's own progress lines are not printed: the summary below says what the build did.
      builder = await vite.createBuilder({
        root,
        mode: "production",
        // Vite's level also gates the bundler's own progress lines ("transforming...", "rendering chunks..."), which are
        // written outside the logger: the summary below replaces them. Warnings and errors still reach the logger.
        logLevel: "warn",
        customLogger: duskLogger({
          term,
          verbose: false,
          quietInfo: true,
          ...(spinner === undefined ? {} : { spinner }),
        }),
      });
      await builder.buildApp();
    } catch (error) {
      // A config that throws or code that does not build is the app's to fix: no stack, `DUSK_BUILD_FAILED` in JSON.
      markBuildFailure(error);
      throw error;
    }
    const ms = performance.now() - started;
    spinner?.stop();
    const outDir = buildDirOf(builder.config);
    // `dusk start` does not read the config: it finds the folder through this marker. A marker that cannot be written is
    // said aloud, because `dusk start` would then look in the wrong folder.
    try {
      await writeBuildMarker(root, outDir);
    } catch (error) {
      builder.config.logger.warn(
        `dusk: could not record the build folder for \`dusk start\` (${error instanceof Error ? error.message : String(error)}). Pass --dir to \`dusk start\`.`,
      );
    }
    const manifest = await readBuildManifest(join(outDir, "dusk-manifest.json"));
    if (manifest === undefined)
      throw new CliError("the build wrote no manifest. Run `dusk build` again.", "DUSK_BAD_BUILD");
    const api = duskApiOf(builder.config.plugins);
    const summary = await summarizeBuild({
      version,
      manifest,
      clientDir: join(outDir, "client"),
      outDir: buildDirLabel(root, outDir),
      report: api?.buildReport,
      budgets: api?.buildBudgets,
      ms,
    });
    // With `build.budgets.enforce` a page over its budget fails the build, after the summary says which.
    const over = summary.routes.filter((route) => route.overBudget);
    const failed = api?.buildBudgets?.enforce === true && over.length > 0;
    const failure = `${over.length} ${over.length === 1 ? "page is" : "pages are"} over the budget set in build.budgets (${over.map((route) => route.path).join(", ")}).`;
    if (flags.json) {
      // The warnings of the summary are the envelope's warnings: one place for a script to read them.
      const { warnings, ...data } = summary;
      const found = warnings.map((message) => ({ code: "DUSK_BUDGET", message }));
      writeJson(
        failed
          ? jsonFailure(
              "dusk build",
              { code: "DUSK_BUDGET_EXCEEDED", message: failure },
              { data, warnings: found },
            )
          : jsonSuccess("dusk build", data, found),
      );
      return failed ? 1 : 0;
    }
    for (const line of buildLines(summary, term)) out(line);
    // The caller prints the error on a clean line and exits 1.
    if (failed) throw new CliError(failure, "DUSK_BUDGET_EXCEEDED");
    return 0;
  } finally {
    // Also when the build fails: the error is printed on a clean line.
    spinner?.stop();
  }
}
