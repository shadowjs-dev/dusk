import { describe, expect, it } from "vitest";
import {
  type StartConnectionOptions,
  startWebSocket,
  type WebSocketSink,
} from "../src/server/websocket";
import { encodeFrame, FrameReader } from "../src/server/ws-protocol";

/** A masked client frame, as a browser sends it. */
function maskedFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const mask = [0x12, 0x34, 0x56, 0x78];
  let header: number[];
  if (payload.byteLength < 126) header = [0x80 | opcode, 0x80 | payload.byteLength];
  else if (payload.byteLength < 65536)
    header = [0x80 | opcode, 0x80 | 126, payload.byteLength >> 8, payload.byteLength & 0xff];
  else {
    const length = payload.byteLength;
    header = [
      0x80 | opcode,
      0x80 | 127,
      0,
      0,
      0,
      0,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ];
  }
  if (!fin) header[0] = (header[0] ?? 0) & 0x7f;
  const out = new Uint8Array(header.length + 4 + payload.byteLength);
  out.set(header, 0);
  out.set(mask, header.length);
  for (let index = 0; index < payload.byteLength; index += 1) {
    out[header.length + 4 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return out;
}

describe("SEC-15x WebSocket frames", () => {
  it("[SEC-150] a message declared over the limit is refused from its header, before its bytes are buffered", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    const header = new Uint8Array([
      0x82, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => reader.push(header)).toThrow();
  });

  it("[SEC-151] a message in fragments is refused once the fragments add up over the limit", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    const piece = new Uint8Array(400).fill(97);
    reader.push(maskedFrame(0x2, piece, false));
    reader.push(maskedFrame(0x0, piece, false));
    expect(() => reader.push(maskedFrame(0x0, piece, true))).toThrow();
  });

  it("[SEC-152] an unmasked client frame is a protocol error", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expect(() => reader.push(new Uint8Array([0x81, 0x01, 0x61]))).toThrow();
  });

  it("[SEC-153] a frame with a reserved bit set and no extension is a protocol error", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expect(() =>
      reader.push(
        maskedFrame(0x1, new Uint8Array([1])).map((byte, index) =>
          index === 0 ? byte | 0x40 : byte,
        ),
      ),
    ).toThrow();
  });

  it("[SEC-154] a frame that trickles in one byte at a time is decoded in linear time (no quadratic copying)", () => {
    // A 256 KiB message is well under the 1 MiB default limit; trickled byte by byte it must still decode fast.
    const size = 262_144;
    const frame = maskedFrame(0x2, new Uint8Array(size).fill(7));
    const reader = new FrameReader({ maxMessageBytes: 1 << 20, requireMask: true });
    const started = performance.now();
    let events = 0;
    for (const byte of frame) events += reader.push(new Uint8Array([byte])).length;
    const elapsed = performance.now() - started;
    expect(events).toBe(1);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("SEC-16x WebSocket connection limits", () => {
  function connection(maxMessagesPerSecond: number): {
    frames: Uint8Array[];
    ended: { value: boolean };
    input: ReturnType<typeof startWebSocket>;
  } {
    const frames: Uint8Array[] = [];
    const ended = { value: false };
    const sink: WebSocketSink = {
      write: (bytes) => void frames.push(bytes),
      end: () => {
        ended.value = true;
      },
    };
    const controller = new AbortController();
    const options: StartConnectionOptions = {
      handlers: {},
      event: { signal: controller.signal } as never,
      limits: {
        maxMessageBytes: 1024,
        maxMessagesPerSecond,
        pingIntervalMs: 3_600_000,
        pongTimeoutMs: 3_600_000,
      },
      sink,
      report: () => undefined,
      data: {},
    } as StartConnectionOptions;
    return { frames, ended, input: startWebSocket(options) };
  }

  it("[SEC-160] a flood of ping frames is held to the message rate: the peer is closed with 1008 instead of answered forever", () => {
    const { frames, ended, input } = connection(10);
    const flood = new Uint8Array(0);
    const pings: Uint8Array[] = [];
    for (let index = 0; index < 500; index += 1) pings.push(maskedFrame(0x9, flood));
    const total = pings.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of pings) {
      joined.set(part, at);
      at += part.byteLength;
    }
    input.push(joined);
    const pongs = frames.filter((frame) => frame[0] === 0x8a).length;
    const closes = frames.filter((frame) => frame[0] === 0x88);
    expect(pongs).toBeLessThanOrEqual(10);
    expect(closes.length).toBe(1);
    expect(ended.value).toBe(true);
  });

  it("[SEC-161] text messages over the rate limit close the connection with 1008 (policy)", () => {
    const { frames, input } = connection(3);
    const parts: Uint8Array[] = [];
    for (let index = 0; index < 5; index += 1)
      parts.push(maskedFrame(0x1, new TextEncoder().encode("hi")));
    input.push(
      parts.reduce((joined, part) => {
        const next = new Uint8Array(joined.byteLength + part.byteLength);
        next.set(joined, 0);
        next.set(part, joined.byteLength);
        return next;
      }, new Uint8Array(0)),
    );
    const close = frames.find((frame) => frame[0] === 0x88);
    expect(close).toBeDefined();
    expect(((close?.[2] ?? 0) << 8) | (close?.[3] ?? 0)).toBe(1008);
  });

  it("[SEC-162] an encoded server frame is a plain frame the peer can decode (no mask on server frames)", () => {
    const frame = encodeFrame("text", new TextEncoder().encode("ok"));
    expect(frame[1] ?? 0).toBe(2);
    expect(frame[0]).toBe(0x81);
  });
});
