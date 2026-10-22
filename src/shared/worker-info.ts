/**
 * Which process of a multi-process server the code runs in, and the registry of stores that live in one process only.
 * Both are read by the Node server (`serve({ workers })`, `dusk start --workers`) and by any server code that needs to
 * know whether it shares memory with other workers. Nothing here imports a Node module, so it is safe in every bundle.
 *
 * @packageDocumentation
 */

/** Environment variable the primary sets in a worker: the worker's id (1, 2, ...). @internal */
export const WORKER_ID_ENV = "DUSK_WORKER_ID";
/** Environment variable the primary sets in a worker: how many workers the server runs. @internal */
export const WORKER_COUNT_ENV = "DUSK_WORKER_COUNT";

/** Environment variable the primary sets to `"1"` in a worker that should send the `x-dusk-worker` header. @internal */
export const WORKER_HEADER_ENV = "DUSK_WORKER_HEADER";

/**
 * The key of the registry of process-local stores on `globalThis`. A store that keeps its entries in the memory of one
 * process (an in-memory page cache, a data cache over a memory key-value store) adds a label to the set at this key when
 * it is created, so the primary of a worker pool can warn that each worker would hold its own copy.
 * @internal
 */
export const LOCAL_STORES_KEY: unique symbol = Symbol.for("shadow-js.dusk.process-local-stores");

/** What {@link workerInfo} reports. @since 1.0.0 */
export interface WorkerInfo {
  /** True in a worker started by `serve({ workers })` or `dusk start --workers`; false in a single process. */
  readonly clustered: boolean;
  /** The worker's id (1, 2, ...; a replacement gets a new id), or `undefined` in a single process. */
  readonly id: number | undefined;
  /** How many workers the server runs: 1 in a single process. */
  readonly count: number;
  /** The id of this process. */
  readonly pid: number;
}

interface ProcessLike {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pid: number;
  readonly send?: unknown;
}

function processOf(): ProcessLike | undefined {
  const candidate: unknown = (globalThis as { process?: unknown }).process;
  return typeof candidate === "object" && candidate !== null && "env" in candidate
    ? (candidate as ProcessLike)
    : undefined;
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^[1-9]\d{0,5}$/.test(text)) return undefined;
  return Number(text);
}

/**
 * Tells which process the caller runs in. In a worker of a pool (`serve({ workers })`, `dusk start --workers`) it reports the
 * worker's id and the size of the pool; in a single process it reports `clustered: false` and a count of 1. Use it to
 * keep state that must be shared out of a worker's memory, or to label logs.
 *
 * @returns The worker information.
 * @example
 * import { workerInfo } from "@shadow-js/dusk/node";
 * const { clustered, id, count } = workerInfo();
 * if (clustered) console.log(`worker ${id} of ${count}`);
 * @since 1.0.0
 */
export function workerInfo(): WorkerInfo {
  const proc = processOf();
  const id = positiveInteger(proc?.env[WORKER_ID_ENV]);
  const clustered = id !== undefined && typeof proc?.send === "function";
  return {
    clustered,
    id: clustered ? id : undefined,
    count: clustered ? (positiveInteger(proc?.env[WORKER_COUNT_ENV]) ?? 1) : 1,
    pid: proc?.pid ?? 0,
  };
}

/**
 * Records that a store keeps its entries in the memory of this process only. When the server runs several workers, the
 * primary prints one warning that names the label and points to the shared-storage section of the deploy guide.
 * Call it where the store is created; calling it again with the same label is harmless.
 *
 * @param label A short name for the store, for example `"isr page cache"`.
 * @example
 * import { markProcessLocalStore } from "@shadow-js/dusk/node";
 * markProcessLocalStore("my session map");
 * @since 1.0.0
 */
export function markProcessLocalStore(label: string): void {
  const holder = globalThis as { [LOCAL_STORES_KEY]?: Set<string> };
  const set = holder[LOCAL_STORES_KEY] ?? new Set<string>();
  holder[LOCAL_STORES_KEY] = set;
  set.add(label);
}

/**
 * The labels recorded with {@link markProcessLocalStore} in this process, in the order they were added.
 * @returns The labels.
 * @internal
 */
export function processLocalStores(): readonly string[] {
  const set = (globalThis as { [LOCAL_STORES_KEY]?: Set<string> })[LOCAL_STORES_KEY];
  return set === undefined ? [] : [...set];
}
