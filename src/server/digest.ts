/**
 * Error digests: a short code for one unexpected error. The error UI the page shows (`error.digest`) and the server's
 * log line both carry it, so a user's report can be matched to the log.
 *
 * It is a keyed hash (32 bits, 8 hexadecimal characters) of the name, message and stack of the error's root cause
 * (following `cause` a bounded number of times). The key is random for each process and is never sent or logged, so
 * the digest reveals nothing about the message and nobody outside the process can test a guessed message against it.
 * It is for correlation only: a short code, not a cryptographic commitment and not a secret. It is synchronous, since
 * a route's error UI is rendered synchronously.
 * @internal
 */

/**
 * The key of this process: a random 32-bit word, drawn at the first digest (not when the module loads: a Worker may not
 * generate random values outside a request, so a module that does it at import fails to start).
 */
let key: number | undefined;

/** One random 32-bit word, from the platform's generator. */
function drawKey(): number {
  const words = new Uint32Array(1);
  globalThis.crypto.getRandomValues(words);
  return words[0] ?? 0;
}

/**
 * A data property of a thrown value, found on the value or its prototypes; undefined for an accessor or an absent
 * key. Read through the descriptor, so no getter runs: the digest is computed inside the error path, and a getter
 * or a `toString` the application wrote would throw there and replace the error being answered.
 */
function dataProperty(value: object, key: string): unknown {
  let at: object | null = value;
  for (let depth = 0; at !== null && depth < 64; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(at, key);
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
    at = Object.getPrototypeOf(at) as object | null;
  }
  return undefined;
}

/** The text of a thrown value that is not an error: a primitive's own text, or a fixed phrase for an object. */
function textOfOther(value: unknown): string {
  if (typeof value === "object" || typeof value === "function") return "[object]";
  return String(value);
}

/**
 * The digest of an error: 8 hexadecimal characters, the same for the same error in one process.
 *
 * @param error Any thrown value.
 * @returns The digest.
 * @example
 * const digest = errorDigest(new Error("db down")); // e.g. "3f2a9c01"
 * @internal
 */
export function errorDigest(error: unknown): string {
  let root: unknown = error;
  // Bounded: a cyclic chain of causes ends after eight links.
  for (let depth = 0; depth < 8 && root instanceof Error; depth += 1) {
    const cause = dataProperty(root, "cause");
    if (cause === undefined) break;
    root = cause;
  }
  let text: string;
  if (root instanceof Error) {
    const name = dataProperty(root, "name");
    const message = dataProperty(root, "message");
    const stack = dataProperty(root, "stack");
    text = `${typeof name === "string" ? name : ""}\n${typeof message === "string" ? message : ""}\n${typeof stack === "string" ? stack : ""}`;
  } else {
    text = textOfOther(root);
  }
  // 32-bit FNV-1a, started from the key.
  key ??= drawKey();
  let hash = key;
  for (let at = 0; at < text.length; at += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Gives a development error its digest: the original error is returned (it keeps its message), with the `digest` the
 * production page would show for it, so the error UI and the log line name the same code. The digest is taken once: an
 * error that already has one keeps it (the dev server rewrites the stack the digest hashes when it reports the error, so
 * a second computation would name another code). It is computed here, on the server, because the dev server's plugin
 * is a separate bundle with its own key. An error that cannot take the property (not an object, or not extensible, or
 * with a fixed `digest`) is returned as it is.
 *
 * @param error Any thrown value.
 * @returns The same value.
 * @internal
 */
export function attachDigest(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !Object.isExtensible(error)) return error;
  const own = Object.getOwnPropertyDescriptor(error, "digest");
  if (own !== undefined && (typeof own.value === "string" || !own.configurable)) return error;
  return Object.defineProperty(error, "digest", {
    value: errorDigest(error),
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
