import { describe, expect, it } from "vitest";
import { boundRequest, DEFAULT_FORM_LIMITS } from "../src/server/limits";

/** The engine's garbage collector hook; the gc project always runs with --expose-gc. */
function exposedGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error("the gc project must run with --expose-gc");
  return gc;
}

/** Yields to the next job: a WeakRef target made in the current job stays alive until that job ends. */
function nextJob(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Makes the request a handler reads, the way a page's request is wired: a listener on its signal that reaches the request
 * itself (the page's dispose hook reaches the router, the event and so the request). Returns a WeakRef to the request. Made
 * here, not in the test body, so no slot of the caller's frame keeps it alive.
 */
function bind(count: number): WeakRef<Request>[] {
  const refs: WeakRef<Request>[] = [];
  for (let index = 0; index < count; index += 1) {
    const source = new AbortController();
    const copy = boundRequest(
      new Request("http://localhost/page"),
      { limit: 1024, form: DEFAULT_FORM_LIMITS },
      source.signal,
    );
    source.signal.addEventListener("abort", () => void copy.url);
    refs.push(new WeakRef(copy));
  }
  return refs;
}

/** Collects until `expected` targets are gone, at most 25 forced collections, each after a yield to the next job. */
async function collectUntil(
  gc: () => void,
  refs: readonly WeakRef<Request>[],
  expected: number,
): Promise<number> {
  let released = 0;
  for (let pass = 0; pass < 25 && released < expected; pass += 1) {
    await nextJob();
    gc();
    gc();
    released = refs.filter((ref) => ref.deref() === undefined).length;
  }
  return released;
}

describe("a bound request does not outlive the request it was made for", () => {
  /*
   * Node's fetch implementation (undici) keeps the signal given to `new Request` strongly, in a finalization registry, until
   * that request is collected. A page's request signal has listeners that reach the router, the event and so the request
   * itself: handing it on directly closed a cycle through that registry, and every streamed page stayed alive until the
   * process ended (the heap grew by 52 MB over three load passes of 1,000 connections). `boundRequest` hands on a signal
   * that follows the source and references nothing else.
   */
  it("[SIG-GC-1] a request whose signal has a listener that reaches the request is collected", async () => {
    const gc = exposedGc();
    const refs = bind(500);
    const released = await collectUntil(gc, refs, refs.length);
    expect(released, `${released} of ${refs.length} requests were collected`).toBe(refs.length);
  });
});
