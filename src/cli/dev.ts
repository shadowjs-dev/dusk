import type { Plugin, ServerOptions } from "vite";
import { CliError } from "./errors";
import { jsonSuccess, jsonTerminal, writeJson } from "./json";
import { duskLogger } from "./logger";
import {
  actionLine,
  bannerLines,
  CLEAR_SCREEN,
  currentTerminal,
  err,
  FORCED_LINE,
  out,
  type RequestFacts,
  requestLine,
  STOPPED_LINE,
  shortcutHint,
  shortcutLines,
  stoppingLine,
  type Terminal,
} from "./output";
import type { RunFlags } from "./parse";
import { reportFailure } from "./report";
import { duskApiOf, hostFromEnv, portFromEnv } from "./serving";
import { bindShortcuts, type ShortcutActions, terminalKeys } from "./shortcuts";
import { untilStopped } from "./shutdown";
import { startSpinner } from "./spinner";
import { duskVersion } from "./version";

/**
 * `dusk dev`: one Vite dev server for the app in the working folder, run with Dusk's output. The app's config file is
 * the only configuration: the bin passes a server option only when the user set it (a flag or a variable), so the
 * config's `server.port`, `server.host` and `server.strictPort` still apply. The default port is 3000 when nothing sets
 * one. Vite restarts the same server object when the config or an env file changes, so the bin keeps one reference and
 * never restarts it itself.
 *
 * @packageDocumentation
 */

/** The port `dusk dev` uses when neither a flag, the environment nor the config sets one. @since 1.0.0 */
export const DEV_DEFAULT_PORT = 3000;

/** Vite's message for a port that is taken and must not be replaced (strictPort). */
const PORT_TAKEN = /^Port (\d+) is already in use$/;

/**
 * The options of `createServer` that the flags and the environment set. Port precedence: `--port`, then `PORT`, then the
 * config, then {@link DEV_DEFAULT_PORT}. Host precedence: `--host` (a bare flag is all interfaces), then `HOST`, then the
 * config (the default is localhost, which is not on the network).
 * @param flags The parsed flags.
 * @param env The environment.
 * @returns The server options to pass; only the keys that are set.
 * @throws CliError when `PORT` is not a port.
 * @since 1.0.0
 */
export function devServerOptions(flags: RunFlags, env: NodeJS.ProcessEnv): ServerOptions {
  const port = flags.port ?? portFromEnv("PORT", env["PORT"]);
  const host =
    flags.host !== undefined ? (flags.host === "" ? true : flags.host) : hostFromEnv(env["HOST"]);
  return {
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(flags.strictPort ? { strictPort: true } : {}),
    ...(flags.open ? { open: true } : {}),
  };
}

/**
 * The plugin that gives the dev server Dusk's defaults and its request lines. It sets the port only when the config does
 * not (Vite's own default is 5173). Its middleware runs before Vite's and the app's, so it sees every request and its
 * answer: a page or an API route is logged like Next's `GET /dashboard 200 in 34ms`; modules, stylesheets and hot
 * updates are logged only with `--verbose`.
 * @param verbose `--verbose`.
 * @param term The output's rules.
 * @param onRequest Called with each request that would be printed, instead of printing its line (`--json`).
 * @returns The plugin.
 * @internal
 */
export function devCliPlugin(
  verbose: boolean,
  term: Terminal,
  onRequest?: (request: RequestFacts) => void,
): Plugin {
  return {
    name: "dusk:cli",
    config(userConfig) {
      if (userConfig.server?.port !== undefined) return undefined;
      return { server: { port: DEV_DEFAULT_PORT } };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const started = performance.now();
        res.once("finish", () => {
          const type = String(res.getHeader("content-type") ?? "");
          const path = new URL(req.url ?? "/", "http://localhost").pathname;
          // Pages and API routes are the app's requests; a module, a stylesheet or a file of `public/` is an asset.
          const asset =
            path.startsWith("/@") || path.startsWith("/__") || /\.[a-z0-9]+$/i.test(path);
          if (asset && !type.includes("text/html") && !verbose) return;
          const request: RequestFacts = {
            method: req.method ?? "GET",
            path,
            status: res.statusCode,
            ms: performance.now() - started,
          };
          if (onRequest === undefined) out(requestLine(request, term));
          else onRequest(request);
        });
        next();
      });
    },
  };
}

