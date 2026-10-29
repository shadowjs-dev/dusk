import cluster, { type Worker } from "node:cluster";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { WORKER_COUNT_ENV, WORKER_HEADER_ENV, WORKER_ID_ENV } from "../shared/worker-info";
import type { DrainMessage } from "./cluster-worker";
import type { ServeOptions, ServerHandle, SignalTarget } from "./serve";
import { resolveWorkerCount } from "./worker-count";

/**
 * The primary of a worker pool: forks the workers with `node:cluster`, waits until each is listening, replaces a worker
 * that dies (with a growing delay, and a breaker for a crash loop), replaces them one by one on request without a gap
 * (a rolling restart), and stops them gracefully. The primary serves no request itself.
 *
 * @packageDocumentation
 */

/** Settings of the supervision of a worker pool. @since 1.0.0 */
export interface SuperviseOptions {
  /** Delay before the first replacement of a crashed worker, in milliseconds; it doubles for each crash in a row. Default 500. */
  readonly restartBackoffMs?: number;
  /** Longest delay before a replacement, in milliseconds. Default 30 000. */
  readonly maxRestartBackoffMs?: number;
  /** Crashes within `crashWindowMs` that stop the pool (the crash-loop breaker). Default 5. */
  readonly maxCrashes?: number;
  /** The window of the breaker, in milliseconds. Also how long a worker must stay up before its crashes are forgiven. Default 30 000. */
  readonly crashWindowMs?: number;
  /** How long a worker may take to start listening before it is killed, in milliseconds. Default 30 000. */
  readonly readyTimeoutMs?: number;
  /**
   * The signal that starts a rolling restart. Default `"SIGUSR2"`; `false` registers none. Windows has no such signal:
   * call {@link PoolControl.restart} there.
   */
  readonly restartSignal?: false | string;
  /** Receives the primary's messages (a worker died, a restart ended, a warning). Default: `console.error` with a `[dusk]` prefix. */
  readonly log?: (message: string) => void;
}

/** Options of the worker pool's primary (`serve` passes its own). @internal */
export interface PoolOptions
  extends Pick<
    ServeOptions,
    | "port"
    | "host"
    | "workers"
    | "gracefulShutdownMs"
    | "shutdownSignals"
    | "signalTarget"
    | "exitOnSignal"
    | "exit"
    | "supervise"
  > {
  /** `"https"` when the workers serve TLS; only used for `ServerHandle.url`. Default `"http"`. */
  readonly scheme?: "http" | "https";
  /**
   * Send the `x-dusk-worker` response header (the id of the worker that answered). Default: when `NODE_ENV` is not
   * `"production"`, so a developer sees which worker answered and a production response carries no extra header.
   */
  readonly workerHeader?: boolean;
  /** After the breaker trips, call `exit(1)`. Default `true`; a caller that reports the failure itself passes `false`. */
  readonly exitOnFailure?: boolean;
}

/** What the primary of a worker pool can do, on `ServerHandle.pool`. @since 1.0.0 */
export interface PoolControl {
  /** How many workers the pool keeps. */
  readonly workers: number;
  /** The process ids of the workers that are listening now. */
  pids(): readonly number[];
  /**
   * Replaces the workers one by one: a new worker starts and must be listening before the old one drains, so the
   * pool never has fewer than `workers` serving. Stops (and leaves the old workers serving) if a new worker fails to start.
   * What `SIGUSR2` does. A call while one is running returns the running one.
   * @throws Error when the pool is stopping, or a new worker fails to start.
   */
  restart(): Promise<void>;
  /** Resolves with the reason when the crash-loop breaker stops the pool. Never resolves otherwise, and never rejects. */
  readonly failed: Promise<Error>;
}

/** Longest the primary waits for a worker to leave after the graceful period, before it kills it. */
const KILL_GRACE_MS = 5000;

interface Member {
  readonly id: number;
  readonly worker: Worker;
  /** Started by a rolling restart: its death does not bring a replacement (the restart stops instead). */
  readonly surge: boolean;
  readonly startedAt: number;
  phase: "starting" | "ready" | "draining";
  readyAt: number | undefined;
  /** The worker began to stop on its own (a signal sent to it directly). */
  selfRetired: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly ready: Promise<void>;
  readonly gone: Promise<void>;
}

let active = false;

function describeExit(code: number | null, signal: string | null): string {
  return signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
}

/**
 * True for the errors a call to a worker raises because the worker has already left: no such process, or a channel that is
 * closed. Those are not worth a line; any other error is.
 *
 * @internal
 */
