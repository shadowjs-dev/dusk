import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NODE_DEFAULT_HOST, NODE_DEFAULT_PORT } from "../node/adapter";
import { type ServerHandle, serve } from "../node/serve";
import { parseWorkers, resolveWorkerCount, WORKERS_ENV } from "../node/worker-count";
import type { Handler } from "../server/types";
import { workerInfo } from "../shared/worker-info";
import { BUILD_DIR } from "./build";
import { CliError, isErrorCode } from "./errors";
import { jsonSuccess, jsonTerminal, writeJson } from "./json";
import { readBuildManifest } from "./manifest";
import {
  bannerLines,
  currentTerminal,
  err,
  FORCED_LINE,
  out,
  type RequestFacts,
  requestLine,
  STOPPED_LINE,
  stoppingLine,
} from "./output";
import type { RunFlags } from "./parse";
import { reportFailure } from "./report";
import { hostFromEnv, localUrl, networkUrlsFor, portFromEnv } from "./serving";
import { untilStopped } from "./shutdown";
import { duskVersion } from "./version";

/**
 * `dusk start` (and `dusk preview`): serves the production build with the Node adapter, the same way the generated
 * `server.mjs` does: the handler of `dist/server/entry.js`, the static files of `dist/client`, and the port and host
 * of the flags, then `PORT` and `HOST`, then the adapter's defaults. The config is not evaluated; the build's manifest
 * says which adapter it used.
 *
 * @packageDocumentation
 */

const ENTRY = join(BUILD_DIR, "server", "entry.js");

/**
 * Starts the production server and runs until it is stopped. With `--json`, stdout carries JSON Lines and nothing else: a
 * `ready` line (`url`, `urls`, `port`, `host`, `mode`, `version`, `adapter`, `environments`, `readyMs`), a `request`
 * line for each request with `--log`, and a `stopped` line after a clean stop. The words go to stderr.
 * @param flags The parsed flags.
 * @returns 0 after a clean stop.
 * @throws CliError when there is no build, the build used another adapter, or the port is taken.
 * @since 1.0.0
 */
