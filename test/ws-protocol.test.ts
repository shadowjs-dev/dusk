import { describe, expect, it } from "vitest";
import {
  CLOSE,
  encodeFrame,
  FrameReader,
  WebSocketProtocolError,
  websocketAcceptKey,
} from "../src/server/ws-protocol";

/** A client frame: always masked (RFC 6455 section 5.3). */
function clientFrame(
  opcode: number,
  payload: Uint8Array,
  options: { fin?: boolean; rsv?: number; mask?: boolean; length?: number } = {},
): Uint8Array {
  const fin = options.fin === false ? 0 : 0x80;
  const rsv = (options.rsv ?? 0) << 4;
  const masked = options.mask === false ? 0 : 0x80;
  const key = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);
  const n = payload.byteLength;
  const header: number[] = [fin | rsv | opcode];
  if (n < 126) header.push(masked | n);
  else if (n < 65536) header.push(masked | 126, (n >> 8) & 0xff, n & 0xff);
  else {
    header.push(masked | 127);
    for (let shift = 56; shift >= 0; shift -= 8)
      header.push(Number((BigInt(n) >> BigInt(shift)) & 0xffn));
  }
  if (options.length !== undefined) header.length = 1;
  const out = new Uint8Array(header.length + (masked ? 4 : 0) + n);
  out.set(header, 0);
  let at = header.length;
  if (masked) {
    out.set(key, at);
    at += 4;
  }
  for (let index = 0; index < n; index += 1)
    out[at + index] = (payload[index] ?? 0) ^ (masked ? (key[index % 4] ?? 0) : 0);
  return out;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("WebSocket framing (RFC 6455)", () => {
  it("[WS-01] the accept key is the base64 SHA-1 of the client key and the RFC's GUID", async () => {
    expect(await websocketAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("[WS-02] a masked text frame is unmasked and delivered as one message", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expect(reader.push(clientFrame(0x1, bytes("hello")))).toEqual([
      { kind: "text", data: bytes("hello") },
    ]);
  });

  it("[WS-03] a frame split across reads is held until it is complete", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    const frame = clientFrame(0x2, bytes("split"));
    expect(reader.push(frame.subarray(0, 3))).toEqual([]);
    expect(reader.push(frame.subarray(3))).toEqual([{ kind: "binary", data: bytes("split") }]);
  });

  it("[WS-04] fragments are joined into one message; a control frame may come between them", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    const events = reader.push(
      new Uint8Array([
        ...clientFrame(0x1, bytes("ab"), { fin: false }),
        ...clientFrame(0x9, bytes("p")),
        ...clientFrame(0x0, bytes("cd")),
      ]),
    );
    expect(events).toEqual([
      { kind: "ping", data: bytes("p") },
      { kind: "text", data: bytes("abcd") },
    ]);
  });

  it("[WS-05] payloads of 126 and 65536 bytes use the extended lengths and still decode", () => {
    const reader = new FrameReader({ maxMessageBytes: 1 << 20, requireMask: true });
    const medium = "m".repeat(300);
    const large = "l".repeat(70_000);
    const events = reader.push(
      new Uint8Array([...clientFrame(0x1, bytes(medium)), ...clientFrame(0x1, bytes(large))]),
    );
    expect(events.map((event) => (event.kind === "text" ? event.data.byteLength : -1))).toEqual([
      300, 70_000,
    ]);
  });

  it("[WS-06] a frame that is not masked is a protocol error (1002): clients must mask", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expectCode(
      () => reader.push(clientFrame(0x1, bytes("x"), { mask: false })),
      CLOSE.PROTOCOL_ERROR,
    );
  });

  it("[WS-07] reserved bits, unknown opcodes and a fragmented control frame are protocol errors (1002)", () => {
    const reader = (): FrameReader => new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expectCode(
      () => reader().push(clientFrame(0x1, bytes("x"), { rsv: 0x4 })),
      CLOSE.PROTOCOL_ERROR,
    );
    expectCode(() => reader().push(clientFrame(0x3, bytes("x"))), CLOSE.PROTOCOL_ERROR);
    expectCode(
      () => reader().push(clientFrame(0x9, bytes("x"), { fin: false })),
      CLOSE.PROTOCOL_ERROR,
    );
    expectCode(() => reader().push(clientFrame(0x9, new Uint8Array(126))), CLOSE.PROTOCOL_ERROR);
    expectCode(() => reader().push(clientFrame(0x0, bytes("x"))), CLOSE.PROTOCOL_ERROR);
  });

  it("[WS-08] a message over the limit is too big (1009), and a header that declares one is refused before its payload arrives", () => {
    const reader = new FrameReader({ maxMessageBytes: 8, requireMask: true });
    expectCode(() => reader.push(clientFrame(0x1, bytes("nine-byte"))), CLOSE.TOO_BIG);
    const next = new FrameReader({ maxMessageBytes: 8, requireMask: true });
    expectCode(
      () => next.push(new Uint8Array([0x81, 0xff, 0, 0, 0, 0, 0, 1, 0, 0])),
      CLOSE.TOO_BIG,
    );
  });

  it("[WS-09] a text message that is not UTF-8 is invalid data (1007)", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expectCode(
      () => reader.push(clientFrame(0x1, new Uint8Array([0xc3, 0x28]))),
      CLOSE.INVALID_DATA,
    );
  });

  it("[WS-10] a close frame carries a code and a reason; a code that must not be sent is a protocol error", () => {
    const reader = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    const payload = new Uint8Array([0x03, 0xe8, ...bytes("bye")]);
    expect(reader.push(clientFrame(0x8, payload))).toEqual([
      { kind: "close", code: 1000, reason: "bye" },
    ]);
    const none = new FrameReader({ maxMessageBytes: 1024, requireMask: true });
    expect(none.push(clientFrame(0x8, new Uint8Array()))).toEqual([
      { kind: "close", code: 1005, reason: "" },
    ]);
    expectCode(
      () =>
        new FrameReader({ maxMessageBytes: 1024, requireMask: true }).push(
          clientFrame(0x8, new Uint8Array([0x03, 0xed])),
        ),
      CLOSE.PROTOCOL_ERROR,
    );
    expectCode(
      () =>
        new FrameReader({ maxMessageBytes: 1024, requireMask: true }).push(
          clientFrame(0x8, new Uint8Array([0x03])),
        ),
      CLOSE.PROTOCOL_ERROR,
    );
  });

  it("[WS-11] server frames are written unmasked, with the shortest length encoding", () => {
    expect([...encodeFrame("text", bytes("hi"))]).toEqual([0x81, 0x02, 0x68, 0x69]);
    expect(encodeFrame("binary", new Uint8Array(200))[1]).toBe(126);
    expect(encodeFrame("binary", new Uint8Array(70_000))[1]).toBe(127);
    expect([...encodeFrame("pong", new Uint8Array([1]))]).toEqual([0x8a, 0x01, 0x01]);
  });

  it("[WS-12] a close frame built by the server holds the code and the reason", () => {
    const frame = encodeFrame("close", new Uint8Array([0x03, 0xe9, ...bytes("gone")]));
    expect([...frame.subarray(0, 2)]).toEqual([0x88, 6]);
    expect([...frame.subarray(2)]).toEqual([0x03, 0xe9, ...bytes("gone")]);
  });
});

function expectCode(run: () => unknown, code: number): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WebSocketProtocolError);
    expect((error as WebSocketProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected a protocol error ${code}`);
}