export function isWorkerGone(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return code === "ESRCH" || code === "ERR_IPC_DISCONNECTED" || code === "ERR_IPC_CHANNEL_CLOSED";
}

/** Fails with the error of `listen` when the port cannot be bound; the workers would each fail the same way. */
function probePort(port: number, host: string): Promise<void> {
  if (port === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve());
    });
  });
}

/**
 * Starts a pool of workers that share one port and supervises them. Each worker is a copy of this program (`node:cluster`
 * runs the same entry file), so the program must call `serve()` or be started with `dusk start`; the primary serves nothing.
 * It resolves once every worker is listening.
 *
 * - A worker that dies is replaced after a delay that doubles with each crash in a row (up to 30 s); 5 crashes within
 *   30 s stop the pool with a message and exit code 1.
 * - A worker that dies before the pool was ever ready fails the start at once.
 * - `SIGUSR2` replaces the workers one by one, each new one listening before its predecessor drains.
 * - `SIGTERM` and `SIGINT` stop accepting, let requests in flight finish for up to `gracefulShutdownMs`, and exit 0.
 *
 * `serve({ workers })` calls this; `dusk start --workers` calls it without loading the app in the primary.
 *
 * @param options The worker count, the address to check, shutdown and supervision settings.
 * @returns The primary's handle: `role` is `"primary"`, `pool` controls the workers, and `server` is a server that does not listen (the workers do).
 * @throws Error when called in a worker, or twice in one process, or when a worker fails to start.
 * @throws RangeError for an invalid `workers`.
 * @internal
 */
