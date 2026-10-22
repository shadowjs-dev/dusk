import type { ParseArgsOptionsConfig } from "node:util";

/**
 * The commands of the `dusk` bin, with the options each one takes. The parser and the help text read the same table, so
 * a flag that is documented is a flag that parses.
 *
 * @packageDocumentation
 */

/** The things the bin does. `preview` is `start`. @since 1.0.0 */
export type RunName = "dev" | "build" | "start" | "doctor";

/** The shells `dusk completion` writes a script for. @since 1.0.0 */
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

/** One of the shells `dusk completion` supports. @since 1.0.0 */
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** One line of the options list of a command's help. @since 1.0.0 */
export interface OptionHelp {
  readonly flag: string;
  readonly text: string;
}

/** The fields every command has. @internal */
interface CommandBase {
  /** The summary line of the command's help. */
  readonly summary: string;
  /** The options, in the order the help lists them. */
  readonly options: readonly OptionHelp[];
  /** Example command lines, shown at the end of the command's help. */
  readonly examples: readonly string[];
  /** The `util.parseArgs` options of the command. */
  readonly parse: ParseArgsOptionsConfig;
  /** True when the command takes `--host`: a bare `--host` (no value) is then accepted. */
  readonly takesHost: boolean;
}

/** A command that runs the app (dev, build, start, doctor, preview). @since 1.0.0 */
export interface RunCommandSpec extends CommandBase {
  /** The name typed after `dusk`. */
  readonly name: "dev" | "build" | "start" | "preview" | "doctor";
  /** What runs. `preview` runs `start`. */
  readonly run: RunName;
}

/** `dusk completion <shell>`: prints a shell completion script and runs nothing. @since 1.0.0 */
export interface CompletionCommandSpec extends CommandBase {
  readonly name: "completion";
  /** The shells the operand accepts. */
  readonly shells: readonly CompletionShell[];
}

/** A command as the user types it. @since 1.0.0 */
export type CommandSpec = RunCommandSpec | CompletionCommandSpec;

const LOG_OPTION: OptionHelp = {
  flag: "--log",
  text: "Print one line per request the app answers (static files are not logged).",
};
const JSON_PARSE = { json: { type: "boolean" } } as const;
const HELP_FLAG: OptionHelp = { flag: "-h, --help", text: "Show this help." };
const WORKERS_OPTION: OptionHelp = {
  flag: "--workers <n|auto>",
  text: "Run n server processes that share the port (auto: one per core, at most 16). Default: DUSK_WORKERS, then 1. SIGUSR2 replaces them one by one.",
};
const STREAM_JSON_OPTION: OptionHelp = {
  flag: "--json",
  text: "Print JSON Lines on stdout, one event per line (ready, request, stopped), and nothing else there.",
};
const HELP_PARSE = { help: { type: "boolean", short: "h" } } as const;
const HOST_HELP = "Interface to listen on. Without a value: all interfaces. Default: HOST, then ";

const SERVING_OPTIONS = (defaultHost: string): readonly OptionHelp[] => [
  {
    flag: "-p, --port <n>",
    text: "Port to listen on. Default: the PORT environment variable, then 3000.",
  },
  { flag: "--host [<host>]", text: `${HOST_HELP}${defaultHost}.` },
  HELP_FLAG,
];

const SERVING_PARSE: ParseArgsOptionsConfig = {
  port: { type: "string", short: "p" },
  host: { type: "string" },
  ...JSON_PARSE,
  ...HELP_PARSE,
};

