/**
 * WebSocket framing (RFC 6455), without any runtime API: a streaming reader for the frames a client
 * sends and an encoder for the frames the server sends. No extensions are negotiated, so reserved bits
 * must be zero. The reader enforces the protocol's own rules (masking, control frames, fragmentation,
 * UTF-8) and a message size limit, and reports each violation with the close code the RFC prescribes.
 */

/** Close codes the server uses (RFC 6455 section 7.4.1). @since 1.0.0 */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED: 1003,
  NO_STATUS: 1005,
  ABNORMAL: 1006,
  INVALID_DATA: 1007,
  POLICY: 1008,
  TOO_BIG: 1009,
  EXTENSION: 1010,
  INTERNAL: 1011,
  /** The server cannot take more now (1013): the client may reconnect later. */
  TRY_AGAIN_LATER: 1013,
} as const;

/** A protocol violation: the connection is closed with `code`. @since 1.0.0 */
export class WebSocketProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "WebSocketProtocolError";
    this.code = code;
  }
}

/** One thing a client sent. A message is whole: fragments are joined. @since 1.0.0 */
export type WsEvent =
  | { readonly kind: "text"; readonly data: Uint8Array }
  | { readonly kind: "binary"; readonly data: Uint8Array }
  | { readonly kind: "ping"; readonly data: Uint8Array }
  | { readonly kind: "pong"; readonly data: Uint8Array }
  | { readonly kind: "close"; readonly code: number; readonly reason: string };

/** Options of a {@link FrameReader}. @since 1.0.0 */
export interface FrameReaderOptions {
  /** Largest message (after joining fragments), in bytes. Larger is 1009. */
  readonly maxMessageBytes: number;
  /** Clients must mask their frames (RFC 6455 section 5.1). True for a server. */
  readonly requireMask: boolean;
}

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** The size above which an emptied read buffer is released instead of kept for the next frame. */
const RETAINED_BUFFER_BYTES = 64 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Close codes a peer may send (RFC 6455 section 7.4.2). */
function isSendableCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014 && code !== 1012 && code !== 1013) ||
    (code >= 3000 && code <= 4999)
  );
}

/**
 * Reads the frames a peer sends. Feed it the bytes as they arrive; it returns the events they complete
 * and keeps the rest. A violation throws a {@link WebSocketProtocolError}; the reader must not be used
 * after that.
 *
 * @example
 * const reader = new FrameReader({ maxMessageBytes: 1 << 20, requireMask: true });
 * for (const event of reader.push(chunk)) if (event.kind === "text") handle(event.data);
 * @since 1.0.0
 */
export class FrameReader {
  readonly #options: FrameReaderOptions;
  /**
   * The bytes received and not yet taken as a frame live in this one buffer, from `#start` to `#end`. Chunks are copied
   * into it as they arrive (it grows by doubling, so the copying is linear in the bytes received) and are not kept: a peer
   * that sends a frame a byte at a time costs the frame's size, not a chunk object per byte.
   */
  #buffer: Uint8Array = new Uint8Array(0);
  #start = 0;
  #end = 0;
  /** The number of buffered bytes the frame in progress needs before it can be read. */
  #need = 0;
  /** Fragments of the data message in progress, and its opcode. */
  #fragments: Uint8Array[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode: number | undefined;

  constructor(options: FrameReaderOptions) {
    this.#options = options;
  }

  /** Bytes received that no event has used yet. */
  get bufferedBytes(): number {
    return this.#end - this.#start;
  }

