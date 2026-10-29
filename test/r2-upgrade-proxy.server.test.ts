import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { upgradeRequestOf } from "../src/node/websocket";

function incoming(headers: Record<string, string>, url = "/chat"): IncomingMessage {
  return { headers, rawHeaders: Object.entries(headers).flat(), url } as unknown as IncomingMessage;
}

const upgrade = { upgrade: "websocket", connection: "Upgrade" };

describe("WebSocket upgrade: the public URL behind a trusted proxy", () => {
  const behind = {
    host: "internal:3000",
    "x-forwarded-host": "app.example.com",
    "x-forwarded-proto": "https",
    origin: "https://app.example.com",
    ...upgrade,
  };

  it("[DUSK-R2-11] with trustProxy the URL is the one the visitor used, so the browser's Origin matches it", () => {
    const request = upgradeRequestOf(incoming(behind), false, true);
    expect(request?.url).toBe("https://app.example.com/chat");
    expect(new URL(request?.url ?? "").origin).toBe(request?.headers.get("origin"));
  });

  it("[DUSK-R2-11] without trustProxy the forwarded headers are ignored", () => {
    expect(upgradeRequestOf(incoming(behind), false)?.url).toBe("http://internal:3000/chat");
    expect(upgradeRequestOf(incoming(behind), true, false)?.url).toBe("https://internal:3000/chat");
  });

  it("[DUSK-R2-11] only the rightmost forwarded value is believed (the client controls the left)", () => {
    const spoofed = {
      ...behind,
      "x-forwarded-host": "evil.example, app.example.com",
      "x-forwarded-proto": "http, https",
    };
    expect(upgradeRequestOf(incoming(spoofed), false, true)?.url).toBe(
      "https://app.example.com/chat",
    );
  });

  it("[DUSK-R2-11] a forwarded host that is not a plain host name is refused, like any Host", () => {
    for (const bad of ["a b", "app.example.com/admin", "evil.com@app.example.com", "[::1"]) {
      expect(
        upgradeRequestOf(incoming({ ...behind, "x-forwarded-host": bad }), false, true),
        bad,
      ).toBeUndefined();
    }
  });

  it("[DUSK-R2-11] a forwarded protocol that is not http or https falls back to the socket's", () => {
    expect(
      upgradeRequestOf(incoming({ ...behind, "x-forwarded-proto": "javascript" }), false, true)
        ?.url,
    ).toBe("http://app.example.com/chat");
  });
});