/** Every command, in the order the help lists them. @since 1.0.0 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "dev",
    run: "dev",
    summary:
      "Start the development server of the app in this folder (hot reload, server rendering).",
    options: [
      {
        flag: "-p, --port <n>",
        text: "Port to listen on. Default: PORT, then server.port of the app's config, then 3000.",
      },
      { flag: "--host [<host>]", text: `${HOST_HELP}server.host of the app's config.` },
      {
        flag: "--strictPort",
        text: "Exit with an error when the port is taken, instead of using the next free one.",
      },
      { flag: "--open", text: "Open the app in the default browser." },
      {
        flag: "--verbose",
        text: "Also print the quiet events: hot updates, page reloads, and a line for every asset request.",
      },
      STREAM_JSON_OPTION,
      HELP_FLAG,
    ],
    examples: [
      "dusk dev                  Serve on port 3000.",
      "dusk dev -p 4000 --open   Serve on port 4000 and open the browser.",
      "dusk dev --host           Listen on the network, to try the app on a phone.",
      "dusk dev --json           Print JSON Lines: a ready line with the url, then one line per request.",
    ],
    parse: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      strictPort: { type: "boolean" },
      open: { type: "boolean" },
      verbose: { type: "boolean" },
      ...JSON_PARSE,
      ...HELP_PARSE,
    },
    takesHost: true,
  },
  {
    name: "build",
    run: "build",
    summary:
      "Build the app in this folder for production: the client, the server bundle, and the adapter's output.",
    options: [
      {
        flag: "--json",
        text: "Print the build summary as JSON on stdout (the summary is in data), and nothing else there.",
      },
      HELP_FLAG,
    ],
    examples: [
      "dusk build                          Build and print the route table.",
      "dusk build --json > summary.json    Save the summary for a CI check.",
    ],
    parse: { ...JSON_PARSE, ...HELP_PARSE },
    takesHost: false,
  },
  {
    name: "start",
    run: "start",
    summary: "Serve the production build in dist/ with the Node adapter. Run `dusk build` first.",
    options: [
      ...SERVING_OPTIONS("0.0.0.0").slice(0, -1),
      WORKERS_OPTION,
      LOG_OPTION,
      STREAM_JSON_OPTION,
      HELP_FLAG,
    ],
    examples: [
      "dusk start                 Serve the build on port 3000.",
      "dusk start -p 8080 --log   Serve on port 8080 and print each request.",
      "dusk start --workers auto  Serve with one process per core.",
      "dusk start --json          Print JSON Lines: a ready line with the url, then one line per request with --log.",
    ],
    parse: { ...SERVING_PARSE, log: { type: "boolean" }, workers: { type: "string" } },
    takesHost: true,
  },
  {
    name: "doctor",
    run: "doctor",
    summary:
      "Check the project in this folder: Node version, config, routes, env files, adapter, lockfile and duplicate packages.",
    options: [
      {
        flag: "--json",
        text: "Print the checks as JSON on stdout (they are in data), and nothing else there.",
      },
      HELP_FLAG,
    ],
    examples: [
      "dusk doctor              Check the project and print what to fix.",
      "dusk doctor --json       Print the report for a CI step (exit code 1 on a failure).",
    ],
    parse: { ...JSON_PARSE, ...HELP_PARSE },
    takesHost: false,
  },
  {
    name: "completion",
    summary:
      "Print a shell completion script for bash, zsh or fish, to load in your shell. Runs no app.",
    options: [
      {
        flag: "--json",
        text: "Print { shell, script } as JSON on stdout, and nothing else there (for scripts).",
      },
      HELP_FLAG,
    ],
    examples: [
      "dusk completion bash > ~/.dusk-completion.bash   Save the bash script.",
      "dusk completion fish | source                    Load the fish script in this shell.",
    ],
    parse: { ...JSON_PARSE, ...HELP_PARSE },
    takesHost: false,
    shells: COMPLETION_SHELLS,
  },
  {
    name: "preview",
    run: "start",
    summary: "The same as dusk start.",
    options: [
      ...SERVING_OPTIONS("0.0.0.0").slice(0, -1),
      WORKERS_OPTION,
      LOG_OPTION,
      STREAM_JSON_OPTION,
      HELP_FLAG,
    ],
    examples: ["dusk preview -p 4173   Look at the production build on port 4173."],
    parse: { ...SERVING_PARSE, log: { type: "boolean" }, workers: { type: "string" } },
    takesHost: true,
  },
];

/**
 * The command a name refers to.
 * @param name What the user typed.
 * @returns The command, or undefined for an unknown name.
 * @since 1.0.0
 */
export function commandNamed(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