/**
 * Starts the dev server and runs until it is stopped. With `--json`, stdout carries JSON Lines and nothing else: a `ready`
 * line (`url`, `urls`, `port`, `mode`, `version`, `adapter`, `environments`, `readyMs`), a `request` line for each page
 * or API request (and each asset with `--verbose`), and a `stopped` line after a clean stop. The words go to stderr.
 * @param flags The parsed flags.
 * @returns The exit code after the stop (0), or 1 when the stop failed.
 * @throws CliError when the port is taken and strictPort is on; any other failure to start as it is.
 * @since 1.0.0
 */
export async function runDev(flags: RunFlags): Promise<number> {
  const started = performance.now();
  const json = flags.json;
  const term = json ? jsonTerminal() : currentTerminal();
  // The words of a `--json` run go to stderr: stdout is the stream.
  const say = json ? err : out;
  const spinner = startSpinner(term, "Starting the dev server");
  const version = duskVersion();
  const vite = await import("vite");
  const server = await vite
    .createServer({
      root: process.cwd(),
      customLogger: duskLogger({
        term,
        verbose: flags.verbose,
        quietInfo: false,
        spinner,
        infoToStderr: json,
      }),
      plugins: [
        devCliPlugin(
          flags.verbose,
          term,
          json
            ? (request) => writeJson(jsonSuccess("dusk dev", request, [], "request"), true)
            : undefined,
        ),
      ],
      server: devServerOptions(flags, process.env),
    })
    .catch((error: unknown) => {
      // The error is printed on a clean line.
      spinner.stop();
      throw error;
    });
  // Read before listen: Vite writes the port it bound back into the config, which would hide a port that was moved.
  const asked = server.config.server.port;
  try {
    await server.listen();
  } catch (error) {
    spinner.stop();
    await server.close();
    const taken = PORT_TAKEN.exec(error instanceof Error ? error.message : "");
    if (taken?.[1] !== undefined) {
      throw new CliError(
        `port ${taken[1]} is already in use. Strict port mode (--strictPort, or strictPort in the config) does not try another port: pass --port with a free one.`,
        "DUSK_PORT_IN_USE",
      );
    }
    throw error;
  }
  spinner.stop();
  const readyMs = performance.now() - started;

  const address = server.httpServer?.address();
  const bound = typeof address === "object" && address !== null ? address.port : undefined;
  if (bound !== undefined && asked !== undefined && asked !== 0 && bound !== asked) {
    say(`port ${asked} is in use, using ${bound}.`);
  }
  const api = duskApiOf(server.config.plugins);
  const local = server.resolvedUrls?.local ?? [];
  const network = server.resolvedUrls?.network ?? [];
  if (json) {
    writeJson(
      jsonSuccess(
        "dusk dev",
        {
          url: local[0] ?? network[0] ?? `http://localhost:${bound ?? asked ?? DEV_DEFAULT_PORT}/`,
          urls: { local, network },
          port: bound ?? null,
          mode: "development",
          version,
          adapter: api?.adapterName ?? null,
          environments: api?.envFiles ?? [],
          readyMs,
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
        mode: "development",
        local,
        network,
        networkHint: "pass --host to listen on the network",
        environments: api?.envFiles ?? [],
        adapter: api?.adapterName,
        readyMs,
      },
      term,
    )) {
      out(line);
    }
    if (term.interactive) out(shortcutHint(term));
  }

  const actions: ShortcutActions = {
    restart: () => {
      say(actionLine(term, "restarting the dev server"));
      server
        .restart()
        .catch((error: unknown) => reportFailure("dusk dev", error, json ? "stream" : false));
    },
    open: () => server.openBrowser(),
    clear: () => process.stdout.write(CLEAR_SCREEN),
    quit: () => {
      process.emit("SIGINT", "SIGINT");
    },
    help: () => {
      for (const line of shortcutLines(term)) say(line);
    },
  };
  const keys =
    term.interactive && process.stdin.isTTY === true ? terminalKeys(process.stdin) : undefined;
  const unbind = bindShortcuts(actions, term, keys);
  let stoppedBy: NodeJS.Signals | undefined;
  return untilStopped(
    async () => {
      unbind();
      await server.close();
    },
    (error) => {
      reportFailure("dusk dev", error, json ? "stream" : false);
    },
    {
      signaled: (signal) => {
        stoppedBy = signal;
        say(stoppingLine(signal, "dev server"));
      },
      stopped: () => {
        if (json) {
          writeJson(jsonSuccess("dusk dev", { signal: stoppedBy ?? null }, [], "stopped"), true);
        } else {
          out(STOPPED_LINE);
        }
      },
      forced: () => err(FORCED_LINE),
    },
  );
}