export async function superviseWorkers(options: PoolOptions): Promise<ServerHandle> {
  const count = resolveWorkerCount(options.workers);
  if (!cluster.isPrimary)
    throw new Error("a worker pool can only be started by the primary process.");
  if (active) throw new Error("a worker pool already runs in this process.");
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const gracefulMs = options.gracefulShutdownMs ?? 10_000;
  const settings = options.supervise ?? {};
  const baseBackoff = settings.restartBackoffMs ?? 500;
  const maxBackoff = settings.maxRestartBackoffMs ?? 30_000;
  const maxCrashes = settings.maxCrashes ?? 5;
  const crashWindow = settings.crashWindowMs ?? 30_000;
  const readyTimeout = settings.readyTimeoutMs ?? 30_000;
  const log = settings.log ?? ((message: string): void => console.error(`[dusk] ${message}`));
  const sendWorkerHeader = options.workerHeader ?? process.env["NODE_ENV"] !== "production";
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  for (const [name, value] of [
    ["restartBackoffMs", baseBackoff],
    ["maxRestartBackoffMs", maxBackoff],
    ["maxCrashes", maxCrashes],
    ["crashWindowMs", crashWindow],
    ["readyTimeoutMs", readyTimeout],
  ] as const) {
    if (!Number.isFinite(value) || value < 1) {
      throw new RangeError(`supervise.${name} must be a positive number.`);
    }
  }

  await probePort(requestedPort, host);
  active = true;

  const members = new Map<number, Member>();
  const respawns = new Set<ReturnType<typeof setTimeout>>();
  const crashes: number[] = [];
  const warned = new Set<string>();
  let lastId = 0;
  let consecutive = 0;
  let listeningPort = requestedPort;
  let started = false;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
  let resolveFailed: (error: Error) => void = () => undefined;
  const failed = new Promise<Error>((resolve) => {
    resolveFailed = resolve;
  });

  const spawnMember = (surge: boolean): Member => {
    lastId += 1;
    const id = lastId;
    const worker = cluster.fork({
      [WORKER_ID_ENV]: String(id),
      [WORKER_COUNT_ENV]: String(count),
      [WORKER_HEADER_ENV]: sendWorkerHeader ? "1" : "0",
    });
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    let resolveGone: () => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A start that nobody awaits (a replacement) must not be an unhandled rejection.
    ready.catch(() => undefined);
    const gone = new Promise<void>((resolve) => {
      resolveGone = resolve;
    });
    const member: Member = {
      id,
      worker,
      surge,
      startedAt: Date.now(),
      phase: "starting",
      readyAt: undefined,
      selfRetired: false,
      timer: setTimeout(() => {
        log(`worker ${id} did not start listening within ${readyTimeout} ms; killing it.`);
        killWorker(member);
      }, readyTimeout),
      ready,
      gone,
    };
    members.set(id, member);
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    worker.on("listening", (address) => {
      if (member.phase !== "starting") return;
      member.phase = "ready";
      member.readyAt = Date.now();
      clearTimeout(member.timer);
      member.timer = undefined;
      if (typeof address.port === "number") listeningPort = address.port;
      resolveReady();
    });
    worker.on("message", (message: unknown) => onMessage(member, message));
    worker.on("error", (error) => log(`worker ${id}: ${error.message}`));
    worker.on("disconnect", () => {
      // A worker that cut its channel while it still runs can no longer be told to drain: end it, and it is replaced.
      if (member.phase === "draining" || stopping) return;
      log(`worker ${id} disconnected from the primary; ending it.`);
      signalWorker(member, "SIGTERM");
      disconnectTimer = setTimeout(() => killWorker(member), gracefulMs + KILL_GRACE_MS);
      disconnectTimer.unref();
    });
    worker.once("exit", (code, signal) => {
      clearTimeout(member.timer);
      clearTimeout(disconnectTimer);
      members.delete(id);
      const how = describeExit(code, signal);
      if (member.phase === "starting") {
        rejectReady(new Error(`worker ${id} exited before it was ready (${how}).`));
      }
      const previous = member.phase;
      resolveGone();
      onExit(member, previous, how);
    });
    return member;
  };

  const signalWorker = (member: Member, signal: NodeJS.Signals): void => {
    try {
      member.worker.process.kill(signal);
    } catch (error) {
      // A worker that is already gone is the expected case; anything else (a bad signal, a permission) is said aloud.
      if (!isWorkerGone(error))
        log(`worker ${member.id}: could not send ${signal}: ${String(error)}`);
    }
  };
  const killWorker = (member: Member): void => signalWorker(member, "SIGKILL");

  function onMessage(member: Member, message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const kind: unknown = Reflect.get(message, "dusk");
    if (kind === "stopping") {
      if (member.phase !== "draining") member.selfRetired = true;
      member.phase = "draining";
      return;
    }
    if (kind === "stores") {
      const labels: unknown = Reflect.get(message, "labels");
      if (!Array.isArray(labels)) return;
      for (const label of labels) {
        if (typeof label !== "string" || warned.has(label)) continue;
        warned.add(label);
        log(
          `warning: with ${count} workers, ${label} keeps its entries in the memory of each worker, so a page revalidated or a tag invalidated in one worker is not seen by the others. Use a shared store (see "Shared storage" in the Dusk deploy guide).`,
        );
      }
    }
  }

  function onExit(member: Member, phase: Member["phase"], how: string): void {
    if (stopping) return;
    if (phase === "draining") {
      if (member.selfRetired) {
        log(`worker ${member.id} stopped on its own (${how}); starting a replacement.`);
        spawnMember(false);
      }
      return;
    }
    if (!started) return; // the start reports it through the worker's `ready`
    const now = Date.now();
    log(`worker ${member.id} exited unexpectedly (${how}).`);
    while (crashes.length > 0 && now - (crashes[0] ?? now) >= crashWindow) crashes.shift();
    crashes.push(now);
    if (crashes.length >= maxCrashes) {
      fail(
        new Error(
          `crash loop: ${crashes.length} workers crashed within ${crashWindow / 1000} s (the last: worker ${member.id}, ${how}). Not restarting workers. Fix the cause; the output of the workers is above.`,
        ),
      );
      return;
    }
    if (member.surge) return; // a rolling restart saw it die before it was ready and stops
    // A worker that ran for a whole window was healthy: the next crash starts the delay from the beginning.
    if (member.readyAt !== undefined && now - member.readyAt >= crashWindow) consecutive = 0;
    const delay = Math.min(maxBackoff, baseBackoff * 2 ** Math.min(consecutive, 30));
    consecutive += 1;
    const timer = setTimeout(() => {
      respawns.delete(timer);
      if (!stopping) spawnMember(false);
    }, delay);
    respawns.add(timer);
  }

  function fail(error: Error): void {
    if (stopping) return;
    log(error.message);
    resolveFailed(error);
    void close().then(() => {
      if (options.exitOnFailure !== false) exit(1);
    });
  }

  /** Asks a worker to drain and waits for it to leave; kills it when it takes longer than the graceful period. */
  const retire = async (member: Member): Promise<void> => {
    if (member.phase === "starting") {
      killWorker(member);
      await member.gone;
      return;
    }
    member.phase = "draining";
    // The primary stops handing this worker connections before the worker closes its listener: the worker's own close
    // reaches the primary later, and a connection handed over in between is lost without an answer. The worker answers
    // this with its soft shutdown (see `serve`), so idle connections are not cut.
    try {
      member.worker.disconnect();
    } catch (error) {
      // The worker is already gone: the drain message below fails the same way and the kill follows.
      if (!isWorkerGone(error)) log(`worker ${member.id}: could not disconnect: ${String(error)}`);
    }
    const message: DrainMessage = { dusk: "drain" };
    try {
      member.worker.send(message, (error) => {
        if (error !== null) signalWorker(member, "SIGTERM");
      });
    } catch (error) {
      if (!isWorkerGone(error))
        log(`worker ${member.id}: could not send the drain message: ${String(error)}`);
      signalWorker(member, "SIGTERM");
    }
    const timer = setTimeout(() => {
      log(`worker ${member.id} did not stop within ${gracefulMs} ms; killing it.`);
      killWorker(member);
    }, gracefulMs + KILL_GRACE_MS);
    await member.gone;
    clearTimeout(timer);
  };

  const target = options.shutdownSignals === false ? undefined : (options.signalTarget ?? process);
  const signals =
    options.shutdownSignals === false ? [] : (options.shutdownSignals ?? ["SIGTERM", "SIGINT"]);
  const registered: Array<readonly [SignalTarget, string, () => void]> = [];
  const unregister = (): void => {
    for (const [from, signal, listener] of registered) from.off(signal, listener);
    registered.length = 0;
  };

  function close(): Promise<void> {
    closing ??= (async () => {
      stopping = true;
      for (const timer of respawns) clearTimeout(timer);
      respawns.clear();
      unregister();
      await Promise.all([...members.values()].map((member) => retire(member)));
      active = false;
    })();
    return closing;
  }

  const restart = (): Promise<void> => {
    if (stopping) return Promise.reject(new Error("the pool is stopping."));
    restarting ??= (async () => {
      const olds = [...members.values()].filter((member) => member.phase === "ready");
      log(`rolling restart: replacing ${olds.length} workers.`);
      try {
        for (const old of olds) {
          if (stopping) return;
          if (!members.has(old.id) || old.phase !== "ready") continue;
          const fresh = spawnMember(true);
          try {
            await fresh.ready;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            killWorker(fresh);
            log(`rolling restart stopped: ${reason} The old workers keep serving.`);
            throw new Error(`rolling restart stopped: ${reason}`);
          }
          await retire(old);
        }
        log("rolling restart finished.");
      } finally {
        restarting = undefined;
      }
    })();
    return restarting;
  };

  if (target !== undefined) {
    for (const signal of signals) {
      const onSignal = (): void => {
        close()
          .then(() => {
            if (options.exitOnSignal !== false) exit(0);
          })
          .catch((error: unknown) => log(`shutdown failed: ${String(error)}`));
      };
      registered.push([target, signal, onSignal]);
      target.once(signal, onSignal);
    }
  }
  // The restart signal does not depend on the shutdown signals: `dusk start` handles those itself and still restarts on this one.
  const restartTarget = options.signalTarget ?? process;
  const restartSignal = settings.restartSignal === undefined ? "SIGUSR2" : settings.restartSignal;
  if (restartSignal !== false && process.platform !== "win32") {
    const onRestart = (): void => {
      // The listener is armed again at once: a second signal while one restart runs must not end the process.
      restartTarget.once(restartSignal, onRestart);
      restart().catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith("rolling restart")) {
          log(`rolling restart failed: ${String(error)}`);
        }
      });
    };
    registered.push([restartTarget, restartSignal, onRestart]);
    restartTarget.once(restartSignal, onRestart);
  }

  const initial = Array.from({ length: count }, () => spawnMember(false));
  try {
    await Promise.all(initial.map((member) => member.ready));
  } catch (error) {
    stopping = true;
    unregister();
    for (const member of members.values()) killWorker(member);
    await Promise.all(initial.map((member) => member.gone));
    active = false;
    throw error;
  }
  started = true;

  const scheme = options.scheme ?? "http";
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    role: "primary",
    port: listeningPort,
    host,
    url: `${scheme}://${shownHost}:${listeningPort}`,
    // The primary has no connections of its own: the workers hold them.
    server: createHttpServer(),
    get draining() {
      return stopping;
    },
    droppedConnections: 0,
    droppedSlowClients: 0,
    close,
    pool: {
      workers: count,
      pids() {
        return [...members.values()]
          .filter((member) => member.phase === "ready" && member.worker.process.pid !== undefined)
          .map((member) => member.worker.process.pid ?? 0);
      },
      restart,
      failed,
    },
  };
}