export async function runStart(flags: RunFlags): Promise<number> {
  const started = performance.now();
  const root = process.cwd();
  const version = duskVersion();
  const json = flags.json;
  const term = json ? jsonTerminal() : currentTerminal();
  const clientDir = join(root, BUILD_DIR, "client");
  const manifest = await readBuildManifest(join(root, BUILD_DIR, "dusk-manifest.json"));
  if (
    manifest === undefined ||
    !(await isDirectory(clientDir)) ||
    !(await isFile(join(root, ENTRY)))
  ) {
    throw new CliError("no build found in dist. Run `dusk build` first.", "DUSK_NO_BUILD");
  }
  const adapter = manifest.adapter;
  if (adapter === undefined) {
    throw new CliError(
      "this build has no adapter. Add `adapter: node()` from `@shadow-js/dusk/node` to dusk() in vite.config.ts and run `dusk build`.",
      "DUSK_NO_ADAPTER",
    );
  }
  if (adapter.name !== "node") {
    throw new CliError(
      `dusk start runs the Node build; this app was built with the ${adapter.name} adapter. Deploy it with that platform's tooling.`,
      "DUSK_WRONG_ADAPTER",
    );
  }

  // The real environment decides the port and the host (as the generated server.mjs reads them), then the env files of
  // the production mode fill in the variables the server code reads, as the dev server does.
  const port = flags.port ?? portFromEnv("PORT", process.env["PORT"]) ?? NODE_DEFAULT_PORT;
  const host =
    flags.host !== undefined
      ? flags.host === ""
        ? NODE_DEFAULT_HOST
        : flags.host
      : (hostFromEnv(process.env["HOST"]) ?? NODE_DEFAULT_HOST);
  const { applyServerEnv, loadedEnvFiles, loadServerEnv } = await import("../vite/env");
  const environments = loadedEnvFiles("production", root);
  applyServerEnv(loadServerEnv("production", root));

  // `--workers`: this process becomes the primary of a pool that forks workers, each running this same command. The
  // primary never loads the app. A worker (started by the primary) serves like a single process and is not seen on the
  // terminal: the primary prints the banner and the JSON lines `ready` and `stopped`.
  const workers = workersOf(flags);
  const isWorker = workerInfo().clustered;
  if (workers > 1 && !isWorker) {
    return runPool({
      workers,
      port,
      host,
      json,
      started,
      version,
      environments,
      adapterName: adapter.name,
    });
  }

  const built = handlerOf(await import(pathToFileURL(join(root, ENTRY)).href));
  const handler = flags.log
    ? withRequestLog(
        built,
        json
          ? (request) => writeJson(jsonSuccess("dusk start", request, [], "request"), true)
          : (request) => out(requestLine(request, term)),
      )
    : built;
  let running: ServerHandle;
  try {
    running = await serve(handler, {
      port,
      host,
      // The same static options as the generated Node server: prerendered pages (`/about`, `/`) answer from their files.
      static: {
        dir: clientDir,
        index: "index.html",
        extensions: [".html"],
        pages: manifest.staticPages,
        ...(manifest.assetsDir === undefined ? {} : { assetsDir: manifest.assetsDir }),
      },
      // A worker of a pool stops when its primary says so (or on a signal sent to it); a single process stops through the
      // handlers of this command.
      ...(isWorker ? {} : { shutdownSignals: false as const }),
    });
  } catch (error) {
    if (isErrorCode(error, "EADDRINUSE")) {
      throw new CliError(
        `port ${port} is already in use. Pass --port with a free one.`,
        "DUSK_PORT_IN_USE",
      );
    }
    throw error;
  }
  if (isWorker) return new Promise<number>(() => undefined);
  const local = [localUrl(host, running.port)];
  const network = networkUrlsFor(host, running.port);
  if (json) {
    writeJson(
      jsonSuccess(
        "dusk start",
        {
          url: local[0] ?? network[0] ?? "",
          urls: { local, network },
          port: running.port,
          host,
          mode: "production",
          version,
          adapter: adapter.name,
          environments,
          readyMs: performance.now() - started,
        },
        [],
        "ready",
      ),
      true,
    );
  } else {
    for (const line of bannerLines(
      {
        version,
        mode: "production",
        local,
        network,
        networkHint: "set HOST or pass --host to listen on the network",
        environments,
        adapter: adapter.name,
        readyMs: performance.now() - started,
      },
      term,
    )) {
      out(line);
    }
  }
  return untilServerStops(running, json);
}

/**
 * Waits until the user stops the server (SIGINT or SIGTERM), closes it, and says so; with a worker pool it also ends when
 * the pool gives up (the crash-loop breaker).
 * @internal
 */
async function untilServerStops(running: ServerHandle, json: boolean): Promise<number> {
  const say = json ? err : out;
  let stoppedBy: NodeJS.Signals | undefined;
  const stopped = untilStopped(
    () => running.close(),
    (error) => {
      reportFailure("dusk start", error, json ? "stream" : false);
    },
    {
      signaled: (signal) => {
        stoppedBy = signal;
        say(stoppingLine(signal, "server"));
      },
      stopped: () => {
        if (json) {
          writeJson(jsonSuccess("dusk start", { signal: stoppedBy ?? null }, [], "stopped"), true);
        } else {
          out(STOPPED_LINE);
        }
      },
      forced: () => err(FORCED_LINE),
    },
  );
  const pool = running.pool;
  if (pool === undefined) return stopped;
  const gaveUp = pool.failed.then(async (error) => {
    await running.close();
    reportFailure(
      "dusk start",
      new CliError(error.message, "DUSK_FAILED"),
      json ? "stream" : false,
    );
    return 1;
  });
  return Promise.race([stopped, gaveUp]);
}

/**
 * `dusk start --workers n`: the primary. It forks the workers (each runs this command again and serves), prints the banner
 * once all of them listen, and stops them on a signal. The app is not loaded here.
 * @internal
 */
