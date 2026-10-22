import { COMMANDS, type CommandSpec, type CompletionShell, type OptionHelp } from "./commands";

/**
 * The shell completion scripts of `dusk completion`. The command and flag lists come from COMMANDS, the table the
 * parser and the help read, so a command or flag added there is completed with no change here. The scripts are
 * static: printing one runs no app and reads no project file.
 *
 * @packageDocumentation
 */

/** The flags the bin takes before a command. The help lists the same two. @internal */
const GLOBAL_OPTIONS: readonly OptionHelp[] = [
  { flag: "-h, --help", text: "Show this help." },
  { flag: "-v, --version", text: "Print the version." },
  { flag: "--json", text: "Print JSON on stdout instead of words." },
];

/**
 * The completion script of one shell. Print it to stdout and load it from the shell's startup file or completion
 * folder, as the script's header comment says.
 *
 * @param shell The shell the script is for.
 * @returns The script, ending with a newline.
 * @since 1.0.0
 * @example completionScript("fish").startsWith("# fish completion for dusk"); // true
 */
export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
  }
}

/** The long and short names of an option line: `-p, --port <n>` gives `-p` and `--port`. @internal */
function flagNames(option: OptionHelp): string[] {
  return option.flag.split(", ").map((part) => part.split(" ")[0] ?? part);
}

/** Every flag a command takes, short and long, once each. @internal */
function commandFlags(command: CommandSpec): string[] {
  return [...new Set(command.options.flatMap(flagNames))];
}

/**
 * The value an option takes, from its placeholder: `-p, --port <n>` takes a required `n`, `--host [<host>]` takes an
 * optional `host`. Undefined for a flag with no value. @internal
 */
function optionValue(
  option: OptionHelp,
): { readonly name: string; readonly optional: boolean } | undefined {
  const name = /<([^>]+)>/.exec(option.flag)?.[1];
  if (name === undefined) return undefined;
  return { name, optional: option.flag.includes("[") };
}

/** A bash-style single-quoted word, for the zsh and fish scripts that quote this way. @internal */
function zshQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** The explanation of a zsh `_arguments` spec: brackets and backslashes escaped. @internal */
function zshExplain(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

/** A fish single-quoted string: backslashes and quotes escaped. @internal */
function fishQuote(text: string): string {
  return `'${text.replace(/[\\']/g, "\\$&")}'`;
}

/** The fish `complete` arguments that name an option: `-s p -l port -r` for a required value. @internal */
function fishFlagArgs(option: OptionHelp): string {
  const parts = flagNames(option).map((name) =>
    name.startsWith("--") ? `-l ${name.slice(2)}` : `-s ${name.slice(1)}`,
  );
  const value = optionValue(option);
  if (value !== undefined && !value.optional) parts.push("-r");
  return parts.join(" ");
}

/** The bash script: a `complete -F` function that answers from the command table. @internal */
function bashScript(): string {
  const commandNames = COMMANDS.map((command) => command.name).join(" ");
  const globalFlags = GLOBAL_OPTIONS.flatMap(flagNames).join(" ");
  const cases = COMMANDS.map((command) => {
    const flags = commandFlags(command).join(" ");
    if (!("shells" in command)) return `    ${command.name}) words="${flags}" ;;`;
    return [
      `    ${command.name})`,
      `      if [[ $cur == -* ]]; then words="${flags}"; else words="${command.shells.join(" ")}"; fi`,
      "      ;;",
    ].join("\n");
  });
  return [
    "# bash completion for dusk. Load it with: source <(dusk completion bash)",
    "_dusk_completion() {",
    "  local cur cmd words",
    "  COMPREPLY=()",
    `  cur="\${COMP_WORDS[COMP_CWORD]}"`,
    '  words=""',
    "  if (( COMP_CWORD == 1 )); then",
    `    if [[ $cur == -* ]]; then words="${globalFlags}"; else words="${commandNames}"; fi`,
    "  else",
    `    cmd="\${COMP_WORDS[1]}"`,
    '    case "$cmd" in',
    ...cases,
    "    esac",
    "  fi",
    '  COMPREPLY=( $(compgen -W "$words" -- "$cur") )',
    "  return 0",
    "}",
    "complete -F _dusk_completion dusk",
    "",
  ].join("\n");
}

/** The zsh script: a `#compdef` function with `_describe` for commands and `_arguments` per command. @internal */
function zshScript(): string {
  const entries = COMMANDS.map(
    (command) => `      ${zshQuote(`${command.name}:${command.summary}`)}`,
  );
  const cases = COMMANDS.map((command) => {
    const specs = command.options.flatMap((option) =>
      flagNames(option).map((name) => {
        const value = optionValue(option);
        const argument = value === undefined ? "" : `${value.optional ? "::" : ":"}${value.name}:`;
        return zshQuote(`${name}[${zshExplain(option.text)}]${argument}`);
      }),
    );
    if ("shells" in command) specs.push(zshQuote(`1:shell:(${command.shells.join(" ")})`));
    return [
      `    ${command.name})`,
      "      shift words",
      "      (( CURRENT-- ))",
      `      _arguments -s \\`,
      `        ${specs.join(" \\\n        ")}`,
      "      ;;",
    ].join("\n");
  });
  return [
    "#compdef dusk",
    "# zsh completion for dusk. Save it as _dusk in a folder on $fpath, or load it with: source <(dusk completion zsh)",
    "# It needs compinit to have run first.",
    "_dusk() {",
    "  local -a commands",
    "  if (( CURRENT == 2 )); then",
    "    commands=(",
    ...entries,
    "    )",
    "    _describe -t commands 'dusk command' commands",
    "    return",
    "  fi",
    "  case $words[2] in",
    ...cases,
    "  esac",
    "}",
    "",
    'if [ "$funcstack[1]" = "_dusk" ]; then',
    '  _dusk "$@"',
    "else",
    "  compdef _dusk dusk",
    "fi",
    "",
  ].join("\n");
}

/** The fish script: `complete` lines, conditioned on the command word already typed. @internal */
function fishScript(): string {
  const lines = [
    "# fish completion for dusk. Load it with: dusk completion fish | source",
    "complete -c dusk -f",
  ];
  for (const command of COMMANDS) {
    lines.push(
      `complete -c dusk -n '__fish_use_subcommand' -a ${command.name} -d ${fishQuote(command.summary)}`,
    );
  }
  for (const option of GLOBAL_OPTIONS) {
    lines.push(`complete -c dusk ${fishFlagArgs(option)} -d ${fishQuote(option.text)}`);
  }
  for (const command of COMMANDS) {
    const condition = fishQuote(`__fish_seen_subcommand_from ${command.name}`);
    for (const option of command.options) {
      lines.push(
        `complete -c dusk -n ${condition} ${fishFlagArgs(option)} -d ${fishQuote(option.text)}`,
      );
    }
    if ("shells" in command)
      lines.push(`complete -c dusk -n ${condition} -a ${fishQuote(command.shells.join(" "))}`);
  }
  return `${lines.join("\n")}\n`;
}
