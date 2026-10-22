import { emitKeypressEvents } from "node:readline";
import type { Terminal } from "./output";

/**
 * The single-key shortcuts of `dusk dev`: `r` restart, `o` open, `c` clear, `q` quit, `h` help. They work when a person
 * is at a terminal (raw mode, no Enter needed); a pipe, a CI run or a non-TTY stdin has none. Ctrl+C reaches the stop
 * handler as SIGINT, as it does without raw mode. The terminal is restored when the binding is removed.
 *
 * @packageDocumentation
 */

/** What each key does. @since 1.0.0 */
export interface ShortcutActions {
  restart(): void;
  open(): void;
  clear(): void;
  quit(): void;
  help(): void;
}

/** One key press: its name (lower case) and whether Ctrl was held. @since 1.0.0 */
export interface KeyPress {
  readonly name: string;
  readonly ctrl: boolean;
}

/** Where key presses come from. The terminal's keys in a dev server; a test feeds its own. @since 1.0.0 */
export interface KeyFeed {
  /**
   * Starts reporting the key presses to `onKey`.
   * @returns A function that stops the reports and gives the terminal back.
   */
  listen(onKey: (key: KeyPress) => void): () => void;
}

/**
 * The keys of a terminal: raw mode on, so each key arrives at once.
 * @param input The input stream (stdin).
 * @returns The key feed.
 * @since 1.0.0
 */
export function terminalKeys(input: NodeJS.ReadStream): KeyFeed {
  return {
    listen(onKey) {
      emitKeypressEvents(input);
      const wasRaw = input.isRaw;
      input.setRawMode(true);
      input.resume();
      const onPress = (
        text: string | undefined,
        key: { name?: string; ctrl?: boolean } | undefined,
      ): void => {
        onKey({
          name: (key?.name ?? text ?? "").toLowerCase(),
          ctrl: key?.ctrl === true,
        });
      };
      input.on("keypress", onPress);
      return () => {
        input.off("keypress", onPress);
        input.setRawMode(wasRaw);
        input.pause();
      };
    },
  };
}

/**
 * Binds the keys to the actions while the command runs. Ctrl+C is not an action: it is a SIGINT to this process, which
 * the stop handler takes.
 * @param actions What the keys do.
 * @param term The output's rules: no keys unless a person is watching.
 * @param feed Where the keys come from; undefined when there are none.
 * @returns A function that removes the binding and restores the terminal.
 * @since 1.0.0
 */
export function bindShortcuts(
  actions: ShortcutActions,
  term: Terminal,
  feed: KeyFeed | undefined,
): () => void {
  if (!term.interactive || feed === undefined) return () => undefined;
  return feed.listen((key) => {
    if (key.ctrl && key.name === "c") {
      // The stop handler listens for SIGINT; emitting it in-process works on every platform (Windows has no SIGINT to send).
      process.emit("SIGINT", "SIGINT");
      return;
    }
    if (key.name === "r") actions.restart();
    else if (key.name === "o") actions.open();
    else if (key.name === "c") actions.clear();
    else if (key.name === "q") actions.quit();
    else if (key.name === "h") actions.help();
  });
}
