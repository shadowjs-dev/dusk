import { addressKey } from "./client-address";

/**
 * Counting of the upgraded WebSocket connections of one handler: how many a client address holds, and how
 * many there are in all. The count is taken when an upgrade is decided (before any socket exists) and given
 * back when the connection ends or the transport abandons the decision, so a refused or failed upgrade never
 * keeps a slot.
 *
 * @packageDocumentation
 */

/** The caps of a {@link ConnectionTracker}; `false` is no cap. @internal */
export interface ConnectionCaps {
  /** Connections one client address (an IPv6 client by its /64) may hold. */
  readonly perAddress: number | false;
  /** Connections the handler may hold in all. */
  readonly total: number | false;
}

/** One counted connection. @internal */
export interface ConnectionSlot {
  /** Gives the slot back. Idempotent. */
  release(): void;
}

/** Counts connections against {@link ConnectionCaps}. @internal */
export interface ConnectionTracker {
  /**
   * Takes a slot for a client address, or returns `undefined` when a cap is reached. An unknown address
   * (`undefined`) is counted in the total only: one shared bucket would lock every such client out together.
   */
  acquire(address: string | undefined): ConnectionSlot | undefined;
  /** Connections counted now. */
  readonly open: number;
  /** Client addresses with at least one counted connection (the size of the bookkeeping). */
  readonly addresses: number;
}

/**
 * Makes a tracker. The per-address table holds only addresses that have a connection, and the total cap bounds
 * the connections, so the table never grows past the total cap.
 *
 * @param caps The caps.
 * @returns The tracker.
 * @internal
 */
export function createConnectionTracker(caps: ConnectionCaps): ConnectionTracker {
  const perAddress = new Map<string, number>();
  let open = 0;
  return {
    acquire(address) {
      if (caps.total !== false && open >= caps.total) return undefined;
      const key =
        address === undefined || caps.perAddress === false ? undefined : addressKey(address);
      if (key !== undefined && caps.perAddress !== false) {
        const held = perAddress.get(key) ?? 0;
        if (held >= caps.perAddress) return undefined;
        perAddress.set(key, held + 1);
      }
      open += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          open -= 1;
          if (key === undefined) return;
          const held = perAddress.get(key) ?? 0;
          if (held <= 1) perAddress.delete(key);
          else perAddress.set(key, held - 1);
        },
      };
    },
    get open() {
      return open;
    },
    get addresses() {
      return perAddress.size;
    },
  };
}
