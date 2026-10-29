import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { answerUpgrade } from "../src/node/websocket";

function upgradeRequest(): IncomingMessage {
  const rawHeaders = ["Host", "example.com", "Upgrade", "websocket", "Connection", "Upgrade"];
  return {
    url: "/ws",
    headers: { host: "example.com", upgrade: "websocket", connection: "Upgrade" },
    rawHeaders,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("answerUpgrade: a refused upgrade", () => {
  it("[DUSK-REST-REV-10] the refusal carries one framing of its own, whatever framing headers the response brought", async () => {
    const socket = new PassThrough();
    const written: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => written.push(chunk));
    const reject = new Response("no", {
      status: 403,
      headers: {
        "content-length": "999",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "x-reason": "closed",
      },
    });
    await answerUpgrade(upgradeRequest(), socket, Buffer.alloc(0), {
      decide: async () => ({ kind: "reject", response: reject }),
      secure: false,
      draining: () => false,
      report: (error) => {
        throw error;
      },
      sockets: new Set(),
    });
    await new Promise<void>((resolve) => socket.once("end", resolve));
    const text = Buffer.concat(written).toString("utf8");
    const head = text.slice(0, text.indexOf("\r\n\r\n")).toLowerCase();
    expect(head).toContain("x-reason: closed");
    expect(head.match(/content-length:/g)).toHaveLength(1);
    expect(head).toContain("content-length: 2");
    expect(head).not.toContain("transfer-encoding");
    expect(head.match(/connection:/g)).toHaveLength(1);
    expect(text.endsWith("\r\n\r\nno")).toBe(true);
  });
});

describe("createNativeFetch: a static folder that does not exist", () => {
  it("[DUSK-REST-REV-11] the missing folder is reported once and the requests go to the handler, as on the Node server", async () => {
    const { createNativeFetch } = await import("../src/adapter/native");
    const errors: unknown[] = [];
    const fetch = createNativeFetch(
      {
        fetch: async () => new Response("from the handler"),
      },
      {
        static: "/definitely/not/a/folder/dusk-rest-review",
        compress: false,
        onError: (error) => errors.push(error),
      },
    );
    const answer = await fetch(new Request("http://localhost/a.txt"), undefined);
    expect(await answer.text()).toBe("from the handler");
    expect(answer.status).toBe(200);
    expect(errors).toHaveLength(1);
    expect(Reflect.get(errors[0] as object, "code")).toBe("ENOENT");
  });
});