async function runPool(input: {
  readonly workers: number;
  readonly port: number;
  readonly host: string;
  readonly json: boolean;
  readonly started: number;
  readonly version: string;
  readonly environments: readonly string[];
  readonly adapterName: string;
}): Promise<number> {
  const { json, host, workers } = input;
  const term = json ? jsonTerminal() : currentTerminal();
  let running: ServerHandle;
  try {
    const { superviseWorkers } = await import("../node/cluster");
    running = await superviseWorkers({
      workers,
      port: input.port,
      host,
      // `dusk start` stops the pool itself (see `untilServerStops`), and reports a breaker trip with its own envelope.
      shutdownSignals: false,
      exitOnFailure: false,
      // A production build: no extra response header.
      workerHeader: false,
    });
  } catch (error) {
    if (isErrorCode(error, "EADDRINUSE")) {
      throw new CliError(
        `port ${input.port} is already in use. Pass --port with a free one.`,
        "DUSK_PORT_IN_USE",
      );
    }
    if (error instanceof Error && /^worker \d+ (exited|did not)/.test(error.message)) {
      throw new CliError(
        `the workers did not start: ${error.message} Their output is above.`,
        "DUSK_FAILED",
      );
    }
    throw error;
  }
  const local = [localUrl(host, running.port)];
  const network = networkUrlsFor(host, running.port);
  if (json) {
    writeJson(
      jsonSuccess(
        "dusk start",
        {
          url: local[0] ?? network[0] ?? "",
          urls: { local, network },
          port: running.port,
          host,
          mode: "production",
          version: input.version,
          adapter: input.adapterName,
          environments: input.environments,
          workers,
          readyMs: performance.now() - input.started,
        },
        [],
        "ready",
      ),
      true,
    );
  } else {
    for (const line of bannerLines(
      {
        version: input.version,
        mode: "production",
        local,
        network,
        networkHint: "set HOST or pass --host to listen on the network",
        environments: input.environments,
        adapter: input.adapterName,
        readyMs: performance.now() - input.started,
      },
      term,
    )) {
      out(line);
    }
    out(`  ${workers} workers share the port (SIGUSR2 replaces them one by one)`);
  }
  return untilServerStops(running, json);
}

/**
 * The number of workers: `--workers`, then `DUSK_WORKERS`, then 1.
 * @throws CliError for an invalid `DUSK_WORKERS`.
 * @internal
 */
function workersOf(flags: RunFlags): number {
  if (flags.workers !== undefined) return resolveWorkerCount(flags.workers);
  try {
    return resolveWorkerCount(parseWorkers(process.env[WORKERS_ENV], WORKERS_ENV));
  } catch (error) {
    if (error instanceof RangeError) throw new CliError(error.message, "DUSK_INVALID_OPTION");
    throw error;
  }
}

/**
 * The handler that reports each request it answers (`--log`) to `report`. Static files are answered before the handler
 * and are not logged: the log shows the requests the app handled. Everything but `fetch` is the handler's own (a proxy
 * keeps `this` on the handler).
 * @internal
 */
function withRequestLog(handler: Handler, report: (request: RequestFacts) => void): Handler {
  const fetch = async (request: Request, env?: unknown): Promise<Response> => {
    const started = performance.now();
    const response = await handler.fetch(request, env);
    report({
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      ms: performance.now() - started,
    });
    return response;
  };
  return new Proxy(handler, {
    get(target, property) {
      if (property === "fetch") return fetch;
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * The handler the built entry exports.
 * @internal
 */
function handlerOf(module: unknown): Handler {
  const candidate =
    typeof module === "object" && module !== null ? Reflect.get(module, "handler") : undefined;
  if (!isHandler(candidate)) {
    throw new CliError(
      `${ENTRY} does not export a handler. Run \`dusk build\` again.`,
      "DUSK_BAD_BUILD",
    );
  }
  return candidate;
}

function isHandler(value: unknown): value is Handler {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "fetch") === "function"
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return (await statOrUndefined(path))?.isDirectory() === true;
}

async function isFile(path: string): Promise<boolean> {
  return (await statOrUndefined(path))?.isFile() === true;
}

async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}
