/**
 * The spinner of `dusk build` and the start of `dusk dev` (`spinner.ts`), and how the logger prints around it.
 *
 * - CLI-41 a spinner exists only on a terminal a person watches; a pipe or CI sees no frame and no escape code.
 * - CLI-42 frames turn on a timer, lines printed meanwhile land on a clean line, and stop erases the line exactly once.
 * - CLI-43 the label is cut to the width of the terminal, and the timer never keeps the process alive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { duskLogger } from "../../src/cli/logger";
import type { Terminal } from "../../src/cli/output";
import { FRAME_MS, startSpinner } from "../../src/cli/spinner";

const ESC = String.fromCharCode(27);
const ERASE = `\r${ESC}[2K`;
const WATCHED: Terminal = { color: false, interactive: true, unicode: true, columns: 80 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dusk spinner", () => {
  it("[CLI-41] a pipe, CI or a log file gets nothing", () => {
    const writes: string[] = [];
    const spinner = startSpinner({ ...WATCHED, interactive: false }, "Building", (chunk) =>
      writes.push(chunk),
    );
    vi.advanceTimersByTime(FRAME_MS * 5);
    let ran = false;
    spinner.around(() => {
      ran = true;
    });
    spinner.stop();
    expect(writes).toEqual([]);
    expect(ran).toBe(true);
  });

  it("[CLI-42] a frame is drawn at once and again every frame time, each one over the last", () => {
    const writes: string[] = [];
    const spinner = startSpinner(WATCHED, "Building for production", (chunk) => writes.push(chunk));
    expect(writes).toEqual([`${ERASE}⠋ Building for production`]);
    vi.advanceTimersByTime(FRAME_MS);
    vi.advanceTimersByTime(FRAME_MS);
    expect(writes).toEqual([
      `${ERASE}⠋ Building for production`,
      `${ERASE}⠙ Building for production`,
      `${ERASE}⠹ Building for production`,
    ]);
    spinner.stop();
  });

  it("[CLI-42] ASCII frames on a terminal without Unicode", () => {
    const writes: string[] = [];
    const spinner = startSpinner({ ...WATCHED, unicode: false }, "Working", (chunk) =>
      writes.push(chunk),
    );
    vi.advanceTimersByTime(FRAME_MS * 4);
    expect(writes.map((chunk) => chunk.slice(ERASE.length, ERASE.length + 1))).toEqual([
      "-",
      "\\",
      "|",
      "/",
      "-",
    ]);
    spinner.stop();
  });

  it("[CLI-42] a line printed meanwhile erases the spinner first and draws it again after", () => {
    const writes: string[] = [];
    const spinner = startSpinner(WATCHED, "Building", (chunk) => writes.push(chunk));
    writes.length = 0;
    spinner.around(() => writes.push("warn: something\n"));
    expect(writes).toEqual([ERASE, "warn: something\n", `${ERASE}⠙ Building`]);
    spinner.stop();
  });

  it("[CLI-42] the spinner is drawn again even when the printed line throws", () => {
    const writes: string[] = [];
    const spinner = startSpinner(WATCHED, "Building", (chunk) => writes.push(chunk));
    writes.length = 0;
    expect(() =>
      spinner.around(() => {
        throw new Error("closed pipe");
      }),
    ).toThrow("closed pipe");
    expect(writes.at(-1)).toContain("Building");
    spinner.stop();
  });

  it("[CLI-42] stop erases the line once, ends the timer, and later lines print plainly", () => {
    const writes: string[] = [];
    const spinner = startSpinner(WATCHED, "Building", (chunk) => writes.push(chunk));
    writes.length = 0;
    spinner.stop();
    spinner.stop();
    expect(writes).toEqual([ERASE]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(FRAME_MS * 10);
    spinner.around(() => writes.push("after\n"));
    expect(writes).toEqual([ERASE, "after\n"]);
  });

  it("[CLI-43] the label is cut to the width of the terminal and can change", () => {
    const writes: string[] = [];
    const spinner = startSpinner({ ...WATCHED, columns: 14 }, "x".repeat(40), (chunk) =>
      writes.push(chunk),
    );
    expect(writes[0]).toBe(`${ERASE}⠋ ${"x".repeat(10)}`);
    spinner.label("done soon");
    vi.advanceTimersByTime(FRAME_MS);
    expect(writes[1]).toBe(`${ERASE}⠙ done soon`);
    spinner.stop();
  });

  it("[CLI-43] the timer does not keep the process alive", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      const spinner = startSpinner(WATCHED, "Building", () => undefined);
      const timer = interval.mock.results[0]?.value as NodeJS.Timeout | undefined;
      expect(timer?.hasRef()).toBe(false);
      spinner.stop();
    } finally {
      interval.mockRestore();
    }
  });

  it("[CLI-42] the logger prints around a spinner: a warning never lands on a frame", () => {
    const writes: string[] = [];
    const spinner = startSpinner(WATCHED, "Building", (chunk) => writes.push(chunk));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      writes.length = 0;
      const logger = duskLogger({ term: WATCHED, verbose: false, quietInfo: true, spinner });
      logger.warn("slow plugin");
      expect(writes).toEqual([ERASE, "warn slow plugin\n", `${ERASE}⠙ Building`]);
    } finally {
      stderr.mockRestore();
      spinner.stop();
    }
  });
});
