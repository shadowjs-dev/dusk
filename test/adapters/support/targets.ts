import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * How the conformance suite reaches a target: an in-process fetch function (the emitted module is
 * imported), or a real runtime started as a child process on a free port.
 */

/** A target: a base URL and a way to send one request. */
export interface Target {
  readonly name: string;
  /** The origin requests are sent to (`http://localhost` for in-process targets). */
  readonly base: string;
  /** True when the target serves the client folder itself (a runtime server, not a function). */
  readonly servesStatic: boolean;
  call(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/** Ports {@link freePort} already returned in this process (a few hundred at most per run, so the set needs no cap). */
const handedOut = new Set<number>();

/** Whether a server can listen on `port` on the loopback address right now. */
function canListen(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

/** A TCP port that was free a moment ago on 127.0.0.1, picked at random below the ephemeral range. */
export async function freePort(): Promise<number> {
  // Port 0 hands out the next ephemeral port, the same pool every outbound socket draws from, so a parallel suite
  // (or a fetch) often takes it between this probe and the server's listen. A random port below the ephemeral
  // range, never handed out twice by this process, makes that collision rare instead of routine.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 25_000);
    if (handedOut.has(port)) continue;
    if (await canListen(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error("freePort: no free port found in 64 attempts between 20000 and 45000");
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Starts an emitted `server.mjs` in this process: sets the `PORT` and `HOST` it reads, imports it, and puts the process back as it
 * found it. The module keeps no handle to close its server, and its server registers stop-signal listeners; leaving those behind
 * made a worker that starts eleven of them warn of a leak. The server itself keeps answering until the worker ends.
 * @param file Absolute path of the emitted `server.mjs`.
 * @param port The port it listens on.
 */
export async function importEmittedServer(file: string, port: number): Promise<void> {
  const env = { PORT: process.env["PORT"], HOST: process.env["HOST"] };
  const known = STOP_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))] as const);
  process.env["PORT"] = String(port);
  process.env["HOST"] = "127.0.0.1";
  try {
    await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [signal, before] of known) {
      for (const listener of process.listeners(signal)) {
        if (!before.has(listener)) process.off(signal, listener);
      }
    }
  }
}

/** Polls a URL until it answers, or throws after `timeoutMs`. */
export async function waitForHttp(
  url: string,
  timeoutMs: number,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`no answer from ${url} within ${timeoutMs} ms (${String(last)})\n${output()}`);
}

/**
 * Runs a child process and collects its output for diagnostics. With `ownGroup` the child leads
 * its own process group (POSIX), so `stopChild` can also end what it started: `wrangler dev`
 * leaves the workerd runtime running when only wrangler is stopped.
 */
export function startChild(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; ownGroup?: boolean },
): { child: ChildProcess; output(): string } {
  const chunks: string[] = [];
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: options.ownGroup === true && process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return { child, output: () => chunks.join("").slice(-4000) };
}

/** Signals a child, and its whole process group when it leads one (`ownGroup`). */
function signalChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  const pid = child.pid;
  if (group && pid !== undefined) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // ESRCH: the group is already gone.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  child.kill(signal);
}

/**
 * Stops a child process: SIGTERM, then SIGKILL after two seconds. With `ownGroup` the signals go
 * to the whole process group, and the group gets the final SIGKILL even when the child exited.
 */
export async function stopChild(
  child: ChildProcess,
  options: { ownGroup?: boolean } = {},
): Promise<void> {
  const group = options.ownGroup === true;
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (!alreadyExited) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signalChild(child, "SIGTERM", group);
    const timer = setTimeout(() => signalChild(child, "SIGKILL", group), 2000);
    await exited;
    clearTimeout(timer);
  }
  // wrangler exits on SIGTERM but can leave workerd behind: end whatever is left in the group.
  if (group) signalChild(child, "SIGKILL", true);
}

/**
 * An in-process target over a module's default export `{ fetch(request, ...rest) }` or a function.
 * @param name Target name.
 * @param call How to send one request.
 */
export function inProcess(name: string, call: (request: Request) => Promise<Response>): Target {
  return {
    name,
    base: "http://localhost",
    servesStatic: false,
    call,
    close: async () => undefined,
  };
}

/** Writes `tsconfig.json` in a fixture so Bun resolves `@shadow-js/dusk/*` to the sources. */
export function writeSourceTsconfig(
  root: string,
  packagesDir: string,
  subpaths: readonly string[],
): void {
  const paths: Record<string, string[]> = {};
  for (const subpath of subpaths) {
    paths[`@shadow-js/dusk/${subpath}`] = [join(packagesDir, "dusk", "src", subpath, "index.ts")];
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", paths } }, null, 2)}\n`,
  );
}

/** Whether a program runs and exits 0 with `--version` (so it is installed and usable). */
export function runsOnPath(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 15_000 });
  return result.status === 0;
}

/** Whether `bun` runs here. Tests that need it are skipped, with the reason printed, otherwise. */
export const bunAvailable = (): boolean => runsOnPath("bun");

/** Whether `deno` runs here. */
export const denoAvailable = (): boolean => runsOnPath("deno");
