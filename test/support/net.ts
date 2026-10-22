import { connect } from "node:net";

/** Sends raw bytes to a local port and returns everything the server writes until it closes. */
export function rawRequest(port: number, text: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const parts: Buffer[] = [];
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(parts).toString("latin1")));
  });
}

/** The status code of a raw HTTP/1.1 answer, or 0 when the server closed without one. */
export function statusOf(raw: string): number {
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
}

/** Lets the event loop run until `read()` returned the same value for `turns` turns in a row. */
export async function settled<T>(read: () => T, turns = 200): Promise<T> {
  let last = read();
  let stable = 0;
  while (stable < turns) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const now = read();
    stable = Object.is(now, last) ? stable + 1 : 0;
    last = now;
  }
  return last;
}
