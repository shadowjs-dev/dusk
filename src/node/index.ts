/**
 * `@shadow-js/dusk/node`: serve a handler with Node's `http` module. Streaming bodies both ways,
 * client-disconnect abort, static files with safe path resolution, content-hash caching, range
 * requests, brotli/gzip, and graceful shutdown.
 * @packageDocumentation
 */

export { markProcessLocalStore, type WorkerInfo, workerInfo } from "../shared/worker-info";
export { type NodeAdapterOptions, node } from "./adapter";
export type { PoolControl, SuperviseOptions } from "./cluster";
export { type CompressOptions, type Encoding, isCompressible, negotiateEncoding } from "./compress";
export { createFileKVStore, type FileKVStoreOptions } from "./kv-file";
export { type ServeOptions, type ServerHandle, type SignalTarget, serve } from "./serve";
export { type StaticOptions, safeSegments } from "./static-files";
