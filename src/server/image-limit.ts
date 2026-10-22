/**
 * A cap on the image sources in flight, kept per endpoint (the closure of one `createImageRoute`, so there is no module
 * state). Each request with a new URL reads its source again, up to `maxSourceBytes` each, so many slow sources would hold
 * memory and sockets without it.
 */

/** Limits of {@link createFetchLimiter}. */
export interface FetchLimits {
  /** Source reads in flight at the same time, over all clients. */
  readonly global: number;
  /** Source reads in flight for one client key. */
  readonly perClient: number;
}

/**
 * Hands out permits. `acquire` returns a release function, or the reason it refused: `"global"` (the endpoint is full)
 * or `"client"` (this client has its share in flight).
 */
export interface FetchLimiter {
  acquire(client: string | undefined): (() => void) | "global" | "client";
  /** Permits out right now. */
  readonly active: number;
  /** Client keys with a permit out. Never more than `limits.global`: an entry leaves with its last permit. */
  readonly clients: number;
}

/**
 * Creates a limiter. The per-client map holds only clients that have a permit out and a permit is counted in the global
 * total first, so the map has at most `limits.global` entries however many distinct clients ask. A request without a client
 * address is held to the global cap only (it has no bucket of its own to share with strangers).
 *
 * @param limits The two caps.
 * @returns The limiter.
 * @internal
 */
export function createFetchLimiter(limits: FetchLimits): FetchLimiter {
  const perClient = new Map<string, number>();
  let active = 0;
  return {
    get active(): number {
      return active;
    },
    get clients(): number {
      return perClient.size;
    },
    acquire(client): (() => void) | "global" | "client" {
      if (active >= limits.global) return "global";
      if (client !== undefined && (perClient.get(client) ?? 0) >= limits.perClient) return "client";
      active += 1;
      if (client !== undefined) perClient.set(client, (perClient.get(client) ?? 0) + 1);
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        active -= 1;
        if (client === undefined) return;
        const left = (perClient.get(client) ?? 1) - 1;
        if (left > 0) perClient.set(client, left);
        else perClient.delete(client);
      };
    },
  };
}