  /**
   * Adds bytes and returns the events they complete, in order.
   * @throws WebSocketProtocolError for a violation (the close code is in `code`).
   */
  push(chunk: Uint8Array): WsEvent[] {
    if (chunk.byteLength > 0) this.#append(chunk);
    if (this.#end - this.#start < this.#need) return [];
    const events: WsEvent[] = [];
    for (;;) {
      const frame = this.#takeFrame();
      if (frame === undefined) break;
      const event = this.#accept(frame);
      if (event !== undefined) events.push(event);
    }
    // Nothing is waiting: a large buffer a past frame needed is let go, so an idle connection holds no megabytes.
    if (this.#start === this.#end && this.#buffer.byteLength > RETAINED_BUFFER_BYTES) {
      this.#buffer = new Uint8Array(0);
      this.#start = 0;
      this.#end = 0;
    }
    return events;
  }

  /** Copies a chunk behind the buffered bytes, making room first (compacting, or doubling the buffer). */
  #append(chunk: Uint8Array): void {
    const used = this.#end - this.#start;
    if (this.#end + chunk.byteLength > this.#buffer.byteLength) {
      const needed = used + chunk.byteLength;
      const grown =
        needed > this.#buffer.byteLength
          ? new Uint8Array(Math.max(needed, this.#buffer.byteLength * 2, 64))
          : this.#buffer;
      grown.set(this.#buffer.subarray(this.#start, this.#end), 0);
      this.#buffer = grown;
      this.#start = 0;
      this.#end = used;
    }
    this.#buffer.set(chunk, this.#end);
    this.#end += chunk.byteLength;
  }

  /** Reads one complete frame from the buffer, or returns undefined when more bytes are needed. */
  #takeFrame(): { fin: boolean; opcode: number; payload: Uint8Array } | undefined {
    const buf = this.#buffer.subarray(this.#start, this.#end);
    if (buf.byteLength < 2) {
      this.#need = 2;
      return undefined;
    }
    const first = buf[0] ?? 0;
    const second = buf[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if (rsv !== 0)
      throw new WebSocketProtocolError(
        CLOSE.PROTOCOL_ERROR,
        "a reserved bit is set and no extension was negotiated",
      );
    if (
      !(
        opcode === OPCODE_CONTINUATION ||
        opcode === OPCODE_TEXT ||
        opcode === OPCODE_BINARY ||
        (opcode >= 0x8 && opcode <= 0xa)
      )
    ) {
      throw new WebSocketProtocolError(CLOSE.PROTOCOL_ERROR, `unknown opcode ${opcode}`);
    }
    if (this.#options.requireMask && !masked)
      throw new WebSocketProtocolError(CLOSE.PROTOCOL_ERROR, "a client frame must be masked");
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.byteLength < 4) {
        this.#need = 4;
        return undefined;
      }
      length = ((buf[2] ?? 0) << 8) | (buf[3] ?? 0);
      offset = 4;
    } else if (length === 127) {
      if (buf.byteLength < 10) {
        this.#need = 10;
        return undefined;
      }
      let big = 0;
      for (let index = 2; index < 10; index += 1) big = big * 256 + (buf[index] ?? 0);
      if (!Number.isSafeInteger(big))
        throw new WebSocketProtocolError(CLOSE.TOO_BIG, "frame too large");
      length = big;
      offset = 10;
    }
    if (opcode >= 0x8 && (length > 125 || !fin)) {
      throw new WebSocketProtocolError(
        CLOSE.PROTOCOL_ERROR,
        "a control frame must not be fragmented or longer than 125 bytes",
      );
    }
    // The size is judged from the header: an oversized message is refused before its bytes are buffered.
    if (opcode < 0x8 && length > this.#options.maxMessageBytes) {
      throw new WebSocketProtocolError(CLOSE.TOO_BIG, "message too big");
    }
    const maskLength = masked ? 4 : 0;
    const total = offset + maskLength + length;
    if (buf.byteLength < total) {
      this.#need = total;
      return undefined;
    }
    this.#need = 0;
    const key = masked ? buf.subarray(offset, offset + 4) : undefined;
    const payload = new Uint8Array(length);
    const start = offset + maskLength;
    for (let index = 0; index < length; index += 1) {
      const byte = buf[start + index] ?? 0;
      payload[index] = key === undefined ? byte : byte ^ (key[index % 4] ?? 0);
    }
    this.#start += total;
    return { fin, opcode, payload };
  }

  /** Applies one frame to the message state; returns the event it completes, if any. */
  #accept(frame: { fin: boolean; opcode: number; payload: Uint8Array }): WsEvent | undefined {
    const { fin, opcode, payload } = frame;
    if (opcode === OPCODE_PING) return { kind: "ping", data: payload };
    if (opcode === OPCODE_PONG) return { kind: "pong", data: payload };
    if (opcode === OPCODE_CLOSE) return closeEvent(payload);
    if (opcode === OPCODE_CONTINUATION) {
      if (this.#fragmentOpcode === undefined)
        throw new WebSocketProtocolError(
          CLOSE.PROTOCOL_ERROR,
          "a continuation frame without a message",
        );
    } else {
      if (this.#fragmentOpcode !== undefined)
        throw new WebSocketProtocolError(
          CLOSE.PROTOCOL_ERROR,
          "a new message began before the last one ended",
        );
      this.#fragmentOpcode = opcode;
    }
    this.#fragmentBytes += payload.byteLength;
    if (this.#fragmentBytes > this.#options.maxMessageBytes) {
      throw new WebSocketProtocolError(CLOSE.TOO_BIG, "message too big");
    }
    this.#fragments.push(payload);
    if (!fin) return undefined;
    const data = joinAll(this.#fragments, this.#fragmentBytes);
    const kind = this.#fragmentOpcode;
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#fragmentOpcode = undefined;
    if (kind === OPCODE_TEXT) {
      try {
        decoder.decode(data);
      } catch {
        throw new WebSocketProtocolError(CLOSE.INVALID_DATA, "a text message is not valid UTF-8");
      }
      return { kind: "text", data };
    }
    return { kind: "binary", data };
  }
}

/** A close frame's payload: an optional code, then a reason that must be UTF-8. */
function closeEvent(payload: Uint8Array): WsEvent {
  if (payload.byteLength === 1)
    throw new WebSocketProtocolError(CLOSE.PROTOCOL_ERROR, "a close frame has a one-byte payload");
  if (payload.byteLength === 0) return { kind: "close", code: CLOSE.NO_STATUS, reason: "" };
  const code = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
  if (!isSendableCode(code))
    throw new WebSocketProtocolError(CLOSE.PROTOCOL_ERROR, `close code ${code} must not be sent`);
  let reason: string;
  try {
    reason = decoder.decode(payload.subarray(2));
  } catch {
    throw new WebSocketProtocolError(CLOSE.INVALID_DATA, "the close reason is not valid UTF-8");
  }
  return { kind: "close", code, reason };
}

function joinAll(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** The kinds of frame the server sends. @since 1.0.0 */
export type OutgoingKind = "text" | "binary" | "ping" | "pong" | "close";

const OUTGOING_OPCODE: Record<OutgoingKind, number> = {
  text: OPCODE_TEXT,
  binary: OPCODE_BINARY,
  ping: OPCODE_PING,
  pong: OPCODE_PONG,
  close: OPCODE_CLOSE,
};

/**
 * Encodes one frame the server sends: a single final frame, unmasked, with the shortest length
 * encoding. Text payloads are the UTF-8 bytes of the string; the caller passes bytes.
 *
 * @param kind The frame kind.
 * @param payload The payload (at most 125 bytes for ping, pong and close).
 * @returns The frame bytes.
 * @throws RangeError for a control frame with a payload over 125 bytes.
 * @since 1.0.0
 */
export function encodeFrame(kind: OutgoingKind, payload: Uint8Array): Uint8Array {
  const control = kind === "ping" || kind === "pong" || kind === "close";
  if (control && payload.byteLength > 125)
    throw new RangeError("a control frame carries at most 125 bytes.");
  const n = payload.byteLength;
  const header = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = new Uint8Array(header + n);
  out[0] = 0x80 | OUTGOING_OPCODE[kind];
  if (n < 126) {
    out[1] = n;
  } else if (n < 65536) {
    out[1] = 126;
    out[2] = (n >> 8) & 0xff;
    out[3] = n & 0xff;
  } else {
    out[1] = 127;
    let rest = n;
    for (let index = 9; index >= 2; index -= 1) {
      out[index] = rest % 256;
      rest = Math.floor(rest / 256);
    }
  }
  out.set(payload, header);
  return out;
}

/**
 * The payload of a close frame: the code, then the reason as UTF-8.
 * @since 1.0.0
 */
export function closePayload(code: number, reason: string): Uint8Array {
  const text = encoder.encode(reason);
  const out = new Uint8Array(2 + text.byteLength);
  out[0] = (code >> 8) & 0xff;
  out[1] = code & 0xff;
  out.set(text, 2);
  return out;
}

/**
 * The `Sec-WebSocket-Accept` value for a client key: base64 of the SHA-1 of the key and the RFC's GUID.
 * @since 1.0.0
 */
export async function websocketAcceptKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    encoder.encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
